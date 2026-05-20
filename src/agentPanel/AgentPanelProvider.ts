import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentTask,
  TaskDetectionTrace,
  findCurrentSession,
  getTasksDir,
  getSubagentsDir,
  listAgentFiles,
  listSubagentFiles,
  parseAgentFile,
  findAgentDescriptions,
  findSessionsWithTasks,
  findActiveTaskSessions,
  getSessionDisplayName,
  parseSessionConversation,
  reconstructWsPath,
  pathToProjectKey,
  getSessionPermissionMode,
  countConversationTurns,
  getSessionLastContext,
} from '../agentParser';
import { getAgentPanelHtml, serializeTask, serializeConversation, renderConvMessageHtml, SerializedTask, PanelInfo, expandBlockLimit, ConversationMessage, DiagnosticInfo } from '../agentWebview';
import { PendingPermItem } from '../permissionProxy';
import { createDiagnosticLog, DiagnosticLog, HealthChecker } from '../diagnosticLog';
import { SearchCoordinator } from './searchCoordinator';
import { BgCommandWatcher } from './bgCommandWatcher';
import { MessageRouter } from './messageRouter';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'claudeCodeInsights.agentView';

  private _view?: vscode.WebviewView;
  private _tasks = new Map<string, AgentTask>();
  private _descriptions = new Map<string, string>();
  private _watchers = new Map<string, fs.FSWatcher>();
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _currentSessionIds = new Set<string>();
  private _disposed = false;

  // Overrides
  private _overrideWorkspace?: string;
  private _selectedSessionIds = new Set<string>();
  private _conversationSessionId?: string; // Which session to show in Conversation tab

  private _lastIconState = false;
  private _editorPanel?: vscode.WebviewPanel;
  private _displayNameCache = new Map<string, string>();
  private _outputChannel: vscode.OutputChannel;
  private _lastDiagnostics?: DiagnosticInfo;
  private _lastTrace?: TaskDetectionTrace;
  private _lastInitKey?: string;
  private _convDebugDumped = false;
  private _convWatcher?: fs.FSWatcher;
  private _convWatchPath?: string;
  private _convLastSize = 0;
  private _convChanged = false; // Track if conversation file changed in current refresh cycle
  private _convCache = new Map<string, { mtime: number; messages: ConversationMessage[] }>();
  private _diagLog: DiagnosticLog;
  private _healthChecker: HealthChecker;
  private _permProxy?: import('../permissionProxy').PermissionProxyWatcher;

  // Extracted collaborators
  private _searchCoordinator: SearchCoordinator;
  private _bgCommandWatcher: BgCommandWatcher;
  private _messageRouter: MessageRouter;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._outputChannel = vscode.window.createOutputChannel('Claude Lens');
    this._diagLog = createDiagnosticLog(this._outputChannel);
    this._healthChecker = new HealthChecker(this._diagLog);
    this._healthChecker.setStateProvider(() => ({
      taskCount: this._tasks.size,
      sessionIds: [...this._currentSessionIds],
      watcherCount: this._watchers.size,
      workspace: this.getEffectiveWorkspacePath(),
    }));
    this._healthChecker.start();
    // Stream new log entries and health checks to the webview
    this._diagLog.onEntry(entry => {
      this._postToAll({ command: 'diagLogEntries', entries: [entry] });
    });
    setInterval(() => {
      if (!this._view && !this._editorPanel) return;
      this._postToAll({ command: 'ping' });
      this._postToAll({ command: 'diagHealthUpdate', checks: this._healthChecker.getResults() });
    }, 10000);

    // Initialize collaborators
    this._searchCoordinator = new SearchCoordinator(
      { postToAll: (msg) => this._postToAll(msg), getWebviews: () => [this._view?.webview, this._editorPanel?.webview] },
      { log: (msg) => this.log(msg) },
      () => this.getEffectiveWorkspacePath(),
      () => this._currentSessionIds,
      () => this._displayNameCache,
    );

    this._bgCommandWatcher = new BgCommandWatcher(
      { postToAll: (msg) => this._postToAll(msg), getWebviews: () => [this._view?.webview, this._editorPanel?.webview] },
      { log: (msg) => this.log(msg) },
      () => this.refresh(),
    );

    this._messageRouter = new MessageRouter(
      {
        handleSelectWorkspace: () => this.handleSelectWorkspace(),
        handleSelectSession: () => this.handleSelectSession(),
        handleClearOverrides: () => this.handleClearOverrides(),
        sendInitData: () => this._sendInitData(),
        refresh: () => this.refresh(),
        getDebugInfo: () => this.getDebugInfo(),
        showOutputChannel: () => this.showOutputChannel(),
        buildPanelInfo: () => this.buildPanelInfo(),
        dumpConvDebug: () => this._dumpConvDebug(),
        setConversationSessionId: (id) => { this._conversationSessionId = id; this._cachedConvMsgCount = -1; if (id) this._convCache.delete(id); },
        focusSession: (sessionId) => {
          if (sessionId) {
            this._selectedSessionIds = new Set([sessionId]);
          } else {
            this._selectedSessionIds.clear();
          }
          this._conversationSessionId = sessionId ?? undefined;
          this._persistState();
          this._tasks.clear();
          this._currentSessionIds.clear();
          this._initialized.clear();
          this.resetWatchers();
          this.refresh();
        },
        jumpToSession: (sessionId, messageIndex, projectKey, searchQuery) => this._handleJumpToSession(sessionId, messageIndex, projectKey, searchQuery),
        postToAll: (msg) => this._postToAll(msg),
        getPermProxy: () => this._permProxy,
        pushNotificationModes: () => this.pushNotificationModes(),
        restoreFocus: () => this._permProxy?.restoreFocus() ?? vscode.commands.executeCommand('workbench.action.focusPreviousGroup'),
      },
      this._searchCoordinator,
      { log: (msg) => this.log(msg) },
      this._diagLog,
      this._healthChecker,
    );

    // Restore persisted state
    this._restoreState();
    // Start polling immediately (even before view is resolved) so the icon shows up
    this.startWatching();
  }

  private _restoreState() {
    const ws = this._context.workspaceState;
    const savedWs = ws.get<string>('agentPanel.overrideWorkspace');
    const savedSessions = ws.get<string[]>('agentPanel.selectedSessionIds');
    const savedConvSession = ws.get<string>('agentPanel.conversationSessionId');
    if (savedWs) this._overrideWorkspace = savedWs;
    if (savedSessions && savedSessions.length > 0) {
      this._selectedSessionIds = new Set(savedSessions);
    }
    if (savedConvSession) this._conversationSessionId = savedConvSession;
  }

  private _persistState() {
    const ws = this._context.workspaceState;
    ws.update('agentPanel.overrideWorkspace', this._overrideWorkspace);
    ws.update('agentPanel.selectedSessionIds', [...this._selectedSessionIds]);
    ws.update('agentPanel.conversationSessionId', this._conversationSessionId);
    // Save full multi-session selection (for restoring after single-session focus)
    if (this._selectedSessionIds.size > 1) {
      ws.update('agentPanel.allSelectedSessionIds', [...this._selectedSessionIds]);
    }
  }

  private log(msg: string) {
    // Parse source/category from msg prefix like "[task-detection]" or "render:"
    const bracketMatch = msg.match(/^\[([^\]]+)\]\s*/);
    const colonMatch = !bracketMatch ? msg.match(/^(\w[\w-]*):\s*/) : null;
    const source = bracketMatch?.[1] ?? colonMatch?.[1] ?? 'agentPanel';
    const cleanMsg = bracketMatch ? msg.slice(bracketMatch[0].length) : colonMatch ? msg.slice(colonMatch[0].length) : msg;
    this._diagLog.info(source, 'general', cleanMsg);
  }

  private _postToAll(msg: Record<string, unknown>) {
    try { this._view?.webview.postMessage(msg); } catch {}
    try { this._editorPanel?.webview.postMessage(msg); } catch {}
  }

  /** Called by PermissionProxyWatcher whenever pending permission state changes */
  pushPendingPermissions(items: PendingPermItem[]) {
    this._postToAll({ command: 'pendingPermissions', items });
  }

  /** Called by PermissionProxyWatcher whenever foreground session notifications change */
  pushForegroundNotifications(items: import('../permissionProxy').ForegroundNotifyItem[]) {
    this._postToAll({ command: 'foregroundNotifications', items });
  }

  /** Push current notification mode settings to the webview */
  pushNotificationModes() {
    const modes = this._permProxy?.getNotificationModes() ?? { local: 'panel', external: 'notifications' };
    this._postToAll({ command: 'notificationModes', ...modes });
  }

  /** Store reference to perm proxy so inline decisions can bypass the batch panel */
  setPermProxy(proxy: import('../permissionProxy').PermissionProxyWatcher) {
    this._permProxy = proxy;
  }


  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    this._initialized.delete('sidebar');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this._context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.onDidReceiveMessage(msg => this._messageRouter.handleMessage(msg));

    webviewView.onDidDispose(() => {
      this._disposed = true;
      this._initialized.delete('sidebar');
      this.stopWatching();
    });

    this.refresh();
  }

  private getEffectiveWorkspacePath(): string | undefined {
    return this._overrideWorkspace ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getEffectiveSessions(workspacePath: string): { sessionIds: string[]; projectKey: string; selectedBy: TaskDetectionTrace['selectedBy'] } | null {
    const projectKey = pathToProjectKey(workspacePath);

    // Always gather sessions that have active tasks so agents in non-foreground sessions are visible.
    // Use findActiveTaskSessions (ephemeral /tmp only) to avoid returning all historical sessions.
    const taskSessions = findActiveTaskSessions(workspacePath);

    if (this._selectedSessionIds.size > 0) {
      // Use only the user-selected sessions — do not merge task sessions so chips reflect the picker selection exactly
      const sessionIds = [...this._selectedSessionIds];
      this.log(`[task-detection] getEffectiveSessions: using override sessions=[${sessionIds.join(', ')}]`);
      return { sessionIds, projectKey, selectedBy: 'override' };
    }

    const current = findCurrentSession(workspacePath, (msg) => this.log(msg));
    const sessionIds = new Set<string>();
    if (current) sessionIds.add(current.sessionId);
    for (const ts of taskSessions) sessionIds.add(ts);

    if (sessionIds.size === 0) {
      this.log(`[task-detection] getEffectiveSessions: findCurrentSession returned null and no task sessions for workspace=${workspacePath}`);
      return null;
    }

    this.log(`[task-detection] getEffectiveSessions: selected sessions=[${[...sessionIds].join(', ')}] (current=${current?.sessionId ?? 'none'}, taskSessions=[${taskSessions.join(', ')}]), projectKey=${projectKey}`);
    return { sessionIds: [...sessionIds], projectKey, selectedBy: 'most-recent' };
  }

  // ── Select workspace ───────────────────────────────────────
  private async handleSelectWorkspace() {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    let entries: string[];
    try {
      entries = fs.readdirSync(projectsDir).filter(d => {
        return fs.statSync(path.join(projectsDir, d)).isDirectory();
      });
    } catch {
      vscode.window.showErrorMessage('Cannot read ~/.claude/projects/');
      return;
    }

    // Convert project keys back to paths for display
    const items = entries.map(key => {
      const wsPath = reconstructWsPath(key);
      const sessionCount = fs.readdirSync(path.join(projectsDir, key))
        .filter(f => f.endsWith('.jsonl')).length;
      return {
        label: wsPath,
        description: `${sessionCount} sessions`,
        projectKey: key,
        wsPath,
      };
    }).sort((a, b) => {
      // Sort by most recent session file
      const aDir = path.join(projectsDir, a.projectKey);
      const bDir = path.join(projectsDir, b.projectKey);
      const aMtime = getLatestMtime(aDir);
      const bMtime = getLatestMtime(bDir);
      return bMtime - aMtime;
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select workspace (project)',
      matchOnDescription: true,
    });

    if (picked) {
      this._overrideWorkspace = picked.wsPath;
      this._selectedSessionIds.clear();
      this._persistState();
      this._tasks.clear();
      this._currentSessionIds.clear();
      this._initialized.clear(); // Force full re-render (toolbar changed)
      this.resetWatchers();
      this.refresh();
    }
  }

  // ── Select session(s) ──────────────────────────────────────
  private async handleSelectSession() {
    const workspacePath = this.getEffectiveWorkspacePath();
    if (!workspacePath) {
      vscode.window.showErrorMessage('Select a workspace first');
      return;
    }

    const projectKey = pathToProjectKey(workspacePath);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

    let jsonlFiles: { name: string; mtime: number }[];
    try {
      jsonlFiles = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      vscode.window.showErrorMessage(`No sessions found for ${workspacePath}`);
      return;
    }

    const sessionsWithTasks = new Set(findSessionsWithTasks(workspacePath));

    const fmtSize = (bytes: number) => {
      if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
      if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
      return bytes + ' B';
    };
    const fmtTimeAgo = (ms: number) => {
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    };

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const items = jsonlFiles
      .filter(f => {
        const sessionId = f.name.replace('.jsonl', '');
        return sessionsWithTasks.has(sessionId) || f.mtime > sevenDaysAgo;
      })
      .map(f => {
        const sessionId = f.name.replace('.jsonl', '');
        const filePath = path.join(projectDir, f.name);
        const displayName = getSessionDisplayName(workspacePath, sessionId);
        const picked = this._selectedSessionIds.has(sessionId);
        let size = 0;
        try { size = fs.statSync(filePath).size; } catch {}
        const turns = countConversationTurns(workspacePath, sessionId);
        const msgs = turns.user + turns.assistant;
        const agentCount = sessionsWithTasks.has(sessionId)
          ? (listAgentFiles(getTasksDir(workspacePath, sessionId)).length + listSubagentFiles(getSubagentsDir(workspacePath, sessionId)).length)
          : 0;
        const parts: string[] = [fmtTimeAgo(f.mtime), fmtSize(size), `${msgs} msgs`];
        if (agentCount > 0) parts.push(`${agentCount} agents`);
        return {
          label: `$(symbol-event) ${displayName}`,
          description: parts.join('  ·  '),
          detail: sessionId,
          sessionId,
          picked,
        };
      });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select sessions (multi-select)',
      matchOnDescription: true,
      matchOnDetail: true,
      canPickMany: true,
    });

    if (picked) {
      this._selectedSessionIds = new Set(picked.map(p => p.sessionId));
      this._persistState();
      this._tasks.clear();
      this._currentSessionIds.clear();
      this._initialized.clear(); // Force full re-render (toolbar changed)
      this.resetWatchers();
      this.refresh();
    }
  }

  private _dumpConvDebug() {
    const panelInfo = this.buildPanelInfo();
    const convMessages = panelInfo.conversation ?? [];
    this.log(`=== CONV DEBUG: ${convMessages.length} messages ===`);
    // Find last few assistant messages with toolBlocks
    const withTools = convMessages.filter(m => m.toolBlocks && m.toolBlocks.length > 0);
    const last3 = withTools.slice(-3);
    for (const m of last3) {
      this.log(`--- Assistant msg (${m.toolBlocks!.length} tools) ---`);
      for (const tb of m.toolBlocks!) {
        this.log(`  tool: ${tb.name}, toolUseId: ${tb.toolUseId}`);
        this.log(`  input.run_in_background: ${tb.input['run_in_background']} (type: ${typeof tb.input['run_in_background']})`);
        this.log(`  hasResult: ${tb.result !== undefined}, isError: ${tb.isError}`);
        this.log(`  backgroundCommand: ${JSON.stringify(tb.backgroundCommand)}`);
        this.log(`  result preview: ${tb.result?.slice(0, 200)}`);
      }
    }
    // Also dump the HTML for those blocks
    const html = serializeConversation(convMessages);
    const lastHtml = html.slice(-5).filter(h => h.includes('tool-pair'));
    for (let i = 0; i < lastHtml.length; i++) {
      // Find bg-related classes and indicators
      const hasPending = lastHtml[i].includes('tool-result-pending');
      const hasBgRunning = lastHtml[i].includes('running in background');
      const hasInline = lastHtml[i].includes('flex-basis:100%');
      this.log(`  html[${i}]: pending=${hasPending}, bgRunning=${hasBgRunning}, inlineStyle=${hasInline}`);
    }
    this.showOutputChannel();
  }

  /** Send task + conversation data to the webview via postMessage (avoids HTML embedding issues) */
  private _buildSessionJsonlBytes(): Record<string, number> {
    const map: Record<string, number> = {};
    if (!this._lastTrace) return map;
    const ids = this._lastTrace.sessionIds;
    const paths = this._lastTrace.convJsonlPaths;
    for (let i = 0; i < ids.length && i < paths.length; i++) {
      if (paths[i].size > 0) map[ids[i]] = paths[i].size;
    }
    return map;
  }

  private _sendInitData() {
    const serialized = this.getSortedSerializedTasks();
    const panelInfo = this.buildPanelInfo();
    const sessionJsonlBytes = this._buildSessionJsonlBytes();
    const jsonlBytes = Object.values(sessionJsonlBytes).reduce((s, n) => s + n, 0);
    const diag: DiagnosticInfo = {
      taskCount: serialized.length,
      conversationCount: panelInfo.conversation?.length ?? 0,
      htmlBytes: 0,
      jsonlBytes: jsonlBytes > 0 ? jsonlBytes : undefined,
      renderTimeMs: 0,
      sessionIds: [...this._currentSessionIds],
      workspace: panelInfo.workspace,
      timestamp: new Date().toISOString(),
      targets: [],
      warnings: [],
    };

    const convMessages = panelInfo.conversation ?? [];
    const conversationHtml = serializeConversation(convMessages);

    // Debug: dump last tool blocks on first init
    if (!this._convDebugDumped) {
      this._convDebugDumped = true;
      const withTools = convMessages.filter(m => m.toolBlocks && m.toolBlocks.length > 0);
      const lastMsg = withTools[withTools.length - 1];
      if (lastMsg?.toolBlocks) {
        this.log(`=== CONV DEBUG ===`);
        for (const tb of lastMsg.toolBlocks) {
          this.log(`tool=${tb.name} bg=${tb.input['run_in_background']} hasResult=${tb.result !== undefined} bgCmd=${JSON.stringify(tb.backgroundCommand)} result=${(tb.result ?? '').slice(0, 100)}`);
        }
        const lastHtmlIdx = conversationHtml.length - 1;
        const lastH = conversationHtml[lastHtmlIdx] ?? '';
        this.log(`lastHtml has pending=${lastH.includes('tool-result-pending')} bgRunning=${lastH.includes('running in background')} inline=${lastH.includes('flex-basis')}`);
        this.log(`lastHtml snippet: ${lastH.slice(0, 500)}`);
      }
    }

    // Watch bg commands from conversation tool blocks
    this._bgCommandWatcher.watchConversationBgCommands(convMessages);

    this._healthChecker.recordEvent('initDataSent');

    const activeChipSessionId = panelInfo.conversationSessionId ?? panelInfo.sessions[0]?.id ?? null;
    const msg = {
      command: 'initData',
      tasks: serialized,
      conversation: convMessages,
      conversationHtml,
      diagnostics: diag,
      bgCommandComplete: this._bgCommandWatcher.getCompleteSerialized(),
      taskDetectionTrace: this._lastTrace,
      diagLog: this._diagLog.getEntries().slice(-200),
      healthChecks: this._healthChecker.getResults(),
      pendingPermissions: this._permProxy?.getPendingItems() ?? [],
      activeChipSessionId,
      sessionCtx: panelInfo.sessionCtx ?? {},
      sessionJsonlBytes,
    };

    // Only log on first send or when counts change
    const key = `${serialized.length}:${diag.conversationCount}`;
    if (!this._lastInitKey || this._lastInitKey !== key) {
      this.log(`initData: ${serialized.length} tasks, ${diag.conversationCount} conv msgs`);
      this._lastInitKey = key;
    }

    if (this._view) {
      this._view.webview.postMessage(msg);
      diag.targets.push('sidebar');
    }
    if (this._editorPanel) {
      this._editorPanel.webview.postMessage(msg);
      diag.targets.push('editor');
    }
    this._lastDiagnostics = diag;
    this._sendPendingCommands();
    this.pushNotificationModes();
  }

  private _pendingClearSearch = false;

  private _sendPendingCommands() {
    const targets = [this._view?.webview, this._editorPanel?.webview].filter(Boolean);
    if (targets.length === 0) return;
    // Clear search if requested (before tab switch so convFull is visible)
    if (this._pendingClearSearch) {
      this._pendingClearSearch = false;
      for (const t of targets) t?.postMessage({ command: 'clearSearch' });
    }
    // Switch tab if requested
    if (this._pendingTab) {
      const tab = this._pendingTab;
      const scroll = this._pendingScrollToMessage;
      this._pendingTab = undefined;
      this._pendingScrollToMessage = undefined;
      setTimeout(() => {
        for (const t of targets) t?.postMessage({ command: 'switchTab', tab });
        if (scroll) {
          setTimeout(() => {
            for (const t of targets) t?.postMessage({ command: 'scrollToMessage', messageIndex: scroll.messageIndex, query: scroll.query });
          }, 100);
        }
      }, 150);
    }
    // Focus agent if requested
    if (this._pendingFocusAgent) {
      const focusId = this._pendingFocusAgent;
      this._pendingFocusAgent = undefined;
      setTimeout(() => {
        for (const t of targets) t?.postMessage({ command: 'focusAgent', agentId: focusId });
      }, 200);
    }
  }

  private handleClearOverrides() {
    this._overrideWorkspace = undefined;
    this._selectedSessionIds.clear();
    this._persistState();
    this._tasks.clear();
    this._currentSessionIds.clear();
    this._displayNameCache.clear();
    this._convCache.clear();
    this._initialized.clear(); // Force full re-render (toolbar changed)
    this.resetWatchers();
    this.refresh();
  }

  private resetWatchers() {
    for (const w of this._watchers.values()) w.close();
    this._watchers.clear();
    this._bgCommandWatcher.resetWatchers();
  }

  private startWatching() {
    this.stopWatching();

    // Poll for discovery only (new sessions/dirs/conv files).
    // fs.watch on each discovered path handles all real-time rendering updates.
    this._pollTimer = setInterval(() => {
      if (this._disposed) return;
      if (!this._view && !this._editorPanel) return;
      this.checkForUpdates();
    }, 1000);
  }

  private stopWatching() {
    this.resetWatchers();
    this._convWatcher?.close();
    this._convWatcher = undefined;
    this._convWatchPath = undefined;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private checkForUpdates() {
    const workspacePath = this.getEffectiveWorkspacePath();
    if (!workspacePath) {
      this.updateContextKey(false);
      return;
    }

    const result = this.getEffectiveSessions(workspacePath);
    if (!result) {
      this.updateContextKey(false);
      return;
    }

    const currentIdSet = new Set(result.sessionIds);
    const changed = currentIdSet.size !== this._currentSessionIds.size
      || [...currentIdSet].some(id => !this._currentSessionIds.has(id));

    if (changed) {
      this._currentSessionIds = currentIdSet;
      this._tasks.clear();
      this._descriptions.clear();
      for (const sid of result.sessionIds) {
        const descs = findAgentDescriptions(workspacePath, sid);
        for (const [k, v] of descs) this._descriptions.set(k, v);
      }
    }

    // Track whether we set up any new watchers — if so, trigger a refresh to pick up files
    // that arrived between the last poll and now. fs.watch handles ongoing changes; we only
    // need to refresh here when something structurally new is discovered.
    let newWatcher = false;

    let hasFiles = false;
    for (const sid of result.sessionIds) {
      // Watch persistent subagents dir (preferred)
      const subagentsDir = getSubagentsDir(workspacePath, sid);
      const subagentsWatchKey = `subagents:${sid}`;
      if (!this._watchers.has(subagentsWatchKey) && fs.existsSync(subagentsDir)) {
        try {
          this._watchers.set(subagentsWatchKey, fs.watch(subagentsDir, () => { this._healthChecker.recordEvent(`watcherFired:${subagentsDir}`); this.refresh(); }));
          newWatcher = true;
        } catch {}
      }
      if (fs.existsSync(subagentsDir) && listSubagentFiles(subagentsDir).length > 0) {
        hasFiles = true;
      }

      // Also watch ephemeral /tmp tasks dir for currently-running agents
      const tasksDir = getTasksDir(workspacePath, sid);
      if (!this._watchers.has(sid) && fs.existsSync(tasksDir)) {
        try {
          this._watchers.set(sid, fs.watch(tasksDir, () => { this._healthChecker.recordEvent(`watcherFired:${tasksDir}`); this.refresh(); }));
          newWatcher = true;
        } catch {}
      }
      if (!hasFiles && fs.existsSync(tasksDir) && listAgentFiles(tasksDir).length > 0) {
        hasFiles = true;
      }
    }

    // Watch conversation JSONL file for live updates
    if (result.sessionIds.length > 0) {
      const firstSid = result.sessionIds[0];
      const projectKey = pathToProjectKey(workspacePath);
      const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${firstSid}.jsonl`);
      if (jsonlPath !== this._convWatchPath) {
        this._convWatcher?.close();
        this._convWatcher = undefined;
        this._convWatchPath = undefined;
        if (fs.existsSync(jsonlPath)) {
          try {
            this._convWatcher = fs.watch(jsonlPath, () => { this._healthChecker.recordEvent(`watcherFired:${jsonlPath}`); this.refresh(); });
            this._convWatchPath = jsonlPath;
          } catch {}
        }
        newWatcher = true; // conv path changed — may have new content
      }
    }

    this.updateContextKey(hasFiles);
    // Only refresh when sessions changed or new watchers were registered.
    // fs.watch callbacks on the dirs/files handle all ongoing content updates.
    if (changed || newWatcher) {
      this.refresh();
    }
  }

  private buildPanelInfo(): PanelInfo {
    const workspace = this.getEffectiveWorkspacePath();
    const sessions = [...this._currentSessionIds].map(id => {
      if (!this._displayNameCache.has(id) && workspace) {
        this._displayNameCache.set(id, getSessionDisplayName(workspace, id));
      }
      return { id, displayName: this._displayNameCache.get(id) ?? id.slice(0, 8) };
    });

    // Build session names map for all sessions that have tasks
    const sessionNames = new Map<string, string>();
    for (const [, task] of this._tasks) {
      if (task.sessionId && !sessionNames.has(task.sessionId)) {
        if (!this._displayNameCache.has(task.sessionId) && workspace) {
          this._displayNameCache.set(task.sessionId, getSessionDisplayName(workspace, task.sessionId));
        }
        sessionNames.set(task.sessionId, this._displayNameCache.get(task.sessionId) ?? task.sessionId.slice(0, 8));
      }
    }

    // Compute per-session agent count from _tasks
    const agentCountBySession = new Map<string, number>();
    for (const [, task] of this._tasks) {
      if (task.sessionId) {
        agentCountBySession.set(task.sessionId, (agentCountBySession.get(task.sessionId) ?? 0) + 1);
      }
    }
    const sessionsWithCount = sessions.map(s => ({
      ...s,
      agentCount: agentCountBySession.get(s.id) ?? 0,
    }));

    // Parse conversation for the pinned conversation session (or fall back to first session)
    let conversation: ConversationMessage[] | undefined;
    let error: string | undefined;
    if (workspace && sessions.length > 0) {
      const convSession = sessions.find(s => s.id === this._conversationSessionId) ?? sessions[0];
      try {
        const projectKey = pathToProjectKey(workspace);
        const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${convSession.id}.jsonl`);
        let mtime = 0;
        try { mtime = fs.statSync(jsonlPath).mtimeMs; } catch {}
        const cached = this._convCache.get(convSession.id);
        // Skip cache if conversation file changed during this refresh cycle
        // mtime-based caching has race conditions with file writes, so we force re-parse on actual changes
        if (!this._convChanged && cached && cached.mtime === mtime) {
          conversation = cached.messages;
        } else {
          conversation = parseSessionConversation(workspace, convSession.id);
          this._convCache.set(convSession.id, { mtime, messages: conversation });
        }
      } catch (e) {
        error = `Failed to parse conversation: ${e}`;
      }
    }

    // Compute per-session lastContext from JSONL tails
    const sessionCtx: Record<string, number> = {};
    if (workspace) {
      for (const s of sessions) {
        sessionCtx[s.id] = getSessionLastContext(workspace, s.id);
      }
    }

    return {
      workspace,
      sessions: sessionsWithCount,
      sessionNames,
      conversationSessionId: this._conversationSessionId ?? sessions[0]?.id,
      isOverride: !!(this._overrideWorkspace || this._selectedSessionIds.size > 0),
      conversation,
      error,
      sessionCtx,
    };
  }

  private updateContextKey(hasAgents: boolean) {
    if (hasAgents === this._lastIconState) return;
    this._lastIconState = hasAgents;
    vscode.commands.executeCommand('setContext', 'claudeCodeInsights.hasBackgroundAgents', hasAgents);
  }

  private _refreshTimer?: ReturnType<typeof setTimeout>;

  refresh() {
    if ((!this._view && !this._editorPanel) || this._disposed) return;

    // Invalidate search cache when data changes
    this._searchCoordinator.invalidateSearchCache();

    // Debounce rapid refresh calls (fs.watch can fire many times)
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      this._refreshNow();
    }, 300);
  }

  private _refreshNow() {
    if ((!this._view && !this._editorPanel) || this._disposed) return;

    try {
      this._doRefresh();
    } catch (e) {
      console.error('[claude-code-insights] refresh error:', e);
      const errorHtml = `<!DOCTYPE html><html><body style="padding:16px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);">
        <div style="padding:8px 10px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder,#f44747);border-radius:4px;font-size:12px;">
          <strong>Refresh error:</strong> ${String(e)}
        </div></body></html>`;
      if (this._view) this._view.webview.html = errorHtml;
      if (this._editorPanel) this._editorPanel.webview.html = errorHtml;
    }
  }

  private _doRefresh() {
    const t0 = Date.now();
    const workspacePath = this.getEffectiveWorkspacePath();
    if (!workspacePath) {
      this.log('[task-detection] _doRefresh: no workspace path resolved — rendering empty');
      this.renderEmpty();
      return;
    }

    this.log(`[task-detection] _doRefresh: workspace=${workspacePath}`);

    const result = this.getEffectiveSessions(workspacePath);
    if (!result) {
      this.log(`[task-detection] _doRefresh: getEffectiveSessions returned null for workspace=${workspacePath} — rendering empty`);
      // Build a minimal trace for diagnostics
      this._lastTrace = {
        workspacePath,
        projectKey: pathToProjectKey(workspacePath),
        sessionIds: [],
        subagentsDirs: [],
        tmpTaskDirs: [],
        convJsonlPaths: [],
        selectedBy: 'none',
        reason: 'getEffectiveSessions returned null — no .jsonl files found in project dir',
      };
      this.renderEmpty();
      return;
    }

    this.log(`[task-detection] _doRefresh: sessions=[${result.sessionIds.join(', ')}], selectedBy=${result.selectedBy}`);

    const currentIdSet = new Set(result.sessionIds);
    const sessionChanged = currentIdSet.size !== this._currentSessionIds.size
      || [...currentIdSet].some(id => !this._currentSessionIds.has(id));
    if (sessionChanged) {
      this.log(`[task-detection] _doRefresh: session set changed — clearing tasks and descriptions`);
      this._currentSessionIds = currentIdSet;
      this._tasks.clear();
      this._descriptions.clear();
      for (const sid of result.sessionIds) {
        const descs = findAgentDescriptions(workspacePath, sid);
        for (const [k, v] of descs) this._descriptions.set(k, v);
      }
      // Write permission mode files for hook consumption
      this._writePermissionModes(workspacePath, result.sessionIds);
    }

    // Build trace object incrementally
    const trace: TaskDetectionTrace = {
      workspacePath,
      projectKey: result.projectKey,
      sessionIds: result.sessionIds,
      subagentsDirs: [],
      tmpTaskDirs: [],
      convJsonlPaths: [],
      selectedBy: result.selectedBy,
    };

    let allFiles: string[] = [];
    const _seenAgentFiles = new Set<string>(); // track by agentId to avoid duplicates
    for (const sid of result.sessionIds) {
      // Primary: persistent subagents dir
      const subagentsDir = getSubagentsDir(workspacePath, sid);
      const subagentsExists = fs.existsSync(subagentsDir);
      const subagentFiles = listSubagentFiles(subagentsDir);
      trace.subagentsDirs.push({ path: subagentsDir, exists: subagentsExists, fileCount: subagentFiles.length });
      this.log(`[task-detection] _doRefresh: subagentsDir=${subagentsDir}, exists=${subagentsExists}, files=${subagentFiles.length}`);
      for (const file of subagentFiles) {
        const agentId = path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
        if (!_seenAgentFiles.has(agentId)) {
          _seenAgentFiles.add(agentId);
          allFiles.push(file);
        }
      }
      // Fallback: ephemeral /tmp tasks dir
      const tasksDir = getTasksDir(workspacePath, sid);
      const tasksExists = fs.existsSync(tasksDir);
      const taskFiles = listAgentFiles(tasksDir);
      trace.tmpTaskDirs.push({ path: tasksDir, exists: tasksExists, fileCount: taskFiles.length });
      this.log(`[task-detection] _doRefresh: tasksDir=${tasksDir}, exists=${tasksExists}, files=${taskFiles.length}`);
      for (const file of taskFiles) {
        const agentId = path.basename(file).replace('.output', '');
        if (!_seenAgentFiles.has(agentId)) {
          _seenAgentFiles.add(agentId);
          allFiles.push(file);
        }
      }

      // Track conversation JSONL path
      const jsonlPath = path.join(os.homedir(), '.claude', 'projects', result.projectKey, `${sid}.jsonl`);
      let jsonlSize = 0;
      const jsonlExists = fs.existsSync(jsonlPath);
      if (jsonlExists) {
        try { jsonlSize = fs.statSync(jsonlPath).size; } catch {}
      }
      trace.convJsonlPaths.push({ path: jsonlPath, exists: jsonlExists, size: jsonlSize });
      this.log(`[task-detection] _doRefresh: convJsonl=${jsonlPath}, exists=${jsonlExists}, size=${jsonlSize}`);
    }

    this.log(`[task-detection] _doRefresh: allFiles total (after dedup)=${allFiles.length}, existing cached tasks=${this._tasks.size}`);
    this._lastTrace = trace;

    if (allFiles.length === 0 && this._tasks.size === 0) {
      // Even with no agents, render the panel if we have conversation data
      const panelInfo = this._makePanelInfo();
      if (panelInfo.conversation && panelInfo.conversation.length > 0) {
        this.log(`[task-detection] _doRefresh: no agent files found, falling back to conversation-only (${panelInfo.conversation.length} msgs)`);
        trace.reason = `no agent files found in subagents or tmp dirs — showing conversation-only`;
        this._renderWithConversationOnly(panelInfo);
        return;
      }
      this.log('[task-detection] _doRefresh: no agents and no conversation — rendering empty');
      trace.reason = 'no agent files found and no conversation messages';
      this.renderEmpty();
      return;
    }

    let changed = false;
    const currentIds = new Set<string>();

    for (const file of allFiles) {
      const _basename = path.basename(file);
      const agentId = _basename.replace(/^agent-/, '').replace(/\.(output|jsonl)$/, '');
      currentIds.add(agentId);
      const existing = this._tasks.get(agentId);

      try {
        const stat = fs.statSync(file);
        if (existing && existing._readOffset >= stat.size && existing.status !== 'running') {
          continue;
        }
      } catch {
        continue;
      }

      const updated = parseAgentFile(file, existing);
      this._tasks.set(agentId, updated);
      changed = true;

      // Detect and watch background command output files
      const taskDone = updated.status !== 'running';
      for (const block of updated.contentBlocks) {
        if (block.type === 'tool_result' && block.backgroundCommand) {
          const { commandId, outputPath } = block.backgroundCommand;
          if (taskDone && !this._bgCommandWatcher.completeSet.has(commandId)) {
            // Task already finished — read output once and send as complete
            const content = fs.existsSync(outputPath) ? this._bgCommandWatcher.readBgTail(outputPath) : '';
            this._postToAll({ command: 'bgCommandOutput', commandId, output: content, isComplete: true });
            this._bgCommandWatcher.markComplete(commandId);
          } else {
            this._bgCommandWatcher.watchBgCommand(commandId, outputPath);
          }
        }
      }
    }

    for (const [id, task] of this._tasks) {
      if (task.status !== 'running') continue;
      if (!currentIds.has(id)) {
        task.status = 'completed';
        changed = true;
        continue;
      }
      // Only auto-complete from the panel level after 5 minutes of inactivity.
      // The parser's own completion detection (end_turn + staleness) handles faster cases.
      // 30s was too aggressive — agents regularly pause 30s+ waiting for builds/tests.
      if (task._lastMtime > 0 && (Date.now() - task._lastMtime) > 300_000 && task.contentBlocks.length > 0) {
        task.status = 'completed';
        changed = true;
      }
    }

    // Check if conversation JSONL changed
    let convChanged = false;
    if (this._convWatchPath) {
      try {
        const sz = fs.statSync(this._convWatchPath).size;
        if (sz !== this._convLastSize) {
          this._convLastSize = sz;
          convChanged = true;
          this._convChanged = true; // Mark for cache skip during this refresh cycle
        }
      } catch {}
    }

    if (changed) {
      this.log(`refresh: tasks=${this._tasks.size}, took ${Date.now() - t0}ms`);
    }
    if (changed || convChanged || !this._initialized.has('sidebar') || !this._initialized.has('editor')) {
      this._render(convChanged);
    }
  }

  private _initialized = new Set<'sidebar' | 'editor'>();
  private _cachedConvHtml: string[] = [];
  private _cachedConvMsgCount = -1;

  private getSortedSerializedTasks(): SerializedTask[] {
    const workspace = this.getEffectiveWorkspacePath();
    const sessionNames = new Map<string, string>();
    for (const [, task] of this._tasks) {
      if (task.sessionId && !sessionNames.has(task.sessionId)) {
        if (!this._displayNameCache.has(task.sessionId) && workspace) {
          this._displayNameCache.set(task.sessionId, getSessionDisplayName(workspace, task.sessionId));
        }
        sessionNames.set(task.sessionId, this._displayNameCache.get(task.sessionId) ?? task.sessionId.slice(0, 8));
      }
    }

    return Array.from(this._tasks.values())
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        if (a.status === 'running') {
          return (a.startedAt || '').localeCompare(b.startedAt || '');
        }
        return (b.lastActivity || '').localeCompare(a.lastActivity || '');
      })
      .map(t => serializeTask(t, this._descriptions.get(t.agentId), sessionNames.get(t.sessionId)));
  }

  private _render(convChanged = true) {
    if (!this._view && !this._editorPanel) return;

    try {
      const serialized = this.getSortedSerializedTasks();
      const panelInfo = this._makePanelInfo();
      const convMessages = panelInfo.conversation ?? [];

      // Conversation HTML is expensive — only re-serialize when JSONL changed.
      // Cache the result; reuse when only tasks changed.
      let conversationHtml: string[];
      const needsUpdate = (this._view && this._initialized.has('sidebar'))
        || (this._editorPanel && this._initialized.has('editor'));
      if (needsUpdate) {
        if (convChanged || this._cachedConvMsgCount !== convMessages.length) {
          if (this._cachedConvMsgCount >= 0 && convMessages.length > this._cachedConvMsgCount) {
            // Incremental: only render new messages appended since last render
            const newMessages = convMessages.slice(this._cachedConvMsgCount);
            const newHtml = serializeConversation(newMessages);
            this._cachedConvHtml = this._cachedConvHtml.concat(newHtml);
          } else {
            // Full re-render (first time, or messages were removed/replaced)
            this._cachedConvHtml = serializeConversation(convMessages);
          }
          this._cachedConvMsgCount = convMessages.length;
          this._bgCommandWatcher.watchConversationBgCommands(convMessages);
        }
        conversationHtml = this._cachedConvHtml;
      } else {
        conversationHtml = this._cachedConvHtml;
      }

      // If webview not yet initialized, set the HTML shell (data arrives via postMessage when webview signals ready)
      const activeChipSessionId = panelInfo.conversationSessionId ?? panelInfo.sessions[0]?.id ?? null;

      if (this._view && !this._initialized.has('sidebar')) {
        this._view.webview.html = getAgentPanelHtml(serialized, panelInfo);
        this._initialized.add('sidebar');
        this.log('render: sidebar HTML shell set');
      } else if (this._view) {
        this._view.webview.postMessage({ command: 'updateTasks', tasks: serialized, conversation: convMessages, conversationHtml, activeChipSessionId, bgCommandComplete: this._bgCommandWatcher.getCompleteSerialized(), taskDetectionTrace: this._lastTrace, sessionCtx: panelInfo.sessionCtx ?? {}, sessionJsonlBytes: this._buildSessionJsonlBytes() });
        this._bgCommandWatcher.flushBgOutputs();
      }

      if (this._editorPanel && !this._initialized.has('editor')) {
        this._editorPanel.webview.html = getAgentPanelHtml(serialized, panelInfo);
        this._initialized.add('editor');
        this.log('render: editor HTML shell set');
      } else if (this._editorPanel) {
        this._editorPanel.webview.postMessage({ command: 'updateTasks', tasks: serialized, conversation: convMessages, conversationHtml, activeChipSessionId, bgCommandComplete: this._bgCommandWatcher.getCompleteSerialized(), taskDetectionTrace: this._lastTrace, sessionCtx: panelInfo.sessionCtx ?? {}, sessionJsonlBytes: this._buildSessionJsonlBytes() });
        this._bgCommandWatcher.flushBgOutputs();
      }

      // Send any pending focus/tab commands after data update
      this._sendPendingCommands();
    } catch (e) {
      this.log(`render: EXCEPTION: ${e}`);
      const errorHtml = `<!DOCTYPE html><html><body style="padding:16px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);">
        <div style="padding:8px 10px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder,#f44747);border-radius:4px;font-size:12px;">
          <strong>Render error:</strong> ${String(e)}
        </div></body></html>`;
      if (this._view) this._view.webview.html = errorHtml;
      if (this._editorPanel) this._editorPanel.webview.html = errorHtml;
      console.error('[claude-code-insights] render error:', e);
    } finally {
      // Reset conv changed flag after render completes
      this._convChanged = false;
    }
  }

  private _makePanelInfo() {
    const nonce = require('crypto').randomBytes(16).toString('hex');
    const webview = this._view?.webview ?? this._editorPanel?.webview;
    const cspSource = webview?.cspSource ?? '';
    const scriptUri = webview
      ? webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'agentWebviewClient.js')).toString()
      : '';
    const cssUri = webview
      ? webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'agentWebview.css')).toString()
      : '';
    return {
      ...this.buildPanelInfo(),
      nonce,
      cspSource,
      scriptUri,
      cssUri,
    };
  }

  private renderEmpty() {
    const panelInfo = this._makePanelInfo();
    this.log('renderEmpty');

    // Use two-phase rendering: HTML shell once, then postMessage for empty state
    if (this._view && !this._initialized.has('sidebar')) {
      this._view.webview.html = getAgentPanelHtml([], panelInfo);
      this._initialized.add('sidebar');
    } else if (this._view) {
      this._view.webview.postMessage({ command: 'updateTasks', tasks: [], conversation: [], conversationHtml: [], bgCommandComplete: [], taskDetectionTrace: this._lastTrace, sessionCtx: panelInfo.sessionCtx ?? {}, sessionJsonlBytes: this._buildSessionJsonlBytes() });
    }

    if (this._editorPanel && !this._initialized.has('editor')) {
      this._editorPanel.webview.html = getAgentPanelHtml([], panelInfo);
      this._initialized.add('editor');
    } else if (this._editorPanel) {
      this._editorPanel.webview.postMessage({ command: 'updateTasks', tasks: [], conversation: [], conversationHtml: [], bgCommandComplete: [], taskDetectionTrace: this._lastTrace, sessionCtx: panelInfo.sessionCtx ?? {}, sessionJsonlBytes: this._buildSessionJsonlBytes() });
    }
  }

  private _renderWithConversationOnly(panelInfo: PanelInfo) {
    const convMessages = panelInfo.conversation ?? [];
    this.log(`renderConvOnly: ${convMessages.length} conv msgs`);

    // Use two-phase rendering: HTML shell once, then postMessage updates
    if (this._view && !this._initialized.has('sidebar')) {
      this._view.webview.html = getAgentPanelHtml([], panelInfo, { autoConversationTab: true });
      this._initialized.add('sidebar');
      this.log('renderConvOnly: sidebar HTML shell set');
    } else if (this._view) {
      if (this._cachedConvMsgCount !== convMessages.length) {
        this._cachedConvHtml = serializeConversation(convMessages);
        this._cachedConvMsgCount = convMessages.length;
        this._bgCommandWatcher.watchConversationBgCommands(convMessages);
      }
      this._view.webview.postMessage({ command: 'updateTasks', tasks: [], conversation: convMessages, conversationHtml: this._cachedConvHtml, bgCommandComplete: this._bgCommandWatcher.getCompleteSerialized(), taskDetectionTrace: this._lastTrace, sessionCtx: panelInfo.sessionCtx ?? {}, sessionJsonlBytes: this._buildSessionJsonlBytes() });
      this._bgCommandWatcher.flushBgOutputs();
    }

    if (this._editorPanel && !this._initialized.has('editor')) {
      this._editorPanel.webview.html = getAgentPanelHtml([], panelInfo, { autoConversationTab: true });
      this._initialized.add('editor');
      this.log('renderConvOnly: editor HTML shell set');
    } else if (this._editorPanel) {
      // Reuse already-updated cache from sidebar branch (or rebuild if sidebar not active)
      if (this._cachedConvMsgCount !== convMessages.length) {
        this._cachedConvHtml = serializeConversation(convMessages);
        this._cachedConvMsgCount = convMessages.length;
        this._bgCommandWatcher.watchConversationBgCommands(convMessages);
      }
      this._editorPanel.webview.postMessage({ command: 'updateTasks', tasks: [], conversation: convMessages, conversationHtml: this._cachedConvHtml, bgCommandComplete: this._bgCommandWatcher.getCompleteSerialized(), taskDetectionTrace: this._lastTrace, sessionCtx: panelInfo.sessionCtx ?? {}, sessionJsonlBytes: this._buildSessionJsonlBytes() });
      this._bgCommandWatcher.flushBgOutputs();
    }
  }

  openInEditor() {
    this._ensureEditorPanel();
    this._render();
  }

  private _ensureEditorPanel() {
    if (this._editorPanel) {
      this._editorPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'claudeCodeInsights.agentEditor',
      'Claude Lens',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this._context.extensionUri, 'dist'),
          vscode.Uri.joinPath(this._context.extensionUri, 'media'),
        ],
      },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'agents-icon-light.svg'),
      dark: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'agents-icon.svg'),
    };

    this._editorPanel = panel;
    this._initialized.delete('editor');

    panel.webview.onDidReceiveMessage(msg => this._messageRouter.handleMessage(msg));

    panel.onDidDispose(() => {
      this._editorPanel = undefined;
      this._initialized.delete('editor');
      this._context.workspaceState.update('agentPanel.editorPanelOpen', false);
    });

    this._context.workspaceState.update('agentPanel.editorPanelOpen', true);
  }

  /**
   * Adopt a panel that VS Code deserialized on reload.
   * Called by the WebviewPanelSerializer registered in extension.ts.
   */
  adoptDeserializedPanel(panel: vscode.WebviewPanel) {
    this.log('adoptDeserializedPanel called');
    if (this._editorPanel) {
      this.log('adoptDeserializedPanel: already have panel, disposing deserialized');
      panel.dispose();
      return;
    }

    this._editorPanel = panel;
    this._initialized.delete('editor');

    panel.iconPath = {
      light: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'agents-icon-light.svg'),
      dark: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'agents-icon.svg'),
    };

    panel.webview.onDidReceiveMessage(msg => this._messageRouter.handleMessage(msg));

    panel.onDidDispose(() => {
      this._editorPanel = undefined;
      this._initialized.delete('editor');
      this._context.workspaceState.update('agentPanel.editorPanelOpen', false);
    });

    this._context.workspaceState.update('agentPanel.editorPanelOpen', true);
    this.log('adoptDeserializedPanel: panel adopted, triggering render');
    // Don't add to _initialized yet — let render() set the full HTML shell on next refresh cycle
    // Force an immediate refresh cycle
    this._refreshNow();
  }

  /** Open the agent panel focused on a specific workspace + session, optionally highlighting a task */
  openForSession(wsPath: string, sessionId: string, focusAgentId?: string) {
    this._overrideWorkspace = wsPath;
    this._selectedSessionIds = new Set([sessionId]);
    this._persistState();
    this._tasks.clear();
    this._currentSessionIds.clear();
    this._pendingFocusAgent = focusAgentId;
    this._pendingClearSearch = true;
    // When clicking a session (no agent), auto-switch to conversation tab
    this._pendingTab = focusAgentId ? 'agents' : 'conversation';
    this.resetWatchers();
    this._ensureEditorPanel();
    // If webview already initialized, send data via postMessage (don't re-create HTML)
    if (this._initialized.has('editor') || this._initialized.has('sidebar')) {
      this.refresh();
    } else {
      this._initialized.clear();
      this.refresh();
    }
  }

  private _pendingTab?: string;
  private _pendingScrollToMessage?: { messageIndex: number; query: string };

  private _pendingFocusAgent?: string;

  private _handleJumpToSession(sessionId: string, messageIndex: number, projectKey?: string, searchQuery?: string) {
    // Empty sessionId = "back to search" navigation — now handled client-side, just clear search
    if (!sessionId) {
      this._pendingClearSearch = true;
      this._sendPendingCommands();
      return;
    }

    // If we're already viewing this session, just switch to conversation tab (no reload)
    if (this._currentSessionIds.has(sessionId)) {
      this.log(`jumpToSession: already on session ${sessionId}, fast-switching to conversation tab`);
      this._pendingClearSearch = true;
      this._pendingTab = 'conversation';
      if (searchQuery) this._pendingScrollToMessage = { messageIndex, query: searchQuery };
      this._sendPendingCommands();
      return;
    }

    // Different session — need full reload
    let wsPath: string | undefined;
    if (projectKey) {
      wsPath = reconstructWsPath(projectKey);
    } else {
      wsPath = this.getEffectiveWorkspacePath() || undefined;
    }

    if (!wsPath) {
      this.log(`jumpToSession: no workspace path for session ${sessionId}`);
      return;
    }

    this.log(`jumpToSession: ${sessionId} in ${wsPath}`);
    this.openForSession(wsPath, sessionId);
  }

  getDebugInfo(): Record<string, unknown> {
    return {
      workspace: this.getEffectiveWorkspacePath(),
      sessionIds: [...this._currentSessionIds],
      taskCount: this._tasks.size,
      initialized: [...this._initialized],
      hasView: !!this._view,
      hasEditorPanel: !!this._editorPanel,
      lastDiagnostics: this._lastDiagnostics,
      taskDetectionTrace: this._lastTrace,
    };
  }

  showOutputChannel() {
    this._outputChannel.show(true);
  }

  getOutputChannel(): vscode.OutputChannel {
    return this._outputChannel;
  }

  /** Returns true if the agent panel webview is currently visible to the user */
  isPanelVisible(): boolean {
    return (this._view?.visible ?? false) || (this._editorPanel?.visible ?? false);
  }

  /** Returns the set of session IDs currently tracked by this panel instance. */
  getTrackedSessionIds(): ReadonlySet<string> {
    return this._currentSessionIds;
  }

  /**
   * Write permission mode files for each session so the hook can
   * quickly check if a session is in "acceptEdits" mode etc.
   * File: /tmp/claude-permissions/mode-{sessionId}.json
   */
  private _writePermissionModes(workspacePath: string, sessionIds: string[]) {
    const permDir = path.join('/tmp', 'claude-permissions');
    try { fs.mkdirSync(permDir, { recursive: true }); } catch {}
    for (const sid of sessionIds) {
      const mode = getSessionPermissionMode(workspacePath, sid);
      if (!mode) continue;
      const modeFile = path.join(permDir, `mode-${sid}.json`);
      try {
        fs.writeFileSync(modeFile, JSON.stringify({ sessionId: sid, permissionMode: mode }));
      } catch {}
    }
  }

  dispose() {
    this._disposed = true;
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = undefined; }
    this.stopWatching();
    this._bgCommandWatcher.dispose();
    this._searchCoordinator.terminate();
    this._editorPanel?.dispose();
  }
}

function getLatestMtime(dir: string): number {
  try {
    const files = fs.readdirSync(dir);
    let max = 0;
    for (const f of files) {
      try {
        const mt = fs.statSync(path.join(dir, f)).mtimeMs;
        if (mt > max) max = mt;
      } catch {}
    }
    return max;
  } catch {
    return 0;
  }
}
