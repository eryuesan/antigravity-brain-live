# Changelog

All notable changes to **Brain Live (`antigravity-brain-live`)** will be documented in this file.

## [1.6.0] - 2026-11-24

### Added
- Real-time Antigravity native Sidecar panel (`AUX_PANE` + `SIDEBAR`) tracking `transcript_full.jsonl` via 0.8s ETag-cached polling.
- Automatic expansion & highlight of newly arrived thinking blocks, plus one-click copy, search highlighting, and Thinking / All / Errors filters.
- Compact Context Window usage bar (`%`, `used / limit`, color-coded threshold) reading Antigravity's per-conversation `executor_metadata` limit from local SQLite.
- Sticky Turn headers (`position: sticky`) with high-contrast styling so the active question stays pinned while scrolling.
- Fixed dark neutral charcoal theme with pure white body text, semantic highlight colors for badges/code/bold/tools, and subtle luminous hover border glow.
- Automated parser unit tests (`tests/parser.test.mjs`) and GitHub Actions CI workflow.
