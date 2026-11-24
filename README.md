# Brain Live (`antigravity-brain-live`)

A zero-dependency native Sidecar plugin for **Google Antigravity** that renders your agent's full thinking blocks, tool call timelines, and compact context window usage in real time right inside the side pane.

一款零外部依赖的 **Google Antigravity** 原生 Sidecar 插件，可在右侧辅助面板中**步级实时展示**模型的完整思考过程、工具调用时间线与精简上下文占用进度条。

## Features / 核心特性

- **Per-Step Real-Time Thinking Feed (步级实时思考流)**: Watches local `transcript_full.jsonl` via 0.8s ETag-cached polling; newly arrived thinking blocks automatically expand and scroll into view.
- **Sticky Turn Headers (吸顶提问锚点)**: Keeps the current Turn prompt pinned at the top of the feed while scrolling through long reasoning chains so you always know which question is being solved.
- **Compact Context Window Meter (精简上下文占用条)**: Displays overall context usage (`%`, `used / limit`) and a color-coded progress bar aligned with Antigravity's per-conversation `executor_metadata` limit.
- **Refined Dark UI (深色语义高亮界面)**: Neutral dark-charcoal cards, luminous hover border glow, pure white body prose, semantic color badges (`THINK` / `RESULT` / `TOOL` / `ERROR`), and syntax highlights for inline code, bold terms, and tool names.
- **Zero Extra Tokens & Zero Dependencies (零额外 Token / 零外部依赖)**: Runs 100% locally on Node.js >= 22 (`node:sqlite` + Antigravity's built-in `sidecar_sdk`).
- **Search, Filter & Conversation Switcher**: Filter by **Thinking Only / Thinking + Tools / Errors**, search with live highlights, expand/collapse all, copy any thinking block in one click, or switch across the 25 most recent conversations.

## Installation / 安装方式

### Option 1: Copy into Antigravity Global Plugins Directory

Clone this repository into `~/.gemini/config/plugins/thinking-visualizer`:

**Windows (PowerShell):**
```powershell
git clone https://github.com/eryuesan/antigravity-brain-live.git "$env:USERPROFILE\.gemini\config\plugins\thinking-visualizer"
```

**macOS / Linux:**
```bash
git clone https://github.com/eryuesan/antigravity-brain-live.git ~/.gemini/config/plugins/thinking-visualizer
```

### Option 2: Antigravity CLI (`agy`)

```bash
agy plugin install https://github.com/eryuesan/antigravity-brain-live
```

### Opening the Panel / 打开面板

1. Restart Antigravity (or enable **Brain Live (Thinking Visualizer)** in **Skills & Customizations**).
2. Click **`+`** (`Ctrl+T` / `Cmd+T`) in the right auxiliary pane and choose **Brain Live**.
3. Right-click the tab → **Pin Tab** to keep it visible alongside your chat.

## Project Structure

```text
.
├── plugin.json
├── assets/
│   └── logo.svg
└── sidecars/
    └── live_thinking/
        ├── sidecar.json
        ├── package.json
        ├── main.mjs      # SidecarApp server + standalone HTTP fallback
        ├── parser.mjs    # Local JSONL transcript & SQLite limit parser
        ├── index.html
        ├── styles.css
        └── app.js
```

## Requirements

- Google Antigravity (Desktop App / IDE)
- Node.js >= 22 (for built-in `node:sqlite`)

## Credits

Inspired by [glaforge/antigravity-brain-visualizer](https://github.com/glaforge/antigravity-brain-visualizer) and [ahmetdotsh/agy-context](https://github.com/ahmetdotsh/agy-context).

## License

MIT
