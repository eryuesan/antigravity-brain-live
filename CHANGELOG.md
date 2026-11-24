# Changelog

All notable changes to **Brain Live (`antigravity-brain-live`)** will be documented in this file.

## [1.7.0] - 2026-11-24

### Added
- **Google 4-Color Rainbow Live Activity Card**: Detects live in-flight thinking, tool execution, and `/compact` compaction phases directly from the latest transcript step, displaying a flowing Google 4-color (`#4285F4`, `#EA4335`, `#FBBC05`, `#34A853`) breathing card with a live elapsed timer.
- **Organic 150 TPS Sequential Stream Engine**: Streams newly arrived thinking blocks and tool call descriptions in strict chronological order (thinking prose → tool name badge → streamed tool summary → token stats → next activity state) with blur-to-sharp word reveal, natural punctuation cadence, a glowing Google 4-color orb cursor, queued multi-step handoff (no premature skipping), a topbar `打字机` toggle, and click-to-reveal-all.
- **First-Class `/compact` & `CHECKPOINT` Support**: Keeps `/compact` turns visible in both **Thinking Only** and **All** views with dedicated `COMPACT #N` milestone cards showing before/after token savings (`379.6k → 25.7k`, `%` freed, summary size) and collapsible compaction summaries.
- **Real-Time Post-Compaction Context Meter Reset**: Immediately recalculates and drops the Context Window meter upon `CHECKPOINT` completion using the conversation's fixed prompt baseline + summary tokens (`~used / limit`), then snaps to exact API token counts on the next `PLANNER_RESPONSE`.

### Changed
- Upgraded transcript polling interval from `800ms` to `300ms` (with ETag short-circuiting) for snappier live responsiveness.
- Expanded automated unit test coverage (`tests/parser.test.mjs`) for live activity states and `/compact` context window resets.

## [1.6.0] - 2026-11-24

### Added
- Real-time Antigravity native Sidecar panel (`AUX_PANE` + `SIDEBAR`) tracking `transcript_full.jsonl` via 0.8s ETag-cached polling.
- Automatic expansion & highlight of newly arrived thinking blocks, plus one-click copy, search highlighting, and Thinking / All / Errors filters.
- Compact Context Window usage bar (`%`, `used / limit`, color-coded threshold) reading Antigravity's per-conversation `executor_metadata` limit from local SQLite.
- Sticky Turn headers (`position: sticky`) with high-contrast styling so the active question stays pinned while scrolling.
- Fixed dark neutral charcoal theme with pure white body text, semantic highlight colors for badges/code/bold/tools, and subtle luminous hover border glow.
- Automated parser unit tests (`tests/parser.test.mjs`) and GitHub Actions CI workflow.
