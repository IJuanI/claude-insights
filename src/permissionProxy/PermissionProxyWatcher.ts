import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  PERM_DIR, POLL_MS, BATCH_DELAY_MS, TIMEOUT_GRACE_MS,
  PermissionRequest, PendingPermItem, ForegroundNotifyItem, BatchQueueItem,
} from './types';
import { ensurePermDir, readRequestFile, writeDecision, listPermDir } from './permissionStore';
import { showPermissionBatchPanel, formatRemaining, BatchPanelController } from './permissionUI';

/**
 * Watches for permission request files from the PreToolUse hook
 * and shows VS Code notifications to the user for approval.
 *
 * Batches concurrent requests (e.g. parallel Bash calls from one agent)
 * into a single notification to avoid notification queue stacking.
 */
export class PermissionProxyWatcher implements vscode.Disposable {
  private _pending = new Set<string>();
  private _externalUuids = new Set<string>();
  // UUIDs recently resolved (allow/deny) — suppress from scan until req file disappears
  private _recentlyResolved = new Map<string, number>(); // uuid → resolvedAt timestamp
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _disposed = false;
  private _log: vscode.OutputChannel;
  private _sessionFilter?: () => ReadonlySet<string>;
  private _requestTimestamps = new Map<string, number>();
  private _dismissCount = new Map<string, number>(); // Track dismissals to back off
  // UUIDs that have passed their timeout — kept visible for TIMEOUT_GRACE_MS before eviction
  private _timedOutAt = new Map<string, number>(); // uuid → timestamp when grace period started
  // Cache of last-read request data so we can still render after req file is deleted
  private _lastKnownRequests = new Map<string, PermissionRequest>();

  // Batch queue: collect requests arriving close together
  private _batchQueue: BatchQueueItem[] = [];
  private _batchTimer: ReturnType<typeof setTimeout> | null = null;
  private _notificationActive = false;
  private _countdownStatusBar: vscode.StatusBarItem | null = null;
  private _countdownTimer: ReturnType<typeof setInterval> | null = null;
  private _countdownCommand: vscode.Disposable | null = null;
  private _activeItems: BatchQueueItem[] = [];
  private _webviewPush: ((items: PendingPermItem[]) => void) | null = null;
  private _notifyPush: ((items: ForegroundNotifyItem[]) => void) | null = null;
  private _isPanelVisible: (() => boolean) | null = null;
  /** Controller for the currently-open dedicated approval panel (if any) */
  private _activePanelController: BatchPanelController | null = null;

  // Focus management
  private _lastTypingMs = 0;
  private _lastFocusType: 'editor' | 'terminal' | 'other' = 'editor';
  private _lastActiveEditorUri?: vscode.Uri;
  private _lastActiveEditorColumn?: vscode.ViewColumn;
  private _lastActiveTerminal?: vscode.Terminal;
  private _typingSubscription: vscode.Disposable | null = null;
  private _focusSubscriptions: vscode.Disposable[] = [];

  // Foreground session notifications (read-only, no decision needed)
  private _notifyItems = new Map<string, ForegroundNotifyItem>(); // keyed by tool_use_id
  // IDs suppressed from display after DISPLAY_TTL_MS (approved & running; file still on disk)
  private _suppressedNotifyIds = new Set<string>();

  /** Register a callback to push pending permission state to the webview.
   *  Immediately calls the callback with current state so late registrations don't miss items. */
  setPushCallback(cb: (items: PendingPermItem[]) => void) {
    this._webviewPush = cb;
    this._pushToWebview(); // push current state immediately
  }

  /** Register a callback to push foreground session notifications to the webview */
  setNotifyPushCallback(cb: (items: ForegroundNotifyItem[]) => void) {
    this._notifyPush = cb;
  }

  /** Dismiss a foreground notification by tool_use_id (user clicked ✕) */
  dismissNotification(toolUseId: string) {
    this._notifyItems.delete(toolUseId);
    this._suppressedNotifyIds.add(toolUseId);
    this._pushNotifyToWebview();
  }

  /** Register a callback that returns whether the agent panel webview is currently visible */
  setPanelVisibleCallback(cb: () => boolean) {
    this._isPanelVisible = cb;
  }

  private _getLocalMode(): 'silent' | 'notifications' | 'panel' {
    return vscode.workspace.getConfiguration('claudeCodeInsights')
      .get<string>('permissionProxy.localNotificationMode', 'panel') as 'silent' | 'notifications' | 'panel';
  }

  private _getExternalMode(): 'silent' | 'notifications' | 'panel' {
    return vscode.workspace.getConfiguration('claudeCodeInsights')
      .get<string>('permissionProxy.externalNotificationMode', 'notifications') as 'silent' | 'notifications' | 'panel';
  }

  private _getFocusBehavior(): 'never' | 'idle' | 'always' {
    return vscode.workspace.getConfiguration('claudeCodeInsights')
      .get<string>('permissionProxy.focusBehavior', 'idle') as 'never' | 'idle' | 'always';
  }

