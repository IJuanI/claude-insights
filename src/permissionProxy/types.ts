export const PERM_DIR = '/tmp/claude-permissions';
export const POLL_MS = 1000;
export const BATCH_DELAY_MS = 400; // Wait this long to collect parallel requests before showing notification

export interface PermissionRequest {
  uuid: string;
  tool_name: string;
  command: string;
  agent_id: string;
  session_id: string;
  timestamp: string;
}

export type PermDecision = 'allow' | 'deny' | 'allow-all' | 'deny-all' | 'dismissed';

export type BatchDecision = { uuid: string; decision: 'allow' | 'deny' }[];

export interface PendingPermItem {
  uuid: string;
  command: string;
  toolName: string;
  agentId: string;
  startTs: number;
  timeout: number;
  /** True when the hook has timed out but we're in the grace period before evicting from UI */
  timedOut?: boolean;
  /** True when the request is from a session not tracked by this workspace */
  isExternal?: boolean;
}

/** How long (ms) to keep a timed-out item visible in the banner before removing it */
export const TIMEOUT_GRACE_MS = 5000;

export interface ForegroundNotifyItem {
  toolUseId: string;
  sessionId: string;
  command: string;
  startTs: number;
}

export interface BatchQueueItem {
  filePath: string;
  uuid: string;
  req: PermissionRequest;
}
