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
});
