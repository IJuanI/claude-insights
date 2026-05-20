import * as vscode from 'vscode';

/**
 * Interface for posting messages to all active webviews (sidebar + editor panel).
 */
export interface WebviewPoster {
  postToAll(msg: Record<string, unknown>): void;
  getWebviews(): (vscode.Webview | undefined)[];
}

/**
 * Logging interface for modules extracted from AgentPanelProvider.
 */
export interface PanelLogger {
  log(msg: string): void;
}
