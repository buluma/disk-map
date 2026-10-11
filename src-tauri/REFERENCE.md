# Scan Engine & Tauri Command Reference

Command registration is in `src-tauri/src/lib.rs`; scanner, filesystem actions, and volume queries live in `scanner.rs`, `actions.rs`, and `volumes.rs`. Frontend types mirror these in `src/types.ts` and `src/utils.ts`. If the Rust and this doc disagree, the Rust is the source of truth and this doc is wrong — fix this doc.

verify: `rg "#\[tauri::command\]" src-tauri/src` → expect `11` matches.

---

## 1. Invocation Model

Every command is registered in `run()` via `tauri::generate_handler!`. There is **no** HTTP/CLI surface — only Tauri IPC.

verify: `grep -n "generate_handler!" src-tauri/src/*.rs`

State is shared via `manage(AppState { next_scan_id, active_scans, cancel_generation })`, all `Arc<…>` wrapped. `scan_directory` takes `State<'_, AppState>`.

---

## 2. Data Structures (camelCase over the wire)

| Struct | Fields | Notes |
|--------|--------|-------|
| `DiskNode` | `name, path, size: u64, is_dir: bool, children: Vec<DiskNode>` | Tree node. Leaf when `children` empty. |
| `ScanResult` | `root, allocatedBytes?, hardLinkDuplicates, largestFiles, fileTypes, skippedPaths, hiddenBytes?, purgeableBytes?, nodes, files, dirs, skipped, permissionDenied, errors, elapsedMs` | Top-level scan envelope. |
| `LargestFile` | `name, path, size, parentPath` | Up to 100 entries, sorted desc. |
| `FileTypeStat` | `kind, bytes, files` | `kind` = lowercase extension or `"(no extension)"`. |
| `SkippedPath` | `path, reason` | `reason` ∈ {`Excluded`, `Permission denied`, `Filesystem error`}. Max 100 recorded. |
| `VolumeInfo` | `name, path, totalBytes, usedBytes, availableBytes, availableIncludingPurgeableBytes, purgeableBytes?` | From `df -kP` + `diskutil`. |
| `PathInspection` | `exists, isSymlink, isDir` | `isDir` is false for symlinks. |
| `ScanProgress` | `clientScanId, rootPath, entriesScanned, dirsScanned, bytesAccumulated, elapsedMs` | Emitted as event `scan-progress`. |

verify: `grep -n "struct ScanResult\|struct DiskNode\|struct VolumeInfo\|struct PathInspection" src-tauri/src/*.rs`

---

## 3. `scan_directory` — the core contract

Signature (async command):

```rust
async fn scan_directory(
    path: String,
    max_display_depth: Option<usize>,
    excludes: Option<Vec<String>>,
    client_scan_id: Option<u64>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String>
```

### Constraints (all must hold; these are the design's invariants)

1. **Depth clamp**: `display_depth = max_display_depth.unwrap_or(4).clamp(1, 12)`. Effective range `[1, 12]` with default `4`. The frontend additionally clamps with `clampDepth` to `[1, 12]` in [`src/utils.ts`](src/utils.ts).
   verify: `grep -n "unwrap_or(4).clamp(1, 12)" src-tauri/src/*.rs`
2. **Exclude normalization**: patterns are `trim()` + `to_lowercase()` + dropped if empty. Match is case-insensitive substring on **filename OR full path**.
   verify: `grep -n "to_lowercase()" src-tauri/src/lib.rs | head`
3. **Symlink safety**: `fs::symlink_metadata` is used (never `metadata`), so traversal never follows symlinks. A symlink node is emitted as `is_dir: false` leaf with no children.
   verify: `grep -n "symlink_metadata" src-tauri/src/*.rs`
4. **Children ordering**: each directory's `children` are `sort_by(|a, b| b.size.cmp(&a.size))` — descending by size.
   verify: `grep -n "children.sort_by" src-tauri/src/*.rs`
5. **Largest files**: cap `largest_limit = 100`; maintained as a bounded vector; final result re-sorted desc.
6. **Progress events**: emitted every 250 scanned entries and once at completion, tagged with `client_scan_id`. Event name `scan-progress`.
   verify: `grep -n "entries_scanned % 250" src-tauri/src/*.rs`
