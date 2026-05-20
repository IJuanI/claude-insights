import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceInfo } from './types';
import { SessionRepository } from './sessionRepository';
import { buildWebviewData } from './serialization';

// ── SVG icon constants (codicon-style, 14×14 viewBox, currentColor) ──

const SVG_FOLDER = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3.5C1 2.67 1.67 2 2.5 2H5.5L7 3.5H11.5C12.33 3.5 13 4.17 13 5V10.5C13 11.33 12.33 12 11.5 12H2.5C1.67 12 1 11.33 1 10.5V3.5Z" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>`;

const SVG_ACTIVITY = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 2" stroke-linecap="round"/><circle cx="7" cy="7" r="2" fill="currentColor"/></svg>`;

const SVG_HEXNODE = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1.5L12 4.25V9.75L7 12.5L2 9.75V4.25L7 1.5Z" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>`;

// Sessions with agents: 3-layer stacked icon (no color — uses currentColor)
const SVG_LAYERS = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1.5L1.5 4.5L7 7.5L12.5 4.5L7 1.5Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" fill="none"/><path d="M1.5 7L7 10L12.5 7" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" fill="none"/><path d="M1.5 9.5L7 12.5L12.5 9.5" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" fill="none"/></svg>`;

const SVG_BUBBLE = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2.5C2 1.95 2.45 1.5 3 1.5H11C11.55 1.5 12 1.95 12 2.5V8.5C12 9.05 11.55 9.5 11 9.5H5L2 12V2.5Z" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>`;

