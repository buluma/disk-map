# Scan Engine Behavioral Features

These scenarios pin the invariants from `src-tauri/REFERENCE.md` §3–§5 and ADR 0001. They are grep-verifiable structure checks; each `Scenario` maps to a Rust test in `src-tauri/src/lib.rs` (the `#[cfg(test)] mod tests` block).

verify: `cargo test --manifest-path src-tauri/Cargo.toml` → all green.

---

## Feature: Recursive directory scanning

```gherkin
Feature: Recursive directory scanning
  The scanner must aggregate sizes bottom-up, order children by size,
  never traverse symlinks, honor excludes, and survive unreadable paths.

  Scenario: Directory size equals sum of descendant files
    Given a directory tree with nested files
    When scan_directory is called on the root
    Then the root node size is greater than or equal to the deepest leaf size
    And the deepest leaf contributes to every ancestor's size

  Scenario: Children are sorted by size descending
    Given a directory containing "small.txt" (1 byte) and "big.txt" (16 bytes)
    When scan_directory is called
    Then children[0].name is "big.txt"
    And children[1].name is "small.txt"

  Scenario: Symlinks are reported as leaf nodes
    Given a symlink "link.txt" pointing at "target.txt"
    When scan_directory is called
    Then node "link.txt" has is_dir false
    And node "link.txt" has no children

  Scenario: Exclude patterns skip matching paths
    Given a directory with "node_modules/pkg.txt" and "keep.txt"
    And excludes contain "node_modules"
    When scan_directory is called
    Then "node_modules" is absent from children
    And stats.skipped is at least 1

  Scenario: Unreadable directories are skipped without crashing
    Given a directory "private" with mode 0000 and a sibling "visible.txt"
    When scan_directory is called
    Then the scan returns Ok
    And "visible.txt" is present in the result

  Scenario: Display depth pruning keeps size but drops descendants
    Given a tree nested deeper than max_display_depth = 1
    When scan_directory is called with max_display_depth 1
    Then pruned.size equals full.size
    And pruned.children count is 1
    And pruned.children[0].children is empty
```

## Feature: Scan cancellation and concurrency

```gherkin
Feature: Scan cancellation and concurrency
  A newer scan for the same root must cancel the older one;
  different roots must run concurrently.

  Scenario: Newer same-root scan cancels the older
    Given an in-flight scan for root R
    When scan_directory is called again for root R
    Then the older scan returns Err "Scan canceled by a newer request"
    And only one entry remains in active_scans for R

  Scenario: Different roots scan concurrently
    Given root A and root B
    When scan_directory is called for A and for B
    Then both return Ok
    And active_scans contains an entry for A and for B

  Scenario: cancel_scan aborts everything
    Given one or more active scans
    When cancel_scan is invoked
    Then cancel_generation is incremented
    And active_scans is cleared
```

## Feature: Permanent delete safety

```gherkin
Feature: Permanent delete safety
  The backend enforces an absolute floor before any irreversible delete.

  Scenario: Refuses to delete the filesystem root
    When permanently_delete_path is called with "/"
    Then the result is Err

  Scenario: Refuses an empty path
    When permanently_delete_path is called with ""
    Then the result is Err

  Scenario: Deletes a regular file
    Given a file "delete-me.txt"
    When permanently_delete_path is called with its path
    Then the file no longer exists

  Scenario: Deletes a directory tree
    Given a directory "child" containing a file
    When permanently_delete_path is called with its path
    Then the directory no longer exists
```

## Feature: macOS purgeable space parsing

```gherkin
Feature: macOS purgeable space parsing
  Parsers must extract purgeable bytes without panicking on bad input.

  Scenario: Parse purgeable from diskutil plist
    Given plist text containing "APFSPurgeableSpace" integer 123456
    When parse_purgeable_bytes_from_plist is called
    Then the result is Some(123456)

  Scenario: Return None when no purgeable key exists
    Given plist text with only "TotalSize"
    When parse_purgeable_bytes_from_plist is called
    Then the result is None

  Scenario: Parse purgeable from diskutil plain text
    Given text "Purgeable Space: 12.4 GB (12400000000 Bytes)"
    When parse_purgeable_bytes_from_text is called
    Then the result is Some(12400000000)
```

## Next Step

After changing any invariant above, extend the matching Rust test in `src-tauri/src/lib.rs` and re-run `cargo test --manifest-path src-tauri/Cargo.toml` before merging.

  Scenario: Bounded display retention preserves deep file analytics
    Given a directory containing files deeper than the display depth
    When the directory is scanned with display depth 1
    Then deep descendants are absent from the returned tree
    And their logical bytes remain in directory totals and file-type analytics
    And their files remain eligible for the largest-file list

  Scenario: Hard links do not double-count allocated bytes
    Given two directory entries pointing to the same Unix device and inode
    When their directory is scanned
    Then logical bytes count both entries
    And allocated bytes count the inode once
    And one hard-link duplicate is reported

  Scenario: Folder scans do not claim volume-wide hidden usage
    Given a scan root below the volume mount point
    When the folder is scanned
    Then hidden bytes are unavailable

  Scenario: Scan completion preserves the selected session
    Given two scan sessions running concurrently
    And the second session is selected
    When the first session completes after the second
    Then the second session remains selected
    And both results remain attached to their own sessions
