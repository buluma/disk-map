# disk-map

`disk-map` is a Tauri v2 desktop starter app inspired by DaisyDisk.

It scans a directory and returns a recursive tree of file/folder sizes, then renders the result in an expandable React UI.

## Stack

- Tauri v2
- React + TypeScript (Vite)
- Rust backend command for filesystem scanning

## Features

- Tauri command:
  - `scan_directory(path: String, max_display_depth?: number, excludes?: string[])`
- Recursive tree response shape:

```ts
{
  name: string,
  path: string,
  size: number,
  is_dir: boolean,
  children: DiskNode[]
}
```

- Scan response envelope:

```ts
{
  root: DiskNode,
  nodes: number,
  files: number,
  dirs: number,
  skipped: number,
  permissionDenied: number,
  errors: number,
  elapsedMs: number
}
```

- Full recursive size computation for accurate directory totals
- Optional max display depth from UI (`1..12`, default `4`)
- Children sorted by `size` descending
- Uses `symlink_metadata` to avoid blindly following symlinks
- Skips unreadable files/folders without crashing
- Optional exclude patterns from UI (comma-separated)
- New scan requests cancel older in-progress scans
- Rust scan runs in `spawn_blocking` to keep UI responsive
- Native folder picker (Tauri dialog plugin)
- Directory focus navigation + breadcrumb jumps (no rescan)
- Dark UI with:
  - path input
  - max depth input
  - exclude patterns input
  - scan button
  - loading state
  - error state
  - scan metrics bar
  - largest-items summary
  - tree filter
  - expandable tree
  - human-readable sizes

## Project Structure

- Frontend: [`src/App.tsx`](/Users/shadowwalker/Documents/GitHub/disk-map/src/App.tsx)
- Frontend styles: [`src/App.css`](/Users/shadowwalker/Documents/GitHub/disk-map/src/App.css)
- Rust command: [`src-tauri/src/lib.rs`](/Users/shadowwalker/Documents/GitHub/disk-map/src-tauri/src/lib.rs)

## Prerequisites

- Node.js 20.19+ (or newer LTS)
- Rust toolchain (`rustup`)
- Tauri platform dependencies for macOS

## Install

```bash
npm install
```

## Run (Development)

```bash
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Tests

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## Notes

- This starter intentionally does **not** include delete functionality.
- It does **not** perform permanent file removal.
