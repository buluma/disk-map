use super::*;

pub(super) fn is_scan_canceled(
    active_scans: &Mutex<HashMap<String, u64>>,
    scan_key: &str,
    scan_id: u64,
    cancel_generation: &AtomicU64,
    cancel_generation_at_start: u64,
) -> bool {
    if cancel_generation.load(Ordering::Relaxed) != cancel_generation_at_start {
        return true;
    }
    match active_scans.lock() {
        Ok(scans) => scans.get(scan_key).copied() != Some(scan_id),
        Err(_) => true,
    }
}

pub(super) fn should_exclude(path: &Path, excludes: &[String]) -> bool {
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

pub(super) fn record_skip(path: &Path, error_kind: Option<ErrorKind>, stats: &mut ScanStats) {
    stats.skipped += 1;
    let reason = match error_kind {
        Some(ErrorKind::PermissionDenied) => "Permission denied",
        Some(_) => "Filesystem error",
        None => "Excluded",
    };
    if stats.skipped_paths.len() < 100 {
        stats.skipped_paths.push(SkippedPath {
            path: path.to_string_lossy().to_string(),
            reason: reason.to_string(),
        });
    }
    match error_kind {
        Some(ErrorKind::PermissionDenied) => stats.permission_denied += 1,
        Some(_) => stats.errors += 1,
        None => {}
    }
}

pub(super) fn scan_path(
    path: &Path,
    excludes: &[String],
    stats: &mut ScanStats,
    largest_files: &mut Vec<LargestFile>,
    largest_limit: usize,
    file_types: &mut HashMap<String, (u64, usize)>,
    progress: &mut ProgressState,
    app_handle: Option<&tauri::AppHandle>,
    client_scan_id: u64,
    root_path: &str,
    started: Instant,
    active_scans: &Mutex<HashMap<String, u64>>,
    scan_key: &str,
    cancel_generation: &AtomicU64,
    cancel_generation_at_start: u64,
    scan_id: u64,
) -> Result<DiskNode, ScanError> {
    if is_scan_canceled(
        active_scans,
        scan_key,
        scan_id,
        cancel_generation,
        cancel_generation_at_start,
    ) {
        return Err(ScanError::Canceled);
    }

    let depth = path
        .strip_prefix(Path::new(root_path))
        .map(|relative| relative.components().count())
        .unwrap_or(0);
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() <= 1 || stats.seen_files.insert((metadata.dev(), metadata.ino())) {
                stats.allocated_bytes = stats
                    .allocated_bytes
                    .saturating_add(metadata.blocks().saturating_mul(512));
            } else {
                stats.hard_link_duplicates += 1;
            }
        }
        progress.bytes_accumulated += metadata.len();
        if progress.entries_scanned % 250 == 0 {
            if let Some(app_handle) = app_handle {
                let _ = app_handle.emit(
                    "scan-progress",
                    ScanProgress {
                        client_scan_id,
                        root_path: root_path.to_string(),
                        entries_scanned: progress.entries_scanned,
                        dirs_scanned: progress.dirs_scanned,
                        bytes_accumulated: progress.bytes_accumulated,
                        elapsed_ms: started.elapsed().as_millis(),
                    },
                );
            }
        }
        track_file_type(path, metadata.len(), file_types);
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
                    if is_scan_canceled(
                        active_scans,
                        scan_key,
                        scan_id,
                        cancel_generation,
                        cancel_generation_at_start,
                    ) {
                        return Err(ScanError::Canceled);
                    }

                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(err) => {
                            record_skip(path, Some(err.kind()), stats);
                            continue;
                        }
                    };

                    let child_path = entry.path();
                    if should_exclude(&child_path, excludes) {
                        record_skip(&child_path, None, stats);
                        continue;
                    }

                    match scan_path(
                        &child_path,
                        excludes,
                        stats,
                        largest_files,
                        largest_limit,
                        file_types,
                        progress,
                        app_handle,
                        client_scan_id,
                        root_path,
                        started,
                        active_scans,
                        scan_key,
                        cancel_generation,
                        cancel_generation_at_start,
                        scan_id,
                    ) {
                        Ok(child) => {
                            total_size += child.size;
                            if stats.display_depth.map_or(true, |limit| depth < limit) {
                                children.push(child);
                            }
                        }
                        Err(ScanError::Canceled) => return Err(ScanError::Canceled),
                        Err(ScanError::Io(kind)) => record_skip(&child_path, Some(kind), stats),
                    }
                }
            }
            Err(err) => record_skip(path, Some(err.kind()), stats),
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

pub(super) fn track_file_type(
    path: &Path,
    size: u64,
    file_types: &mut HashMap<String, (u64, usize)>,
) {
    let kind = file_type_bucket(path);
    let entry = file_types.entry(kind).or_insert((0, 0));
    entry.0 += size;
    entry.1 += 1;
}

pub(super) fn file_type_bucket(path: &Path) -> String {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if !ext.trim().is_empty() => ext.to_ascii_lowercase(),
        _ => String::from("(no extension)"),
    }
}

pub(super) fn maybe_add_largest_file(
    files: &mut Vec<LargestFile>,
    limit: usize,
    candidate: LargestFile,
) {
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

#[cfg(test)]
pub(super) fn prune_for_display(
    node: &DiskNode,
    depth: usize,
    max_display_depth: usize,
) -> DiskNode {
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
