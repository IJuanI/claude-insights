import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSessionDisplayName,
  findSessionsWithTasks,
  getTasksDir,
  listAgentFiles,
} from './agentParser';

// ── Data types ──

interface WorkspaceInfo {
  projectKey: string;
  wsPath: string;
  sessions: SessionMeta[];
}

interface SessionMeta {
  sessionId: string;
  displayName: string;
  mtime: number;
  hasAgents: boolean;
  agents: AgentMeta[];
}

interface AgentMeta {
  agentId: string;
  description: string;
  model?: string;
  status: 'running' | 'completed' | 'errored';
  startedAt: string;
}

// ── Tree items ──

type TreeItem = WorkspaceItem | SessionItem | AgentItem;

class WorkspaceItem extends vscode.TreeItem {
  constructor(
    public readonly wsPath: string,
    public readonly projectKey: string,
    sessionCount: number,
    hasRunning: boolean,
  ) {
    super(shortenPath(wsPath), vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${sessionCount} session${sessionCount !== 1 ? 's' : ''}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'workspace';
    if (hasRunning) {
      this.description += ' · active';
    }
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly meta: SessionMeta,
    public readonly wsPath: string,
  ) {
    super(
      meta.displayName,
      meta.agents.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.description = timeAgo(meta.mtime);
    this.tooltip = new vscode.MarkdownString(
      `**${meta.displayName}**\n\n` +
      `Session: \`${meta.sessionId}\`\n\n` +
      `Last modified: ${new Date(meta.mtime).toLocaleString()}\n\n` +
      (meta.agents.length > 0 ? `Agents: ${meta.agents.length}` : 'No background agents'),
    );
    const hasRunning = meta.agents.some(a => a.status === 'running');
    this.iconPath = new vscode.ThemeIcon(
      hasRunning ? 'loading~spin' : meta.hasAgents ? 'symbol-event' : 'comment-discussion',
      hasRunning ? new vscode.ThemeColor('charts.blue') : undefined,
    );
    this.contextValue = 'session';
  }
}

class AgentItem extends vscode.TreeItem {
  constructor(public readonly meta: AgentMeta, public readonly sessionId: string) {
    super(meta.description, vscode.TreeItemCollapsibleState.None);
    const isRunning = meta.status === 'running';
    this.description = [
      meta.model?.replace('claude-', ''),
      timeAgo(Date.parse(meta.startedAt)),
    ].filter(Boolean).join(' · ');
    this.iconPath = new vscode.ThemeIcon(
      isRunning ? 'loading~spin' : meta.status === 'completed' ? 'check' : 'error',
      isRunning
        ? new vscode.ThemeColor('charts.blue')
        : meta.status === 'completed'
          ? new vscode.ThemeColor('charts.green')
          : new vscode.ThemeColor('charts.red'),
    );
    this.tooltip = new vscode.MarkdownString(
      `**${meta.description}**\n\n` +
      `Agent: \`${meta.agentId}\`\n\n` +
      `Status: ${meta.status}\n\n` +
      (meta.model ? `Model: ${meta.model}` : ''),
    );
    this.contextValue = 'agent';
  }
}

// ── Provider ──

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _searchQuery = '';
  private _cache: WorkspaceInfo[] = [];
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _treeView?: vscode.TreeView<TreeItem>;

  constructor() {
    this.reloadData();
    this._pollTimer = setInterval(() => this.reloadData(), 10_000);
  }

  setTreeView(view: vscode.TreeView<TreeItem>) {
    this._treeView = view;
  }

  search(query: string) {
    this._searchQuery = query.toLowerCase().trim();
    this._onDidChangeTreeData.fire();
    if (this._treeView) {
      this._treeView.message = this._searchQuery
        ? `Searching: "${this._searchQuery}"`
        : undefined;
    }
  }

  clearSearch() {
    this._searchQuery = '';
    this._onDidChangeTreeData.fire();
    if (this._treeView) {
      this._treeView.message = undefined;
    }
  }

  refresh() {
    this.reloadData();
  }

  dispose() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._onDidChangeTreeData.dispose();
  }

