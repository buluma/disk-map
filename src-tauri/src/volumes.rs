use super::*;

#[tauri::command]
pub(super) fn list_volumes() -> Result<Vec<VolumeInfo>, String> {
    let mut paths = discover_volume_paths();
    paths.sort();
    paths.dedup();

    let mut by_mount_path: HashMap<String, VolumeInfo> = HashMap::new();
    for path in paths {
        if let Some(volume) = volume_info_for_path(&path) {
            by_mount_path.entry(volume.path.clone()).or_insert(volume);
        }
    }
    let mut volumes = by_mount_path.into_values().collect::<Vec<_>>();
    volumes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(volumes)
}

#[tauri::command]
pub(super) fn get_purgeable_space(path: String) -> Result<Option<u64>, String> {
    get_purgeable_space_for_path(&path)
}

#[tauri::command]
pub(super) fn reclaim_purgeable_space(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let volume = volume_info_for_path(&path).ok_or("Could not determine target volume")?;
        let target_bytes = get_purgeable_space_for_path(&volume.path)?.unwrap_or(0);
        if target_bytes == 0 {
            return Ok(());
        }

        let output = Command::new("tmutil")
            .args(["thinlocalsnapshots", &volume.path, "999999999999", "4"])
            .output()
            .map_err(|e| format!("Failed to start purgeable reclaim: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Failed to reclaim purgeable space: {}",
                stderr.trim()
            ));
        }
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Ok(())
    }
}

pub(super) fn discover_volume_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let mut out = vec![String::from("/")];
        if let Ok(entries) = fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    out.push(p.to_string_lossy().to_string());
                }
            }
        }
        return out;
    }

    #[cfg(target_os = "windows")]
    {
        let mut out = Vec::new();
        if let Ok(system_drive) = std::env::var("SystemDrive") {
            out.push(format!("{system_drive}\\"));
        } else {
            out.push(String::from("C:\\"));
        }
        return out;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut out = vec![String::from("/")];
        for base in ["/mnt", "/media"] {
            if let Ok(entries) = fs::read_dir(base) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        out.push(p.to_string_lossy().to_string());
                    }
                }
            }
        }
        return out;
    }
}

pub(super) fn volume_info_for_path(path: &str) -> Option<VolumeInfo> {
    let output = Command::new("df").args(["-kP", path]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .skip(1)
        .find(|line| !line.trim().is_empty())?
        .to_string();
    let cols = line.split_whitespace().collect::<Vec<_>>();
    if cols.len() < 6 {
        return None;
    }
    let total_kb = cols.get(1)?.parse::<u64>().ok()?;
    let used_kb = cols.get(2)?.parse::<u64>().ok()?;
    let avail_kb = cols.get(3)?.parse::<u64>().ok()?;
    let mount = cols[5..].join(" ");
    let name = if mount == "/" {
        String::from("System")
    } else {
        Path::new(&mount)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| mount.clone())
    };

    let purgeable_bytes = get_purgeable_space_for_path(path).ok().flatten();
    let available_including_purgeable_bytes = avail_kb
        .saturating_mul(1024)
        .saturating_add(purgeable_bytes.unwrap_or(0));

    Some(VolumeInfo {
        name,
        path: mount.clone(),
        total_bytes: total_kb.saturating_mul(1024),
        used_bytes: used_kb.saturating_mul(1024),
        available_bytes: avail_kb.saturating_mul(1024),
        available_including_purgeable_bytes,
        purgeable_bytes,
    })
}

pub(super) fn get_purgeable_space_for_path(path: &str) -> Result<Option<u64>, String> {
    #[cfg(target_os = "macos")]
    {
        let plist_output = Command::new("diskutil")
            .args(["info", "-plist", path])
            .output()
            .map_err(|e| format!("Failed to inspect purgeable space: {e}"))?;
        if plist_output.status.success() {
            let text = String::from_utf8_lossy(&plist_output.stdout);
            if let Some(bytes) = parse_purgeable_bytes_from_plist(&text) {
                return Ok(Some(bytes));
            }
        }

        let text_output = Command::new("diskutil")
            .args(["info", path])
            .output()
            .map_err(|e| format!("Failed to inspect purgeable space: {e}"))?;
        if !text_output.status.success() {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&text_output.stdout);
        Ok(parse_purgeable_bytes_from_text(&text))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Ok(None)
    }
}

pub(super) fn parse_purgeable_bytes_from_plist(text: &str) -> Option<u64> {
    let lines = text.lines().map(str::trim).collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        if !line.to_ascii_lowercase().contains("purgeable") {
            continue;
        }
        for next in lines.iter().skip(index + 1).take(4) {
            if let Some(value) = next
                .strip_prefix("<integer>")
                .and_then(|v| v.strip_suffix("</integer>"))
                .and_then(|v| v.parse::<u64>().ok())
            {
                return Some(value);
            }
        }
    }
    None
}

pub(super) fn parse_purgeable_bytes_from_text(text: &str) -> Option<u64> {
    for line in text.lines() {
        if !line.to_ascii_lowercase().contains("purgeable") {
            continue;
        }

        if let Some(open) = line.find('(') {
            if let Some(close) = line[open + 1..].find(')') {
                let inside = &line[open + 1..open + 1 + close];
                let digits = inside
                    .chars()
                    .filter(|ch| ch.is_ascii_digit())
                    .collect::<String>();
                if let Ok(value) = digits.parse::<u64>() {
                    return Some(value);
                }
            }
        }

        let mut digits = String::new();
        for ch in line.chars() {
            if ch.is_ascii_digit() {
                digits.push(ch);
            } else if !digits.is_empty() {
                break;
            }
        }
        if !digits.is_empty() {
            if let Ok(value) = digits.parse::<u64>() {
                return Some(value);
            }
        }
    }
    None
}
