# Permission Proxy

The permission proxy gives you control over what background agents are allowed to execute, directly inside VS Code.

## How it works

When enabled, the extension installs a [Claude Code hook](https://docs.anthropic.com/en/docs/claude-code/hooks) that intercepts `Bash` tool calls from background agents. Instead of executing immediately, the hook writes a request file to `/tmp/claude-permissions/` and polls for a decision file. The extension picks up the request, shows an approval UI, and writes the decision.

```
Background Agent ──> PreToolUse hook ──> Writes req-{uuid}.json
                                                │
VS Code polls /tmp/claude-permissions/ (1s) ◄───┘
         │
         ├── Inline banner (agent panel visible)
         ├── Dedicated approval panel (keyboard-driven)
         ├── Status bar countdown (always visible)
         └── Quick pick (click status bar)
         │
Writes decision-{uuid}.json ──> Hook reads it ──> Allows or denies
```

Parallel requests are batched: the extension waits 400 ms to collect simultaneous requests before showing the notification. This avoids a flood of popups when an agent launches several commands at once.

## Approval surfaces

### Inline banner

When the Claude Lens panel is visible, pending commands appear as a banner at the top of both the Agents and Conversation tabs. Each item shows:

- Agent ID (first 8 characters)
- Tool name
- Command text
- Countdown timer
- **Allow** and **Deny** buttons for the first actionable item
- **Open panel** button to switch to the dedicated approval view
- **View agent** button to focus the requesting agent's card

### Dedicated approval panel

![Approval panel](https://raw.githubusercontent.com/IJuanI/claude-insights/main/media/approval-panel.png)

A full webview panel with a card for each pending command. Each card shows the agent ID, the full command text (with a yellow left border), and per-item Allow/Deny buttons. Already-decided items dim and show a green "Allow" or red "Deny" badge.

The panel auto-focuses on open — keyboard shortcuts work immediately without clicking:

| Key | Action |
|-----|--------|
| `1` or `Enter` | Allow all commands and submit |
| `3` or `Escape` | Deny all commands and submit |

For single-command requests, clicking Allow or Deny submits immediately. For multi-command batches, the footer shows "Allow all", "Deny all", and "Confirm all" buttons, plus the keyboard hint.

After submitting, the panel transitions to a "No pending commands" state rather than closing. This keeps it ready for the next batch without losing your editor layout.

### Status bar item

A shield icon (`$(shield)`) appears on the left side of the status bar when commands are pending. It shows:

- Agent ID
- Abbreviated command text
- Live countdown timer

Clicking opens a quick pick with:

| Action | Effect |
|--------|--------|
| **Allow** | Approve all pending commands |
| **Deny** | Deny all pending commands |
| **Review Each** | Open the dedicated approval panel |
| **View Agent** | Focus the requesting agent in Claude Lens |

### Foreground notifications

When `permissionProxy.interceptForegroundNotifications` is enabled, the extension also captures approval requests from the **foreground** Claude Code session — not just background agents. These appear as a separate banner in the agent panel with a dismiss button and auto-expire after 60 seconds.

## Bidirectional sync

Decisions made in any UI are propagated to all others:

- Allowing a command in the inline banner notifies the dedicated panel, which updates its card to show the "Allow" badge
- Submitting in the dedicated panel removes resolved items from the inline banner
- The status bar item updates or disappears as items are resolved

If all items are resolved externally (e.g., all approved via the inline banner while the dedicated panel is open), the panel automatically transitions to the "No pending commands" state.

## Timeout and backoff

Each request has a configurable timeout (default: 60 seconds). The countdown is visible in both the dedicated panel and the status bar item.

**When time runs out:**
1. The hook falls back to Claude Code's default behavior (allowlist-based permission resolution)
2. The UI shows the item as "timed out" for a 5-second grace period
3. After the grace period, the item is removed from all UIs

**Dismiss backoff:** If you close the notification without deciding, it reappears after an exponentially increasing delay: 5 seconds, then 15, 45, up to a maximum of 120 seconds.

**Display TTL:** Items that were allowed and are now executing (approved-and-running) are hidden from the UI after 60 seconds to keep the banner clean.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeCodeInsights.permissionProxy.enabled` | `true` | Enable/disable the permission proxy entirely |
| `claudeCodeInsights.permissionProxy.timeout` | `60` | Seconds before the hook falls back to Claude Code's allowlist |
| `claudeCodeInsights.permissionProxy.interceptForegroundNotifications` | `true` | Show foreground Claude Code approval requests in the panel |

## Hook installation

The hook is automatically provisioned on extension activation. Two scripts are copied to `~/.claude/hooks/`:

| Script | Hook type | Purpose |
|--------|-----------|---------|
| `permission-proxy.sh` | `PreToolUse` | Intercepts Bash commands from background agents, writes request files, waits for decisions |
| `notify-cleanup.sh` | `PostToolUse` | Cleans up notification files after tool execution completes |

The extension also adds the corresponding entries to `~/.claude/settings.json` under the `hooks` key. On each activation, it compares the bundled scripts with the installed versions and only overwrites if they differ.

The `PreToolUse` hook only activates for background agent sessions — it does not intercept commands from foreground Claude Code sessions or non-Bash tools.
