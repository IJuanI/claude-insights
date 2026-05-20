#!/usr/bin/env bash
# PostToolUse hook: cleans up foreground session notification files.
# When Claude Code finishes executing a Bash command (approved or denied),
# this hook deletes the corresponding notify-{tool_use_id}.json file so
# the VS Code extension removes the pending-approval indicator.

set -euo pipefail

PERM_DIR="/tmp/claude-permissions"

INPUT=$(cat)

TOOL_USE_ID=$(/usr/bin/python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_use_id', ''))
except Exception:
    print('')
" <<< "$INPUT" 2>/dev/null || echo "")

if [ -n "$TOOL_USE_ID" ]; then
  rm -f "$PERM_DIR/notify-${TOOL_USE_ID}.json" 2>/dev/null || true
fi

exit 0
