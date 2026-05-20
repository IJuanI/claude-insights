import { ConversationMessage } from '../agentParser';

export interface SerializedTask {
  agentId: string;
  sessionId: string;
  status: string;
  description: string;
  prompt?: string;
  model?: string;
  startedAt: string;
  lastActivity?: string;
  sessionLabel?: string;
  hiddenCount: number;
  blockCount: number;
  blocksHtml: string;
  searchText: string;
  lastActivitySummary?: string;
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheCreate: number; lastContext?: number };
  activeState?: 'thinking' | 'responding' | 'tool' | 'processing';
}

export interface SessionInfo {
  id: string;
  displayName: string;
  agentCount?: number;
}

export interface PanelInfo {
  workspace?: string;
  sessions: SessionInfo[];
  sessionNames: Map<string, string>;
  isOverride: boolean;
  conversation?: ConversationMessage[];
  error?: string;
  nonce?: string;
  cspSource?: string;
  scriptUri?: string;
  cssUri?: string;
  allSelectedSessionIds?: string[];
  conversationSessionId?: string;
  sessionCtx?: Record<string, number>;
}

export interface DiagnosticInfo {
  taskCount: number;
  conversationCount: number;
  htmlBytes: number;
  jsonlBytes?: number;
  renderTimeMs: number;
  sessionIds: string[];
  workspace?: string;
  timestamp: string;
  targets: string[];
  warnings: string[];
}

export interface PanelOptions {
  autoConversationTab?: boolean;
}
