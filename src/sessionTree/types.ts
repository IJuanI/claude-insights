import { SessionTokenUsage } from '../agentParser';

// ── Data types ──

export interface WorkspaceInfo {
  projectKey: string;
  wsPath: string;
  sessions: SessionMeta[];
}

export interface SessionMeta {
  sessionId: string;
  displayName: string;
  mtime: number;
  fileSize: number;
  hasAgents: boolean;
  agents: AgentMeta[];
  convTurns: number;
  permissionMode?: string;
  tokenUsage?: SessionTokenUsage;
  /** Cached content snippet for search (first+last user messages, agent descriptions) */
  searchContent?: string;
}

export interface AgentMeta {
  agentId: string;
  description: string;
  model?: string;
  agentType?: string;
  status: 'running' | 'completed' | 'errored';
  startedAt: string;
  messageCount: number;
}

// ── Serializable data for webview ──

export interface WebviewWorkspace {
  projectKey: string;
  wsPath: string;
  folderName: string;
  shortPath: string;
  sessionCount: number;
  hasRunning: boolean;
  isCurrent: boolean;
  sessions: WebviewSession[];
}

export interface WebviewSession {
  sessionId: string;
  wsPath: string;
  displayName: string;
  mtime: number;
  fileSize: number;
  hasAgents: boolean;
  convTurns: number;
  permissionMode?: string;
  permissionModeLabel?: string;
  timeAgo: string;
  agentCount: number;
  hasRunning: boolean;
  iconType: 'running' | 'agents' | 'conversation';
  tokenUsage?: { totalTokens: number; outputTokens: number; cacheReadTokens: number; avgCacheRead: number; messageCount: number };
  agents: WebviewAgent[];
}

export interface WebviewAgent {
  agentId: string;
  sessionId: string;
  wsPath: string;
  description: string;
  model?: string;
  status: 'running' | 'completed' | 'errored';
  messageCount: number;
  timeAgo: string;
  modelShort?: string;
}

// ── Deep search result ──

export interface SearchResult {
  wsPath: string;
  sessionId: string;
  sessionName: string;
  type: 'session' | 'agent';
  agentId?: string;
  agentDescription?: string;
  matchContext: string;
}
