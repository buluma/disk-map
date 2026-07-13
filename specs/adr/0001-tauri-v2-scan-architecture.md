# ADR 0001: Tauri v2 + Rust Scan Engine Architecture

- **Status**: Accepted
- **Date**: 2026-07-13
- **Deciders**: disk-map maintainers
- **Supersedes**: —

## Context

Disk Map is a desktop storage scanner/cleanup tool (DaisyDisk-inspired). It must:

1. Walk large, possibly unreadable, deeply nested directory trees without blocking the UI.
2. Never follow symlinks into cycles or off-volume targets.
3. Allow the user to abandon a slow scan and start a new one without orphaned work or crashes.
4. Report accurate recursive sizes, largest files, file-type breakdown, and (on macOS) hidden/purgeable space.
5. Stage deletions and refuse irreversible actions on critical paths.

A pure web app cannot safely traverse arbitrary local filesystems or call `tmutil`/`diskutil`. A native shell would lack a maintainable UI. We needed a thin native core with a web UI.

## Decision

Build on **Tauri v2**: a Rust backend exposing filesystem commands over IPC, with a React + TypeScript (Vite) frontend. Specifically:

1. **Rust backend command `scan_directory`** performs the recursive walk. No filesystem logic lives in the frontend.
2. **`spawn_blocking`** runs the walk off the async runtime so the UI thread and progress events stay live.
3. **`symlink_metadata`** (not `metadata`) is used throughout, so symlinks are leaf nodes and traversal never descends into them.
4. **Cancellation via a generation counter + active-scan registry** (`AppState`): a monotonic `cancel_generation` (`AtomicU64`) plus `active_scans: Mutex<HashMap<String, u64>>` keyed by canonicalized path. New same-root scans overwrite the registry entry; the older scan observes the mismatch and aborts. `cancel_scan` bumps the generation and clears the registry.
5. **Platform commands are `#[cfg(...)]`-guarded**; macOS-only features (`qlmanage`, `tmutil`, purgeable parsing) degrade to no-ops or fallbacks off-macOS rather than failing to compile.
6. **Staged Collector in the frontend** holds delete intent; `collectorRisks` (`src/utils.ts`) gates permanent delete on blocker severities. The backend only enforces the absolute floor (no empty path, no filesystem root).

## Constraints (consequences that are now load-bearing)

- `max_display_depth` is clamped to `[1, 12]`, default `4` (backend `unwrap_or(4).min(12)`).
- Children of every directory are sorted by `size` descending.
- `hidden_bytes = volume.used_bytes − scanned_size`, computed with saturating arithmetic (never negative).
- `skipped_paths` records at most the first 100 skipped entries.
- Purgeable parsing must **never panic** on malformed `diskutil` output (unit-tested).
- `permanently_delete_path` refuses empty paths and filesystem roots; everything else is the frontend's job.

## Alternatives Considered

| Option | Rejected because |
|--------|------------------|
| Electron + Node `fs` | Heavier runtime; same IPC model but larger attack surface and bundle; native shell calls still needed for `tmutil`. |
| Pure Rust GUI (e.g. `iced`) | More work for the rich, stateful cleanup UI; slower iteration on the Collector/favorites UX. |
| Frontend-driven walk via Tauri `#[command]` per entry | Per-file IPC overhead would dominate on large trees; no single cancellable unit. |
| Async recursive `tokio::fs` scan | Adds a tokio dependency to the backend and complicates the atomic cancel registry; `spawn_blocking` over std is sufficient and simpler. |

## Verification

The decision's invariants are enforced by Rust tests in `src-tauri/src/lib.rs`:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Key proofs (grep-verifiable):

- `grep -n "spawn_blocking" src-tauri/src/lib.rs` → walk is off the async runtime.
- `grep -n "symlink_metadata" src-tauri/src/lib.rs` → no symlink traversal.
- `grep -n "unwrap_or(4).min(12)" src-tauri/src/lib.rs` → depth clamp.
- `grep -n "children.sort_by" src-tauri/src/lib.rs` → size-descending order.
- `grep -n "Refusing to" src-tauri/src/lib.rs` → delete guards.

## Follow-ups

- If a second scan target type appears (e.g. network shares), extend `normalize_scan_key`, not the cancel model.
- Collector risk rules belong in `src/utils.ts`; promote any that must be backend-enforced into `permanently_delete_path`.
