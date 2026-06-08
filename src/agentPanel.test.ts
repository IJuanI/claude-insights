import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural regression tests for AgentPanelProvider.
 *
 * AgentPanelProvider depends on the vscode API and can't be instantiated
 * in unit tests. These tests verify invariants by reading the source code
 * to catch regressions in ordering and control flow.
 */

const SOURCE = fs.readFileSync(
  path.join(__dirname, 'agentPanel', 'AgentPanelProvider.ts'),
  'utf-8',
);

describe('AgentPanelProvider structural invariants', () => {
  describe('openForSession race condition (regression)', () => {
    // BUG: openForSession previously called refresh() before openInEditor().
    // When the sidebar was not visible, refresh() bailed early at the
    // guard `if ((!this._view && !this._editorPanel))` because the editor
    // panel hadn't been created yet. Tasks were never loaded, and
    // openInEditor() then rendered an empty panel.
    //
    // FIX: openForSession now calls _ensureEditorPanel() before refresh()
    // so the editor panel exists when refresh runs.

    it('openForSession calls _ensureEditorPanel before refresh', () => {
      // Extract the openForSession method body
      const methodMatch = SOURCE.match(
        /openForSession\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m,
      );
      expect(methodMatch).not.toBeNull();
      const body = methodMatch![1];

      const ensureIdx = body.indexOf('_ensureEditorPanel');
      const refreshIdx = body.indexOf('this.refresh()');

      expect(ensureIdx).toBeGreaterThan(-1);
      expect(refreshIdx).toBeGreaterThan(-1);
      expect(ensureIdx).toBeLessThan(refreshIdx);
    });

    it('openForSession does NOT call openInEditor (which would double-render)', () => {
      const methodMatch = SOURCE.match(
        /openForSession\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m,
      );
      expect(methodMatch).not.toBeNull();
      const body = methodMatch![1];

      // Should use _ensureEditorPanel, not the full openInEditor
      expect(body).not.toContain('this.openInEditor()');
    });
  });

  describe('refresh guard', () => {
    it('_doRefresh is guarded by _refreshNow() try-catch wrapper', () => {
      // _refreshNow() should wrap _doRefresh() in try-catch so errors
      // are displayed in the panel instead of silently swallowed
      const refreshMatch = SOURCE.match(
        /\b_refreshNow\(\)\s*\{([\s\S]*?)^\s{2}\}/m,
      );
      expect(refreshMatch).not.toBeNull();
      const body = refreshMatch![1];

      expect(body).toContain('try');
      expect(body).toContain('_doRefresh');
      expect(body).toContain('catch');
    });

    it('refresh() debounces and delegates to _refreshNow()', () => {
      const refreshMatch = SOURCE.match(
        /\brefresh\(\)\s*\{([\s\S]*?)^\s{2}\}/m,
      );
      expect(refreshMatch).not.toBeNull();
      const body = refreshMatch![1];
      expect(body).toContain('_refreshNow');
    });
  });

  describe('render error handling', () => {
    it('_refreshNow() wraps _doRefresh in try-catch', () => {
      const renderMatch = SOURCE.match(
        /private _refreshNow\(\)\s*\{([\s\S]*?)^\s{2}\}/m,
      );
      expect(renderMatch).not.toBeNull();
      const body = renderMatch![1];

      expect(body).toContain('try');
      expect(body).toContain('catch');
      expect(body).toContain('_doRefresh');
    });
  });

  describe('session switch renders (chip + ctx% regression)', () => {
    // Root cause: when user clicked a session chip, switchConversation set _conversationSessionId
    // and called refresh(). _doRefresh checked `changed || convChanged` — both false (no files
    // changed, no watcher fired). So _render was never called and the client never received
    // updateTasks with the new activeChipSessionId or conversation. Fix: track
    // _lastRenderedConvSessionId and include convSessionChanged in the render condition.
    it('_doRefresh render condition includes convSessionChanged', () => {
      // Must compare _conversationSessionId against _lastRenderedConvSessionId
      expect(SOURCE).toContain('_lastRenderedConvSessionId');
      expect(SOURCE).toMatch(/convSessionChanged\s*=\s*this\._conversationSessionId\s*!==\s*this\._lastRenderedConvSessionId/);
    });

    it('convSessionChanged is included in the _render condition', () => {
      const match = SOURCE.match(/convSessionChanged[\s\S]{0,200}_render\(/);
      expect(match).not.toBeNull();
    });

    it('_render is called with convChanged || convSessionChanged when session switches', () => {
      // Passing convSessionChanged as the convChanged arg to _render forces full conv re-render
      expect(SOURCE).toMatch(/this\._render\(\s*convChanged\s*\|\|\s*convSessionChanged\s*\)/);
    });
  });

  describe('polling interval (freeze regression)', () => {
    // Root cause of intermittent Delete/Enter key freezes:
    // 1000ms poll interval = ~60 polls/min, each generating 2-3 log entries,
    // each immediately postMessage'd to the webview via the onEntry→postMessage
    // pipeline. The constant event loop pressure stalled document change handlers.
    // Fix: poll interval must be >= 5000ms; fs.watch handles real-time updates.
    it('discovery poll interval is at least 5000ms', () => {
      // Match the _pollTimer assignment specifically
      const match = SOURCE.match(/this\._pollTimer\s*=\s*setInterval\([^,]+,\s*([\d_]+)\s*\)/);
      expect(match).not.toBeNull();
      const intervalMs = parseInt(match![1].replace(/_/g, ''), 10);
      expect(intervalMs).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('logging in hot path (freeze regression)', () => {
    // getEffectiveSessions() is called on every poll tick.
    // It must NOT call this.log() unconditionally — every log() fires a
    // postMessage to the webview via the onEntry listener, creating ~80
    // postMessages/min at 1000ms intervals. Log only on actual changes.
    it('getEffectiveSessions does not contain unconditional this.log calls', () => {
      const methodMatch = SOURCE.match(
        /private getEffectiveSessions[\s\S]*?(?=\n  (?:private |public |\/\/))/,
      );
      expect(methodMatch).not.toBeNull();
      const body = methodMatch![0];
      // Count unconditional (not inside if/changed guard) log calls
      // Acceptable: zero or only inside conditional branches with debug guard
      const logCalls = (body.match(/this\.log\(/g) ?? []).length;
      expect(logCalls).toBe(0);
    });

    // checkForUpdates() is called on every poll tick.
    // It must NOT call this.log() unless something actually changed.
    it('checkForUpdates does not contain unconditional this.log calls outside change guards', () => {
      const methodMatch = SOURCE.match(
        /private checkForUpdates\(\)[\s\S]*?(?=\n  (?:private |public |\/\/))/,
      );
      expect(methodMatch).not.toBeNull();
      const body = methodMatch![0];
      const logCalls = (body.match(/this\.log\(/g) ?? []).length;
      expect(logCalls).toBe(0);
    });
  });

  describe('sync I/O on conversation JSONL (freeze regression)', () => {
    // The conversation JSONL file is stat'd synchronously in _doRefresh on every
    // fs.watch event (≥ every 300ms while Claude Code is active). When the OS
    // has the file locked for writing the stat blocks the extension host event
    // loop, causing 5+ second gaps in event processing.
    //
    // Fix: use a flag set in the watcher callback instead of re-stat'ing the file.
    // The watcher already tells us the file changed — no stat needed.

    it('_doRefresh does not call statSync on the conv watch path', () => {
      const match = SOURCE.match(/private _doRefresh\(\)[\s\S]*?(?=\n  private )/);
      expect(match).not.toBeNull();
      const body = match![0];
      // Must not contain statSync(_convWatchPath) — that's the redundant stat
      expect(body).not.toMatch(/statSync\s*\(\s*this\._convWatchPath/);
    });

    it('buildPanelInfo does not call statSync for mtime cache invalidation', () => {
      const match = SOURCE.match(/private buildPanelInfo\(\)[\s\S]*?(?=\n  private )/);
      expect(match).not.toBeNull();
      const body = match![0];
      // Must not contain statSync — use _convChanged flag instead
      expect(body).not.toMatch(/statSync/);
    });

    it('conv watcher callback sets _convFileChanged flag before calling refresh', () => {
      // The watcher should mark a flag so _doRefresh can detect the change without
      // issuing another stat call
      const watcherPattern = /fs\.watch\(jsonlPath[\s\S]{0,200}_convFileChanged[\s\S]{0,50}refresh/;
      expect(SOURCE).toMatch(watcherPattern);
    });

    it('_doRefresh has no unconditional this.log calls in the normal rendering path', () => {
      const match = SOURCE.match(/private _doRefresh\(\)[\s\S]*?(?=\n  private )/);
      expect(match).not.toBeNull();
      const body = match![0];
      // Allow zero log calls in _doRefresh — they all send postMessages to the webview
      const logCalls = (body.match(/this\.log\(/g) ?? []).length;
      expect(logCalls).toBe(0);
    });
  });
});
