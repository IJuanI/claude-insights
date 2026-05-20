# Client Webview (agentWebviewClient)

## Constraints

`src/agentWebviewClient/index.ts` is a `@ts-nocheck` vanilla JS IIFE. It runs inside a VS Code webview (browser sandbox).

- Cannot import Node modules or other source files
- Cannot be unit-tested directly — use HTML output assertions or source-level pattern checks
- Bundled separately by esbuild to `dist/agentWebviewClient.js`
- All shared formulas (token calc) must be inlined, matching `tokenCalc.ts`

## Initialization sequence

1. Server calls `_doRefresh()` → parses agent files → populates `_tasks` → calls `_render()`
2. `_render()` sets `webview.html` to the HTML shell (no task data embedded — `__PANEL_DATA__` only carries `initialTab`)
3. Client JS loads, runs the IIFE, sends `{ command: 'webviewReady' }` at the very end
4. Server receives `webviewReady` → calls `_sendInitData()` → sends `{ command: 'initData', tasks, conversation, ... }`
5. Client receives `initData` → calls `renderTasks()` + `renderConversation()`

**Important:** `_tasks` is populated in step 1 *before* the HTML is set in step 2, so `_sendInitData()` in step 4 always has current data. There is no window where `webviewReady` can arrive before `_tasks` is ready.

Subsequent updates arrive as `{ command: 'updateTasks' }` postMessages whenever a watched file changes (agent output file, conversation JSONL, or tasks dir).

## Task card rendering — the expand/collapse pattern

This is the most non-obvious design decision in the client. **Read this before debugging any card content issue.**

### How cards are built

`buildTaskCard(t)` creates the full card DOM element including the content div. The content is set as `innerHTML` using `t.blocksHtml` — the pre-rendered HTML from the server for the last 50 blocks. The content div is hidden by CSS until the card is `.expanded`.

### How cards are updated

`updateTaskCard(el, t)` patches an existing card incrementally:
- Always updates: status dot, time badge, block count, token line, pending tool blocks
- **Only when expanded** (`expandedTasks.has(agentId)`): appends new blocks to the content div

The "only when expanded" rule is intentional — it avoids DOM work for collapsed cards. But it means:
- If a card is built when the agent has 0 blocks, then the agent runs to completion while the card stays collapsed, the card content will be empty when the user first expands it.
- Fix: `toggleTask()` and `focusAgent()` call `updateTaskCard(el, task)` immediately on expand to backfill any missed blocks.

### Incremental block append (when expanded)

`updateTaskCard` finds the highest `data-block-idx` already in the DOM, then appends only the new block wrappers from `t.blocksHtml` that have a higher index. This means:
- Blocks are never re-rendered (no flicker, `<details>` open/close state preserved)
- New blocks always append at the bottom
- "Load more" (older blocks) is a separate code path (`loadMore()` → sends `expandBlockLimit` to server)

### Pending tool blocks

Tool calls that have no result yet are marked `data-pending="1"`. `updateTaskCard` replaces pending wrappers when a fresh version without `data-pending` arrives — this happens even for collapsed cards.

## Key functions

- `buildTaskCard(t)` — creates card DOM, content includes `t.blocksHtml` inline
- `updateTaskCard(el, t)` — patches card; only appends blocks when expanded
- `toggleTask(agentId)` — expand/collapse; calls `updateTaskCard` on expand to backfill content
- `focusAgent(agentId)` — switches to agents tab, expands card, calls `updateTaskCard` to backfill
- `renderTasks(tasks)` — reconciles the full task list (insert/update/remove/reorder)
- `renderConversation()` — renders conversation messages from `conversationHtmlArr`
- `updateRunningTasksBar(tasks)` — sticky bar showing running agents + background commands
- `formatElapsed(ms)` — `<1s` → ms, `<10s` → 1 decimal, `<60s` → whole seconds, etc.
- `timeAgo(ts)` — relative time: "2m ago", "1h ago"
- `pending-timer` class + `data-start-ts` attr — two intervals: 100ms (elapsed < 10s), 1s (elapsed ≥ 10s)

## Server-side rendering (AgentPanelProvider + serverRenderers.ts)

- `serializeTask(task)` — renders `blocksHtml` from `task.contentBlocks`, respects `expandedLimits` map (default 50 visible blocks). Has a render cache keyed by `(agentId, blockCount, visibleLimit)`.
- `_sendInitData()` — responds to `webviewReady`; sends full state including tasks, conversation, diagnostics, permissions
- `_render()` — sends `updateTasks` postMessage (or sets HTML shell on first call per view)
- `checkForUpdates()` — 1s poll: detects new sessions/dirs, sets up `fs.watch` watchers, triggers `refresh()` when new watchers are registered
- `_doRefresh()` — debounced 300ms; parses all agent files incrementally (offset-based), calls `_render()`

### Session and task discovery

- Running agents: `/private/tmp/claude-{uid}/{projectKey}/{sessionId}/tasks/agent-*.output`
- Completed agents: `~/.claude/projects/{projectKey}/{sessionId}/subagents/agent-*.jsonl`
- Conversation: `~/.claude/projects/{projectKey}/{sessionId}.jsonl`

`checkForUpdates()` (1s poll) discovers new tasks dirs and sets up `fs.watch` on them. Once a watcher exists, file changes drive all real-time updates.

## Testing approach

Since the IIFE isn't importable, regression tests use:
1. **Server-side data checks**: verify `serializeTask()` output has correct fields
2. **Source pattern assertions**: read the source file and assert/deny string patterns (e.g., verify "awaiting" doesn't appear as a singular pending label)
3. **HTML output checks**: render via server functions and check attributes/classes
