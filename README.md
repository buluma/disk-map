# Disk Map

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![Tauri](https://img.shields.io/badge/Tauri-v2-orange.svg)
![License](https://img.shields.io/badge/License-TODO-yellow.svg)

> A Tauri v2 desktop storage scanner and cleanup tool inspired by DaisyDisk.

## Navigation

| Lines | Section |
|-------|---------|
| 1 | Title + Badges |
| 7 | Tagline |
| 9 | Description |
| 13 | Prerequisites |
| 19 | Installation |
| 25 | Usage |
| 31 | Features |
| 47 | Command Reference |
| 75 | Configuration |
| 82 | Development |
| 89 | Tests |
| 99 | Contributing |
| 105 | Changelog |
| 109 | Links |
| 113 | License |
| 117 | Credits |

## Description

Disk Map scans folders and mounted volumes, maps file and folder sizes recursively, previews items, and stages cleanup candidates. It surfaces hidden and purgeable space (macOS APFS) so you can see what is consuming a volume beyond the files you can browse.

It is a **staged-cleanup** tool: nothing is mutated until you commit the Collector. Items move to Trash or are permanently deleted only after explicit confirmation, with per-item risk checks that block irreversible actions on critical paths.

The frontend is React + TypeScript on Vite; all filesystem work runs in a Rust backend command invoked over Tauri's IPC. Long scans execute in a blocking thread pool (`spawn_blocking`) so the UI stays responsive and emits live progress events.

## Prerequisites

- **Runtime**: Node.js 20.19+ (or newer LTS)
- **Package manager**: Bun (version declared in `package.json`)
- **Rust**: `rustup` toolchain (stable)
- **Platform deps**: Tauri v2 macOS prerequisites (`webkit2gtk`/Xcode CLI equivalents). See [Tauri v2 setup](https://v2.tauri.app/start/prerequisites/).

## Installation

```bash
bun install --frozen-lockfile
```

The Rust backend is compiled by Tauri at `dev`/`build` time; no separate install step is required.

## Usage

```bash
bun run tauri dev      # launch the app in development
bun run tauri build    # produce a signed/unsigned desktop bundle
```

In-app: paste or pick a path, set max depth and exclude patterns, then **Scan**. Use the tree, largest-items, and file-type panels to find space hogs. Select items into the **Collector**, review risks, then commit to Trash or permanent delete.

## Features

- **Size accounting**: tree sizes are logical bytes; Unix allocated bytes deduplicate hard links. Shared APFS blocks and compression may still affect estimates.
- **Bounded tree retention**: deeper directories are scanned for totals and analytics without retaining their descendants.
- **Independent sessions**: select any scan session to view its own result; completion never changes the selection. Cleanup marks existing and overlapping scans stale and refreshes volume capacity.
- **Native cleanup guards**: both Trash and permanent deletion reject roots, critical directories, home and its ancestors, relative paths, and parent traversal; final symlinks are removed as links.
- **Recursive scan**: full directory size = sum of children; children sorted by size descending.
- **Display depth pruning**: backend clamps `max_display_depth` to `[1, 12]` (default `4`); deeper nodes keep their aggregated size but drop descendants from the payload.
- **Symlink-safe**: uses `symlink_metadata` so symlinks are reported as file-like leaf nodes and never traversed.
- **Exclude patterns**: case-insensitive substring match on name or full path; comma-separated from the UI.
- **Live progress**: `scan-progress` events every 250 entries; newer scan for the same root cancels the older one.
- **Hidden + purgeable space**: macOS APFS purgeable bytes via `diskutil`; `whole-volume unattributed usage estimate = volume.used − unique allocated file bytes`.
- **Staged Collector**: add/remove items, see summary + risk flags (missing, symlink, critical path, covered-by-parent). Permanent delete is blocked while any blocker risk exists.
- **Actions**: Reveal in Finder, Open, Quick Look preview, Move to Trash, Permanently delete, plus `list_volumes` and `reclaim_purgeable_space` (macOS).
- **Favorites**: persist starred scan roots under `disk-map:favorites` (deduped, survives restart).

## Command Reference

All commands are invoked from the frontend via `@tauri-apps/api/core` `invoke`. Commands live in `lib.rs`, `actions.rs`, and `volumes.rs`. The registration entry point is [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs); the registered handler list is the contract:

```bash
rg "(async )?fn (scan_directory|cancel_scan|reveal_in_finder|open_path|preview_path|move_to_trash|inspect_path|permanently_delete_path|list_volumes|get_purgeable_space|reclaim_purgeable_space)" src-tauri/src
```

| Command | Args | Returns | Purpose |
|---------|------|---------|---------|
| `scan_directory` | `path`, `max_display_depth?`, `excludes?`, `client_scan_id?` | `ScanResult` | Recursive size map + analytics |
| `cancel_scan` | — | — | Cancel all active scans (generation bump) |
| `reveal_in_finder` | `path` | `Result<(), String>` | Reveal in OS file manager |
| `open_path` | `path` | `Result<(), String>` | Open item in default app |
| `preview_path` | `path` | `Result<(), String>` | Quick Look (macOS) / open |
| `move_to_trash` | `path` | `Result<(), String>` | Move to Trash / Recycle Bin |
| `inspect_path` | `path` | `PathInspection` | `exists`/`isSymlink`/`isDir` |
| `permanently_delete_path` | `path` | `Result<(), String>` | Delete file or dir (guarded) |
| `list_volumes` | — | `Vec<VolumeInfo>` | Mounted volumes + capacity |
| `get_purgeable_space` | `path` | `Option<u64>` | APFS purgeable bytes |
| `reclaim_purgeable_space` | `path` | `Result<(), String>` | `tmutil thinlocalsnapshots` (macOS) |

`ScanResult` shape (camelCase over the wire): `root: DiskNode`, `allocatedBytes?`, `hardLinkDuplicates`, `largestFiles`, `fileTypes`, `skippedPaths`, `hiddenBytes?`, `purgeableBytes?`, `nodes`, `files`, `dirs`, `skipped`, `permissionDenied`, `errors`, `elapsedMs`. See [`src-tauri/REFERENCE.md`](src-tauri/REFERENCE.md) for every struct and constraint.

## Configuration

No env vars are read by the app. The bundle is configured in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json):

| Field | Value |
|-------|-------|
| `productName` | `Disk Map` |
| `identifier` | `com.shadowwalker.disk-map` |
| `version` | `0.1.0` |
| `app.windows[0]` | `1100 × 800`, title `Disk Map` |
| `build.devUrl` | `http://localhost:1420` |
| `bundle.targets` | `all` |

Capabilities are declared in [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json) (`core:default`, `opener:default`, `dialog:default`).

## Development

```bash
git clone https://github.com/buluma/disk-map.git
cd disk-map
bun install --frozen-lockfile
bun run tauri dev
```

## Tests

```bash
bun run test                                     # vitest (frontend utils/collector logic)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust scan engine + safety guards
```

verify: both suites must pass before a PR is mergeable.

## Contributing

1. Fork the repo.
2. Create a feature branch (`git checkout -b feature/my-thing`).
3. Commit changes (`git commit -am 'Add my thing'`).
4. Push (`git push origin feature/my-thing`).
5. Open a Pull Request. Ensure `bun run test` and `cargo test` pass.

## Changelog

See [Releases](https://github.com/buluma/disk-map/releases). (No `CHANGELOG.md` yet — TODO.)

## Links

- Repository: https://github.com/buluma/disk-map
- Issue tracker: https://github.com/buluma/disk-map/issues

## License

TODO — no `LICENSE` file present. Add one and update this section.

## Credits

Built with [Tauri v2](https://v2.tauri.app/) (Rust + React/TypeScript), inspired by DaisyDisk.
