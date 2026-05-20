import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Auto-provisioning ──────────────────────────────────────────

const HOOK_DIR = path.join(os.homedir(), '.claude', 'hooks');
const HOOK_DEST = path.join(HOOK_DIR, 'permission-proxy.sh');
const CLEANUP_HOOK_DEST = path.join(HOOK_DIR, 'notify-cleanup.sh');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface ClaudeSettings {
  permissions?: { allow?: string[]; deny?: string[] };
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  [key: string]: unknown;
}

/**
 * Copies the bundled hook script to ~/.claude/hooks/ and ensures
 * ~/.claude/settings.json has the PreToolUse hook entry pointing there.
 */
export async function provisionPermissionHook(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<void> {
  try {
    const bundledHook = path.join(context.extensionPath, 'hooks', 'permission-proxy.sh');
    if (!fs.existsSync(bundledHook)) {
      log.appendLine('[PermProxy] Bundled hook not found — skipping provisioning');
      return;
    }

    // 1. Copy hook scripts to ~/.claude/hooks/
    if (!fs.existsSync(HOOK_DIR)) {
      fs.mkdirSync(HOOK_DIR, { recursive: true });
    }

    const bundledContent = fs.readFileSync(bundledHook, 'utf-8');
    const needsCopy = !fs.existsSync(HOOK_DEST) ||
      fs.readFileSync(HOOK_DEST, 'utf-8') !== bundledContent;
    if (needsCopy) {
      fs.writeFileSync(HOOK_DEST, bundledContent, { mode: 0o755 });
      log.appendLine(`[PermProxy] Hook script copied to ${HOOK_DEST}`);
    }

    const bundledCleanup = path.join(context.extensionPath, 'hooks', 'notify-cleanup.sh');
    if (fs.existsSync(bundledCleanup)) {
      const cleanupContent = fs.readFileSync(bundledCleanup, 'utf-8');
      const cleanupNeedsCopy = !fs.existsSync(CLEANUP_HOOK_DEST) ||
        fs.readFileSync(CLEANUP_HOOK_DEST, 'utf-8') !== cleanupContent;
      if (cleanupNeedsCopy) {
        fs.writeFileSync(CLEANUP_HOOK_DEST, cleanupContent, { mode: 0o755 });
        log.appendLine(`[PermProxy] Cleanup hook copied to ${CLEANUP_HOOK_DEST}`);
      }
    }

    // 2. Ensure settings.json has both hooks configured
    let settings: ClaudeSettings = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      } catch {
        log.appendLine('[PermProxy] Failed to parse settings.json — skipping hook registration');
        return;
      }
    }
    if (!settings.hooks) settings.hooks = {};

    // PreToolUse: permission-proxy.sh
    const preToolUse = settings.hooks.PreToolUse;
    if (preToolUse) {
      const existing = preToolUse.find(g =>
        g.matcher === 'Bash' &&
        g.hooks.some(h => h.command.includes('permission-proxy.sh'))
      );
      if (existing) {
        let changed = false;
        for (const h of existing.hooks) {
          if (h.command.includes('permission-proxy.sh') && h.command !== HOOK_DEST) {
            h.command = HOOK_DEST;
            h.timeout = 660;
            changed = true;
          }
        }
        if (!changed) {
          // PreToolUse already up to date — check PostToolUse below
        } else {
          fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
          log.appendLine('[PermProxy] Updated hook path to stable location');
        }
      } else {
        preToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_DEST, timeout: 660 }] });
      }
    } else {
      settings.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_DEST, timeout: 660 }] }];
    }

    // PostToolUse: notify-cleanup.sh (for foreground session notification cleanup)
    const postToolUse = settings.hooks.PostToolUse;
    const cleanupAlreadyRegistered = postToolUse?.some(g =>
      g.hooks.some(h => h.command.includes('notify-cleanup.sh'))
    );
    if (!cleanupAlreadyRegistered) {
      if (postToolUse) {
        const bashGroup = postToolUse.find(g => g.matcher === 'Bash');
        if (bashGroup) {
          bashGroup.hooks.push({ type: 'command', command: CLEANUP_HOOK_DEST, timeout: 10 });
        } else {
          postToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: CLEANUP_HOOK_DEST, timeout: 10 }] });
        }
      } else {
        settings.hooks.PostToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: CLEANUP_HOOK_DEST, timeout: 10 }] }];
      }
      log.appendLine('[PermProxy] PostToolUse cleanup hook registered');
    }

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    log.appendLine('[PermProxy] Hook registered in settings.json');
  } catch (e) {
    log.appendLine(`[PermProxy] Provisioning error: ${e}`);
  }
}