7. **Hidden math**: Only whole-volume scans return `hiddenBytes`: used volume bytes minus unique allocated file bytes, saturating at zero. This is an estimate; folder scans return `null`.
8. **Bounded retention preserves size**: `scan_path` traverses descendants for totals and analytics but retains children only below the display-depth limit. `prune_for_display` remains a test helper.
   verify: `grep -n "fn prune_for_display" src-tauri/src/*.rs`

### Execution

The walk runs inside `tauri::async_runtime::spawn_blocking` so the async runtime is not blocked. `scan_path` is recursive and re-checks cancellation before each directory entry.

---

## 4. Cancellation & Concurrency

Two mechanisms, both in `AppState`:

- **`cancel_generation: Arc<AtomicU64>`** — bumped by `cancel_scan()`. Any in-flight scan whose captured `cancel_generation_at_start` differs aborts with `ScanError::Canceled`.
- **`active_scans: Arc<Mutex<HashMap<String, u64>>`** — keyed by `normalize_scan_key` (canonicalized path). A new `scan_directory` for the same root overwrites the entry; `is_scan_canceled` returns true when the stored id no longer matches, so the older scan aborts.

Consequences:

- **Same root**: newest scan wins; older is canceled deterministically.
- **Different roots**: scan concurrently (separate keys, same generation).
- `cancel_scan()` cancels *everything* and clears `active_scans`.

verify: `grep -n "fn cancel_scan\|fn is_scan_canceled\|fn normalize_scan_key" src-tauri/src/*.rs`

---

## 5. Cleanup Commands (guards)

| Command | Guard | Refuses when |
|---------|-------|--------------|
| `move_to_trash` | native target validation + OS shell | critical/root/home/ancestor paths, relative or parent-traversal paths, missing target, or failed OS command |
| `permanently_delete_path` | same native target validation | same path protections as Trash |
| `reclaim_purgeable_space` | `#[cfg(target_os = "macos")]` only | no-op on non-macOS; uses `tmutil thinlocalsnapshots <selected-volume> 999999999999 4` |
| `preview_path` | `qlmanage -p` on macOS, else `open_path` | — |

`permanently_delete_path` deletes dirs via `remove_dir_all` and files via `remove_file`; it does **not** follow symlinks (uses `symlink_metadata`).

verify: `grep -n "Refusing to" src-tauri/src/*.rs`

> **Never** call `permanently_delete_path` with `/` — it is a hard refuse, not a best-effort guard. The frontend Collector provides early risk feedback; the Rust backend independently validates every cleanup target.

---

## 6. Volume & Purgeable Queries

- `list_volumes()`: discovers `/` + `/Volumes/*` (macOS), `SystemDrive` (Windows), `/mnt` + `/media` (Linux); dedupes by canonical mount path; sorts by path.
- `volume_info_for_path`: parses `df -kP` (columns 2–4 = total/used/avail KB; column 6 = mount). `availableIncludingPurgeableBytes = avail*1024 + purgeable`.
- `get_purgeable_space_for_path`: primary `diskutil info -plist` (parse `<integer>` after `Purgeable`), fallback `diskutil info` plain text; returns `Ok(None)` on non-macOS or unparseable output. **Never panics** on malformed output — both parsers are tested.

verify: `grep -n "fn volume_info_for_path\|fn get_purgeable_space_for_path\|parse_purgeable_bytes" src-tauri/src/*.rs`

---

## 7. Platform Matrix

| Capability | macOS | Windows | Linux |
|-----------|-------|---------|-------|
| `reveal_in_finder` | `open -R` | `explorer /select,` | `xdg-open` parent |
| `open_path` | `open` | `cmd /C start` | `xdg-open` |
| `preview_path` | `qlmanage -p` | `open_path` | `open_path` |
| `move_to_trash` | Finder `delete` | Recycle Bin | `gio trash` / `trash-put` |
| purgeable / reclaim | ✅ `diskutil`/`tmutil` | ❌ | ❌ |

---

## 8. Next Step

Add a behavioral spec under `specs/verifications/features/` when changing any invariant in §3. Run `cargo test --manifest-path src-tauri/Cargo.toml` after edits.

Logical tree/file sizes count each directory entry. Unix `allocatedBytes` sums `blocks * 512` once per device/inode and reports repeated aliases in `hardLinkDuplicates`. Non-Unix platforms return `null` for allocated bytes. Shared APFS blocks, compression, and snapshots limit interpretation.
