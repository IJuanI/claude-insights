import * as vscode from 'vscode';
import * as os from 'os';
import {
  readCredentials,
  refreshToken,
  isTokenExpiredOrExpiringSoon,
  ClaudeCredentials,
} from './credentials';
import { fetchUsageData, UsageData } from './rateLimits';
import { getRecentSessionStats, getSessionUsageBreakdown } from './sessionUsage';
import {
  readSharedCache,
  writeSharedCache,
  CACHE_TTL_MS,
} from './cache';
import { getWebviewHtml } from './webview';
import { evaluateWarnings, evaluateContextBloat, freshWarningState } from './warnings';
import { getSessionTokenUsage, pathToProjectKey } from './agentParser';
import * as fs from 'fs';
import * as path from 'path';
import { AgentPanelProvider } from './agentPanel';
import { SessionTreeProvider, deepSearch } from './sessionTree';
import { SessionDocumentProvider, SESSION_SCHEME } from './sessionConversation';
import { PermissionProxyWatcher, provisionPermissionHook } from './permissionProxy';

const BACKOFF_429_MS = 5 * 60_000;


interface State {
  creds: ClaudeCredentials | null;
  usage: UsageData | null;
  lastFetch: number;
  lastFetchAt: Date | null;
  fetchError: string | null;
  backoffUntil: number;
}

class UsageViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'claudeCodeInsights.usageView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly state: State,
    private readonly onRefresh: () => Promise<void>,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'refresh') this.onRefresh();
    });
    this.update();
  }

  update() {
    if (!this._view) return;
    try {
      const stats = getRecentSessionStats();
      const sessionBreakdown = getSessionUsageBreakdown();
      this._view.webview.html = getWebviewHtml(
        this.state.usage,
        stats,
        this.state.fetchError,
        this.state.lastFetchAt ?? new Date(),
        sessionBreakdown,
      );
    } catch (e) {
      this._view.webview.html =
        `<!DOCTYPE html><html><body style="padding:8px;color:var(--vscode-foreground)">` +
        `Failed to render: ${e}</body></html>`;
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const state: State = {
    creds: null,
    usage: null,
    lastFetch: 0,
    lastFetchAt: null,
    fetchError: null,
    backoffUntil: 0,
  };

  const warned = freshWarningState();

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'claudeCodeInsights.openPanel';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── Token ─────────────────────────────────────────────────────
  async function ensureValidToken(): Promise<string | null> {
    state.creds = readCredentials();
    if (!state.creds) return null;
    if (isTokenExpiredOrExpiringSoon(state.creds)) {
      const refreshed = await refreshToken(state.creds);
      if (refreshed) state.creds = refreshed;
    }
    return state.creds.accessToken;
  }

  // ── Fetch ─────────────────────────────────────────────────────
  async function fetchAndUpdate(force = false) {
    const now = Date.now();

    const cached = readSharedCache();
    const cacheAge = cached ? now - cached.fetchedAt : Infinity;

    if (!force && cacheAge < CACHE_TTL_MS) {
      state.usage = cached!.usage;
      state.fetchError = cached!.error;
      state.lastFetch = cached!.fetchedAt;
      state.lastFetchAt = new Date(cached!.fetchedAt);
      state.backoffUntil = cached!.backoffUntil;
      return;
    }

    const backoff = Math.max(state.backoffUntil, cached?.backoffUntil ?? 0);
    if (now < backoff) {
      state.backoffUntil = backoff;
      // Still hydrate from cache so fresh instances show last-known good data
      if (cached?.usage && !state.usage) {
        state.usage = cached.usage;
        state.fetchError = cached.error;
        state.lastFetch = cached.fetchedAt;
        state.lastFetchAt = new Date(cached.fetchedAt);
      }
      return;
    }

    try {
      const token = await ensureValidToken();
      if (token) {
        state.usage = await fetchUsageData(token);
        state.fetchError = null;
        state.backoffUntil = 0;
      } else {
        state.fetchError = 'No credentials';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.fetchError = msg;
      if (msg.includes('429')) {
        state.backoffUntil = now + BACKOFF_429_MS;
      }
    }

    state.lastFetch = now;
    state.lastFetchAt = new Date(now);

    // Preserve last-known good usage when writing an error — don't overwrite
    // cached good data with null just because this fetch failed.
    const usageToCache = state.usage ?? cached?.usage ?? null;
    writeSharedCache({
      usage: usageToCache,
      error: state.fetchError,
      backoffUntil: state.backoffUntil,
      fetchedAt: now,
      session: null,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────
  function formatCountdown(d: Date): string {
    if (!d || isNaN(d.getTime())) return '';
    const ms = d.getTime() - Date.now();
    if (ms <= 0) return 'soon';
    const totalH = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    const days = Math.floor(totalH / 24);
    const h = totalH % 24;
    if (days > 0) return `${days}d ${h}h ${m}m`;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function formatResetLabel(d: Date): string {
    const cd = formatCountdown(d);
    return cd ? `resets in ${cd}` : '';
  }

  function pctColor(pct: number): string {
    if (pct >= 90) return '#f44747';
    if (pct >= 75) return '#d7ba7d';
    return '#4fc1ff';
  }

  const _barSrcCache = new Map<string, string>();
  function makeBarSrc(pct: number, fillColor: string): string {
    const p = Math.min(Math.max(pct, 0), 100);
    const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
    const cacheKey = `${p}:${fillColor}:${isDark ? 'd' : 'l'}`;
    const cached = _barSrcCache.get(cacheKey);
    if (cached) return cached;
    const track = isDark ? '#3a3a3a' : '#d0d0d0';
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 4">` +
      `<rect width="100" height="4" rx="2" fill="${track}"/>` +
      (p > 0 ? `<rect width="${p}" height="4" rx="2" fill="${fillColor}"/>` : '') +
      `</svg>`;
    const result = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    _barSrcCache.set(cacheKey, result);
    return result;
  }

  // ── Tooltip ───────────────────────────────────────────────────
  function buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    const u = state.usage;
    const stats = getRecentSessionStats();

    md.appendMarkdown(
      `<small><span style="color:var(--vscode-descriptionForeground);">CLAUDE CODE USAGE</span></small>\n\n`
    );

    if (u) {
      const rows: Array<{ label: string; pct: number; sub: string }> = [];

      if (u.fiveHour)
        rows.push({ label: 'Current Session', pct: Math.round(u.fiveHour.utilization), sub: formatResetLabel(u.fiveHour.resetsAt) });
      if (u.sevenDay)
        rows.push({ label: 'Weekly · All Models', pct: Math.round(u.sevenDay.utilization), sub: formatResetLabel(u.sevenDay.resetsAt) });
      if (u.sevenDaySonnet)
        rows.push({ label: 'Weekly · Sonnet', pct: Math.round(u.sevenDaySonnet.utilization), sub: formatResetLabel(u.sevenDaySonnet.resetsAt) });
      if (u.extraUsage?.isEnabled)
        rows.push({
          label: 'Extra Credits (Org)',
          pct: Math.round(u.extraUsage.utilization ?? 0),
          sub: u.extraUsage.usedCredits != null && u.extraUsage.monthlyLimit != null
            ? `${Math.round(u.extraUsage.usedCredits).toLocaleString()} / ${u.extraUsage.monthlyLimit.toLocaleString()} credits`
            : '',
        });

      for (const row of rows) {
        const color = pctColor(row.pct);
        md.appendMarkdown(
          `<table width="100%">` +
          `<tr><td>${row.label}</td>` +
          `<td width="40" align="right"><span style="color:${color};">${row.pct}%</span></td></tr>` +
          `<tr><td colspan="2"><img src="${makeBarSrc(row.pct, color)}" width="100%" height="4"></td></tr>` +
          (row.sub
            ? `<tr><td colspan="2"><small><span style="color:var(--vscode-descriptionForeground);">${row.sub}</span></small></td></tr>`
            : '') +
          `</table>\n\n`
        );
      }
    } else if (state.fetchError) {
      const is429 = state.fetchError.includes('429');
      const msg = is429
        ? `Rate limited — retrying in ${Math.ceil(Math.max(0, state.backoffUntil - Date.now()) / 60_000)}m`
        : state.fetchError;
      md.appendMarkdown(`<span style="color:var(--vscode-charts-red);">⚠ ${msg}</span>\n\n`);
    }

    md.appendMarkdown(`---\n\n`);

    md.appendMarkdown(
      `<table><tr>` +
      `<td width="110"><b>${stats.todayMessages}</b><br>` +
      `<small><span style="color:var(--vscode-descriptionForeground);">prompts today</span></small></td>` +
      `<td><b>${stats.weekMessages}</b><br>` +
      `<small><span style="color:var(--vscode-descriptionForeground);">this week</span></small></td>` +
      `</tr></table>\n\n`
    );

    md.appendMarkdown(`---\n\n`);

    const updated = state.lastFetchAt?.toLocaleTimeString() ?? '—';
    md.appendMarkdown(
      `<small><span style="color:var(--vscode-descriptionForeground);">Updated ${updated}</span></small>\n\n` +
      `[↻ Refresh](command:claudeCodeInsights.refresh)\n\n`
    );

    return md;
  }

  // ── Status bar ────────────────────────────────────────────────
  function renderStatusBar() {
    const u = state.usage;
    const parts: string[] = [];

    if (u?.fiveHour) {
      const pct = Math.round(u.fiveHour.utilization);
      const cd = formatCountdown(u.fiveHour.resetsAt);
      parts.push(cd ? `${pct}% in ${cd}` : `${pct}%`);
    }
    if (u?.sevenDay) {
      parts.push(`${Math.round(u.sevenDay.utilization)}%`);
    }

    statusBar.text =
      parts.length > 0 ? `$(hubot) ${parts.join(' | ')}` : `$(hubot) Claude`;
    statusBar.tooltip = buildTooltip();

    const pct = u?.fiveHour?.utilization ?? u?.sevenDay?.utilization ?? 0;
    statusBar.backgroundColor =
      pct >= 90
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : pct >= 75
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }

  function render() {
    renderStatusBar();
    viewProvider.update();
    if (state.usage) {
      for (const w of evaluateWarnings(state.usage, warned)) {
        if (w.level === 'warning') vscode.window.showWarningMessage(w.message);
        else vscode.window.showInformationMessage(w.message);
      }
    }

    // Context bloat detection — find the most recently modified session JSONL
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspacePath) {
      try {
        const projectKey = pathToProjectKey(workspacePath);
        const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);
        const entries = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        if (entries.length > 0) {
          let latestMtime = 0;
          let latestFile = '';
          for (const entry of entries) {
            const mtime = fs.statSync(path.join(projectDir, entry)).mtimeMs;
            if (mtime > latestMtime) { latestMtime = mtime; latestFile = entry; }
          }
          const sessionId = latestFile.replace(/\.jsonl$/, '');
          const tokenUsage = getSessionTokenUsage(workspacePath, sessionId);
          const bloatWarning = evaluateContextBloat(tokenUsage.avgCacheRead, sessionId, warned);
          if (bloatWarning) {
            vscode.window.showWarningMessage(bloatWarning.message, 'Continue in New Session', 'Dismiss').then(action => {
              if (action === 'Continue in New Session') {
                const term = vscode.window.createTerminal('Claude (new session)');
                term.show();
                term.sendText(`claude --resume ${sessionId}`);
              }
            });
          }
        }
      } catch {
        // Silently ignore — project dir may not exist or be unreadable
      }
    }
  }

  // ── Sidebar view ──────────────────────────────────────────────
  const viewProvider = new UsageViewProvider(state, async () => {
    statusBar.text = '$(sync~spin) Claude';
    await fetchAndUpdate(true);
    render();
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      UsageViewProvider.viewType,
      viewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Agent panel ─────────────────────────────────────────────
  const agentProvider = new AgentPanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentPanelProvider.viewType,
      agentProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push(agentProvider);

  // Restore editor panel across window reloads
  vscode.window.registerWebviewPanelSerializer('claudeCodeInsights.agentEditor', {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown) {
      panel.webview.options = { enableScripts: true };
      agentProvider.adoptDeserializedPanel(panel);
    },
  });

  // ── Permission proxy ───────────────────────────────────────────
  const permProxyEnabled = vscode.workspace.getConfiguration('claudeCodeInsights').get<boolean>('permissionProxy.enabled', true);
  if (permProxyEnabled) {
    provisionPermissionHook(context, agentProvider.getOutputChannel());
    const permProxy = new PermissionProxyWatcher(
      context,
      agentProvider.getOutputChannel(),
      () => agentProvider.getTrackedSessionIds(),
    );
    permProxy.setPushCallback(items => agentProvider.pushPendingPermissions(items));
    permProxy.setNotifyPushCallback(items => agentProvider.pushForegroundNotifications(items));
    permProxy.setPanelVisibleCallback(() => agentProvider.isPanelVisible());
    agentProvider.setPermProxy(permProxy);
    context.subscriptions.push(permProxy);

  }

  // ── Commands ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.openPanel', async () => {
      await vscode.commands.executeCommand('claudeCodeInsights.usageView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.refresh', async () => {
      statusBar.text = '$(sync~spin) Claude';
      await fetchAndUpdate(true);
      render();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.toggleDebug', async () => {
      const config = vscode.workspace.getConfiguration('claudeCodeInsights');
      const current = config.get<boolean>('debugMode', false);
      await config.update('debugMode', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Claude Lens debug mode: ${!current ? 'ON' : 'OFF'}`);
      agentProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.copyDebugInfo', async () => {
      const info = agentProvider.getDebugInfo();
      if (info) {
        const text = JSON.stringify(info, null, 2);
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('Diagnostics copied to clipboard');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.showAgentLogs', () => {
      agentProvider.showOutputChannel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.openAgents', () => {
      agentProvider.openInEditor();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.openSessionAgents', (wsPath: string, sessionId: string, agentId?: string) => {
      agentProvider.openForSession(wsPath, sessionId, agentId);
    })
  );

  // ── Session conversation viewer ──────────────────────────────
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      SESSION_SCHEME,
      new SessionDocumentProvider(),
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.openSessionConversation', async (wsPath: string, sessionId: string) => {
      const uri = vscode.Uri.parse(`${SESSION_SCHEME}:session.md?ws=${encodeURIComponent(wsPath)}&id=${encodeURIComponent(sessionId)}`);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        preview: true,
      });
      // Switch to markdown preview for nicer rendering
      await vscode.commands.executeCommand('markdown.showPreview');
    })
  );

  // ── Session tree (webview) ───────────────────────────────────
  const sessionTree = new SessionTreeProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeCodeInsights.sessionTree', sessionTree)
  );
  context.subscriptions.push({ dispose: () => sessionTree.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.searchSessions', async () => {
      type SearchItem = vscode.QuickPickItem & { _wsPath?: string; _sessionId?: string; _agentId?: string };
      const qp = vscode.window.createQuickPick<SearchItem>();
      qp.placeholder = 'Search sessions, agents, and conversations...';
      qp.value = sessionTree.getSearchQuery();
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;

      let debounceTimer: ReturnType<typeof setTimeout> | undefined;

      const updateItems = (value: string) => {
        qp.busy = true;
        if (!value.trim()) {
          qp.items = [{ label: '$(search) Type to search across all sessions', alwaysShow: true }];
          qp.busy = false;
          return;
        }
        const results = deepSearch(value, 30);
        qp.busy = false;
        if (results.length === 0) {
          qp.items = [{ label: '$(info) No results for "' + value + '"', alwaysShow: true }];
          return;
        }
        qp.items = [
          // First item: apply as tree filter
          { label: `$(filter) Filter tree by "${value}"`, alwaysShow: true, _wsPath: undefined, _sessionId: undefined },
          // Separator
          { label: 'Results', kind: vscode.QuickPickItemKind.Separator },
          ...results.map(r => {
            const icon = r.type === 'agent' ? '$(symbol-event)' : '$(comment-discussion)';
            const wsName = r.wsPath.split('/').filter(Boolean).pop() || r.wsPath;
            return {
              label: `${icon} ${r.type === 'agent' ? r.agentDescription : r.sessionName}`,
              description: wsName,
              detail: r.matchContext,
              _wsPath: r.wsPath,
              _sessionId: r.sessionId,
              _agentId: r.agentId,
              alwaysShow: true,
            } as SearchItem;
          }),
        ];
      };

      // Initial population
      updateItems(qp.value);

      qp.onDidChangeValue(value => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => updateItems(value), 150);
      });

      qp.onDidAccept(() => {
        const selected = qp.selectedItems[0];
        const query = qp.value.trim();
        qp.dispose();

        if (selected?._sessionId) {
          // Open the agent panel for all results (conversation tab for sessions, focused task for agents)
          agentProvider.openForSession(selected._wsPath!, selected._sessionId, selected._agentId);
          // Also filter the tree
          if (query) {
            sessionTree.search(query);
            vscode.commands.executeCommand('setContext', 'claudeCodeInsights.sessionSearchActive', true);
          }
        } else if (query) {
          // "Filter tree by" option or no selection — apply as tree filter
          sessionTree.search(query);
          vscode.commands.executeCommand('setContext', 'claudeCodeInsights.sessionSearchActive', true);
        }
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.clearSessionSearch', () => {
      sessionTree.clearSearch();
      vscode.commands.executeCommand('setContext', 'claudeCodeInsights.sessionSearchActive', false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.refreshSessions', () => {
      sessionTree.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.deepSearch', async () => {
      const query = await vscode.window.showInputBox({
        placeHolder: 'Search through session content...',
        prompt: 'Deep search across all session messages and agent outputs',
      });
      if (!query) return;

      const results = deepSearch(query);
      if (results.length === 0) {
        vscode.window.showInformationMessage(`No results for "${query}"`);
        return;
      }

      const items = results.map(r => {
        const icon = r.type === 'agent' ? '$(symbol-event)' : '$(comment-discussion)';
        const loc = r.wsPath.replace(os.homedir(), '~');
        return {
          label: `${icon} ${r.type === 'agent' ? r.agentDescription : r.sessionName}`,
          description: loc,
          detail: r.matchContext,
          result: r,
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"`,
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (picked) {
        // Copy session/agent ID and show in tree
        const r = picked.result;
        const id = r.type === 'agent' ? r.agentId! : r.sessionId;
        sessionTree.search(id);
        vscode.commands.executeCommand('setContext', 'claudeCodeInsights.sessionSearchActive', true);
        await vscode.commands.executeCommand('claudeCodeInsights.sessionTree.focus');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.copySessionId', (item: unknown) => {
      if (item && typeof item === 'object' && 'meta' in item) {
        const meta = (item as { meta: { sessionId: string } }).meta;
        vscode.env.clipboard.writeText(meta.sessionId);
        vscode.window.showInformationMessage('Copied session id');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeInsights.copyAgentId', (item: unknown) => {
      if (item && typeof item === 'object' && 'meta' in item && 'sessionId' in item) {
        const agentMeta = (item as { meta: { agentId: string }; sessionId: string });
        const fullPath = `${agentMeta.sessionId}/tasks/${agentMeta.meta.agentId}`;
        vscode.env.clipboard.writeText(fullPath);
        vscode.window.showInformationMessage('Copied agent path');
      }
    })
  );

  // ── Boot + polling ────────────────────────────────────────────
  async function tick() {
    await fetchAndUpdate(false);
    render();
  }

  tick();

  const config = vscode.workspace.getConfiguration('claudeCodeInsights');
  const intervalSecs = config.get<number>('refreshInterval', 60);
  const timer = setInterval(() => tick(), intervalSecs * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate() {}
