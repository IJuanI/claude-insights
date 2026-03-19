# Claude Code - Better Usage

A VS Code extension that shows your [Claude Code](https://claude.ai/code) usage and rate limits directly in the status bar and sidebar, plus a real-time monitoring panel for background agents.

## Features

### Usage monitoring

- **Status bar** — at-a-glance usage with countdown to reset

  ![Status bar](https://raw.githubusercontent.com/IJuanI/claude-usage-bar/main/media/statusbar.png)

- **Hover tooltip** — per-limit breakdown with progress bars and activity stats

  ![Hover tooltip](https://raw.githubusercontent.com/IJuanI/claude-usage-bar/main/media/tooltip.png)

- **Sidebar panel** — full-detail view accessible from the Explorer, opens on status bar click

  ![Sidebar panel](https://raw.githubusercontent.com/IJuanI/claude-usage-bar/main/media/sidebar.png)

- **Auto-refresh** — polls on a configurable interval; multiple VS Code windows share a cache to avoid hammering the API
- **Smart warnings** — proactive notifications fired at startup, +1h, and +2h (max 3 per session):
  - **Session hot** — warns when session usage ≥ 80% with 1h+ until reset (you're burning through it fast)
  - **Weekly hot** — warns when weekly usage ≥ 80% with 24h+ until reset (may run out before it resets)
  - **Use it or lose it** — nudges when weekly usage < 60% with < 2 days until reset (unused capacity about to expire)

  ![Notification](https://raw.githubusercontent.com/IJuanI/claude-usage-bar/main/media/notification.png)
- **429 backoff** — automatically backs off for 5 minutes if rate-limited

### Background agent monitoring

Real-time panel for tracking Claude Code background agents (sidechain tasks).

- **Collapsible task cards** — each agent is shown as a card with status, model, description, and block count; click to expand and see full output
- **Live updates** — polls every 2s with incremental DOM updates (no page reloads), preserving scroll position, search input, and expand state
- **Session labels** — each task shows which session it belongs to
- **Search** — filter agents by description, ID, model, session name, or content (indexes tool calls, text blocks, and errors)
- **Status filter** — toggle between All / Active / Done
- **Grouped view** — when viewing multiple sessions, toggle between flat and grouped-by-session layout
- **Multi-session support** — select one or more sessions to monitor simultaneously; only sessions with background tasks are shown
- **Workspace picker** — switch between workspaces to monitor agents from different projects
- **Editor title icon** — appears next to Claude Code's own icon when background tasks are active; opens the agent panel as a side editor
- **Markdown rendering** — agent text output is rendered with headers, bold, italic, code blocks, lists, tables, and horizontal rules
- **Smart scrolling** — auto-scrolls to bottom for running tasks, locks when you scroll up; Start/End navigation buttons appear on hover
- **Debug mode** — toggle via command palette or `claudeUsageBar.debugMode` setting for development

### Session browser

A native tree view for browsing all Claude Code sessions across every workspace.

- **Workspace > Session > Agent hierarchy** — browse all workspaces, their sessions (with display names matching Claude Code), and background agents nested under each session
- **Cross-workspace visibility** — see sessions from all projects, not just the current workspace; current workspace is listed first
- **Quick search** — filter the tree by session name, ID, or agent status via the search icon in the view title
- **Deep content search** — search through the actual content of session messages and agent outputs across all workspaces (command palette: "Claude Sessions: Deep Search")
- **Live status** — running agents show a spinner icon; completed agents show a checkmark
- **Copy IDs** — right-click any session or agent to copy its ID to clipboard
- **Auto-refresh** — tree updates every 10 seconds to reflect new sessions and agent status changes

## What's shown

| Metric | Description |
|---|---|
| Current Session | 5-hour rolling window |
| Weekly · All Models | 7-day all-models limit |
| Weekly · Sonnet | 7-day Sonnet-specific limit |
| Extra Credits (Org) | Org-level add-on credits |
| Prompts today / this week | Counted from `~/.claude/history.jsonl` |

## Requirements

- Claude Code must be installed and signed in (credentials are read from the macOS Keychain or `~/.claude/.credentials.json`)
- macOS (Keychain credential reading), though the file fallback works cross-platform

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudeUsageBar.refreshInterval` | `60` | How often to refresh usage data (seconds) |
| `claudeUsageBar.debugMode` | `false` | Enable debug mode (always show agent icon, dev badge in toolbar) |

## How it works

**Usage:** Credentials are read directly from the Claude Code OAuth token stored locally — no additional sign-in required. Usage data is fetched from `api.anthropic.com/api/oauth/usage` and cached in `~/.claude/claude-usage-bar-cache.json` so multiple VS Code windows don't each make independent API calls.

**Background agents:** Session data is read from `~/.claude/projects/` JSONL files. Agent output files are discovered at `/tmp/claude-*/` task directories. The extension parses these incrementally using byte offsets to avoid re-reading completed content. Completion is detected via `stop_reason=end_turn` with a 30-second staleness heuristic.

## License

MIT