  // ── TreeDataProvider ──

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.getRootItems();
    }
    if (element instanceof WorkspaceItem) {
      return this.getSessionItems(element.projectKey, element.wsPath);
    }
    if (element instanceof SessionItem) {
      return this.getAgentItems(element.meta);
    }
    return [];
  }

  // ── Data loading ──

  private reloadData() {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    let entries: string[];
    try {
      entries = fs.readdirSync(projectsDir).filter(d => {
        try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
    } catch {
      this._cache = [];
      this._onDidChangeTreeData.fire();
      return;
    }

    const workspaces: WorkspaceInfo[] = [];

    for (const key of entries) {
      const wsPath = key.replace(/^-/, '/').replace(/-/g, '/');
      const dir = path.join(projectsDir, key);

      let jsonlFiles: { name: string; mtime: number }[];
      try {
        jsonlFiles = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            try {
              return { name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs };
            } catch { return null; }
          })
          .filter((f): f is { name: string; mtime: number } => f !== null)
          .sort((a, b) => b.mtime - a.mtime);
      } catch { continue; }

      if (jsonlFiles.length === 0) continue;

      const sessionsWithTasks = new Set(findSessionsWithTasks(wsPath));

      const sessions: SessionMeta[] = jsonlFiles.map(f => {
        const sessionId = f.name.replace('.jsonl', '');
        const hasAgents = sessionsWithTasks.has(sessionId);
        const displayName = getSessionDisplayName(wsPath, sessionId);
        const agents = hasAgents ? this.loadAgentMetas(wsPath, sessionId) : [];
        return { sessionId, displayName, mtime: f.mtime, hasAgents, agents };
      });

      workspaces.push({ projectKey: key, wsPath, sessions });
    }

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
    this._onDidChangeTreeData.fire();
  }

  private loadAgentMetas(wsPath: string, sessionId: string): AgentMeta[] {
    const tasksDir = getTasksDir(wsPath, sessionId);
    const files = listAgentFiles(tasksDir);
    const agents: AgentMeta[] = [];

    for (const file of files) {
      const agentId = path.basename(file).replace('.output', '');
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const stat = fs.fstatSync(fd);
        fs.closeSync(fd);

        const raw = buf.toString('utf-8', 0, bytesRead);
        const firstLine = raw.split('\n')[0];
        let description = agentId.slice(0, 12);
        let model: string | undefined;
        let startedAt = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();

        try {
          const entry = JSON.parse(firstLine);
          if (entry.message?.content) {
            const content = entry.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  // First text is usually the description/prompt
                  description = block.text.slice(0, 100).split('\n')[0];
                  break;
                }
              }
            }
          }
          if (entry.model) model = entry.model;
          if (entry.timestamp) startedAt = entry.timestamp;
        } catch {}

        // Check completion
        const isStale = (Date.now() - stat.mtimeMs) > 30_000;
        let completed = false;
        if (isStale) {
          // Check last few lines for stop_reason
          const tailBuf = Buffer.alloc(4096);
          const tailFd = fs.openSync(file, 'r');
          const tailOffset = Math.max(0, stat.size - 4096);
          fs.readSync(tailFd, tailBuf, 0, tailBuf.length, tailOffset);
          fs.closeSync(tailFd);
          const tail = tailBuf.toString('utf-8');
          completed = tail.includes('"stop_reason":"end_turn"') || tail.includes('"stop_reason": "end_turn"');
        }

        agents.push({
          agentId,
          description,
          model,
          status: completed || isStale ? 'completed' : 'running',
          startedAt,
        });
      } catch {}
    }

    // Sort: running first, then by startedAt desc
    agents.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (a.status !== 'running' && b.status === 'running') return 1;
      return b.startedAt.localeCompare(a.startedAt);
    });

    return agents;
  }

  // ── Tree building with search filter ──

  private getRootItems(): TreeItem[] {
    const q = this._searchQuery;
    const items: WorkspaceItem[] = [];

    for (const ws of this._cache) {
      const matchingSessions = this.filterSessions(ws, q);
      if (q && matchingSessions.length === 0) continue;

      const hasRunning = ws.sessions.some(s => s.agents.some(a => a.status === 'running'));
      const item = new WorkspaceItem(
        ws.wsPath,
        ws.projectKey,
        q ? matchingSessions.length : ws.sessions.length,
        hasRunning,
      );
      // Auto-expand when searching
      if (q) item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      items.push(item);
    }

    return items;
  }

  private getSessionItems(projectKey: string, wsPath: string): TreeItem[] {
    const ws = this._cache.find(w => w.projectKey === projectKey);
    if (!ws) return [];

    const q = this._searchQuery;
    const sessions = q ? this.filterSessions(ws, q) : ws.sessions;

    return sessions.map(s => {
      const item = new SessionItem(s, wsPath);
      // Auto-expand sessions with matching agents when searching
      if (q && s.agents.some(a => this.matchesAgent(a, q))) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      }
      return item;
    });
  }

  private getAgentItems(session: SessionMeta): TreeItem[] {
    const q = this._searchQuery;
    const agents = q
      ? session.agents.filter(a => this.matchesAgent(a, q))
      : session.agents;
    return agents.map(a => new AgentItem(a, session.sessionId));
  }

  private filterSessions(ws: WorkspaceInfo, query: string): SessionMeta[] {
    if (!query) return ws.sessions;
    return ws.sessions.filter(s =>
      this.matchesSession(s, query) ||
      s.agents.some(a => this.matchesAgent(a, query)),
    );
  }

  private matchesSession(s: SessionMeta, q: string): boolean {
    return s.displayName.toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q);
  }

  private matchesAgent(a: AgentMeta, q: string): boolean {
    return a.description.toLowerCase().includes(q) ||
      a.agentId.toLowerCase().includes(q) ||
      (a.model?.toLowerCase().includes(q) ?? false) ||
      a.status.includes(q);
  }
}

