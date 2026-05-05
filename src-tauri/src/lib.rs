use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
struct DiskNode {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    children: Vec<DiskNode>,
}

fn scan_path(path: &Path, depth: usize, max_depth: usize) -> Result<DiskNode, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let file_type = metadata.file_type();

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if metadata.is_file() || file_type.is_symlink() {
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

    if metadata.is_dir() && depth < max_depth {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(child) = scan_path(&entry.path(), depth + 1, max_depth) {
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
fn scan_directory(path: String, max_depth: Option<usize>) -> Result<DiskNode, String> {
    let depth = max_depth.unwrap_or(4).min(12);
    scan_path(Path::new(&path), 0, depth)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