const SVG_SPINNER = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" class="svg-spin"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3" stroke-dasharray="8 6" stroke-linecap="round"/></svg>`;

const SVG_CHECK = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const SVG_XMARK = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// Auto-edit mode badge icons (12×12) — match Claude Code's UI iconography
// Ask: shield icon (ask before edits)
const SVG_MODE_ASK = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1L2 3.5V7C2 10 4.5 12.5 7 13C9.5 12.5 12 10 12 7V3.5L7 1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`;
// Auto: code brackets </> (edit automatically)
const SVG_MODE_AUTO = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 3.5L1.5 7L4.5 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 3.5L12.5 7L9.5 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Plan: lightbulb
const SVG_MODE_PLAN = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 10.5V11.5C5.5 12.3 6.2 13 7 13C7.8 13 8.5 12.3 8.5 11.5V10.5" stroke="currentColor" stroke-width="1.1"/><path d="M7 1C4.5 1 2.5 3 2.5 5.5C2.5 7.2 3.5 8.7 5 9.5V10.5H9V9.5C10.5 8.7 11.5 7.2 11.5 5.5C11.5 3 9.5 1 7 1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`;

// ── Provider ──

export class SessionTreeProvider implements vscode.WebviewViewProvider {
  private _searchQuery = '';
  private _cache: WorkspaceInfo[] = [];
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _view?: vscode.WebviewView;
  private _fsWatchers: fs.FSWatcher[] = [];
  private _watchedDirs = new Set<string>();
  private _reloadDebounce?: ReturnType<typeof setTimeout>;
  private _repo = new SessionRepository();

  constructor() {
    this.reloadData();
    this._pollTimer = setInterval(() => this.reloadData(), 10_000);
    this._watchProjectsDir();
  }

  /** Watch ~/.claude/projects/ and subdirs for new/changed .jsonl files */
  private _watchProjectsDir() {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    try {
      if (!fs.existsSync(projectsDir)) return;
      // Watch the top-level projects dir for new workspace subdirs
      this._addDirWatch(projectsDir);
      // Watch each workspace subdir for new .jsonl session files
      for (const entry of fs.readdirSync(projectsDir)) {
        const sub = path.join(projectsDir, entry);
        try { if (fs.statSync(sub).isDirectory()) this._addDirWatch(sub); } catch {}
      }
    } catch {}
  }

  private static readonly MAX_DIR_WATCHERS = 20;
  // Ordered list of watched dirs (insertion order = oldest first)
  private _watchedDirList: string[] = [];
  // dir → watcher
  private _dirWatcherMap = new Map<string, fs.FSWatcher>();

  private _addDirWatch(dir: string) {
    if (this._watchedDirs.has(dir)) return;
    // Cap total watchers — evict oldest if at limit
    if (this._watchedDirList.length >= SessionTreeProvider.MAX_DIR_WATCHERS) {
      const oldest = this._watchedDirList.shift()!;
      try { this._dirWatcherMap.get(oldest)?.close(); } catch {}
      this._dirWatcherMap.delete(oldest);
      this._watchedDirs.delete(oldest);
      this._fsWatchers = this._fsWatchers.filter(w => w !== this._dirWatcherMap.get(oldest));
    }
    try {
      const watcher = fs.watch(dir, () => {
        // Debounce — multiple events fire for a single file creation
        if (this._reloadDebounce) clearTimeout(this._reloadDebounce);
        this._reloadDebounce = setTimeout(() => this.reloadData(), 500);
      });
      watcher.on('error', () => {}); // Silently ignore watch errors
      this._fsWatchers.push(watcher);
      this._watchedDirs.add(dir);
      this._watchedDirList.push(dir);
      this._dirWatcherMap.set(dir, watcher);
    } catch {}
  }

  getSearchQuery(): string {
    return this._searchQuery;
  }

  search(query: string) {
    this._searchQuery = query.toLowerCase().trim();
    // Clear cached search content so it's re-evaluated with new query
    for (const ws of this._cache) {
      for (const s of ws.sessions) {
        s.searchContent = undefined;
      }
    }
    this.updateWebview();
  }

  clearSearch() {
    this._searchQuery = '';
    this.updateWebview();
  }

  refresh() {
    this.reloadData();
  }

  dispose() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._reloadDebounce) clearTimeout(this._reloadDebounce);
    for (const w of this._fsWatchers) { try { w.close(); } catch {} }
    this._fsWatchers = [];
    this._watchedDirs.clear();
    this._watchedDirList = [];
    this._dirWatcherMap.clear();
  }

  // ── WebviewViewProvider ──

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(msg => {
      switch (msg.command) {
        case 'ready':
          this.updateWebview();
          break;
        case 'openSession':
          vscode.commands.executeCommand('claudeCodeInsights.openSessionAgents', msg.wsPath, msg.sessionId);
          break;
        case 'openAgent':
          vscode.commands.executeCommand('claudeCodeInsights.openSessionAgents', msg.wsPath, msg.sessionId, msg.agentId);
          break;
        case 'search':
          this._searchQuery = (msg.query || '').toLowerCase().trim();
          for (const ws of this._cache) {
            for (const s of ws.sessions) {
              s.searchContent = undefined;
            }
          }
          vscode.commands.executeCommand('setContext', 'claudeCodeInsights.sessionSearchActive', !!this._searchQuery);
          this.updateWebview();
          break;
        case 'copySessionId':
          vscode.env.clipboard.writeText(msg.sessionId);
          vscode.window.showInformationMessage('Copied session id');
          break;
        case 'copyAgentId':
          vscode.env.clipboard.writeText(`${msg.sessionId}/tasks/${msg.agentId}`);
          vscode.window.showInformationMessage('Copied agent path');
          break;
      }
    });

    webviewView.webview.html = SessionTreeProvider.getHtml();

    webviewView.onDidDispose(() => {
      this._view = undefined;
    });
  }

  private updateWebview() {
    if (!this._view) return;
    const data = buildWebviewData(
      this._cache,
      this._searchQuery,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      this._repo,
    );
    this._view.webview.postMessage({
      command: 'updateTree',
      workspaces: data,
      searchQuery: this._searchQuery,
    });
  }

  // ── HTML template ──

  static getHtml(): string {
    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  overflow-x: hidden;
}

/* Search bar */
.search-bar {
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border, transparent));
  position: sticky;
  top: 0;
  background: var(--vscode-sideBar-background);
  z-index: 10;
}
.search-container {
  position: relative;
  display: flex;
  align-items: center;
}
.search-bar input {
  width: 100%;
  padding: 3px 24px 3px 6px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  outline: none;
}
.search-bar input:focus {
  border-color: var(--vscode-focusBorder);
}
.search-bar input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
.search-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--vscode-input-foreground);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 2px;
  opacity: 0.6;
  display: none;
}
.search-clear:hover { opacity: 1; }
.search-clear.visible { display: block; }

/* Filter indicator */
.filter-bar {
  padding: 3px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 0.85em;
  display: none;
  align-items: center;
  gap: 4px;
}
.filter-bar.visible { display: flex; }
.filter-bar button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1em;
  padding: 0 2px;
  opacity: 0.8;
}
.filter-bar button:hover { opacity: 1; }

/* Tree container */
#tree {
  padding-bottom: 8px;
}

/* Empty state */
.empty-state {
  padding: 20px 12px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

/* ── Workspace folder row — looks like a folder item in native tree ── */
.workspace-section {}
.workspace-header {
  height: 22px;
  padding: 0 8px 0 0;
  display: flex;
  align-items: center;
  gap: 0;
  cursor: pointer;
  user-select: none;
}
.workspace-header:hover {
  background: var(--vscode-list-hoverBackground);
}
/* VS Code codicon-style chevron: stroked angle bracket > */
.collapse-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.12s ease;
  width: 16px;
  height: 22px;
  flex-shrink: 0;
  color: var(--vscode-foreground);
  transform: rotate(90deg);
}
.workspace-section.collapsed .collapse-icon {
  transform: rotate(0deg);
}
.ws-folder-icon {
  display: inline-flex;
  align-items: center;
  color: var(--vscode-charts-yellow, #cca700);
  flex-shrink: 0;
  margin-left: 2px;
  margin-right: 4px;
}
.ws-name {
  font-weight: 400;
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 22px;
}
.workspace-meta {
  margin-left: 6px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  flex-shrink: 0;
}
.workspace-section.collapsed .tree-children { display: none; }

/* ── Level 1 indent: sessions under workspace ── */
.tree-children {
  position: relative;
}
/* Indent guide — always visible like native VS Code file explorer */
.tree-children::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--vscode-tree-inactiveIndentGuidesStroke, rgba(128,128,128,0.2));
  pointer-events: none;
  z-index: 1;
}

/* ── Generic tree item — 22px row like native ── */
.tree-item {
  height: 22px;
  padding: 0 8px 0 0;
  cursor: pointer;
  user-select: none;
  position: relative;
  display: flex;
  align-items: center;
}
.tree-item:hover {
  background: var(--vscode-list-hoverBackground);
}
/* Running/errored left accent */
.tree-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 3px;
  width: 2px;
  background: var(--vscode-charts-blue, #3794ff);
  border-radius: 1px;
}
.tree-item.errored::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 3px;
  width: 2px;
  background: var(--vscode-charts-red, #f44747);
  border-radius: 1px;
}

/* ── Session item ── */
.session-item {
  display: flex;
  gap: 0;
  align-items: center;
  width: 100%;
  padding-left: 16px; /* indent under workspace */
}
.session-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 4px;
}
.session-icon.running { color: var(--vscode-charts-blue, #3794ff); }
.session-icon.agents { color: var(--vscode-descriptionForeground); }
.session-icon.conversation { color: var(--vscode-descriptionForeground); }
/* Chevron toggle for expandable sessions (has agents) */
.session-toggle {
  flex-shrink: 0;
  width: 16px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.12s ease;
  color: var(--vscode-foreground);
  transform: rotate(90deg);
}
/* Align chevron and icon to top for multi-line items */
.tree-item:has(.session-content.two-line) .session-toggle {
  align-self: flex-start;
  margin-top: 0;
}
.tree-item:has(.session-content.two-line) .session-icon {
  align-self: flex-start;
  margin-top: 3px;
}
.session-wrapper.collapsed .session-toggle {
  transform: rotate(0deg);
}
.session-wrapper.collapsed .agent-children { display: none; }
/* Placeholder: reserve chevron space so icons align (like files under folders) */
.session-toggle-placeholder {
  width: 16px;
  flex-shrink: 0;
}
.session-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
/* Single-line layout (no agents) */
.session-content.single-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* Two-line layout (has agents) */
.session-content.two-line {
  display: flex;
  flex-direction: column;
  gap: 0;
  line-height: 1.3;
}
.session-line1 {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.session-line2 {
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-line3 {
  font-size: 0.78em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.8;
}
.token-warn {
  color: var(--vscode-charts-orange, #e8ab53);
  margin-left: 4px;
}
.session-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 22px;
  flex-shrink: 1;
  min-width: 0;
}
.item-desc {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 45%;
}
.badge {
  display: inline-block;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 0.78em;
  font-weight: 500;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  line-height: 1.3;
  flex-shrink: 0;
}
/* Permission mode badge — icon-only */
.mode-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.mode-badge.mode-ask { color: var(--vscode-descriptionForeground); }
.mode-badge.mode-auto { color: var(--vscode-charts-orange, #e8ab53); }
.mode-badge.mode-plan { color: var(--vscode-charts-yellow, #cca700); }

/* Two-line sessions need auto height */
.tree-item:has(.session-content.two-line) {
  height: auto;
  min-height: 22px;
  padding-top: 2px;
  padding-bottom: 2px;
  align-items: flex-start;
}

/* ── Agent children: indented further under session ── */
.agent-children {
  position: relative;
}
/* No indent guide for 2nd level */

/* Agent item — deeper indent than session */
.agent-item {
  padding-left: 48px; /* 16px (session indent) + 16px (chevron) + 16px (icon) */
  display: flex;
  gap: 0;
  align-items: center;
  width: 100%;
}
.agent-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 4px;
}
.agent-icon.running { color: var(--vscode-charts-blue, #3794ff); }
.agent-icon.completed { color: var(--vscode-charts-green, #89d185); }
.agent-icon.errored { color: var(--vscode-charts-red, #f44747); }
.agent-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 6px;
}
.agent-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 22px;
  flex-shrink: 1;
  min-width: 0;
  font-size: 0.92em;
}

/* Context menu */
.context-menu {
  position: fixed;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));
  border-radius: 4px;
  padding: 4px 0;
  min-width: 120px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  z-index: 100;
  display: none;
}
.context-menu.visible { display: block; }
.context-menu-item {
  padding: 4px 12px;
  cursor: pointer;
  font-size: var(--vscode-font-size);
}
.context-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
}

/* SVG spinner animation */
@keyframes svg-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.svg-spin {
  animation: svg-spin 1.2s linear infinite;
  transform-origin: 7px 7px;
}
</style>
</head>
<body>
<div class="search-bar">
  <div class="search-container">
    <input type="text" id="searchInput" placeholder="Filter sessions..." />
    <button class="search-clear" id="searchClear" title="Clear filter">&times;</button>
  </div>
</div>
<div class="filter-bar" id="filterBar">
  <span id="filterText"></span>
  <button id="filterClear" title="Clear filter">&times;</button>
</div>
<div id="tree"></div>
<div class="context-menu" id="contextMenu">
  <div class="context-menu-item" id="ctxCopyId">Copy Id</div>
</div>

<script>
const vscode = acquireVsCodeApi();
const prevState = vscode.getState() || { collapsed: {}, sessionCollapsed: {}, searchQuery: '', scrollTop: 0 };
let state = { ...prevState };
let currentData = [];
let contextTarget = null;

// ── Search ──
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const filterBar = document.getElementById('filterBar');
const filterText = document.getElementById('filterText');
const filterClearBtn = document.getElementById('filterClear');

searchInput.value = state.searchQuery || '';
searchClear.classList.toggle('visible', !!searchInput.value);

let searchTimer;
searchInput.addEventListener('input', (e) => {
  const val = e.target.value;
  searchClear.classList.toggle('visible', !!val);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.searchQuery = val;
    vscode.setState(state);
    vscode.postMessage({ command: 'search', query: val });
  }, 200);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.remove('visible');
  state.searchQuery = '';
  vscode.setState(state);
  vscode.postMessage({ command: 'search', query: '' });
});

filterClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.remove('visible');
  state.searchQuery = '';
  vscode.setState(state);
  vscode.postMessage({ command: 'search', query: '' });
});

// ── Context menu ──
const contextMenu = document.getElementById('contextMenu');
const ctxCopyId = document.getElementById('ctxCopyId');

document.addEventListener('click', () => {
  contextMenu.classList.remove('visible');
});

ctxCopyId.addEventListener('click', () => {
  if (!contextTarget) return;
  if (contextTarget.type === 'session') {
    vscode.postMessage({ command: 'copySessionId', sessionId: contextTarget.sessionId });
  } else if (contextTarget.type === 'agent') {
    vscode.postMessage({ command: 'copyAgentId', sessionId: contextTarget.sessionId, agentId: contextTarget.agentId });
  }
  contextMenu.classList.remove('visible');
});

// ── Message handling ──
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'updateTree') {
    currentData = msg.workspaces;
    if (msg.searchQuery !== undefined) {
      searchInput.value = msg.searchQuery;
      searchClear.classList.toggle('visible', !!msg.searchQuery);
      state.searchQuery = msg.searchQuery;
    }
    renderTree(currentData, msg.searchQuery);
    vscode.setState(state);
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}

function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

function renderTree(workspaces, searchQuery) {
  const container = document.getElementById('tree');
  const scrollTop = container.parentElement.scrollTop;

  if (!workspaces || workspaces.length === 0) {
    container.innerHTML = '<div class="empty-state">No sessions found</div>';
    return;
  }

  const isSearching = !!searchQuery;
  let html = '';

  for (const ws of workspaces) {
    const wsKey = ws.projectKey;
    // Auto-collapse non-current workspaces when > 3, unless searching
    if (state.collapsed[wsKey] === undefined) {
      state.collapsed[wsKey] = !isSearching && !ws.isCurrent && workspaces.length > 3;
    }
    // When searching, force expand all
    const isCollapsed = isSearching ? false : state.collapsed[wsKey];

    const meta = ws.hasRunning
      ? escapeHtml(ws.sessionCount + ' session' + (ws.sessionCount !== 1 ? 's' : '') + ' · active')
      : escapeHtml(ws.sessionCount + ' session' + (ws.sessionCount !== 1 ? 's' : ''));

    html += '<div class="workspace-section' + (isCollapsed ? ' collapsed' : '') + '" data-ws-key="' + escapeHtml(wsKey) + '">';
    html += '<div class="workspace-header" data-action="toggle-ws" title="' + escapeHtml(ws.shortPath) + '">';
    html += '<span class="collapse-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.146 3.146a.5.5 0 0 0 0 .707l4.146 4.146-4.146 4.146a.5.5 0 0 0 .707.707l4.5-4.5a.5.5 0 0 0 0-.707l-4.5-4.5a.5.5 0 0 0-.707 0Z"/></svg></span>';
    html += '<span class="ws-folder-icon">${SVG_FOLDER}</span>';
    html += '<span class="ws-name">' + escapeHtml(ws.folderName) + '</span>';
    html += '<span class="workspace-meta">' + meta + '</span>';
    html += '</div>';
    html += '<div class="tree-children">';

    for (const session of ws.sessions) {
      var hasAgents = session.agents.length > 0;
      var sessKey = session.sessionId;
      // When searching and agents match, force expand
      var forceExpand = isSearching && hasAgents;
      if (state.sessionCollapsed[sessKey] === undefined) {
        state.sessionCollapsed[sessKey] = !forceExpand;
      }
      var sessCollapsed = forceExpand ? false : state.sessionCollapsed[sessKey];

      var statusClass = session.hasRunning ? 'active' : '';
      var iconHtml = session.iconType === 'running'
        ? '${SVG_SPINNER}'
        : session.iconType === 'agents'
          ? '${SVG_LAYERS}'
          : '${SVG_BUBBLE}';

      // Strip <task-notification> XML from display name
      var rawName = session.displayName;
      var cleanName = rawName;
      if (rawName && rawName.trim().startsWith('<task-notification>')) {
        var taskMatch = rawName.match(new RegExp('<summary>([\\s\\S]*?)</summary>'));
        if (taskMatch) {
          cleanName = taskMatch[1].trim();
        } else {
          var innerText = rawName.replace(/<[^>]+>/g, '').trim();
          cleanName = innerText || 'Background task notification';
        }
      }

      // Build tooltip for session (&#10; = newline in HTML title attribute)
      var NL = '&#10;';
      var sizeStr = session.fileSize > 0 ? formatSize(session.fileSize) : '';
      var sessionTooltip = cleanName + NL
        + session.convTurns + ' msgs'
        + (session.agentCount > 0 ? ' · ' + session.agentCount + ' agent' + (session.agentCount !== 1 ? 's' : '') : '')
        + (sizeStr ? ' · ' + sizeStr : '')
        + NL + session.timeAgo
        + NL + 'ID: ' + session.sessionId;

      // Permission mode icon badge
      var modeBadgeHtml = '';
      if (session.permissionMode === 'acceptEdits') {
        modeBadgeHtml = '<span class="mode-badge mode-auto" title="Edit automatically">${SVG_MODE_AUTO}</span>';
      } else if (session.permissionMode === 'bypassPermissions') {
        modeBadgeHtml = '<span class="mode-badge mode-auto" title="Edit automatically (bypass)">${SVG_MODE_AUTO}</span>';
      } else if (session.permissionMode === 'plan') {
        modeBadgeHtml = '<span class="mode-badge mode-plan" title="Plan mode">${SVG_MODE_PLAN}</span>';
      } else if (session.permissionMode && session.permissionMode !== 'default') {
        modeBadgeHtml = '<span class="mode-badge mode-ask" title="Ask before edits">${SVG_MODE_ASK}</span>';
      }

      html += '<div class="session-wrapper' + (sessCollapsed ? ' collapsed' : '') + '" data-session-key="' + escapeHtml(sessKey) + '">';
      html += '<div class="tree-item ' + statusClass + '" data-action="open-session" data-ws-path="' + escapeHtml(session.wsPath) + '" data-session-id="' + escapeHtml(session.sessionId) + '" title="' + escapeHtml(sessionTooltip) + '">';
      html += '<div class="session-item">';

      // Always reserve toggle width so icon/text aligns whether or not agents exist
      if (hasAgents) {
        html += '<span class="session-toggle" data-action="toggle-session" data-session-key="' + escapeHtml(sessKey) + '"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.146 3.146a.5.5 0 0 0 0 .707l4.146 4.146-4.146 4.146a.5.5 0 0 0 .707.707l4.5-4.5a.5.5 0 0 0 0-.707l-4.5-4.5a.5.5 0 0 0-.707 0Z"/></svg></span>';
      } else {
        html += '<span class="session-toggle-placeholder"></span>';
      }

      html += '<span class="session-icon ' + session.iconType + '">' + iconHtml + '</span>';

      // Token usage line (shared between both layouts)
      var tokenLineHtml = '';
      if (session.tokenUsage && session.tokenUsage.totalTokens > 0) {
        var tokStr = formatTokens(session.tokenUsage.totalTokens) + ' tok';
        var warnHtml = session.tokenUsage.avgCacheRead > 200000
          ? '<span class="token-warn">⚠ high context</span>'
          : '';
        tokenLineHtml = '<div class="session-line3">' + escapeHtml(tokStr) + warnHtml + '</div>';
      }

      if (hasAgents) {
        // Two-line layout for sessions with agents
        var line2Parts = [];
        if (session.convTurns > 0) line2Parts.push(session.convTurns + ' msgs');
        if (session.agentCount > 0) line2Parts.push(session.agentCount + ' agent' + (session.agentCount !== 1 ? 's' : ''));
        if (sizeStr) line2Parts.push(sizeStr);
        line2Parts.push(session.timeAgo);
        var line2Str = line2Parts.join(' · ');
        html += '<div class="session-content two-line">';
        html += '<div class="session-line1">';
        html += '<span class="session-name">' + escapeHtml(cleanName) + '</span>';
        if (modeBadgeHtml) html += modeBadgeHtml;
        html += '</div>'; // session-line1
        if (line2Str) {
          html += '<div class="session-line2">' + escapeHtml(line2Str) + '</div>';
        }
        if (tokenLineHtml) html += tokenLineHtml;
        html += '</div>'; // session-content two-line
      } else {
        // Single-line layout for simple sessions
        var metaParts = [];
        if (session.convTurns > 0) metaParts.push(session.convTurns + ' msgs');
        if (sizeStr) metaParts.push(sizeStr);
        metaParts.push(session.timeAgo);
        var metaStr = metaParts.join(' · ');
        if (tokenLineHtml) {
          // Switch to two-line layout to accommodate token info
          html += '<div class="session-content two-line">';
          html += '<div class="session-line1">';
          html += '<span class="session-name">' + escapeHtml(cleanName) + '</span>';
          if (modeBadgeHtml) html += modeBadgeHtml;
          html += '<span class="item-desc">' + escapeHtml(metaStr) + '</span>';
          html += '</div>'; // session-line1
          html += tokenLineHtml;
          html += '</div>'; // session-content two-line
        } else {
          html += '<div class="session-content single-line">';
          html += '<span class="session-name">' + escapeHtml(cleanName) + '</span>';
          if (modeBadgeHtml) html += modeBadgeHtml;
          html += '<span class="item-desc">' + escapeHtml(metaStr) + '</span>';
          html += '</div>'; // session-content single-line
        }
      }

      html += '</div>'; // session-item
      html += '</div>'; // tree-item

      // Agent children
      if (hasAgents) {
        html += '<div class="agent-children">';
        for (var ai = 0; ai < session.agents.length; ai++) {
          var agent = session.agents[ai];
          var agentStatusClass = agent.status === 'running' ? 'active'
            : agent.status === 'errored' ? 'errored' : '';
          var agentIconHtml = agent.status === 'running'
            ? '${SVG_SPINNER}'
            : agent.status === 'completed'
              ? '${SVG_CHECK}'
              : '${SVG_XMARK}';

          var agentTooltip = agent.description + NL
            + agent.messageCount + ' msgs · ' + agent.status
            + NL + agent.timeAgo
            + (agent.modelShort ? NL + 'Model: ' + agent.modelShort : '')
            + NL + 'ID: ' + agent.agentId;

          html += '<div class="tree-item ' + agentStatusClass + '" data-action="open-agent" data-ws-path="' + escapeHtml(agent.wsPath) + '" data-session-id="' + escapeHtml(agent.sessionId) + '" data-agent-id="' + escapeHtml(agent.agentId) + '" title="' + escapeHtml(agentTooltip) + '">';
          html += '<div class="agent-item">';
          html += '<span class="agent-icon ' + agent.status + '">' + agentIconHtml + '</span>';
          html += '<div class="agent-content">';
          html += '<span class="agent-name">' + escapeHtml(agent.description) + '</span>';

          var agentMetaParts = [];
          if (agent.modelShort) agentMetaParts.push(agent.modelShort);
          if (agent.messageCount > 0) agentMetaParts.push(agent.messageCount + ' msg' + (agent.messageCount !== 1 ? 's' : ''));
          agentMetaParts.push(agent.timeAgo);
          html += '<span class="item-desc">' + escapeHtml(agentMetaParts.join(' · ')) + '</span>';

          html += '</div>'; // agent-content
          html += '</div>'; // agent-item
          html += '</div>'; // tree-item
        }
        html += '</div>'; // agent-children
      }

      html += '</div>'; // session-wrapper
    }

    html += '</div>'; // tree-children
    html += '</div>'; // workspace-section
  }

  container.innerHTML = html;

  // Restore scroll position
  requestAnimationFrame(() => {
    container.parentElement.scrollTop = scrollTop;
  });
}

// Event delegation — no inline onclick needed (avoids esbuild quote-escaping issues)
document.addEventListener('click', function(e) {
  var target = e.target;
  // Walk up to find an element with data-action
  while (target && target !== document.body) {
    var action = target.getAttribute('data-action');
    if (action === 'toggle-ws') {
      var wsEl = target.closest('.workspace-section');
      if (wsEl) {
        var key = wsEl.getAttribute('data-ws-key');
        state.collapsed[key] = !state.collapsed[key];
        vscode.setState(state);
        wsEl.classList.toggle('collapsed');
      }
      return;
    }
    if (action === 'toggle-session') {
      e.stopPropagation();
      var sessKey = target.getAttribute('data-session-key');
      state.sessionCollapsed[sessKey] = !state.sessionCollapsed[sessKey];
      vscode.setState(state);
      var sessEl = document.querySelector('[data-session-key="' + sessKey + '"]');
      if (sessEl) sessEl.classList.toggle('collapsed');
      return;
    }
    if (action === 'open-agent') {
      vscode.postMessage({ command: 'openAgent', wsPath: target.getAttribute('data-ws-path'), sessionId: target.getAttribute('data-session-id'), agentId: target.getAttribute('data-agent-id') });
      return;
    }
    if (action === 'open-session') {
      // Don't trigger if clicking the toggle arrow (handled above)
      vscode.postMessage({ command: 'openSession', wsPath: target.getAttribute('data-ws-path'), sessionId: target.getAttribute('data-session-id') });
      return;
    }
    target = target.parentElement;
  }
});

document.addEventListener('contextmenu', function(e) {
  var target = e.target;
  while (target && target !== document.body) {
    var action = target.getAttribute('data-action');
    if (action === 'open-session') {
      e.preventDefault();
      e.stopPropagation();
      contextTarget = { type: 'session', sessionId: target.getAttribute('data-session-id') };
      var menu = document.getElementById('contextMenu');
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.add('visible');
      return;
    }
    if (action === 'open-agent') {
      e.preventDefault();
      e.stopPropagation();
      contextTarget = { type: 'agent', sessionId: target.getAttribute('data-session-id'), agentId: target.getAttribute('data-agent-id') };
      var menu = document.getElementById('contextMenu');
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.add('visible');
      return;
    }
    target = target.parentElement;
  }
});

// Signal ready
vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }

  // ── Data loading ──

  private reloadData() {
    const workspaces = this._repo.loadWorkspaces();

    // Sort workspaces: current workspace first, then by most recent session
    const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    workspaces.sort((a, b) => {
      if (a.wsPath === currentWs) return -1;
      if (b.wsPath === currentWs) return 1;
      const aMax = a.sessions[0]?.mtime ?? 0;
      const bMax = b.sessions[0]?.mtime ?? 0;
      return bMax - aMax;
    });

    this._cache = workspaces;

    this.updateWebview();

    // Watch any newly discovered workspace subdirs for new session files
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    try {
      const entries = fs.readdirSync(projectsDir).filter(d => {
        try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
      for (const key of entries) {
        this._addDirWatch(path.join(projectsDir, key));
      }
    } catch {}
  }
}