// ── Deep content search (for command palette search) ──

export interface SearchResult {
  wsPath: string;
  sessionId: string;
  sessionName: string;
  type: 'session' | 'agent';
  agentId?: string;
  agentDescription?: string;
  matchContext: string;
}

/**
 * Deep search across all workspaces, sessions, and agent content.
 * Reads JSONL head+tail to search through session messages and agent output.
 */
export function deepSearch(query: string, maxResults = 50): SearchResult[] {
  const q = query.toLowerCase();
  const results: SearchResult[] = [];
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir).filter(d => {
      try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }

  for (const key of entries) {
    if (results.length >= maxResults) break;
    const wsPath = key.replace(/^-/, '/').replace(/-/g, '/');
    const dir = path.join(projectsDir, key);

    let files: string[];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      if (results.length >= maxResults) break;
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(dir, file);

      try {
        const fd = fs.openSync(filePath, 'r');
        const stat = fs.fstatSync(fd);
        const headSize = Math.min(65536, stat.size);
        const headBuf = Buffer.alloc(headSize);
        fs.readSync(fd, headBuf, 0, headSize, 0);
        const head = headBuf.toString('utf-8');

        let tail = head;
        if (stat.size > 65536) {
          const tailBuf = Buffer.alloc(65536);
          fs.readSync(fd, tailBuf, 0, 65536, stat.size - 65536);
          tail = tailBuf.toString('utf-8');
        }
        fs.closeSync(fd);

        const combined = head + '\n' + tail;
        if (!combined.toLowerCase().includes(q)) continue;

        const displayName = getSessionDisplayName(wsPath, sessionId);

        // Find matching context
        const lines = combined.split('\n');
        let matchContext = '';
        for (const line of lines) {
          if (line.toLowerCase().includes(q)) {
            // Try to extract readable text
            try {
              const entry = JSON.parse(line);
              if (entry.message?.content) {
                const content = entry.message.content;
                if (typeof content === 'string' && content.toLowerCase().includes(q)) {
                  matchContext = extractContext(content, q);
                  break;
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'text' && block.text?.toLowerCase().includes(q)) {
                      matchContext = extractContext(block.text, q);
                      break;
                    }
                  }
                  if (matchContext) break;
                }
              }
            } catch {
              // Raw line match
              if (line.toLowerCase().includes(q)) {
                matchContext = extractContext(line, q);
                break;
              }
            }
          }
        }

        results.push({
          wsPath,
          sessionId,
          sessionName: displayName,
          type: 'session',
          matchContext: matchContext || displayName,
        });
      } catch {}
    }

    // Also search agent output files
    const sessionsWithTasks = findSessionsWithTasks(wsPath);
    for (const sessionId of sessionsWithTasks) {
      if (results.length >= maxResults) break;
      const tasksDir = getTasksDir(wsPath, sessionId);
      const agentFiles = listAgentFiles(tasksDir);

      for (const file of agentFiles) {
        if (results.length >= maxResults) break;
        const agentId = path.basename(file).replace('.output', '');

        try {
          const fd = fs.openSync(file, 'r');
          const stat = fs.fstatSync(fd);
          const readSize = Math.min(65536, stat.size);
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, 0);
          fs.closeSync(fd);

          const content = buf.toString('utf-8');
          if (!content.toLowerCase().includes(q)) continue;

          const displayName = getSessionDisplayName(wsPath, sessionId);

          // Get agent description from first line
          let agentDesc = agentId.slice(0, 12);
          try {
            const firstLine = content.split('\n')[0];
            const entry = JSON.parse(firstLine);
            if (entry.message?.content && Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === 'text' && block.text) {
                  agentDesc = block.text.slice(0, 100).split('\n')[0];
                  break;
                }
              }
            }
          } catch {}

          const matchContext = extractContext(content, q);

          results.push({
            wsPath,
            sessionId,
            sessionName: displayName,
            type: 'agent',
            agentId,
            agentDescription: agentDesc,
            matchContext,
          });
        } catch {}
      }
    }
  }

  return results;
}

function extractContext(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query);
  if (idx < 0) return text.slice(0, 80);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + query.length + 50);
  let ctx = text.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) ctx = '...' + ctx;
  if (end < text.length) ctx = ctx + '...';
  return ctx;
}

// ── Helpers ──

function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