  private _getFocusIdleMs(): number {
    return vscode.workspace.getConfiguration('claudeCodeInsights')
      .get<number>('permissionProxy.focusIdleMs', 3000);
  }

  /** Called from webview when user changes notification mode */
  async setNotificationMode(scope: 'local' | 'external', mode: 'silent' | 'notifications' | 'panel') {
    const config = vscode.workspace.getConfiguration('claudeCodeInsights');
    const key = scope === 'local'
      ? 'permissionProxy.localNotificationMode'
      : 'permissionProxy.externalNotificationMode';
    const target = scope === 'external'
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;
    await config.update(key, mode, target);
    this._log.appendLine(`[PermProxy] ${scope} notification mode set to: ${mode}`);
  }

  /** Get current modes for webview display */
  getNotificationModes(): { local: string; external: string } {
    return {
      local: this._getLocalMode(),
      external: this._getExternalMode(),
    };
  }

  /** Return current pending items (used on webview reload to restore state immediately).
   *  Scans disk directly so it's robust to _pending not yet being populated (e.g. after
   *  a VS Code window reload where session filter may not have run yet). */
  getPendingItems(): PendingPermItem[] {
    const items: PendingPermItem[] = [];
    const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
    const tracked = this._sessionFilter ? this._sessionFilter() : new Set<string>();
    try {
      const allFiles = fs.readdirSync(PERM_DIR);
      for (const file of allFiles) {
        if (!file.startsWith('req-') || !file.endsWith('.json')) continue;
        const uuid = file.replace('req-', '').replace('.json', '');
        const filePath = path.join(PERM_DIR, file);
        try {
          const req: PermissionRequest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const isExternal = tracked.size > 0 && !tracked.has(req.session_id);
          // If external and silent mode, skip entirely
          if (isExternal && this._getExternalMode() === 'silent') continue;
          const startTs = this._requestTimestamps.get(uuid) ??
            (req.timestamp ? new Date(req.timestamp).getTime() : Date.now());
          items.push({ uuid, command: req.command, toolName: req.tool_name, agentId: req.agent_id, startTs, timeout, isExternal: isExternal || undefined });
        } catch {}
      }
    } catch {}
    return items;
  }

  /** Push current pending items to the webview */
  private _pushToWebview() {
    if (!this._webviewPush) return;
    const items: PendingPermItem[] = [];
    const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
    // Resolve tracked sessions once for the loop
    const tracked = this._sessionFilter ? this._sessionFilter() : new Set<string>();
    for (const uuid of this._pending) {
      const startTs = this._requestTimestamps.get(uuid) ?? Date.now();
      const timedOut = this._timedOutAt.has(uuid);
      const isExternal = this._externalUuids.has(uuid);
      if (timedOut) {
        const cached = this._lastKnownRequests.get(uuid);
        if (cached) {
          // Session filter defense-in-depth — skip non-tracked non-external items
          if (!isExternal && tracked.size > 0 && !tracked.has(cached.session_id)) continue;
          items.push({ uuid, command: cached.command, toolName: cached.tool_name, agentId: cached.agent_id, startTs, timeout, timedOut: true, isExternal: isExternal || undefined });
        }
        continue;
      }
      const filePath = path.join(PERM_DIR, `req-${uuid}.json`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const req: PermissionRequest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Session filter defense-in-depth — skip non-tracked non-external items
        if (!isExternal && tracked.size > 0 && !tracked.has(req.session_id)) continue;
        items.push({ uuid, command: req.command, toolName: req.tool_name, agentId: req.agent_id, startTs, timeout, isExternal: isExternal || undefined });
      } catch {}
    }
    this._webviewPush(items);
  }

  /** Push foreground notifications to the webview */
  private _pushNotifyToWebview() {
    if (!this._notifyPush) return;
    const tracked = this._sessionFilter ? this._sessionFilter() : new Set<string>();
    if (tracked.size > 0) {
      this._notifyPush([...this._notifyItems.values()].filter(item => tracked.has(item.sessionId)));
    } else {
      this._notifyPush([...this._notifyItems.values()]);
    }
  }

