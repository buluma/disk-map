# disk-map

`disk-map` is a Tauri v2 desktop starter app inspired by DaisyDisk.

It scans a directory and returns a recursive tree of file/folder sizes, then renders the result in an expandable React UI.

## Stack

- Tauri v2
- React + TypeScript (Vite)
- Rust backend command for filesystem scanning

## Features

- Tauri command: `scan_directory(path: String)`
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

- Depth limit: `4`
- Children sorted by `size` descending
- Uses `symlink_metadata` to avoid blindly following symlinks
- Skips unreadable files/folders without crashing
- Dark UI with:
  - path input
  - scan button
  - loading state
  - error state
  - expandable tree
  - human-readable sizes

## Project Structure

- Frontend: [`src/App.tsx`](/Users/shadowwalker/Documents/GitHub/disk-map/src/App.tsx)
- Frontend styles: [`src/App.css`](/Users/shadowwalker/Documents/GitHub/disk-map/src/App.css)
- Rust command: [`src-tauri/src/lib.rs`](/Users/shadowwalker/Documents/GitHub/disk-map/src-tauri/src/lib.rs)

## Prerequisites

- Node.js 18+ (or newer LTS)
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

## Notes

- This starter intentionally does **not** include delete functionality.
- It does **not** perform permanent file removal.
