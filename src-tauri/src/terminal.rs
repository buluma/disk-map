use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub struct TerminalState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Session>>,
}

/// The folder becomes the PTY cwd, never part of a shell string, so odd
/// filenames cannot inject commands.
pub(super) fn validated_terminal_cwd(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Refusing to open a terminal in an empty path".into());
    }
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err("Refusing to open a terminal in a relative path".into());
    }
    let resolved = requested
        .canonicalize()
        .map_err(|e| format!("Failed to resolve terminal folder: {e}"))?;
    if !resolved.is_dir() {
        return Err("Terminal folder is not a directory".into());
    }
    Ok(resolved)
}

/// Elevation happens inside the PTY via sudo, so the password prompt appears
/// in the terminal and the app never sees or stores it.
pub(super) fn shell_invocation(elevated: bool, shell: Option<&str>) -> (String, Vec<String>) {
    let shell = shell
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("/bin/zsh")
        .to_string();
    if elevated {
        ("sudo".to_string(), vec!["-s".to_string()])
    } else {
        (shell, vec!["-l".to_string()])
    }
}

/// Split a byte buffer into the longest valid UTF-8 prefix and an incomplete
/// trailing sequence to carry into the next read.
pub(super) fn split_utf8(buf: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(buf) {
        Ok(text) => (text.to_string(), Vec::new()),
        Err(err) => {
            let valid = err.valid_up_to();
            match err.error_len() {
                None => (
                    String::from_utf8_lossy(&buf[..valid]).into_owned(),
                    buf[valid..].to_vec(),
                ),
                Some(_) => (String::from_utf8_lossy(buf).into_owned(), Vec::new()),
            }
        }
    }
}

fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub(super) fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: String,
    elevated: bool,
    rows: u16,
    cols: u16,
) -> Result<u64, String> {
    let cwd = validated_terminal_cwd(&cwd)?;
    let pair = native_pty_system()
        .openpty(pty_size(rows, cols))
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let (program, args) = shell_invocation(elevated, std::env::var("SHELL").ok().as_deref());
    let mut command = CommandBuilder::new(program);
    command.args(args);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to start shell: {e}"))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to read from PTY: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to write to PTY: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?
        .insert(
            id,
            Session {
                master: pair.master,
                writer,
                child,
            },
        );

    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&chunk[..n]);
                    let (text, rest) = split_utf8(&carry);
                    carry = rest;
                    if !text.is_empty() {
                        let _ = app.emit(&format!("terminal-data-{id}"), text);
                    }
                }
            }
        }
        let _ = app.emit(&format!("terminal-exit-{id}"), ());
    });

    Ok(id)
}

#[tauri::command]
pub(super) fn terminal_write(
    state: State<'_, TerminalState>,
    id: u64,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?;
    let session = sessions.get_mut(&id).ok_or("Terminal session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to terminal: {e}"))
}

#[tauri::command]
pub(super) fn terminal_resize(
    state: State<'_, TerminalState>,
    id: u64,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?;
    let session = sessions.get(&id).ok_or("Terminal session not found")?;
    session
        .master
        .resize(pty_size(rows, cols))
        .map_err(|e| format!("Failed to resize terminal: {e}"))
}

#[tauri::command]
pub(super) fn terminal_close(state: State<'_, TerminalState>, id: u64) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?
        .remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_rejects_empty_and_relative() {
        assert!(validated_terminal_cwd("").is_err());
        assert!(validated_terminal_cwd("  ").is_err());
        assert!(validated_terminal_cwd("relative/dir").is_err());
    }

    #[test]
    fn cwd_rejects_missing_and_files() {
        assert!(validated_terminal_cwd("/definitely/not/here-disk-map").is_err());
        let file = std::env::temp_dir().join("disk-map-terminal-cwd-file");
        std::fs::write(&file, b"x").unwrap();
        let result = validated_terminal_cwd(file.to_str().unwrap());
        std::fs::remove_file(&file).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn cwd_accepts_directory() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        assert_eq!(validated_terminal_cwd(dir.to_str().unwrap()).unwrap(), dir);
    }

    #[test]
    fn shell_is_login_shell_when_not_elevated() {
        let (program, args) = shell_invocation(false, Some("/bin/bash"));
        assert_eq!(program, "/bin/bash");
        assert_eq!(args, vec!["-l"]);
    }

    #[test]
    fn shell_falls_back_when_unset() {
        assert_eq!(shell_invocation(false, None).0, "/bin/zsh");
        assert_eq!(shell_invocation(false, Some(" ")).0, "/bin/zsh");
    }

    #[test]
    fn elevated_uses_sudo_shell() {
        let (program, args) = shell_invocation(true, Some("/bin/bash"));
        assert_eq!(program, "sudo");
        assert_eq!(args, vec!["-s"]);
    }

    #[test]
    fn utf8_split_carries_partial_sequence() {
        let bytes = "aé".as_bytes(); // 'é' is 2 bytes
        let (text, rest) = split_utf8(&bytes[..2]);
        assert_eq!(text, "a");
        assert_eq!(rest, vec![bytes[1]]);
        let mut joined = rest;
        joined.push(bytes[2]);
        assert_eq!(split_utf8(&joined), ("é".to_string(), Vec::new()));
    }

    #[test]
    fn utf8_split_replaces_invalid_bytes() {
        let (text, rest) = split_utf8(&[b'a', 0xFF, b'b']);
        assert_eq!(text, "a\u{FFFD}b");
        assert!(rest.is_empty());
    }

    #[test]
    fn pty_runs_shell_in_requested_cwd() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let pair = native_pty_system().openpty(pty_size(24, 80)).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "pwd"]);
        command.cwd(&dir);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut output = String::new();
        let mut chunk = [0u8; 256];
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            output.push_str(&String::from_utf8_lossy(&chunk[..n]));
        }
        child.wait().unwrap();
        assert!(output.contains(dir.to_str().unwrap()), "got: {output}");
    }
}