  constructor(
    private readonly _context: vscode.ExtensionContext,
    log: vscode.OutputChannel,
    sessionFilter?: () => ReadonlySet<string>,
  ) {
    this._log = log;
    this._sessionFilter = sessionFilter;
    // Track typing activity for focus debounce — both editor and terminal input
    this._typingSubscription = vscode.workspace.onDidChangeTextDocument(() => {
      this._lastTypingMs = Date.now();
    });
    // Detect terminal keystrokes via echoed output (shell echoes input back)
    try {
      if (typeof (vscode.window as any).onDidWriteTerminalData === 'function') {
        this._focusSubscriptions.push(
          (vscode.window as any).onDidWriteTerminalData(() => {
            this._lastTypingMs = Date.now();
          }),
        );
      }
    } catch (e) { log.appendLine(`[PermProxy] onDidWriteTerminalData unavailable: ${e}`); }
    // Track what was last focused for restoration
    this._focusSubscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(e => {
        if (e) {
          this._lastFocusType = 'editor';
          this._lastActiveEditorUri = e.document.uri;
          this._lastActiveEditorColumn = e.viewColumn;
          this._lastActiveTerminal = undefined;
        }
      }),
      vscode.window.onDidChangeActiveTerminal(t => {
        if (t) {
          this._lastFocusType = 'terminal';
          this._lastActiveTerminal = t;
          this._lastActiveEditorUri = undefined;
          this._lastActiveEditorColumn = undefined;
        }
      }),
    );
    ensurePermDir(log);
    this._start();
  }

  private _start() {
    this._scan(); // immediate scan on startup to recover any pending requests
    this._pollTimer = setInterval(() => this._scan(), POLL_MS);
    this._log.appendLine('[PermProxy] Watching for permission requests');
  }

  private _scan() {
    if (this._disposed) return;
    let changed = false;
    let notifyChanged = false;
    try {
      const allFiles = listPermDir();

      // ── Background agent requests (req-*.json) ──
      const reqFiles = allFiles.filter(f => f.startsWith('req-') && f.endsWith('.json'));
      const liveUuids = new Set(reqFiles.map(f => f.replace('req-', '').replace('.json', '')));

      const decFiles = new Set(allFiles.filter(f => f.startsWith('dec-') && f.endsWith('.json'))
        .map(f => f.replace('dec-', '').replace('.json', '')));
      for (const uuid of [...this._pending]) {
        if (!liveUuids.has(uuid)) {
          // If another instance (or this one) wrote a decision for this uuid, propagate to the open panel
          if (decFiles.has(uuid)) {
            this._activePanelController?.notifyResolved(uuid, 'allow');
          }
          const startTs = this._requestTimestamps.get(uuid) ?? Date.now();
          const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
          const elapsed = (Date.now() - startTs) / 1000;

          // If the item timed out naturally (hook deleted the req file after timeout),
          // hold it in the UI for TIMEOUT_GRACE_MS so the user can see what expired
          // instead of the banner collapsing/flickering as the next command arrives.
          if (elapsed >= timeout - 1) {
            if (!this._timedOutAt.has(uuid)) {
              this._timedOutAt.set(uuid, Date.now());
              changed = true; // re-render to show timedOut state
            } else if (Date.now() - this._timedOutAt.get(uuid)! < TIMEOUT_GRACE_MS) {
              continue; // still in grace period — keep showing
            }
            // Grace period elapsed — fall through to evict
          }

          this._pending.delete(uuid);
          this._externalUuids.delete(uuid);
          this._requestTimestamps.delete(uuid);
          this._dismissCount.delete(uuid);
          this._timedOutAt.delete(uuid);
          this._lastKnownRequests.delete(uuid);
          this._recentlyResolved.set(uuid, Date.now());
          changed = true;
        }
      }
      // Only evict a resolved entry once its req file is actually gone (the hook deletes it
      // after reading the decision). The previous 10s TTL caused already-decided items to be
      // re-enqueued if the hook was slow or the agent had already exited.
      for (const [uuid] of [...this._recentlyResolved]) {
        if (!liveUuids.has(uuid)) {
          this._recentlyResolved.delete(uuid);
        }
      }
      if (this._recentlyResolved.size > 1000) {
        // Evict oldest entries (Map insertion order)
        const excess = this._recentlyResolved.size - 1000;
        let i = 0;
        for (const uuid of this._recentlyResolved.keys()) {
          if (i++ >= excess) break;
          this._recentlyResolved.delete(uuid);
        }
      }
      for (const file of reqFiles) {
        const uuid = file.replace('req-', '').replace('.json', '');
        if (this._pending.has(uuid)) continue;
        if (this._recentlyResolved.has(uuid)) continue; // suppress re-enqueue after inline allow/deny
        // Another instance already wrote a decision for this uuid — don't re-pop
        if (decFiles.has(uuid)) {
          this._recentlyResolved.set(uuid, Date.now());
          continue;
        }

        // Filter by session BEFORE adding to _pending — external sessions are routed by mode
        if (this._sessionFilter) {
          const tracked = this._sessionFilter();
          if (tracked.size > 0) {
            try {
              const reqPath = path.join(PERM_DIR, file);
              const req = JSON.parse(fs.readFileSync(reqPath, 'utf-8')) as PermissionRequest;
              if (!tracked.has(req.session_id)) {
                // External session — check mode before deciding to track
                const extMode = this._getExternalMode();
                if (extMode === 'silent') continue; // Skip entirely
                this._externalUuids.add(uuid); // Mark as external
              }
            } catch {
              continue; // Can't read file — skip
            }
          }
        }

        this._pending.add(uuid);
        this._enqueueRequest(path.join(PERM_DIR, file), uuid);
      }

      // ── Foreground session notifications (notify-*.json) ──
      {
        const PERM_TIMEOUT_MS = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10) * 1000;
        // After DISPLAY_TTL_MS the item is hidden from UI (command approved & running; file still on disk)
        const DISPLAY_TTL_MS = 60_000;
        const notifyFiles = allFiles.filter(f => f.startsWith('notify-') && f.endsWith('.json'));
        const liveNotifyIds = new Set(notifyFiles.map(f => f.replace('notify-', '').replace('.json', '')));

        // Remove notifications whose files have been deleted (PostToolUse cleaned up after command ran)
        for (const id of [...this._notifyItems.keys()]) {
          if (!liveNotifyIds.has(id)) {
            this._notifyItems.delete(id);
            this._suppressedNotifyIds.delete(id);
            notifyChanged = true;
          }
        }
        // Clean up suppressed IDs whose files are also gone
        for (const id of [...this._suppressedNotifyIds]) {
          if (!liveNotifyIds.has(id)) this._suppressedNotifyIds.delete(id);
        }
        // Add new notifications; expire stale ones (denied commands — PostToolUse never fires on deny)
        for (const file of notifyFiles) {
          const id = file.replace('notify-', '').replace('.json', '');
          const filePath = path.join(PERM_DIR, file);
          if (this._suppressedNotifyIds.has(id)) continue; // approved & running — hide from UI
          if (this._notifyItems.has(id)) {
            const item = this._notifyItems.get(id)!;
            const age = Date.now() - item.startTs;
            if (age > PERM_TIMEOUT_MS) {
              // Full TTL expired — delete file (deny path cleanup)
              this._notifyItems.delete(id);
              notifyChanged = true;
              try { fs.unlinkSync(filePath); } catch {}
            } else if (age > DISPLAY_TTL_MS) {
              // Display TTL expired — hide from UI but keep file (command approved & running)
              this._notifyItems.delete(id);
              this._suppressedNotifyIds.add(id);
              notifyChanged = true;
            }
            continue;
          }
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const n = JSON.parse(raw);
            const startTs = n.timestamp ? new Date(n.timestamp).getTime() : Date.now();
            const age = Date.now() - (isNaN(startTs) ? Date.now() : startTs);
            // Skip already-expired or already-suppressed files (stale from previous session)
            if (age > PERM_TIMEOUT_MS) {
              try { fs.unlinkSync(filePath); } catch {}
              continue;
            }
            if (age > DISPLAY_TTL_MS) {
              this._suppressedNotifyIds.add(id);
              continue;
            }
            this._notifyItems.set(id, {
              toolUseId: id,
              sessionId: n.session_id ?? '',
              command: n.command ?? '',
              startTs: isNaN(startTs) ? Date.now() : startTs,
            });
            notifyChanged = true;
          } catch {}
        }
      }
    } catch {
      // Directory may not exist yet
    }
    if (changed) this._pushToWebview();
    if (notifyChanged) this._pushNotifyToWebview();
  }

  private _enqueueRequest(filePath: string, uuid: string) {
    const req = readRequestFile(filePath);
    if (!req) {
      this._pending.delete(uuid);
      return;
    }

    // Filter: route external sessions by mode instead of dropping
    if (this._sessionFilter) {
      const tracked = this._sessionFilter();
      if (tracked.size > 0 && !tracked.has(req.session_id)) {
        const extMode = this._getExternalMode();
        if (extMode === 'silent') {
          this._log.appendLine(`[PermProxy] Ignoring request ${uuid.slice(0, 8)}: session ${req.session_id.slice(0, 8)} not tracked (silent mode)`);
          this._pending.delete(uuid);
          return;
        }
        this._externalUuids.add(uuid);
        this._log.appendLine(`[PermProxy] External request ${uuid.slice(0, 8)}: session ${req.session_id.slice(0, 8)} (mode=${extMode})`);
      }
    }

    if (!this._requestTimestamps.has(uuid)) {
      // Use the timestamp from the request file (survives window reloads)
      const reqTs = req.timestamp ? new Date(req.timestamp).getTime() : NaN;
      this._requestTimestamps.set(uuid, isNaN(reqTs) ? Date.now() : reqTs);
    }

    // Cache so we can still render the command after the req file is deleted (grace period)
    this._lastKnownRequests.set(uuid, req);

    this._batchQueue.push({ filePath, uuid, req });
    this._log.appendLine(`[PermProxy] Queued ${uuid.slice(0, 8)}: agent=${req.agent_id.slice(0, 8)} cmd=${req.command.slice(0, 80)}`);
    this._pushToWebview();

    // If no notification is active, schedule a batch flush
    if (!this._notificationActive) {
      if (this._batchTimer) clearTimeout(this._batchTimer);
      this._batchTimer = setTimeout(() => this._flushBatch(), BATCH_DELAY_MS);
    }
    // If a notification IS active, the items will be picked up after the current notification resolves
  }

  private async _flushBatch() {
    if (this._disposed || this._batchQueue.length === 0) return;

    // Take all items from the queue
    const batch = this._batchQueue.splice(0);

    // Filter out requests whose hook has already timed out (req file deleted)
    const live = batch.filter(item => {
      if (!fs.existsSync(item.filePath)) {
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: req file gone, hook already timed out`);
        this._pending.delete(item.uuid);
        this._requestTimestamps.delete(item.uuid);
        return false;
      }
      return true;
    });

    if (live.length === 0) return;

    if (live.length === 1) {
      await this._showSingleNotification(live[0]);
    } else {
      await this._showBatchNotification(live);
    }

    // After notification resolves, check if more items queued while we were waiting
    if (this._batchQueue.length > 0) {
      this._batchTimer = setTimeout(() => this._flushBatch(), BATCH_DELAY_MS);
    }
  }

  private _startCountdown(startTs: number, timeout: number, label: string) {
    this._stopCountdown();
    // Register click command for the status bar
    this._countdownCommand = vscode.commands.registerCommand('claudeCodeInsights._permAction', () => {
      this._showStatusBarAction();
    });
    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    sb.command = 'claudeCodeInsights._permAction';
    this._countdownStatusBar = sb;
    const update = () => {
      const rem = Math.max(0, Math.round(timeout - (Date.now() - startTs) / 1000));
      sb.text = `$(shield) ${label} — ${formatRemaining(rem)}`;
      sb.tooltip = 'Click to Allow/Deny this permission request';
      sb.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      sb.show();
      if (rem <= 0) this._stopCountdown();
    };
    update();
    this._countdownTimer = setInterval(update, 1000);
  }

  private _stopCountdown() {
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
    if (this._countdownStatusBar) { this._countdownStatusBar.dispose(); this._countdownStatusBar = null; }
    if (this._countdownCommand) { this._countdownCommand.dispose(); this._countdownCommand = null; }
  }

  /** Called when user clicks the status bar countdown — shows action quickpick for active items */
  private async _showStatusBarAction() {
    const items = this._activeItems.filter(item => fs.existsSync(item.filePath));
    if (items.length === 0) {
      vscode.window.showInformationMessage('No pending permission requests');
      return;
    }

    if (items.length === 1) {
      const item = items[0];
      const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
      const startTs = this._requestTimestamps.get(item.uuid)!;
      const rem = Math.max(0, Math.round(timeout - (Date.now() - startTs) / 1000));
      const cmdLines = item.req.command.trim().split('\n');
      const fullCmd = cmdLines.map((line, i) => i === 0 ? `$ ${line}` : `  ${line}`).join('\n');

      const choice = await vscode.window.showWarningMessage(
        `⟳ ${item.req.agent_id.slice(0, 8)}: ${formatRemaining(rem)} remaining`,
        { modal: false, detail: fullCmd },
        'Allow', 'Deny', 'View Agent',
      );
      if (choice === 'Allow' || choice === 'Deny' || choice === 'View Agent') {
        await this._handleSingleChoice(choice, item);
      }
      return;
    }

    // Multiple items — show summary with actions
    const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
    const minRem = Math.min(...items.map(item => {
      const startTs = this._requestTimestamps.get(item.uuid)!;
      return Math.max(0, Math.round(timeout - (Date.now() - startTs) / 1000));
    }));
    const cmdSummary = items.map(item => {
      const cmd = item.req.command.trim().split('\n')[0];
      return `• ${item.req.agent_id.slice(0, 8)}: $ ${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}`;
    }).join('\n');

    const choice = await vscode.window.showWarningMessage(
      `⟳ ${items.length} commands pending (${formatRemaining(minRem)})`,
      { modal: false, detail: cmdSummary },
      'Allow All', 'Deny All', 'Review Each',
    );

    if (choice === 'Allow All') {
      for (const item of items) {
        writeDecision(item.uuid, 'allow', this._log);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: allow (status bar batch)`);
        this._cleanup(item.uuid);
      }
      this._activeItems = [];
    } else if (choice === 'Deny All') {
      for (const item of items) {
        writeDecision(item.uuid, 'deny', this._log);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: deny (status bar batch)`);
        this._cleanup(item.uuid);
      }
      this._activeItems = [];
    } else if (choice === 'Review Each') {
      await this._reviewSequentially(items);
    }
  }

  /** Unified handler: shows a single batch panel for one or more commands */
  private async _showNotification(items: BatchQueueItem[]) {
    this._notificationActive = true;

    const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
    const earliestStart = Math.min(...items.map(item => this._requestTimestamps.get(item.uuid) ?? Date.now()));
    const minRemaining = Math.min(...items.map(item => {
      const elapsed = (Date.now() - (this._requestTimestamps.get(item.uuid) ?? Date.now())) / 1000;
      return Math.max(0, Math.round(timeout - elapsed));
    }));

    if (minRemaining <= 0) {
      for (const item of items) this._cleanup(item.uuid);
      this._notificationActive = false;
      return;
    }

    // Filter out items whose req files are gone (hook already timed out)
    const live = items.filter(item => {
      if (fs.existsSync(item.filePath)) return true;
      this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: req file gone before panel open`);
      this._cleanup(item.uuid);
      return false;
    });

    if (live.length === 0) { this._notificationActive = false; return; }

    const agentIds = [...new Set(live.map(i => i.req.agent_id))];
    const agentShort = agentIds.map(a => a.slice(0, 8)).join(', ');
    const countdownLabel = live.length === 1 ? `${agentShort}: allow?` : `${agentShort}: ${live.length} commands`;

    this._activeItems = [...live];
    this._startCountdown(earliestStart, timeout, countdownLabel);

    // Partition items by local vs external
    const localItems = live.filter(item => !this._externalUuids.has(item.uuid));
    const externalItems = live.filter(item => this._externalUuids.has(item.uuid));

    // Handle local items based on localNotificationMode
    const localMode = this._getLocalMode();
    if (localItems.length > 0) {
      if (localMode === 'silent') {
        this._log.appendLine(`[PermProxy] Local items silenced (${localItems.length} items)`);
        for (const item of localItems) this._cleanup(item.uuid);
      } else if (localMode === 'notifications') {
        await this.stealFocusWhenIdle(() => {});
        await this._showVscodeNotification(localItems);
      } else {
        // "panel" mode — use inline if panel is visible for these sessions, else dedicated panel
        if (this._isPanelVisible?.()) {
          this._log.appendLine(`[PermProxy] Panel visible — inline widget active for local items`);
          // Don't call _cleanup — let inline widget handle them
        } else {
          await this.stealFocusWhenIdle(() => {});
          await this._showDedicatedPanel(localItems, earliestStart, timeout);
        }
      }
    }

    // Handle external items based on externalNotificationMode
    const extMode = this._getExternalMode();
    if (externalItems.length > 0) {
      if (extMode === 'silent') {
        this._log.appendLine(`[PermProxy] External items silenced (${externalItems.length} items)`);
        for (const item of externalItems) this._cleanup(item.uuid);
      } else if (extMode === 'notifications') {
        await this.stealFocusWhenIdle(() => {});
        await this._showVscodeNotification(externalItems);
      } else {
        // "panel" mode — open dedicated panel for external items
        await this.stealFocusWhenIdle(() => {});
        await this._showDedicatedPanel(externalItems, earliestStart, timeout);
      }
    }

    this._activeItems = [];
    this._notificationActive = false;
  }

  /** Show a dedicated webview batch panel and handle the result */
  private async _showDedicatedPanel(items: BatchQueueItem[], earliestStart: number, timeout: number) {
    this._log.appendLine(`[PermProxy] Showing panel: ${items.length} commands`);
    const result = await showPermissionBatchPanel(this._context, items, earliestStart, timeout, ctrl => {
      this._activePanelController = ctrl;
    }, this._getFocusBehavior());
    this._activePanelController = null;
    this._stopCountdown();

    if (result === 'dismissed') {
      // Re-queue undecided items with backoff
      for (const item of items) {
        if (fs.existsSync(item.filePath)) {
          const count = (this._dismissCount.get(item.uuid) ?? 0) + 1;
          this._dismissCount.set(item.uuid, count);
          const backoffMs = Math.min(5000 * Math.pow(3, count - 1), 120_000);
          setTimeout(() => {
            if (this._disposed || !fs.existsSync(item.filePath)) { this._cleanup(item.uuid); return; }
            this._pending.delete(item.uuid);
          }, backoffMs);
        } else {
          this._cleanup(item.uuid);
        }
      }
    } else {
      for (const { uuid, decision } of result) {
        writeDecision(uuid, decision, this._log);
        this._log.appendLine(`[PermProxy] ${uuid.slice(0, 8)}: ${decision}`);
        this._cleanup(uuid);
      }
    }
  }

  /** Show VS Code native warning notifications for each item */
  private async _showVscodeNotification(items: BatchQueueItem[]) {
    for (const item of items) {
      const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
      const startTs = this._requestTimestamps.get(item.uuid) ?? Date.now();
      const rem = Math.max(0, Math.round(timeout - (Date.now() - startTs) / 1000));
      const cmdPreview = item.req.command.trim().split('\n')[0];
      const label = cmdPreview.length > 80 ? cmdPreview.slice(0, 77) + '...' : cmdPreview;

      const choice = await vscode.window.showWarningMessage(
        `$(shield) ${item.req.agent_id.slice(0, 8)}: $ ${label} (${formatRemaining(rem)})`,
        { modal: false },
        'Allow', 'Deny', 'Open Panel',
      );

      if (choice === 'Allow') {
        writeDecision(item.uuid, 'allow', this._log);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: allow (notification)`);
        this._cleanup(item.uuid);
      } else if (choice === 'Deny') {
        writeDecision(item.uuid, 'deny', this._log);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: deny (notification)`);
        this._cleanup(item.uuid);
      } else if (choice === 'Open Panel') {
        this.openApprovalPanel();
      } else {
        // Dismissed — backoff
        const count = (this._dismissCount.get(item.uuid) ?? 0) + 1;
        this._dismissCount.set(item.uuid, count);
        const backoffMs = Math.min(5000 * Math.pow(3, count - 1), 120_000);
        setTimeout(() => {
          if (this._disposed || !fs.existsSync(item.filePath)) { this._cleanup(item.uuid); return; }
          this._pending.delete(item.uuid);
        }, backoffMs);
      }
    }
  }

  // Keep for status-bar action "Review Each" path
  private async _showSingleNotification(item: BatchQueueItem) {
    return this._showNotification([item]);
  }

  private async _showBatchNotification(items: BatchQueueItem[]) {
    return this._showNotification(items);
  }

  /** Review commands sequentially — kept for status-bar action fallback */
  private async _reviewSequentially(items: BatchQueueItem[]) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (!fs.existsSync(item.filePath)) {
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: req file gone, skipping`);
        this._cleanup(item.uuid);
        continue;
      }

      const result = await showPermissionBatchPanel(this._context, [item], this._requestTimestamps.get(item.uuid) ?? Date.now(), parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10), undefined, this._getFocusBehavior());

      if (result === 'dismissed') {
        // backoff and continue
        if (fs.existsSync(item.filePath)) {
          const count = (this._dismissCount.get(item.uuid) ?? 0) + 1;
          this._dismissCount.set(item.uuid, count);
          const backoffMs = Math.min(5000 * Math.pow(3, count - 1), 120_000);
          setTimeout(() => {
            if (this._disposed) return;
            if (!fs.existsSync(item.filePath)) { this._cleanup(item.uuid); return; }
            this._pending.delete(item.uuid);
          }, backoffMs);
        } else {
          this._cleanup(item.uuid);
        }
        continue;
      }

      const decision = result[0]?.decision;
      if (decision === 'allow' || decision === 'deny') {
        writeDecision(item.uuid, decision, this._log);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: ${decision}`);
        this._cleanup(item.uuid);
      }
    }
  }

  private async _handleSingleChoice(
    choice: string | undefined,
    item: BatchQueueItem,
  ) {
    if (choice === undefined) {
      if (fs.existsSync(item.filePath)) {
        // Keep in _pending so _scan() won't re-discover it immediately.
        // Schedule a re-show with exponential backoff (5s, 15s, 45s, …)
        const count = (this._dismissCount.get(item.uuid) ?? 0) + 1;
        this._dismissCount.set(item.uuid, count);
        const backoffMs = Math.min(5000 * Math.pow(3, count - 1), 120_000);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: dismissed (#${count}), retry in ${backoffMs / 1000}s`);
        setTimeout(() => {
          if (this._disposed) return;
          if (!fs.existsSync(item.filePath)) { this._cleanup(item.uuid); return; }
          this._pending.delete(item.uuid); // Allow _scan() to re-discover
        }, backoffMs);
      } else {
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: dismissed, already timed out`);
        this._cleanup(item.uuid);
      }
      return;
    }

    if (choice === 'View Agent') {
      vscode.commands.executeCommand('claudeCodeInsights.openAgents');
      vscode.commands.executeCommand('claudeCodeInsights.focusAgent', item.req.agent_id);

      const fullChoice = await vscode.window.showInformationMessage(
        `Command from ${item.req.agent_id.slice(0, 8)}:`,
        { modal: false, detail: `$ ${item.req.command.trim()}` },
        'Allow',
        'Deny',
        'Copy Command',
      );

      if (fullChoice === 'Allow') {
        writeDecision(item.uuid, 'allow', this._log);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: allow (via View Agent)`);
        this._cleanup(item.uuid);
      } else if (fullChoice === 'Deny') {
        writeDecision(item.uuid, 'deny', this._log);
        this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: deny (via View Agent)`);
        this._cleanup(item.uuid);
      } else if (fullChoice === 'Copy Command') {
        vscode.env.clipboard.writeText(item.req.command.trim());
        vscode.window.showInformationMessage('Command copied to clipboard');
        // Keep in _pending, re-show after short delay
        setTimeout(() => {
          if (this._disposed) return;
          if (!fs.existsSync(item.filePath)) { this._cleanup(item.uuid); return; }
          this._pending.delete(item.uuid);
        }, 3000);
      } else {
        // Dismissed from View Agent — backoff like normal dismiss
        const count = (this._dismissCount.get(item.uuid) ?? 0) + 1;
        this._dismissCount.set(item.uuid, count);
        const backoffMs = Math.min(5000 * Math.pow(3, count - 1), 120_000);
        setTimeout(() => {
          if (this._disposed) return;
          if (!fs.existsSync(item.filePath)) { this._cleanup(item.uuid); return; }
          this._pending.delete(item.uuid);
        }, backoffMs);
      }
      return;
    }

    const decision = choice === 'Allow' ? 'allow' : 'deny';
    writeDecision(item.uuid, decision, this._log);
    this._log.appendLine(`[PermProxy] ${item.uuid.slice(0, 8)}: ${decision}`);
    this._cleanup(item.uuid);
  }

  /** Open the dedicated webview batch panel on demand (e.g. "Open panel" button in the inline widget) */
  openApprovalPanel() {
    // Reconstruct live items from _pending (the source of truth) instead of _activeItems,
    // which may be empty when the inline widget handled the notification flow.
    let live = this._activeItems.filter(item => fs.existsSync(item.filePath));
    if (live.length === 0) {
      // Fallback: build from _pending set (same data source as _pushToWebview)
      const reconstructed: BatchQueueItem[] = [];
      for (const uuid of this._pending) {
        if (this._timedOutAt.has(uuid)) continue;
        const filePath = path.join(PERM_DIR, `req-${uuid}.json`);
        if (!fs.existsSync(filePath)) continue;
        try {
          const req: PermissionRequest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          reconstructed.push({ filePath, uuid, req });
        } catch {}
      }
      live = reconstructed;
    }
    if (live.length === 0) {
      vscode.window.showInformationMessage('No pending permission requests');
      return;
    }
    const timeout = parseInt(process.env['CLAUDE_PERM_TIMEOUT'] || '600', 10);
    const earliestStart = Math.min(...live.map(item => this._requestTimestamps.get(item.uuid) ?? Date.now()));
    showPermissionBatchPanel(this._context, live, earliestStart, timeout, ctrl => {
      this._activePanelController = ctrl;
    }, this._getFocusBehavior()).then(result => {
      this._activePanelController = null;
      if (result !== 'dismissed') {
        this._stopCountdown();
        this._activeItems = [];
        this._notificationActive = false;
      }
    });
  }

  /** Resolve a permission request from the inline webview widget — no batch panel will open */
  resolveInline(uuid: string, decision: 'allow' | 'deny') {
    writeDecision(uuid, decision, this._log);
    // Remove from batch queue so the panel never opens for this uuid
    this._batchQueue = this._batchQueue.filter(item => item.uuid !== uuid);
    // If the dedicated approval panel is open, tell it this item was resolved externally
    // so it can update its UI instead of staying stale
    this._activePanelController?.notifyResolved(uuid, decision);
    this._cleanup(uuid);
  }

  private _cleanup(uuid: string) {
    this._pending.delete(uuid);
    this._externalUuids.delete(uuid);
    this._requestTimestamps.delete(uuid);
    this._dismissCount.delete(uuid);
    this._recentlyResolved.set(uuid, Date.now());
    this._pushToWebview();
  }

  /** Steal focus to the approval UI, waiting for typing/terminal to be idle first.
   *  Behavior is governed by `permissionProxy.focusBehavior`:
   *   - 'never'   : never steal focus (resolves without invoking stealFn)
   *   - 'idle'    : wait up to MAX_WAIT_MS for an idle window of focusIdleMs
   *   - 'always'  : invoke immediately
   */
  async stealFocusWhenIdle(stealFn: () => void): Promise<void> {
    const behavior = this._getFocusBehavior();
    if (behavior === 'never') return;
    if (behavior === 'always') { stealFn(); return; }
    const TYPING_IDLE_MS = Math.max(0, this._getFocusIdleMs());
    const MAX_WAIT_MS = 8000;
    const start = Date.now();
    const isTerminalActive = () => !!vscode.window.activeTerminal &&
      (this._lastFocusType === 'terminal' || !vscode.window.activeTextEditor);
    while (Date.now() - this._lastTypingMs < TYPING_IDLE_MS || isTerminalActive()) {
      if (Date.now() - start > MAX_WAIT_MS) break; // give up waiting
      await new Promise(r => setTimeout(r, 250));
    }
    stealFn();
  }

  /** Restore focus to the exact view that was active before focus was stolen. */
  restoreFocus(): void {
    if (this._lastFocusType === 'terminal' && this._lastActiveTerminal) {
      try {
        this._lastActiveTerminal.show(false);
        return;
      } catch { /* terminal may have been disposed — fall through */ }
    }
    if (this._lastFocusType === 'terminal') {
      vscode.commands.executeCommand('workbench.action.terminal.focus');
      return;
    }
    if (this._lastActiveEditorUri && this._lastActiveEditorColumn !== undefined) {
      Promise.resolve(vscode.workspace.openTextDocument(this._lastActiveEditorUri)).then(doc => {
        vscode.window.showTextDocument(doc, { viewColumn: this._lastActiveEditorColumn, preserveFocus: false });
      }).catch(() => {
        vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
      });
      return;
    }
    vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
  }

  dispose() {
    this._disposed = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._batchTimer) clearTimeout(this._batchTimer);
    this._stopCountdown();
    this._typingSubscription?.dispose();
    this._focusSubscriptions.forEach(d => d.dispose());
    this._requestTimestamps.clear();
    this._externalUuids.clear();
    // Do NOT cleanupReqFiles() on dispose: req files are shared across VS Code windows.
    // Deleting them here would wipe pending approvals owned by other instances and produce
    // the symptom of "approvals never appear until I reload the window".
  }
}
