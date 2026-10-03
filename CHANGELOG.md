# Changelog

## 0.2.0 — 2026-10-03

- Independent scan sessions keep results, progress, and errors attached to their own scans. Selecting a session controls which result is displayed.
- Native cleanup guards reject critical directories, home and its ancestors, filesystem and mounted-volume roots, and invalid targets. The Collector rechecks items, prevents repeated submission, and handles overlapping selections once.
- Successful cleanup refreshes volume capacity and marks old or overlapping scan results as needing a rescan.
- Logical and allocated sizes are shown separately. Unix allocated accounting deduplicates hard links; unattributed-space estimates are limited to whole-volume scans.
- Deep scans retain only the configured display depth while continuing to aggregate totals and file analytics.
- Keyboard access, chart geometry, parent percentages, skipped-path explanations, and free-space labels are improved.
- Purgeable reclaim targets the selected volume. macOS parsers are omitted from other production builds to avoid unused-function warnings.
- CI tests the frontend and Rust backend, builds an ad-hoc signed universal macOS DMG, verifies its contents and architectures, and uploads a downloadable artifact.
- Rust filesystem, scanner, and volume responsibilities are split into modules; development and build commands consistently use Bun.

The macOS installer is not notarized or signed with an Apple Developer certificate. First launch may require **System Settings → Privacy & Security → Open Anyway**. Shared filesystem blocks, compression, and snapshots can affect allocated-space estimates.
