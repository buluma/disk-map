# specs/ — Architecture Index

Single source of truth for disk-map's design decisions and behavioral contracts. Lower-level detail lives in the linked modules; do not duplicate sub-file lists here.

## Index

| Module | Pointer | What it owns |
|--------|---------|--------------|
| `adr/` | [ADR 0001](adr/0001-tauri-v2-scan-architecture.md) | Why Tauri v2 + Rust scan engine, cancellation model, delete guards |
| `verifications/features/` | [scan.feature](verifications/features/scan.feature) | Gherkin specs pinning scan/prune/cancel/delete invariants |

## Source of Truth (outside this dir)

- Backend contract: [`src-tauri/REFERENCE.md`](../src-tauri/REFERENCE.md) — structs, command signatures, constraints.
- Implementation: `src-tauri/src/lib.rs` — Rust is authoritative over all docs above.

## Verify

```bash
grep -c "ADR " adr/0001-tauri-v2-scan-architecture.md   # >= 1
grep -c "Scenario:" verifications/features/scan.feature # >= 10
cargo test --manifest-path ../src-tauri/Cargo.toml       # all green
```
