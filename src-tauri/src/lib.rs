use serde::Serialize;
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use std::path::Path;
use tauri::State;

#[derive(Clone, Serialize)]
struct DiskNode {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    children: Vec<DiskNode>,
}

#[derive(Serialize)]
struct ScanResult {
    root: DiskNode,
    elapsed_ms: u128,
    total_nodes: usize,
    total_files: usize,
    total_dirs: usize,
}

struct AppState {
    latest_scan_id: Arc<AtomicU64>,
}

#[derive(Default)]
struct ScanStats {
    total_nodes: usize,
    total_files: usize,
    total_dirs: usize,
}

fn is_canceled(latest_scan_id: &AtomicU64, scan_id: u64) -> bool {
    latest_scan_id.load(Ordering::Relaxed) != scan_id
}

fn should_exclude(path: &Path, excludes: &[String]) -> bool {
    if excludes.is_empty() {
        return false;
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string().to_lowercase())
        .unwrap_or_default();
    let full_path = path.to_string_lossy().to_string().to_lowercase();

    excludes
        .iter()
        .any(|pattern| !pattern.is_empty() && (name.contains(pattern) || full_path.contains(pattern)))
}

fn scan_path(
    path: &Path,
    depth: usize,
    max_depth: usize,
    excludes: &[String],
    stats: &mut ScanStats,
    latest_scan_id: &AtomicU64,
    scan_id: u64,
) -> Result<DiskNode, String> {
    if is_canceled(latest_scan_id, scan_id) {
        return Err("Scan canceled by a newer request".to_string());
    }

    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let file_type = metadata.file_type();

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if metadata.is_file() || file_type.is_symlink() {
        stats.total_nodes += 1;
        stats.total_files += 1;
        return Ok(DiskNode {
            name,
            path: path.to_string_lossy().to_string(),
            size: metadata.len(),
            is_dir: false,
            children: Vec::new(),
        });
    }

    let mut children = Vec::new();
    let mut total_size = 0;
    stats.total_nodes += 1;
    stats.total_dirs += 1;

    if metadata.is_dir() && depth < max_depth {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if is_canceled(latest_scan_id, scan_id) {
                    return Err("Scan canceled by a newer request".to_string());
                }

                let child_path = entry.path();
                if should_exclude(&child_path, excludes) {
                    continue;
                }

                if let Ok(child) = scan_path(
                    &child_path,
                    depth + 1,
                    max_depth,
                    excludes,
                    stats,
                    latest_scan_id,
                    scan_id,
                ) {
                    total_size += child.size;
                    children.push(child);
                }
            }
        }
    }

    children.sort_by(|a, b| b.size.cmp(&a.size));

    Ok(DiskNode {
        name,
        path: path.to_string_lossy().to_string(),
        size: total_size,
        is_dir: metadata.is_dir(),
        children,
    })
}

#[tauri::command]
async fn scan_directory(
    path: String,
    max_depth: Option<usize>,
    excludes: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let depth = max_depth.unwrap_or(4).min(12);
    let exclude_patterns: Vec<String> = excludes
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();
    let scan_id = state.latest_scan_id.fetch_add(1, Ordering::Relaxed) + 1;
    let root_path = path.clone();
    let latest_scan_id = Arc::clone(&state.latest_scan_id);

    let (root, stats, elapsed_ms) = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut stats = ScanStats::default();
        let root = scan_path(
            Path::new(&root_path),
            0,
            depth,
            &exclude_patterns,
            &mut stats,
            &latest_scan_id,
            scan_id,
        )?;
        let elapsed_ms = started.elapsed().as_millis();
        Ok::<(DiskNode, ScanStats, u128), String>((root, stats, elapsed_ms))
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(ScanResult {
        root,
        elapsed_ms,
        total_nodes: stats.total_nodes,
        total_files: stats.total_files,
        total_dirs: stats.total_dirs,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            latest_scan_id: Arc::new(AtomicU64::new(0)),
        })
        .invoke_handler(tauri::generate_handler![scan_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock error")
            .as_nanos();
        std::env::temp_dir().join(format!("disk_map_test_{name}_{nanos}"))
    }

    #[test]
    fn sorts_children_by_size_desc() {
        let root = test_root("sort");
        fs::create_dir_all(&root).expect("create root");
        let small = root.join("small.txt");
        let big = root.join("big.txt");
        fs::write(&small, b"1").expect("write small");
        fs::write(&big, vec![b'x'; 16]).expect("write big");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let node = scan_path(&root, 0, 4, &[], &mut stats, &latest, 1).expect("scan");
        assert_eq!(node.children.len(), 2);
        assert_eq!(node.children[0].name, "big.txt");
        assert_eq!(node.children[1].name, "small.txt");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn honors_depth_limit() {
        let root = test_root("depth");
        let nested = root.join("a").join("b").join("c");
        fs::create_dir_all(&nested).expect("create nested");
        fs::write(nested.join("leaf.txt"), b"hello").expect("write leaf");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let node = scan_path(&root, 0, 1, &[], &mut stats, &latest, 1).expect("scan");
        assert_eq!(node.children.len(), 1);
        assert!(node.children[0].is_dir);
        assert!(node.children[0].children.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn treats_symlink_as_file_like_node() {
        use std::os::unix::fs as unix_fs;
        let root = test_root("symlink");
        fs::create_dir_all(&root).expect("create root");
        let target = root.join("target.txt");
        fs::write(&target, b"target-data").expect("write target");
        let link = root.join("link.txt");
        unix_fs::symlink(&target, &link).expect("create symlink");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let node = scan_path(&root, 0, 4, &[], &mut stats, &latest, 1).expect("scan");
        let symlink_node = node
            .children
            .iter()
            .find(|child| child.name == "link.txt")
            .expect("symlink child missing");
        assert!(!symlink_node.is_dir);
        assert!(symlink_node.children.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn skips_unreadable_directory_without_crash() {
        use std::os::unix::fs::PermissionsExt;
        let root = test_root("unreadable");
        let unreadable = root.join("private");
        fs::create_dir_all(&unreadable).expect("create unreadable dir");
        fs::write(root.join("visible.txt"), b"ok").expect("write visible");
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).expect("chmod");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let result = scan_path(&root, 0, 4, &[], &mut stats, &latest, 1);
        assert!(result.is_ok());
        let node = result.expect("scan");
        assert!(
            node.children.iter().any(|child| child.name == "visible.txt"),
            "visible file should remain in results"
        );

        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o755)).expect("restore perms");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn excludes_matching_paths() {
        let root = test_root("exclude");
        fs::create_dir_all(root.join("node_modules")).expect("create excluded dir");
        fs::write(root.join("node_modules").join("pkg.txt"), b"skip").expect("write excluded");
        fs::write(root.join("keep.txt"), b"keep").expect("write keep");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let node = scan_path(
            &root,
            0,
            4,
            &[String::from("node_modules")],
            &mut stats,
            &latest,
            1,
        )
        .expect("scan");
        assert!(!node.children.iter().any(|child| child.name == "node_modules"));

        let _ = fs::remove_dir_all(&root);
    }
}
