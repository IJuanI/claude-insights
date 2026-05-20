import * as vscode from 'vscode';
import { PermissionRequest, BatchDecision } from './types';

let _activePanel: vscode.WebviewPanel | null = null;

/** Controller returned to the caller so it can notify the panel about external resolutions */
export interface BatchPanelController {
  /** Called when the inline lens widget resolves a uuid externally */
  notifyResolved(uuid: string, decision: 'allow' | 'deny'): void;
}

/**
 * Shows a webview panel with all pending commands at once.
 * Resolves with the per-command decisions when the user submits (or all items are externally
 * resolved). The panel stays open after decisions — it transitions to a "no pending commands"
 * state so the user doesn't lose context.
 * Resolves with 'dismissed' only when the user closes the panel without deciding.
 *
 * @param onController  Optional callback that receives a controller for sending external-resolution
 *                      events (e.g. when the inline lens widget approves a command while this
 *                      panel is open).
 */
export function showPermissionBatchPanel(
  context: vscode.ExtensionContext,
  items: { uuid: string; req: PermissionRequest }[],
  startTs: number,
  timeout: number,
  onController?: (ctrl: BatchPanelController) => void,
  focusBehavior: 'never' | 'idle' | 'always' = 'idle',
): Promise<BatchDecision | 'dismissed'> {
  const preserveFocus = focusBehavior === 'never';
  return new Promise(resolve => {
    let settled = false;
    const settle = (result: BatchDecision | 'dismissed') => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const title = items.length === 1 ? 'Allow command' : `Allow ${items.length} commands`;

    // Reuse existing panel if it exists and hasn't been disposed
    if (_activePanel) {
      try {
        _activePanel.title = title;
        _activePanel.reveal(vscode.ViewColumn.Active, preserveFocus);
      } catch {
        _activePanel = null;
      }
    }

    if (!_activePanel) {
      _activePanel = vscode.window.createWebviewPanel(
        'claudePermission',
        title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus },
        { enableScripts: true, retainContextWhenHidden: false },
      );

      _activePanel.onDidDispose(() => {
        _activePanel = null;
        settle('dismissed');
      });
    }

    // Provide the caller a controller for external-resolution notifications
    onController?.({
      notifyResolved(uuid, decision) {
        _activePanel?.webview.postMessage({ type: 'externalResolution', uuid, decision });
      },
    });

    const esc = (s: string) => s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const itemsJson = JSON.stringify(items.map(item => ({
      uuid: item.uuid,
      cmd: item.req.command.trim(),
      agent: item.req.agent_id.slice(0, 8),
      tool: item.req.tool_name,
    })));

    _activePanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
  .header { padding: 14px 20px 10px; border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1)); flex-shrink: 0; display: flex; align-items: baseline; gap: 12px; }
  .header h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .timeout { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .timeout.urgent { color: var(--vscode-charts-red, #f48771); }
  .commands { flex: 1; overflow-y: auto; padding: 12px 20px; display: flex; flex-direction: column; gap: 12px; }
  .cmd-card { border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1)); border-radius: 4px; overflow: hidden; }
  .cmd-card.decided-allow { border-color: var(--vscode-charts-green, #89d185); opacity: 0.6; }
  .cmd-card.decided-deny { border-color: var(--vscode-charts-red, #f48771); opacity: 0.6; }
  .cmd-meta { padding: 8px 12px; background: var(--vscode-sideBar-background, rgba(0,0,0,0.2)); display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .cmd-meta code { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground); }
  .cmd-meta .badge { margin-left: auto; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; }
  .badge-allow { background: rgba(137,209,133,0.2); color: var(--vscode-charts-green, #89d185); }
  .badge-deny { background: rgba(244,135,113,0.2); color: var(--vscode-charts-red, #f48771); }
  .cmd-body { padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.03)); border-left: 3px solid var(--vscode-charts-yellow, #d7ba7d); max-height: 200px; overflow-y: auto; }
  .cmd-actions { padding: 8px 12px; display: flex; gap: 6px; }
  .footer { padding: 12px 20px; border-top: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1)); flex-shrink: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .footer-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: auto; }
  button { padding: 5px 14px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .btn-allow { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-allow:hover { background: var(--vscode-button-hoverBackground); }
  .btn-deny { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-deny:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.15)); }
  .btn-bulk { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.15)); }
  .btn-bulk:hover { color: var(--vscode-foreground); }
  .btn-submit { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
  .btn-submit:hover { background: var(--vscode-button-hoverBackground); }
  .btn-submit:disabled { opacity: 0.5; cursor: default; }
  .no-pending { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 13px; }
  .no-pending-icon { font-size: 28px; }
</style></head>
<body>
  <div class="header">
    <h2 id="headerTitle">${items.length === 1 ? 'Allow this command?' : `Allow ${items.length} commands`}</h2>
    <span class="timeout" id="timeout">⏱ …</span>
  </div>
  <div class="commands" id="commands"></div>
  ${items.length > 1 ? `<div class="footer" id="footer">
    <button class="btn-bulk" onclick="decideAll('allow')">Allow all</button>
    <button class="btn-bulk" onclick="decideAll('deny')">Deny all</button>
    <button class="btn-submit" id="submitBtn" onclick="submit()">Confirm all</button>
    <span class="footer-hint">1 / Enter = allow all · 3 / Esc = deny all</span>
  </div>` : `<div class="footer" id="footer" style="display:none"></div>`}
  <script>
    const vscode = acquireVsCodeApi();
    const items = ${itemsJson};
    const startTs = ${startTs};
    const timeout = ${timeout};
    const decisions = {};

    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function render() {
      const container = document.getElementById('commands');
      container.innerHTML = items.map(function(item, i) {
        const d = decisions[item.uuid];
        const cardCls = d ? 'cmd-card decided-' + d : 'cmd-card';
        const badge = d ? '<span class="badge badge-' + d + '">' + (d === 'allow' ? '✓ Allow' : '✗ Deny') + '</span>' : '';
        return '<div class="' + cardCls + '" id="card-' + i + '">'
          + '<div class="cmd-meta">'
          + (items.length > 1 ? '<span>' + (i+1) + '/' + items.length + '</span>' : '')
          + '<code>' + esc(item.agent) + '</code>'
          + (item.tool !== 'Bash' ? '<span>· ' + esc(item.tool) + '</span>' : '')
          + badge
          + '</div>'
          + '<div class="cmd-body">$ ' + esc(item.cmd) + '</div>'
          + (d ? '' : '<div class="cmd-actions">'
          + '<button class="btn-allow" onclick="decide(' + i + ',\\'allow\\')">Allow</button>'
          + '<button class="btn-deny" onclick="decide(' + i + ',\\'deny\\')">Deny</button>'
          + '</div>')
          + '</div>';
      }).join('');
    }

    function showNoPending() {
      document.getElementById('commands').innerHTML =
        '<div class="no-pending"><span class="no-pending-icon">✓</span><span>All commands resolved — no pending approvals</span></div>';
      const footer = document.getElementById('footer');
      if (footer) footer.style.display = 'none';
      const timeoutEl = document.getElementById('timeout');
      if (timeoutEl) timeoutEl.style.display = 'none';
      document.getElementById('headerTitle').textContent = 'No pending commands';
    }

    function checkAllResolved() {
      if (items.every(function(item) { return !!decisions[item.uuid]; })) {
        const result = items.map(function(item) { return { uuid: item.uuid, decision: decisions[item.uuid] }; });
        vscode.postMessage({ type: 'decisions', result: result });
        showNoPending();
        return true;
      }
      return false;
    }

    function decide(i, d) {
      decisions[items[i].uuid] = d;
      if (items.length === 1) { checkAllResolved(); return; }
      render();
    }

    function decideAll(d) {
      items.forEach(function(item) { decisions[item.uuid] = d; });
      render();
    }

    function submit() {
      // Default undecided to 'allow'
      items.forEach(function(item) {
        if (!decisions[item.uuid]) decisions[item.uuid] = 'allow';
      });
      checkAllResolved();
    }

    // Timeout countdown
    function updateTimeout() {
      const rem = Math.max(0, Math.round(timeout - (Date.now() - startTs) / 1000));
      const el = document.getElementById('timeout');
      if (!el) return;
      const m = Math.floor(rem / 60), s = rem % 60;
      el.textContent = '⏱ ' + (m > 0 ? m + 'm ' : '') + s + 's';
      el.className = 'timeout' + (rem < 60 ? ' urgent' : '');
      if (rem <= 0) el.textContent = '⏱ timed out';
    }
    updateTimeout();
    setInterval(updateTimeout, 1000);

    // Keyboard shortcuts: Enter/1 = allow all, Esc/3 = deny all
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); decideAll('allow'); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); decideAll('deny'); submit(); }
      else if (e.key === '1' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); decideAll('allow'); submit(); }
      else if (e.key === '3' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); decideAll('deny'); submit(); }
    });

    // Listen for messages from the extension
    window.addEventListener('message', function(e) {
      const msg = e.data;
      if (msg && msg.type === 'focus') {
        document.body.setAttribute('tabindex', '-1');
        document.body.focus();
        var btn = document.querySelector('button');
        if (btn) btn.focus();
      } else if (msg && msg.type === 'externalResolution') {
        decisions[msg.uuid] = msg.decision;
        render();
        checkAllResolved();
      }
    });

    render();

    // Focus the first button so keyboard shortcuts (1/Enter/Esc) work immediately
    document.addEventListener('DOMContentLoaded', function() {
      var btn = document.querySelector('button');
      if (btn) btn.focus();
    });
    // Also try immediately in case DOMContentLoaded already fired
    (function() {
      var btn = document.querySelector('button');
      if (btn) { btn.focus(); return; }
      // Fallback: focus body so key events are captured
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
    })();
  </script>
</body></html>`;

    _activePanel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'decisions') {
        // Resolve the promise but do NOT dispose the panel — it already shows "no pending" state
        settle(msg.result as BatchDecision);
      }
    });

    // Auto-focus: delay to let the panel render before sending focus message.
    // Skip entirely when focusBehavior is 'never' so editor/terminal focus is untouched.
    if (!preserveFocus) {
      setTimeout(() => {
        try {
          _activePanel?.webview.postMessage({ type: 'focus' });
        } catch {}
      }, 100);
    }
  });
}

/** Format remaining seconds as "Xm XXs" or "Xs" */
export function formatRemaining(s: number): string {
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}m ${sec < 10 ? '0' : ''}${sec}s`;
  }
  return `${s}s`;
}
