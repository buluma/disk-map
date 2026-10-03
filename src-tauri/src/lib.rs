mod actions;
mod scanner;
mod volumes;
use scanner::*;
use volumes::*;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
    allocated_bytes: Option<u64>,
    hard_link_duplicates: usize,
    largest_files: Vec<LargestFile>,
    file_types: Vec<FileTypeStat>,
    skipped_paths: Vec<SkippedPath>,
    hidden_bytes: Option<u64>,
    purgeable_bytes: Option<u64>,
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileTypeStat {
    kind: String,
    bytes: u64,
    files: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkippedPath {
    path: String,
    reason: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VolumeInfo {
    name: String,
    path: String,
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
    available_including_purgeable_bytes: u64,
    purgeable_bytes: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PathInspection {
    exists: bool,
    is_symlink: bool,
    is_dir: bool,
}

struct AppState {
    next_scan_id: Arc<AtomicU64>,
    active_scans: Arc<Mutex<HashMap<String, u64>>>,
    cancel_generation: Arc<AtomicU64>,
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
    root_path: String,
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
    skipped_paths: Vec<SkippedPath>,
    allocated_bytes: u64,
    hard_link_duplicates: usize,
    seen_files: HashSet<(u64, u64)>,
    display_depth: Option<usize>,
}

#[derive(Debug)]
enum ScanError {
    Canceled,
    Io(ErrorKind),
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
    let display_depth = max_display_depth.unwrap_or(4).clamp(1, 12);
    let largest_limit = 100usize;
    let exclude_patterns: Vec<String> = excludes
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();
    let scan_id = state.next_scan_id.fetch_add(1, Ordering::Relaxed) + 1;
    let client_scan_id = client_scan_id.unwrap_or(scan_id);
    let root_path = path.clone();
    let scan_key = normalize_scan_key(&root_path);
    let active_scans = Arc::clone(&state.active_scans);
    let cancel_generation = Arc::clone(&state.cancel_generation);
    let cancel_generation_at_start = cancel_generation.load(Ordering::Relaxed);
    let app_handle_for_scan = app_handle.clone();

    {
        let mut scans = state
            .active_scans
            .lock()
            .map_err(|_| "Failed to lock scan state".to_string())?;
        scans.insert(scan_key.clone(), scan_id);
    }

    let scan_outcome = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut stats = ScanStats {
            display_depth: Some(display_depth),
            ..ScanStats::default()
        };
        let mut largest_files = Vec::<LargestFile>::with_capacity(largest_limit);
        let mut file_types = HashMap::<String, (u64, usize)>::new();
        let mut progress = ProgressState::default();
        let full_root = scan_path(
            Path::new(&root_path),
            &exclude_patterns,
            &mut stats,
            &mut largest_files,
            largest_limit,
            &mut file_types,
            &mut progress,
            Some(&app_handle_for_scan),
            client_scan_id,
            &root_path,
            started,
            &active_scans,
            &scan_key,
            &cancel_generation,
            cancel_generation_at_start,
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
                root_path: root_path.clone(),
                entries_scanned: progress.entries_scanned,
                dirs_scanned: progress.dirs_scanned,
                bytes_accumulated: progress.bytes_accumulated,
                elapsed_ms: started.elapsed().as_millis(),
            },
        );
        let elapsed_ms = started.elapsed().as_millis();
        Ok::<
            (
                DiskNode,
                Vec<LargestFile>,
                HashMap<String, (u64, usize)>,
                ScanStats,
                u128,
            ),
            String,
        >((full_root, largest_files, file_types, stats, elapsed_ms))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);

    clear_scan_if_current(&state.active_scans, &normalize_scan_key(&path), scan_id);

    let (full_root, mut largest_files, file_types, stats, elapsed_ms) = scan_outcome?;

    largest_files.sort_by(|a, b| b.size.cmp(&a.size));
    let mut file_types = file_types
        .into_iter()
        .map(|(kind, (bytes, files))| FileTypeStat { kind, bytes, files })
        .collect::<Vec<_>>();
    file_types.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    let volume = volume_info_for_path(&path);
    let purgeable_bytes = get_purgeable_space_for_path(&path).unwrap_or(None);
    // Only a whole-volume scan can estimate unattributed space. Logical sizes
    // include hard-link aliases and cannot be subtracted from allocated usage.
    let allocated_bytes = if cfg!(unix) {
        Some(stats.allocated_bytes)
    } else {
        None
    };
    let hidden_bytes = volume.and_then(|v| {
        (normalize_scan_key(&v.path) == normalize_scan_key(&path))
            .then(|| allocated_bytes.map(|bytes| v.used_bytes.saturating_sub(bytes)))
            .flatten()
    });

    Ok(ScanResult {
        root: full_root,
        allocated_bytes,
        hard_link_duplicates: stats.hard_link_duplicates,
        largest_files,
        file_types,
        skipped_paths: stats.skipped_paths,
        hidden_bytes,
        purgeable_bytes,
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
    state.cancel_generation.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut scans) = state.active_scans.lock() {
        scans.clear();
    }
}

fn normalize_scan_key(path: &str) -> String {
    Path::new(path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn clear_scan_if_current(active_scans: &Mutex<HashMap<String, u64>>, scan_key: &str, scan_id: u64) {
    if let Ok(mut scans) = active_scans.lock() {
        if scans.get(scan_key).copied() == Some(scan_id) {
            scans.remove(scan_key);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            next_scan_id: Arc::new(AtomicU64::new(0)),
            active_scans: Arc::new(Mutex::new(HashMap::new())),
            cancel_generation: Arc::new(AtomicU64::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            cancel_scan,
            actions::reveal_in_finder,
            actions::open_path,
            actions::preview_path,
            actions::move_to_trash,
            actions::inspect_path,
            actions::permanently_delete_path,
            volumes::list_volumes,
            volumes::get_purgeable_space,
            volumes::reclaim_purgeable_space
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::actions::*;
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

    fn test_scan_state(root: &Path) -> (Mutex<HashMap<String, u64>>, AtomicU64, u64, String) {
        let scan_key = normalize_scan_key(&root.to_string_lossy());
        let active = Mutex::new(HashMap::from([(scan_key.clone(), 1)]));
        let generation = AtomicU64::new(0);
        (active, generation, 0, scan_key)
    }

    #[test]
    fn sorts_children_by_size_desc() {
        let root = test_root("sort");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("small.txt"), b"1").expect("write small");
        fs::write(root.join("big.txt"), vec![b'x'; 16]).expect("write big");

        let mut stats = ScanStats::default();
        let (active, generation, generation_start, scan_key) = test_scan_state(&root);
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut HashMap::new(),
            &mut progress,
            None,
            1,
            &root.to_string_lossy(),
            Instant::now(),
            &active,
            &scan_key,
            &generation,
            generation_start,
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
        let (active, generation, generation_start, scan_key) = test_scan_state(&root);
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut HashMap::new(),
            &mut progress,
            None,
            1,
            &root.to_string_lossy(),
            Instant::now(),
            &active,
            &scan_key,
            &generation,
            generation_start,
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
        let (active, generation, generation_start, scan_key) = test_scan_state(&root);
        let mut progress = ProgressState::default();
        let full = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut HashMap::new(),
            &mut progress,
            None,
            1,
            &root.to_string_lossy(),
            Instant::now(),
            &active,
            &scan_key,
            &generation,
            generation_start,
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
        let (active, generation, generation_start, scan_key) = test_scan_state(&root);
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut HashMap::new(),
            &mut progress,
            None,
            1,
            &root.to_string_lossy(),
            Instant::now(),
            &active,
            &scan_key,
            &generation,
            generation_start,
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
        let (active, generation, generation_start, scan_key) = test_scan_state(&root);
        let mut progress = ProgressState::default();
        let result = scan_path(
            &root,
            &[],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut HashMap::new(),
            &mut progress,
            None,
            1,
            &root.to_string_lossy(),
            Instant::now(),
            &active,
            &scan_key,
            &generation,
            generation_start,
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
        let (active, generation, generation_start, scan_key) = test_scan_state(&root);
        let mut progress = ProgressState::default();
        let node = scan_path(
            &root,
            &[String::from("node_modules")],
            &mut stats,
            &mut Vec::new(),
            50,
            &mut HashMap::new(),
            &mut progress,
            None,
            1,
            &root.to_string_lossy(),
            Instant::now(),
            &active,
            &scan_key,
            &generation,
            generation_start,
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

    #[test]
    fn parses_purgeable_bytes_from_plist() {
        let text = r#"
        <dict>
          <key>APFSPurgeableSpace</key>
          <integer>123456</integer>
        </dict>
        "#;

        assert_eq!(parse_purgeable_bytes_from_plist(text), Some(123456));
    }

    #[test]
    fn returns_none_for_plist_without_purgeable_space() {
        let text = r#"
        <dict>
          <key>TotalSize</key>
          <integer>123456</integer>
        </dict>
        "#;

        assert_eq!(parse_purgeable_bytes_from_plist(text), None);
    }

    #[test]
    fn parses_purgeable_bytes_from_diskutil_text() {
        let text = "   Purgeable Space: 12.4 GB (12400000000 Bytes)";

        assert_eq!(parse_purgeable_bytes_from_text(text), Some(12400000000));
    }

    #[test]
    fn hidden_space_math_saturates() {
        let used = 100u64;
        let scanned = 140u64;

        assert_eq!(used.saturating_sub(scanned), 0);
    }

    #[test]
    fn permanently_deletes_file() {
        let root = test_root("permanent_file");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("delete-me.txt");
        fs::write(&file, b"delete").expect("write file");

        permanently_delete_path(file.to_string_lossy().to_string()).expect("delete file");

        assert!(!file.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn permanently_deletes_directory() {
        let root = test_root("permanent_dir");
        let child = root.join("child");
        fs::create_dir_all(&child).expect("create child");
        fs::write(child.join("delete-me.txt"), b"delete").expect("write file");

        permanently_delete_path(child.to_string_lossy().to_string()).expect("delete directory");

        assert!(!child.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_permanently_delete_root() {
        assert!(permanently_delete_path(String::from("/")).is_err());
    }
    #[test]
    fn rejects_critical_aliases_and_traversal() {
        for path in ["", "/", "/Users", "/usr", "relative.txt", "/tmp/../Users"] {
            assert!(validated_delete_target(path).is_err(), "accepted {path}");
        }
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap();
        assert!(validated_delete_target(&home).is_err());
        assert!(validated_delete_target(&format!("{home}/")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn deleting_symlink_preserves_its_target_and_blocks_parent_alias() {
        use std::os::unix::fs::symlink;
        let root = test_root("delete_symlink");
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original");
        fs::create_dir_all(&original).unwrap();
        fs::write(original.join("keep.txt"), b"keep").unwrap();
        let link = root.join("link");
        symlink(&original, &link).unwrap();
        permanently_delete_path(link.to_string_lossy().to_string()).unwrap();
        assert!(original.join("keep.txt").exists());
        assert!(fs::symlink_metadata(&link).is_err());
        let alias = root.join("alias");
        let home = std::env::var("HOME").unwrap();
        let home = Path::new(&home);
        symlink(home.parent().unwrap(), &alias).unwrap();
        assert!(
            validated_delete_target(&alias.join(home.file_name().unwrap()).to_string_lossy())
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bounded_scan_keeps_totals_analytics_and_unique_allocated_bytes() {
        use std::os::unix::fs::MetadataExt;
        let root = test_root("bounded");
        let nested = root.join("a/b/c");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("leaf.bin");
        fs::write(&file, vec![b'x'; 8192]).unwrap();
        fs::hard_link(&file, nested.join("alias.bin")).unwrap();
        let mut stats = ScanStats {
            display_depth: Some(1),
            ..ScanStats::default()
        };
        let (active, generation, generation_start, scan_key) = test_scan_state(&root);
        let mut largest = Vec::new();
        let mut types = HashMap::new();
        let node = scan_path(
            &root,
            &[],
            &mut stats,
            &mut largest,
            100,
            &mut types,
            &mut ProgressState::default(),
            None,
            1,
            &root.to_string_lossy(),
            Instant::now(),
            &active,
            &scan_key,
            &generation,
            generation_start,
            1,
        )
        .unwrap();
        assert_eq!(node.size, 16384);
        assert_eq!(node.children.len(), 1);
        assert!(node.children[0].children.is_empty());
        assert_eq!(stats.files, 2);
        assert_eq!(stats.hard_link_duplicates, 1);
        assert_eq!(
            stats.allocated_bytes,
            fs::metadata(&file).unwrap().blocks() * 512
        );
        assert_eq!(largest.len(), 2);
        assert_eq!(types.get("bin"), Some(&(16384, 2)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_and_global_cancellation_do_not_remove_newer_registry_entries() {
        let active = Mutex::new(HashMap::from([("a".to_string(), 2), ("b".to_string(), 3)]));
        let generation = AtomicU64::new(0);
        assert!(is_scan_canceled(&active, "a", 1, &generation, 0));
        assert!(!is_scan_canceled(&active, "a", 2, &generation, 0));
        clear_scan_if_current(&active, "a", 1);
        assert_eq!(active.lock().unwrap().get("a"), Some(&2));
        generation.fetch_add(1, Ordering::Relaxed);
        assert!(is_scan_canceled(&active, "a", 2, &generation, 0));
        assert!(is_scan_canceled(&active, "b", 3, &generation, 0));
    }
}
