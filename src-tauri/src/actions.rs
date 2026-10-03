use super::*;

#[tauri::command]
pub(super) fn reveal_in_finder(path: String) -> Result<(), String> {
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
pub(super) fn open_path(path: String) -> Result<(), String> {
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

#[tauri::command]
pub(super) fn preview_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("qlmanage")
            .args(["-p", &path])
            .spawn()
            .map_err(|e| format!("Failed to preview path: {e}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        open_path(path)
    }
}

#[tauri::command]
pub(super) fn move_to_trash(path: String) -> Result<(), String> {
    let path = validated_delete_target(&path)?
        .to_string_lossy()
        .to_string();
    #[cfg(target_os = "macos")]
    {
        let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
        let status = Command::new("osascript")
            .args([
                "-e",
                &format!("tell application \"Finder\" to delete POSIX file \"{escaped}\""),
            ])
            .status()
            .map_err(|e| format!("Failed to move to Trash: {e}"))?;
        if !status.success() {
            return Err("Failed to move item to Trash".to_string());
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let escaped = path.replace('\'', "''");
        let script = format!(
            "$p = '{escaped}'; $shell = New-Object -ComObject Shell.Application; \
             $folder = Split-Path -Parent $p; $name = Split-Path -Leaf $p; \
             $ns = $shell.Namespace($folder); if ($ns -eq $null) {{ exit 1 }}; \
             $item = $ns.ParseName($name); if ($item -eq $null) {{ exit 1 }}; \
             $item.InvokeVerb('delete')"
        );
        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .map_err(|e| format!("Failed to move to Recycle Bin: {e}"))?;
        if !status.success() {
            return Err("Failed to move item to Recycle Bin".to_string());
        }
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("gio").args(["trash", &path]).status();
        if let Ok(status) = status {
            if status.success() {
                return Ok(());
            }
        }
        let status = Command::new("trash-put")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to move to Trash: {e}"))?;
        if !status.success() {
            return Err("Failed to move item to Trash".to_string());
        }
        return Ok(());
    }
}

#[tauri::command]
pub(super) fn inspect_path(path: String) -> Result<PathInspection, String> {
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            Ok(PathInspection {
                exists: true,
                is_symlink: file_type.is_symlink(),
                is_dir: metadata.is_dir() && !file_type.is_symlink(),
            })
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(PathInspection {
            exists: false,
            is_symlink: false,
            is_dir: false,
        }),
        Err(err) => Err(format!("Failed to inspect path: {err}")),
    }
}

/// Resolve parent aliases without following a final symlink: deleting a link
/// must remove the link, never the directory it points at.
pub(super) fn validated_delete_target(path: &str) -> Result<std::path::PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Refusing to delete an empty path".into());
    }
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err("Refusing to delete a relative path".into());
    }
    if requested.components().any(|part| {
        matches!(
            part,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )
    }) {
        return Err("Refusing to delete a path containing dot components".into());
    }
    let name = requested
        .file_name()
        .ok_or("Refusing to delete a filesystem root")?;
    let parent = requested
        .parent()
        .ok_or("Refusing to delete a filesystem root")?
        .canonicalize()
        .map_err(|e| format!("Failed to resolve delete parent: {e}"))?;
    let target = parent.join(name);
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Cannot determine home directory; refusing deletion")?;
    let home = Path::new(&home)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve home directory: {e}"))?;
    let protected = [
        "/Users",
        "/System",
        "/Library",
        "/Applications",
        "/bin",
        "/sbin",
        "/usr",
        "/etc",
        "/var",
        "/private",
        "/dev",
        "/proc",
        "/sys",
        "/boot",
        "/home",
        "/root",
        "/Volumes",
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Users",
    ];
    if home.starts_with(&target)
        || protected.iter().any(|critical| {
            let critical = Path::new(critical);
            let resolved = critical
                .canonicalize()
                .unwrap_or_else(|_| critical.to_path_buf());
            target == critical || target == resolved
        })
    {
        return Err("Refusing to delete a critical path".into());
    }
    let metadata = fs::symlink_metadata(&target)
        .map_err(|e| format!("Failed to inspect delete target: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.is_dir()
            && metadata.dev()
                != fs::metadata(&parent)
                    .map_err(|e| format!("Cannot inspect delete parent: {e}"))?
                    .dev()
        {
            return Err("Refusing to delete a mounted volume root".into());
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    Ok(target)
}

#[tauri::command]
pub(super) fn permanently_delete_path(path: String) -> Result<(), String> {
    let target = validated_delete_target(&path)?;
    let metadata = fs::symlink_metadata(&target)
        .map_err(|e| format!("Failed to inspect path before delete: {e}"))?;
    let file_type = metadata.file_type();

    if metadata.is_dir() && !file_type.is_symlink() {
        fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to permanently delete directory: {e}"))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("Failed to permanently delete file: {e}"))?;
    }

    Ok(())
}
