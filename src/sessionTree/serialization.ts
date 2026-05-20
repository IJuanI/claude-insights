import { WorkspaceInfo, SessionMeta, AgentMeta, WebviewWorkspace, WebviewSession } from './types';
import { timeAgo, folderName, shortenPath, permissionModeLabel } from './sessionMetrics';
import { SessionRepository } from './sessionRepository';

export function buildWebviewData(
  cache: WorkspaceInfo[],
  searchQuery: string,
  currentWsPath: string | undefined,
  repo: SessionRepository,
): WebviewWorkspace[] {
  const q = searchQuery;
  const result: WebviewWorkspace[] = [];

  for (const ws of cache) {
    const matchingSessions = filterSessions(ws, q, cache, repo);
    if (q && matchingSessions.length === 0) continue;

    const sessions = q ? matchingSessions : ws.sessions;
    const hasRunning = ws.sessions.some(s => s.agents.some(a => a.status === 'running'));

    const webviewSessions: WebviewSession[] = sessions.map(s => {
      const agents = q
        ? s.agents.filter(a => matchesAgent(a, q))
        : s.agents;
      const sessionHasRunning = s.agents.some(a => a.status === 'running');

      return {
        sessionId: s.sessionId,
        wsPath: ws.wsPath,
        displayName: s.displayName,
        mtime: s.mtime,
        fileSize: s.fileSize ?? 0,
        hasAgents: s.hasAgents,
        convTurns: s.convTurns,
        permissionMode: s.permissionMode,
        permissionModeLabel: s.permissionMode && s.permissionMode !== 'default'
          ? permissionModeLabel(s.permissionMode) : undefined,
        timeAgo: timeAgo(s.mtime),
        agentCount: s.agents.length,
        hasRunning: sessionHasRunning,
        iconType: sessionHasRunning ? 'running' : s.hasAgents ? 'agents' : 'conversation',
        tokenUsage: s.tokenUsage ? {
          totalTokens: s.tokenUsage.totalTokens,
          outputTokens: s.tokenUsage.outputTokens,
          cacheReadTokens: s.tokenUsage.cacheReadTokens,
          avgCacheRead: s.tokenUsage.avgCacheRead,
          messageCount: s.tokenUsage.messageCount,
        } : undefined,
        agents: agents.map(a => ({
          agentId: a.agentId,
          sessionId: s.sessionId,
          wsPath: ws.wsPath,
          description: a.description,
          model: a.model,
          status: a.status,
          messageCount: a.messageCount,
          timeAgo: timeAgo(Date.parse(a.startedAt)),
          modelShort: a.model ? a.model.replace('claude-', '') : undefined,
        })),
      };
    });

    result.push({
      projectKey: ws.projectKey,
      wsPath: ws.wsPath,
      folderName: folderName(ws.wsPath),
      shortPath: shortenPath(ws.wsPath),
      sessionCount: q ? matchingSessions.length : ws.sessions.length,
      hasRunning,
      isCurrent: ws.wsPath === currentWsPath,
      sessions: webviewSessions,
    });
  }

  return result;
}

// ── Search filter logic ──

export function filterSessions(ws: WorkspaceInfo, query: string, cache: WorkspaceInfo[], repo: SessionRepository): SessionMeta[] {
  if (!query) return ws.sessions;
  return ws.sessions.filter(s =>
    matchesSession(s, query, cache, repo) ||
    s.agents.some(a => matchesAgent(a, query)),
  );
}

export function matchesSession(s: SessionMeta, q: string, cache: WorkspaceInfo[], repo: SessionRepository): boolean {
  if (s.displayName.toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q)) {
    return true;
  }
  // Lazy-load searchContent on first search
  if (s.searchContent === undefined) {
    s.searchContent = repo.loadSessionSearchContent(s, cache);
  }
  return s.searchContent.includes(q);
}

export function matchesAgent(a: AgentMeta, q: string): boolean {
  return a.description.toLowerCase().includes(q) ||
    a.agentId.toLowerCase().includes(q) ||
    (a.model?.toLowerCase().includes(q) ?? false);
}
