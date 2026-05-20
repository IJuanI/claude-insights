import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { expandBlockLimit } from '../agentWebview';
import type { PanelLogger } from './types';
import type { SearchCoordinator } from './searchCoordinator';
import type { DiagnosticLog, HealthChecker } from '../diagnosticLog';

/**
 * Callback interface for message handling — delegates back to AgentPanelProvider
 * for state-dependent operations.
 */
export interface MessageHandlerCallbacks {
  handleSelectWorkspace(): void;
  handleSelectSession(): void;
  handleClearOverrides(): void;
  sendInitData(): void;
  refresh(): void;
  getDebugInfo(): Record<string, unknown>;
  showOutputChannel(): void;
  buildPanelInfo(): { conversation?: import('../agentParser').ConversationMessage[] };
  dumpConvDebug(): void;
  setConversationSessionId(id: string | undefined): void;
  focusSession(sessionId: string | null): void;
  jumpToSession(sessionId: string, messageIndex: number, projectKey?: string, searchQuery?: string): void;
  postToAll(msg: Record<string, unknown>): void;
  getPermProxy(): import('../permissionProxy').PermissionProxyWatcher | undefined;
  pushNotificationModes?(): void;
  restoreFocus?(): void;
}

/**
 * Routes webview messages to the appropriate handler.
 * Extracts the big switch/if-else from _handleMessage.
 */
export class MessageRouter {
  constructor(
    private readonly _callbacks: MessageHandlerCallbacks,
    private readonly _searchCoordinator: SearchCoordinator,
    private readonly _logger: PanelLogger,
    private readonly _diagLog: DiagnosticLog,
    private readonly _healthChecker: HealthChecker,
  ) {}

  async handleMessage(msg: { command: string; [key: string]: unknown }) {
    if (msg.command === 'selectWorkspace') this._callbacks.handleSelectWorkspace();
    else if (msg.command === 'selectSession') this._callbacks.handleSelectSession();
    else if (msg.command === 'clearOverrides') this._callbacks.handleClearOverrides();
    else if (msg.command === 'loadMore') {
      expandBlockLimit(msg.agentId as string);
      // Send updated task data via postMessage (don't reset HTML — that loses webview state)
      this._callbacks.sendInitData();
    } else if (msg.command === 'copyToClipboard') {
      vscode.env.clipboard.writeText(msg.text as string);
      vscode.window.showInformationMessage('Copied to clipboard');
    } else if (msg.command === 'webviewError') {
      const errText = msg.error as string;
      this._logger.log(`[WebviewError] ${errText}`);
      this._diagLog?.error('webview', 'renderError', errText);
    } else if (msg.command === 'copyDiagnostics') {
      const fullExport = {
        ...this._diagLog.exportAll(),
        state: this._callbacks.getDebugInfo(),
      };
      vscode.env.clipboard.writeText(JSON.stringify(fullExport, null, 2));
      vscode.window.showInformationMessage('Full diagnostics copied to clipboard');
    } else if (msg.command === 'showOutput') {
      this._callbacks.showOutputChannel();
    } else if (msg.command === 'loadTaskOutput') {
      this._handleLoadTaskOutput(msg.filePath as string);
    } else if (msg.command === 'webviewReady') {
      this._callbacks.sendInitData();
    } else if (msg.command === 'searchConversations') {
      this._searchCoordinator.handleSearch(msg.query as string, msg.scope as string, !!msg.matchCase, !!msg.matchWholeWord);
    } else if (msg.command === 'jumpToSession') {
      const query = (msg.searchQuery as string | undefined) || '';
      this._callbacks.jumpToSession(msg.sessionId as string, msg.messageIndex as number, msg.projectKey as string | undefined, query);
    } else if (msg.command === 'pong') {
      this._healthChecker.recordEvent('pongReceived');
    } else if (msg.command === 'clearDiagLog') {
      this._diagLog.clear();
    } else if (msg.command === 'dumpConvDebug') {
      this._callbacks.dumpConvDebug();
    } else if (msg.command === 'switchConversation') {
      // Only switches the Conversation tab — tasks are unaffected
      this._callbacks.setConversationSessionId((msg.sessionId as string) || undefined);
      this._callbacks.refresh();
    } else if (msg.command === 'focusSession') {
      const sessionId = msg.sessionId as string | null;
      this._callbacks.focusSession(sessionId);
    } else if (msg.command === 'openFile') {
      const filePath = msg.path as string | undefined;
      const oldString = msg.oldString as string | undefined;
      if (filePath) {
        const uri = vscode.Uri.file(filePath);
        vscode.workspace.openTextDocument(uri).then(doc => {
          let line = 0;
          if (oldString) {
            const text = doc.getText();
            const idx = text.indexOf(oldString);
            if (idx >= 0) line = doc.positionAt(idx).line;
          }
          vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Range(line, 0, line, 0),
          });
        }, () => {});
      }
    } else if (msg.command === 'dismissForegroundNotification') {
      this._callbacks.getPermProxy()?.dismissNotification(msg.toolUseId as string);
    } else if (msg.command === 'openPermPanel') {
      this._callbacks.getPermProxy()?.openApprovalPanel();
    } else if (msg.command === 'setNotificationMode') {
      const permProxy = this._callbacks.getPermProxy();
      if (permProxy) {
        permProxy.setNotificationMode(
          msg.scope as 'local' | 'external',
          msg.mode as 'silent' | 'notifications' | 'panel',
        );
      }
      this._callbacks.pushNotificationModes?.();
    } else if (msg.command === 'permDecision') {
      // Inline permission decision from conversation view — bypass batch panel
      const uuid = msg.uuid as string;
      const decision = msg.decision as 'allow' | 'deny';
      const permProxy = this._callbacks.getPermProxy();
      if (permProxy) {
        permProxy.resolveInline(uuid, decision);
        this._logger.log(`[PermProxy] Inline decision (via proxy): ${uuid.slice(0, 8)} → ${decision}`);
      } else {
        // Fallback: write directly if proxy not set
        const PERM_DIR = '/tmp/claude-permissions';
        const decFile = path.join(PERM_DIR, `dec-${uuid}.json`);
        const tmpFile = path.join(PERM_DIR, `.dec-${uuid}.tmp`);
        try {
          fs.writeFileSync(tmpFile, JSON.stringify({ decision }));
          fs.renameSync(tmpFile, decFile);
          this._logger.log(`[PermProxy] Inline decision (fallback): ${uuid.slice(0, 8)} → ${decision}`);
        } catch (e) {
          this._logger.log(`[PermProxy] Failed to write inline decision: ${e}`);
        }
      }
    } else if (msg.command === 'restoreFocus') {
      if (this._callbacks.restoreFocus) {
        this._callbacks.restoreFocus();
      } else {
        vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
      }
    }
  }

  private _handleLoadTaskOutput(filePath: string) {
    let content: string;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      content = raw.length > 10000 ? raw.slice(0, 10000) + '\n... (truncated)' : raw;
    } catch (e) {
      content = `Error reading file: ${e}`;
    }
    this._callbacks.postToAll({ command: 'taskOutputResult', content });
  }
}
