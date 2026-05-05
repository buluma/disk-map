use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;
use tauri::State;

#[derive(Clone, Serialize)]
struct DiskNode {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    children: Vec<DiskNode>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    root: DiskNode,
    largest_files: Vec<LargestFile>,
    nodes: usize,
    files: usize,
    dirs: usize,
    skipped: usize,
    permission_denied: usize,
    errors: usize,
    elapsed_ms: u128,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LargestFile {
    name: String,
    path: String,
    size: u64,
    parent_path: String,
}

struct AppState {
    latest_scan_id: Arc<AtomicU64>,
}

#[derive(Default)]
struct ProgressState {
    entries_scanned: usize,
    dirs_scanned: usize,
    bytes_accumulated: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    client_scan_id: u64,
    entries_scanned: usize,
    dirs_scanned: usize,
    bytes_accumulated: u64,
    elapsed_ms: u128,
}

#[derive(Default)]
struct ScanStats {
    nodes: usize,
    files: usize,
    dirs: usize,
    skipped: usize,
    permission_denied: usize,
    errors: usize,
}

#[derive(Debug)]
enum ScanError {
    Canceled,
    Io(ErrorKind),
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

    excludes.iter().any(|pattern| {
        !pattern.is_empty() && (name.contains(pattern) || full_path.contains(pattern))
    })
}

fn record_skip(error_kind: Option<ErrorKind>, stats: &mut ScanStats) {
    stats.skipped += 1;
    match error_kind {
        Some(ErrorKind::PermissionDenied) => stats.permission_denied += 1,
        Some(_) => stats.errors += 1,
        None => {}
    }
}

fn scan_path(
    path: &Path,
    excludes: &[String],
    stats: &mut ScanStats,
    largest_files: &mut Vec<LargestFile>,
    largest_limit: usize,
    progress: &mut ProgressState,
    app_handle: Option<&tauri::AppHandle>,
    client_scan_id: u64,
    started: Instant,
    latest_scan_id: &AtomicU64,
    scan_id: u64,
) -> Result<DiskNode, ScanError> {
    if is_canceled(latest_scan_id, scan_id) {
        return Err(ScanError::Canceled);
    }

    let metadata = fs::symlink_metadata(path).map_err(|e| ScanError::Io(e.kind()))?;
    let file_type = metadata.file_type();

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if metadata.is_file() || file_type.is_symlink() {
        stats.nodes += 1;
        stats.files += 1;
        progress.entries_scanned += 1;
        progress.bytes_accumulated += metadata.len();
        if progress.entries_scanned % 250 == 0 {
            if let Some(app_handle) = app_handle {
                let _ = app_handle.emit(
                    "scan-progress",
                    ScanProgress {
                        client_scan_id,
                        entries_scanned: progress.entries_scanned,
                        dirs_scanned: progress.dirs_scanned,
                        bytes_accumulated: progress.bytes_accumulated,
                        elapsed_ms: started.elapsed().as_millis(),
                    },
                );
            }
        }
        let parent_path = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(String::new);
        maybe_add_largest_file(
            largest_files,
            largest_limit,
            LargestFile {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                size: metadata.len(),
                parent_path,
            },
        );
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
    stats.nodes += 1;
    stats.dirs += 1;
    progress.entries_scanned += 1;
    progress.dirs_scanned += 1;

    if metadata.is_dir() {
        match fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries {
                    if is_canceled(latest_scan_id, scan_id) {
                        return Err(ScanError::Canceled);
                    }

                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(err) => {
                            record_skip(Some(err.kind()), stats);
                            continue;
                        }
                    };

                    let child_path = entry.path();
                    if should_exclude(&child_path, excludes) {
                        record_skip(None, stats);
                        continue;
                    }

                    match scan_path(
                        &child_path,
                        excludes,
                        stats,
                        largest_files,
                        largest_limit,
                        progress,
                        app_handle,
                        client_scan_id,
                        started,
                        latest_scan_id,
                        scan_id,
                    ) {
                        Ok(child) => {
                            total_size += child.size;
                            children.push(child);
                        }
                        Err(ScanError::Canceled) => return Err(ScanError::Canceled),
                        Err(ScanError::Io(kind)) => record_skip(Some(kind), stats),
                    }
                }
            }
            Err(err) => record_skip(Some(err.kind()), stats),
        }
    }

    children.sort_by(|a, b| b.size.cmp(&a.size));

    Ok(DiskNode {
        name,
        path: path.to_string_lossy().to_string(),
        size: total_size,
        is_dir: true,
        children,
    })
}

fn maybe_add_largest_file(files: &mut Vec<LargestFile>, limit: usize, candidate: LargestFile) {
    if limit == 0 {
        return;
    }
    if files.len() < limit {
        files.push(candidate);
        return;
    }
    if let Some((smallest_index, smallest_size)) = files
        .iter()
        .enumerate()
        .map(|(idx, item)| (idx, item.size))
        .min_by_key(|(_, size)| *size)
    {
        if candidate.size > smallest_size {
            files[smallest_index] = candidate;
        }
    }
}

fn prune_for_display(node: &DiskNode, depth: usize, max_display_depth: usize) -> DiskNode {
    if depth >= max_display_depth {
        return DiskNode {
            name: node.name.clone(),
            path: node.path.clone(),
            size: node.size,
            is_dir: node.is_dir,
            children: Vec::new(),
        };
    }

    let children = node
        .children
        .iter()
        .map(|child| prune_for_display(child, depth + 1, max_display_depth))
        .collect::<Vec<_>>();

    DiskNode {
        name: node.name.clone(),
        path: node.path.clone(),
        size: node.size,
        is_dir: node.is_dir,
        children,
    }
}

