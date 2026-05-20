# Claude Lens

Claude Lens is the real-time monitoring panel for Claude Code sessions. It provides a unified view of background agents, conversation history, and approval workflows.

## Opening the panel

| Method | How |
|--------|-----|
| Sidebar | Activity Bar > Claude Sessions > Claude Lens |
| Editor panel | Command Palette: `Claude Lens`, or click the Claude icon in the editor title bar |
| Session tree | Click any session or agent in the Session Browser |

The editor panel gives you more screen space and persists across window reloads. The editor title icon only appears when background agents are active (`claudeCodeInsights.hasBackgroundAgents` context).

---

## Agents tab

![Agents panel](https://raw.githubusercontent.com/IJuanI/claude-insights/main/media/agents-panel.png)

### Running tasks bar

The blue bar below the tab buttons shows all currently active work: background agents (with their description) and background commands (with the command text). Click any item to jump to its location — agents focus in the Agents tab, background commands scroll to the tool call in the Conversation tab.

### Task cards

Each background agent gets a collapsible card. The header row shows:

- **Status icon** — spinning dot (running), checkmark (completed), X (errored)
- **Description** — from the `description` field of the Agent tool call; falls back to the first 12 characters of the agent ID
- **Model badge** — e.g., `opus-4`, `sonnet-4`, `haiku-4`
- **Time** — relative time since the agent started (e.g., `12m ago`)
- **Block count** — total tool calls and text blocks

Below the header, each card shows the agent ID with a copy button, a "View prompt" link, and optional token usage stats.

### Expanded card content

Expanding a card reveals the full agent output with these block types:

**Text blocks** — Full markdown rendering with headers, bold, italic, inline code, fenced code blocks (with language-based syntax detection), ordered and unordered lists, tables, and horizontal rules. Text blocks longer than 10 lines collapse with a "Show more" / "Show less" toggle.

**Tool call pairs** — Each tool call is a collapsible `<details>` element:
- **Header**: tool icon, tool name, one-line command preview, result status icon (checkmark/X/spinner), and line count for successful results
- **Body**: full input (formatted per tool type), result content, and optional file-open button for Edit/Write/NotebookEdit tools

Tool results longer than 2,000 characters are truncated with a "Show more" button. If the full content is under 20,000 characters, it's embedded in the DOM (hidden) for instant reveal; larger results are loaded on demand.

When 3 or more consecutive calls to the same tool appear, they're collapsed into a group header.

**Inline diffs** — `Edit` and `NotebookEdit` tool calls render a unified diff view:
- Removed lines in red with a `-` prefix
- Added lines in green with a `+` prefix
- 3 context lines around each change
- Collapsed unchanged sections show the skipped line count
- Hard cap of 120 rendered diff lines
- Edits where old + new lines exceed 200 total show a "too large to diff" summary with line counts instead

**Background command output** — Bash commands run with `run_in_background` show a live output section:
- Streams the last 8 KB of the command's output file
- Updates via `fs.watch` (debounced at 500 ms) with a 10-second polling fallback
- If the output file doesn't exist yet, retries every second (up to 10 times)
- Auto-completes after 5 minutes of no file changes
- Status badge transitions from "running" to "completed" when a matching task-notification arrives

**Typing indicator** — running agents display a pulsing animation at the bottom of their content area.

### Progressive loading

To keep the panel responsive, only the most recent 50 content blocks per agent are rendered initially. A "Load more" button at the top of the card loads 50 additional older blocks each time.

### Controls

**Search input** — Filters agents by description, ID, model, session name, or block content. Minimum query length is 2 characters. Debounced at 150 ms.

**Status filter buttons** — Three toggle buttons:
- **All** — show every agent
- **Active** — only running agents
- **Done** — completed and errored agents

**View mode** — When monitoring multiple sessions:
- **Flat** — all agents in a single list sorted by last activity
- **Grouped** — agents grouped under collapsible session headers, each showing a running-count badge

A "No matching agents" message appears when the filter/search combination yields zero results.

### Smart scrolling

- Running tasks auto-scroll to keep the latest output visible
- Scrolling up locks the position — auto-scroll won't pull you back down
- Scrolling back to the bottom re-enables auto-scroll
- **Start** and **End** navigation buttons appear when hovering over a task card

---

## Conversation tab

![Conversation panel](https://raw.githubusercontent.com/IJuanI/claude-insights/main/media/conversation-panel.png)

### Message rendering

Messages are pre-rendered as HTML on the extension side and delivered via `postMessage` for efficient updates. Only new messages are appended — no full re-renders.

**User messages** are classified before rendering:

| Classification | Trigger | Rendering |
|----------------|---------|-----------|
| Normal | Default | Standard message with markdown |
| Slash command | `<command-name>` tag | Badge with the command name (e.g., `/compact`) |
| Interrupted | Starts with `[Request interrupted by user` | "System" label with interrupt text |
| Context summary | Starts with "This session is being continued from a previous conversation" | Collapsible `<details>` block |
| Compaction | Contains "context compressed" or similar markers (< 500 chars) | System badge with `⊘ Context compacted` |
| System reminder | `<system-reminder>` with summary/compact keywords | System badge with `⊘ Context summarized` |
| Task notification | `<task-notification>` XML | Status badge (✓ completed, ✗ failed, ⟳ running), command name, exit code, optional "Load result" button |
| Command stdout | `<local-command-stdout>` tag | Monospace `<pre>` block |
| IDE context only | `<ide_opened_file>` with no remaining text | Hidden entirely |
| IDE context + text | `<ide_opened_file>` followed by real text | Only the text portion shown |
| System caveat | `<local-command-caveat>` | Hidden entirely |

**Assistant messages** include:

- **Model badge** — e.g., `opus-4`
- **Extended thinking** — shows "Extended thinking" indicator when `thinkingCount > 0` but content is redacted. Shows full thinking text in a collapsible `<details>` block with word count when content is available.
- **Inline tool calls** — same collapsible pair rendering as the Agents tab, including diffs, background command output, and "View agent" links for Agent tool calls
- **Token usage footer** — shows input tokens (`new`), cache read tokens (`cached`), cache write tokens (`saved`), and output tokens (`out`). Values >= 1,000 are formatted as K (e.g., `45.2K cached`). Only appears when `output_tokens > 0` to avoid duplicate counts from streaming chunks.

**Long messages** — text with more than 22 lines (20 + 2 tolerance) is collapsed with a CSS line clamp. A "Show more" bar at the bottom reveals the full text; "Show less" collapses it back.

**Continuation messages** — when two consecutive messages have the same role (e.g., assistant followed by assistant), the second omits the role header and renders with a `continuation` class to visually merge them.

### Pagination

The most recent 50 messages are rendered initially. Older messages load in batches of 50:
- **Manual**: click the "Load earlier messages" button at the top
- **Automatic**: enable the "Auto-load" toggle, then scroll to the top to trigger loading

### Navigation

- **Live indicator** — a green "Live" pill at the bottom appears when new messages are arriving in real time
- **Jump to bottom** — a floating button appears when scrolled more than a screenful away from the latest messages
- **Session chips** — when monitoring multiple sessions, chips below the tab bar let you switch which conversation is displayed; the active session is highlighted

### Scroll behavior

- New messages auto-append at the bottom
- If you're scrolled to the bottom, the view follows new messages (sticky scroll)
- If you've scrolled up, new messages don't move your viewport
- Scroll position is preserved across tab switches and re-renders
- `<details>` open/closed states are preserved across content updates

---

## Conversation search

The search bar at the top of the Conversation tab provides full-text search.

### Controls

- **Query input** — minimum 2 characters; debounced
- **Scope toggle** — `Workspace` searches current project only; `Global` searches all Claude Code workspaces
- **Match Case** button — toggle case-sensitive matching
- **Whole Word** button — toggle whole-word matching
- **Preview mode** — `Compact` shows one-line results; `Rich` shows 4 context lines around each match (up to 12 lines total if the text is short)

### Result types

Results are rendered per type with appropriate formatting:
- **User/assistant messages** — with role label and timestamp
- **Tool calls** — with tool icon, tool name, and input preview
- **Tool output** — with context window (4 lines before and after the match, max 12 lines)
- **Task notifications** — with status badge and command name
- **Slash commands** — with command badge
- **Stdout** — monospace formatting

Matches are highlighted with `<mark>` tags. Click any result to navigate to that message in the conversation view.

### Implementation

Search runs in a dedicated worker thread (`searchWorker.js`) to avoid blocking the UI. Results are capped at 200 per query. The extension caches the 10 most recent queries for instant re-queries.

After navigating to a result, a "Back to search" banner appears at the top of the conversation to return to search results.

---

## Diagnostics

The diagnostics system provides visibility into the extension's internal state for debugging and bug reporting.

### Summary line

Always visible in the header bar:
- Message count, agent count, JSONL file size
- Total tokens and estimated billed tokens
- **Context window badge** — color-coded percentage:
  - Green: < 50%
  - Yellow: 50-74%
  - Orange: 75-89%
  - Red: >= 90%

### Expanded panel

Toggle with the `i` button:

- **Stats** — task count, message count, active sessions, workspace path, DOM task count, JS error count
- **Health checks** — four checks with status dots:
  - **Message flow** — are new messages arriving?
  - **Webview responsiveness** — is the webview responding to pings?
  - **Task count sync** — do server-side and client-side task counts match?
  - **File watcher liveness** — are `fs.watch` watchers firing?
- **Live log** — scrollable feed of the last 50 events (500 max retained) with timestamps and severity levels
- **Error log** — captured JS errors (max 100 retained)

### Actions

- **Copy diagnostics** — exports the full state as JSON: configuration, health checks, log entries, errors, task state
- **Show logs** — opens the "Claude Lens" output channel with server-side logs
- **Clear** — resets the diagnostic log

---

## State preservation

The following state persists across tab switches, panel reloads, and content updates:

- Expanded/collapsed state of task cards
- Open/closed state of all `<details>` elements (tool calls, diffs, etc.)
- Current status filter (All/Active/Done) and search query
- Active tab (Agents/Conversation)
- View mode (Flat/Grouped)
- Scroll position in both tabs
- Conversation search scope, query, match options, and preview mode
- Webview state survives tab switches via `vscode.setState`/`getState`
