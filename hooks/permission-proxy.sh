#!/usr/bin/env bash
# Permission Proxy Hook for Claude Code Background Agents
#
# This PreToolUse hook intercepts Bash tool calls from background agents
# and delegates the permission decision to the VS Code extension UI.
#
# Foreground sessions pass through to the normal interactive prompt.
# Background agents get a file-based IPC flow:
#   1. Hook writes request to /tmp/claude-permissions/req-{uuid}.json
#   2. Extension shows VS Code notification with [Allow] [Deny] buttons
#   3. Extension writes decision to /tmp/claude-permissions/dec-{uuid}.json
#   4. Hook reads decision and returns it to Claude Code
#
# If no decision after TIMEOUT seconds, falls back to allowlist check.

set -euo pipefail

PERM_DIR="/tmp/claude-permissions"
TIMEOUT="${CLAUDE_PERM_TIMEOUT:-600}"
POLL_INTERVAL=0.3
ALLOWLIST_FILE="$PERM_DIR/allowlist.json"
SETTINGS_PATH="$HOME/.claude/settings.json"

# Read hook input from stdin
INPUT=$(cat)

# Extract fields via a single python call for performance
eval "$(/usr/bin/python3 -c "
import sys, json
d = json.load(sys.stdin)
tn = d.get('tool_name', '')
aid = d.get('agent_id', '')
sid = d.get('session_id', '')
tuid = d.get('tool_use_id', '')
ti = d.get('tool_input', {})
if isinstance(ti, str):
    ti = json.loads(ti)
cmd = ti.get('command', '')
# Shell-safe quoting
def sq(s):
    return \"'\" + s.replace(\"'\", \"'\\\"'\\\"'\") + \"'\"
print(f'TOOL_NAME={sq(tn)}')
print(f'AGENT_ID={sq(aid)}')
print(f'SESSION_ID={sq(sid)}')
print(f'TOOL_USE_ID={sq(tuid)}')
print(f'COMMAND={sq(cmd)}')
" <<< "$INPUT" 2>/dev/null)" || {
  # If python fails, pass through
  exit 0
}

# Only intercept Bash calls
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Foreground sessions (no AGENT_ID): write a notification-only file and let
# Claude Code handle the approval itself. The PostToolUse cleanup hook will
# delete this file once the command completes or is denied.
if [ -z "$AGENT_ID" ]; then
  if [ -n "$TOOL_USE_ID" ]; then
    mkdir -p "$PERM_DIR"
    /usr/bin/python3 -c "
import json, sys, datetime
notify = {
    'tool_use_id': '$TOOL_USE_ID',
    'session_id': '$SESSION_ID',
    'command': sys.stdin.read(),
    'timestamp': datetime.datetime.now().isoformat()
}
with open('$PERM_DIR/notify-${TOOL_USE_ID}.json', 'w') as f:
    json.dump(notify, f)
" <<< "$COMMAND" 2>/dev/null || true
  fi
  exit 0
fi

# ── Early allowlist check ──
# If the command matches the allowlist, auto-allow without prompting.
# This enables "edit automatically" style workflows for safe commands.
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWED=$(/usr/bin/python3 -c "
import json, re, sys
try:
    with open('$ALLOWLIST_FILE') as f:
        patterns = json.load(f)
    cmd = sys.stdin.read()
    for p in patterns:
        if re.search(p, cmd):
            print('yes')
            sys.exit(0)
except Exception:
    pass
print('no')
" <<< "$COMMAND" 2>/dev/null || echo "no")

  if [ "$ALLOWED" = "yes" ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Allowlisted command"}}'
    exit 0
  fi
fi

# ── Check Claude Code settings for "edit automatically" (acceptEdits) mode ──
# Only auto-allow if the session is in "acceptEdits" mode AND the command
# matches an explicit Bash(...) allow rule from settings.json.
# This is conservative: both conditions must be true.
if [ -f "$SETTINGS_PATH" ]; then
  AUTO_ALLOW=$(/usr/bin/python3 -c "
import json, sys
try:
    with open('$SETTINGS_PATH') as f:
        settings = json.load(f)
    mode = settings.get('permissions', {}).get('defaultMode', 'default')
    # Only auto-allow in 'acceptEdits' (edit automatically) mode
    if mode != 'acceptEdits':
        print('no')
        sys.exit(0)
    # Check if command matches any explicit Bash allow patterns
    allow = settings.get('permissions', {}).get('allow', [])
    cmd = sys.stdin.read().strip()
    for rule in allow:
        if not rule.startswith('Bash('):
            continue
        pattern = rule[5:]  # strip 'Bash('
        if pattern.endswith(')'):
            pattern = pattern[:-1]
        # Handle wildcard suffix: 'Bash(git *)' matches 'git status'
        if pattern.endswith('*'):
            prefix = pattern[:-1]
            if cmd.startswith(prefix):
                print('yes')
                sys.exit(0)
        else:
            # Exact match
            if cmd == pattern:
                print('yes')
                sys.exit(0)
    print('no')
except Exception:
    print('no')
" <<< "$COMMAND" 2>/dev/null || echo "no")

  if [ "$AUTO_ALLOW" = "yes" ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-allowed: permissive mode + matching allow rule"}}'
    exit 0
  fi
fi

# ── Create permission request for VS Code extension ──
mkdir -p "$PERM_DIR"

REQ_ID=$(uuidgen 2>/dev/null || /usr/bin/python3 -c "import uuid; print(uuid.uuid4())")
REQ_FILE="$PERM_DIR/req-${REQ_ID}.json"
DEC_FILE="$PERM_DIR/dec-${REQ_ID}.json"

# Write request file (atomic: write to tmp then rename)
TMP_FILE="$PERM_DIR/.req-${REQ_ID}.tmp"
/usr/bin/python3 -c "
import json, sys, datetime
req = {
    'uuid': '$REQ_ID',
    'tool_name': '$TOOL_NAME',
    'command': sys.stdin.read(),
    'agent_id': '$AGENT_ID',
    'session_id': '$SESSION_ID',
    'timestamp': datetime.datetime.now().isoformat()
}
with open('$TMP_FILE', 'w') as f:
    json.dump(req, f)
" <<< "$COMMAND" 2>/dev/null
mv "$TMP_FILE" "$REQ_FILE"

# Poll for decision file
ELAPSED=0
while [ ! -f "$DEC_FILE" ]; do
  sleep "$POLL_INTERVAL"
  ELAPSED=$(echo "$ELAPSED + $POLL_INTERVAL" | bc)

  # Check if request file was removed (extension not running / cleanup)
  if [ ! -f "$REQ_FILE" ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Permission request was cancelled. Use Write/Edit/Read tools instead."}}'
    exit 0
  fi

  # Timeout reached
  if [ "$(echo "$ELAPSED >= $TIMEOUT" | bc)" -eq 1 ]; then
    rm -f "$REQ_FILE"
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Permission request timed out ('"$TIMEOUT"'s). User did not respond. Use Write/Edit/Read tools instead."}}'
    exit 0
  fi
done

# Decision file exists — read it
DECISION=$(/usr/bin/python3 -c "
import json
with open('$DEC_FILE') as f:
    d = json.load(f)
print(d.get('decision', 'deny'))
" 2>/dev/null || echo "deny")

# Clean up
rm -f "$REQ_FILE" "$DEC_FILE"

if [ "$DECISION" = "deny" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"User denied this Bash command. Use Write/Edit/Read tools instead, or rephrase the command."}}'
else
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${DECISION}\"}}"
fi