#[tauri::command]
async fn scan_directory(
    path: String,
    max_display_depth: Option<usize>,
    excludes: Option<Vec<String>>,
    client_scan_id: Option<u64>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let display_depth = max_display_depth.unwrap_or(4).min(12);
    let largest_limit = 100usize;
    let exclude_patterns: Vec<String> = excludes
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();
    let scan_id = state.latest_scan_id.fetch_add(1, Ordering::Relaxed) + 1;
    let client_scan_id = client_scan_id.unwrap_or(scan_id);
    let root_path = path.clone();
    let latest_scan_id = Arc::clone(&state.latest_scan_id);
    let app_handle_for_scan = app_handle.clone();

    let (full_root, mut largest_files, stats, elapsed_ms) = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut stats = ScanStats::default();
        let mut largest_files = Vec::<LargestFile>::with_capacity(largest_limit);
        let mut progress = ProgressState::default();
        let full_root = scan_path(
            Path::new(&root_path),
            &exclude_patterns,
            &mut stats,
            &mut largest_files,
            largest_limit,
            &mut progress,
            Some(&app_handle_for_scan),
            client_scan_id,
            started,
            &latest_scan_id,
            scan_id,
        )
        .map_err(|err| match err {
            ScanError::Canceled => "Scan canceled by a newer request".to_string(),
            ScanError::Io(kind) => format!("Failed to scan root path ({kind:?})"),
        })?;
        let _ = app_handle_for_scan.emit(
            "scan-progress",
            ScanProgress {
                client_scan_id,
                entries_scanned: progress.entries_scanned,
                dirs_scanned: progress.dirs_scanned,
                bytes_accumulated: progress.bytes_accumulated,
                elapsed_ms: started.elapsed().as_millis(),
            },
        );
        let elapsed_ms = started.elapsed().as_millis();
        Ok::<(DiskNode, Vec<LargestFile>, ScanStats, u128), String>((
            full_root,
            largest_files,
            stats,
            elapsed_ms,
        ))
    })
    .await
    .map_err(|e| e.to_string())??;

    largest_files.sort_by(|a, b| b.size.cmp(&a.size));

    Ok(ScanResult {
        root: prune_for_display(&full_root, 0, display_depth),
        largest_files,
        nodes: stats.nodes,
        files: stats.files,
        dirs: stats.dirs,
        skipped: stats.skipped,
        permission_denied: stats.permission_denied,
        errors: stats.errors,
        elapsed_ms,
    })
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    state.latest_scan_id.fetch_add(1, Ordering::Relaxed);
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to reveal in Finder: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to reveal in File Explorer: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        Command::new("xdg-open")
            .arg(parent)
            .status()
            .map_err(|e| format!("Failed to open parent directory: {e}"))?;
        return Ok(());
    }
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .status()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            latest_scan_id: Arc::new(AtomicU64::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            cancel_scan,
            reveal_in_finder,
            open_path
        ])
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
        fs::write(root.join("small.txt"), b"1").expect("write small");
        fs::write(root.join("big.txt"), vec![b'x'; 16]).expect("write big");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut progress,
            None,
            1,
            Instant::now(),
            &latest,
            1,
        )
        .expect("scan");
        assert_eq!(node.children.len(), 2);
        assert_eq!(node.children[0].name, "big.txt");
        assert_eq!(node.children[1].name, "small.txt");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn full_scan_is_recursive_for_size() {
        let root = test_root("recursive");
        let nested = root.join("a").join("b").join("c");
        fs::create_dir_all(&nested).expect("create nested");
        fs::write(nested.join("leaf.txt"), vec![b'x'; 20]).expect("write leaf");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut progress,
            None,
            1,
            Instant::now(),
            &latest,
            1,
        )
        .expect("scan");
        assert!(node.size >= 20);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_only_limits_display_depth() {
        let root = test_root("prune");
        let nested = root.join("a").join("b");
        fs::create_dir_all(&nested).expect("create nested");
        fs::write(nested.join("leaf.bin"), vec![b'x'; 20]).expect("write leaf");

        let mut stats = ScanStats::default();
        let latest = AtomicU64::new(1);
        let mut progress = ProgressState::default();
        let full = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut progress,
            None,
            1,
            Instant::now(),
            &latest,
            1,
        )
        .expect("scan");
        let pruned = prune_for_display(&full, 0, 1);

        assert_eq!(full.size, pruned.size);
        assert_eq!(pruned.children.len(), 1);
        assert!(pruned.children[0].children.is_empty());

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
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut progress,
            None,
            1,
            Instant::now(),
            &latest,
            1,
        )
        .expect("scan");
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
        let mut progress = ProgressState::default();
        let result = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut progress,
            None,
            1,
            Instant::now(),
            &latest,
            1,
        );
        assert!(result.is_ok());

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
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[String::from("node_modules")],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut progress,
            None,
            1,
            Instant::now(),
            &latest,
            1,
        )
        .expect("scan");
        assert!(!node
            .children
            .iter()
            .any(|child| child.name == "node_modules"));
        assert!(stats.skipped >= 1);

        let _ = fs::remove_dir_all(&root);
    }
}
