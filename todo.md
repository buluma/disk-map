# DaisyDisk-Inspired Implementation TODO

## Scope
- [x] Implement: purgeable/hidden-space visibility, Quick Look preview, staged deletion (Collector), parallel scan orchestration, favorites.
- [x] Exclude: keyboard shortcuts, Multi-Touch gestures, drag-and-drop.

## Milestone Order
1. [x] Issue 1: Extend volume/scan models
2. [x] Issue 5: Add preview command (Quick Look)
3. [x] Issue 6: Replace direct Trash with Collector
4. [x] Issue 2: Add purgeable-space detection command
5. [x] Issue 3: Add hidden-space + purgeable UI block
6. [x] Issue 4: Update gauge math to include purgeable
7. [x] Issue 7: Add purgeable reclaim flow
8. [x] Issue 8: Improve parallel scan orchestration
9. [x] Issue 9: Add favorites (starred scan roots)
10. [x] Issue 10: Add tests and regression coverage

## Issue 1: Extend Volume/Scan Models
### Files
- [x] `src-tauri/src/lib.rs`
- [x] `src/App.tsx`

### Tasks
- [x] Add `purgeable_bytes: Option<u64>` to `VolumeInfo` (Rust).
- [x] Add `available_including_purgeable_bytes: u64` to `VolumeInfo` (Rust).
- [x] Add `hidden_bytes: Option<u64>` and `purgeable_bytes: Option<u64>` to `ScanResult` (Rust).
- [x] Add matching TypeScript fields for `VolumeInfo` and `ScanResult`.

### Acceptance
- [x] Builds on macOS and non-macOS.
- [x] Missing purgeable values render as `Unavailable` instead of erroring.

## Issue 2: macOS Purgeable Space Detection Command
### Files
- [x] `src-tauri/src/lib.rs`

### Tasks
- [x] Add `get_purgeable_space(path: String) -> Result<Option<u64>, String>`.
- [x] Primary source: `diskutil info -plist <mount>`.
- [x] Fallback: parse `diskutil info` plain-text output.
- [x] Return `Ok(None)` for unsupported platforms or unavailable data.
- [x] Register command in Tauri invoke handler.

### Acceptance
- [x] No panic on malformed command output.
- [x] Unit tests cover parser success and failure.

## Issue 3: Hidden Space + Purgeable UI Block
### Files
- [x] `src/App.tsx`
- [x] `src/App.css`

### Tasks
- [x] Add a "Hidden Space" section to scan results.
- [x] Show `hidden_bytes`.
- [x] Show `purgeable_bytes` as sub-item.
- [x] Show `other hidden/restricted = max(hidden_bytes - purgeable_bytes, 0)`.
- [x] Style to match existing summary panels.

### Acceptance
- [x] Section appears only on successful scan results.
- [x] Handles `undefined`/missing values cleanly.

## Issue 4: Disk Gauge Math Includes Purgeable
### Files
- [x] `src/App.tsx`

### Tasks
- [x] Base available display on `available_including_purgeable_bytes`.
- [x] Keep used/available math internally consistent.

### Acceptance
- [x] Percentages always clamped to `[0, 100]`.
- [x] No negative/NaN outputs in edge cases.

## Issue 5: Add Preview Command (Quick Look)
### Files
- [x] `src-tauri/src/lib.rs`
- [x] `src/App.tsx`

### Tasks
- [x] Add `preview_path(path: String) -> Result<(), String>`.
- [x] macOS: use Quick Look (`qlmanage -p` or equivalent).
- [x] non-macOS: fallback to current open behavior.
- [x] Add `Preview` action in:
- [x] `NodeView`
- [x] `TopLargest`
- [x] `GlobalLargestFiles`

### Acceptance
- [x] Preview works from all three UI entry points.
- [x] Failures show a user-visible error.

## Issue 6: Replace Direct Trash with Collector (Staged Delete)
### Files
- [x] `src/App.tsx`
- [x] `src/App.css`
- [x] `src-tauri/src/lib.rs` (no functional change expected initially)

### Tasks
- [x] Add `collectorItems` state (`path`, `name`, `size`, `isDir`).
- [x] Change row action from immediate `Trash` to `Collect`.
- [x] Add Collector panel with:
- [x] remove-item
- [x] clear-all
- [x] commit button: `Delete (Move to Trash)` with confirmation
- [x] Keep backend `move_to_trash` command as-is for first pass.

### Acceptance
- [x] No filesystem mutation before explicit confirmation.
- [x] Partial failures report per-item errors and preserve remaining items.

## Issue 7: Purgeable Reclaim Flow (macOS)
### Files
- [x] `src-tauri/src/lib.rs`
- [x] `src/App.tsx`

### Tasks
- [x] Add `reclaim_purgeable_space(path: String) -> Result<(), String>`.
- [x] Add reclaim button in Hidden Space panel.
- [x] Add confirmation text (duration + not-all-space-may-be-reclaimed caveat).
- [x] Poll purgeable value post-action and refresh UI.

### Acceptance
- [x] Button hidden/disabled on unsupported platforms.
- [x] UI stays responsive during reclaim and polling.

## Issue 8: Parallel Scan Orchestration
### Files
- [x] `src-tauri/src/lib.rs`
- [x] `src/App.tsx`

### Tasks
- [x] Preserve current cancel-by-newer behavior for same-target scans.
- [x] Add scan session identifiers for concurrent scans.
- [x] Add per-scan progress cards/list in UI.
- [x] Prevent duplicate active scan for identical root path.

### Acceptance
- [x] Different roots can scan concurrently.
- [x] Starting same-root scan deterministically replaces prior one.

## Issue 9: Favorites (Starred Scan Roots)
### Files
- [x] `src/App.tsx`
- [x] `src/utils.ts` (optional)

### Tasks
- [x] Add persisted favorites key: `disk-map:favorites`.
- [x] Add star/unstar action for current path.
- [x] Add one-click scan from favorites list.
- [x] Deduplicate favorites.

### Acceptance
- [x] Favorites persist across app restarts.
- [x] Duplicate favorites cannot be added.

## Issue 10: Tests + Regression Coverage
### Files
- [x] `src-tauri/src/lib.rs`
- [x] `src/utils.test.ts`
- [x] additional frontend test files as needed

### Tasks
- [x] Add purgeable parser tests.
- [x] Add hidden-space calculation tests.
- [x] Add reclaim command platform-guard tests.
- [x] Add Collector logic tests.
- [x] Add gauge math tests with purgeable present/absent.

### Acceptance
- [x] `npm test` passes.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes.

## Suggested Labels
- [x] `feature`
- [x] `macos`
- [x] `backend`
- [x] `frontend`
- [x] `ux`
- [x] `tests`
