import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Diagnostic trace object built during each refresh cycle to capture
 * exactly how task detection proceeded. Useful for debugging "0 tasks"
 * in long-running conversations.
 */
export interface TaskDetectionTrace {
  workspacePath: string;
  projectKey: string;
  sessionIds: string[];
  subagentsDirs: { path: string; exists: boolean; fileCount: number }[];
  tmpTaskDirs: { path: string; exists: boolean; fileCount: number }[];
  convJsonlPaths: { path: string; exists: boolean; size: number }[];
  /** How the active session was selected */
  selectedBy: 'lock-file' | 'most-recent' | 'override' | 'none';
  /** Explains why no sessions were found, when applicable */
  reason?: string;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  id: string;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface TextBlock {
  type: 'text';
  text: string;
  timestamp: string;
  /** Token usage for this assistant turn (only set on the last block of a final turn) */
  turnUsage?: TurnUsage;
}

export interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  id: string;
  input: Record<string, unknown>;
  timestamp: string;
  /** Token usage for this assistant turn (only set on the last block of a final turn) */
  turnUsage?: TurnUsage;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
  timestamp: string;
  backgroundCommand?: BackgroundCommand;
}

export interface BackgroundCommand {
  commandId: string;
  outputPath: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface AgentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Context window fill from the last assistant turn (input + cacheRead + cacheCreate) */
  lastContext: number;
}

export interface AgentTask {
  agentId: string;
  sessionId: string;
  description: string;
  prompt: string;
  status: 'running' | 'completed' | 'errored';
  startedAt: string;
  lastActivity: string;
  contentBlocks: ContentBlock[];
  model?: string;
  slug?: string;
  tokenUsage?: AgentTokenUsage;
  /**
   * Active state when running (derived from last meaningful JSONL entry):
   * - 'thinking'  : streaming assistant chunk with thinking blocks (stop_reason null, no text/tool)
   * - 'responding': streaming assistant chunk with text or tool_use blocks (stop_reason null)
   * - 'tool'      : final assistant chunk with stop_reason "tool_use" — tool is now executing
   * - 'processing': last entry was user/tool_result — Claude received output, about to respond
   * - undefined   : not running or state unknown
   */
  activeState?: 'thinking' | 'responding' | 'tool' | 'processing';
  /** Byte offset for incremental reads */
  _readOffset: number;
  /** File mtime for staleness detection */
  _lastMtime: number;
}

/** Convert a filesystem path to Claude Code's project key format (replace / and . with -) */
export function pathToProjectKey(p: string): string {
  return p.replace(/[/.]/g, '-');
}

/**
 * Discover the tasks directory for a given project+session.
 * Claude Code stores agent outputs at /tmp/claude-{uid}/{project-path}/{session-id}/tasks/
 *
 * Returns: /private/tmp/claude-{uid}/{projectKey}/{sessionId}/tasks
 * This is ephemeral — only populated while agents are actively running.
 * Files here are *.output files containing JSONL agent conversation data.
 */
export function getTasksDir(projectPath: string, sessionId: string): string {
  const uid = process.getuid?.() ?? 501;
  const sanitized = pathToProjectKey(projectPath);
  return path.join('/private/tmp', `claude-${uid}`, sanitized, sessionId, 'tasks');
}

/**
 * Return the persistent subagents directory for a given workspace+session.
 * Claude Code stores agent JSONL files at ~/.claude/projects/{projectKey}/{sessionId}/subagents/
 *
 * Returns: ~/.claude/projects/{projectKey}/{sessionId}/subagents
 * This is persistent — survives session restarts. Contains agent-*.jsonl files.
 */
export function getSubagentsDir(workspacePath: string, sessionId: string): string {
  const projectKey = pathToProjectKey(workspacePath);
  return path.join(os.homedir(), '.claude', 'projects', projectKey, sessionId, 'subagents');
}

export interface AgentMetaFile {
  agentType?: string;
  description?: string;
}

/**
 * Load the companion .meta.json file for an agent in the subagents directory.
 * Returns undefined if the file does not exist or cannot be parsed.
 */
export function loadAgentMeta(subagentsDir: string, agentId: string): AgentMetaFile | undefined {
  const metaPath = path.join(subagentsDir, `${agentId}.meta.json`);
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch { return undefined; }
}

/**
 * List agent JSONL files in the persistent subagents directory.
 * Matches agent-*.jsonl but excludes agent-acompact-*.jsonl (context compaction snapshots).
 */
export function listSubagentFiles(subagentsDir: string): string[] {
  try {
    return fs.readdirSync(subagentsDir)
      .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl') && !f.startsWith('agent-acompact-'))
      .map(f => path.join(subagentsDir, f));
  } catch {
    return [];
  }
}

/**
 * Find the current Claude Code session for a workspace folder.
 * Looks at the project JSONL files and finds the most recent one.
 *
 * @param workspacePath - Absolute path to the workspace folder
 * @param logger - Optional callback for diagnostic logging (receives a formatted message string)
 */
export function findCurrentSession(
  workspacePath: string,
  logger?: (msg: string) => void,
): { sessionId: string; projectKey: string } | null {
  const projectKey = pathToProjectKey(workspacePath);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

  logger?.(`[task-detection] findCurrentSession: projectDir=${projectDir}`);

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        sessionId: f.replace('.jsonl', ''),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    logger?.(`[task-detection] findCurrentSession: found ${files.length} .jsonl files: [${files.map(f => f.name).join(', ')}]`);

    if (files.length === 0) {
      logger?.(`[task-detection] findCurrentSession: no .jsonl files found — returning null`);
      return null;
    }

    // Prefer a session with active tasks (running bg commands) over raw JSONL mtime.
    // This prevents a long-lived conversation session from masking a new CLI session
    // that is actively running background commands.
    const uid = process.getuid?.() ?? 501;
    const tmpBase = path.join('/private/tmp', `claude-${uid}`, projectKey);
    let activeSessionId: string | null = null;
    let activeMtime = 0;
    try {
      for (const dir of fs.readdirSync(tmpBase)) {
        const tasksDir = path.join(tmpBase, dir, 'tasks');
        if (!fs.existsSync(tasksDir)) continue;
        for (const f of fs.readdirSync(tasksDir)) {
          if (!f.endsWith('.output')) continue;
          const mtime = fs.statSync(path.join(tasksDir, f)).mtimeMs;
          if (mtime > activeMtime) {
            activeMtime = mtime;
            activeSessionId = dir;
          }
        }
      }
    } catch { /* /tmp may not exist */ }

    const ACTIVE_THRESHOLD_MS = 5 * 60_000; // 5 minutes
    if (activeSessionId && (Date.now() - activeMtime) < ACTIVE_THRESHOLD_MS) {
      logger?.(`[task-detection] findCurrentSession: selected=${activeSessionId} (active tasks, mtime=${new Date(activeMtime).toISOString()})`);
      return { sessionId: activeSessionId, projectKey };
    }

    const selected = files[0];
    logger?.(`[task-detection] findCurrentSession: selected=${selected.name} (most-recent, mtime=${new Date(selected.mtime).toISOString()})`);
    return { sessionId: selected.sessionId, projectKey };
  } catch (e) {
    logger?.(`[task-detection] findCurrentSession: error reading projectDir — ${e}`);
    return null;
  }
}

/**
 * Find all sessions that have active task directories (not just the latest JSONL).
 * Checks the persistent ~/.claude/projects/{projectKey}/{sessionId}/subagents/ location first,
 * then falls back to the ephemeral /tmp tasks directory for currently-running agents.
 */
export function findSessionsWithTasks(workspacePath: string): string[] {
  const projectKey = pathToProjectKey(workspacePath);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

  const sessionSet = new Map<string, number>(); // sessionId -> latest mtime

  // Primary: scan persistent subagents directories
  try {
    const entries = fs.readdirSync(projectDir);
    for (const entry of entries) {
      // Each entry that is a directory (not a .jsonl file) may be a session directory
      const entryPath = path.join(projectDir, entry);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
      } catch { continue; }

      const subagentsDir = path.join(entryPath, 'subagents');
      if (!fs.existsSync(subagentsDir)) continue;

      const agentFiles = listSubagentFiles(subagentsDir);
      if (agentFiles.length === 0) continue;

      const mtime = getLatestMtime(subagentsDir);
      const existing = sessionSet.get(entry);
      if (existing === undefined || mtime > existing) {
        sessionSet.set(entry, mtime);
      }
    }
  } catch {}

  // Fallback: scan ephemeral /tmp tasks directories (for currently-running agents
  // that may not have flushed to persistent storage yet)
  try {
    const uid = process.getuid?.() ?? 501;
    const baseDir = path.join('/private/tmp', `claude-${uid}`, projectKey);
    const tmpEntries = fs.readdirSync(baseDir);
    for (const d of tmpEntries) {
      const tasksDir = path.join(baseDir, d, 'tasks');
      if (!fs.existsSync(tasksDir)) continue;
      const files = fs.readdirSync(tasksDir);
      if (files.length === 0) continue;
      const mtime = getLatestMtime(tasksDir);
      const existing = sessionSet.get(d);
      if (existing === undefined || mtime > existing) {
        sessionSet.set(d, mtime);
      }
    }
  } catch {}

  return Array.from(sessionSet.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([sessionId]) => sessionId);
}

/**
 * Find sessions that have CURRENTLY RUNNING tasks by scanning only the ephemeral
 * /tmp directory. Unlike findSessionsWithTasks, this never reads persistent
 * ~/.claude/projects/ directories, so it won't return stale historical sessions.
 */
export function findActiveTaskSessions(workspacePath: string): string[] {
  const projectKey = pathToProjectKey(workspacePath);
  const sessionSet = new Map<string, number>(); // sessionId -> latest mtime

  try {
    const uid = process.getuid?.() ?? 501;
    const baseDir = path.join('/private/tmp', `claude-${uid}`, projectKey);
    const tmpEntries = fs.readdirSync(baseDir);
    for (const d of tmpEntries) {
      const tasksDir = path.join(baseDir, d, 'tasks');
      if (!fs.existsSync(tasksDir)) continue;
      // Only include sessions with valid agent .output files (first byte == '{')
      const agentFiles = listAgentFiles(tasksDir);
      if (agentFiles.length === 0) continue;
      const mtime = getLatestMtime(tasksDir);
      const existing = sessionSet.get(d);
      if (existing === undefined || mtime > existing) {
        sessionSet.set(d, mtime);
      }
    }
  } catch {}

  return Array.from(sessionSet.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([sessionId]) => sessionId);
}

function getLatestMtime(dir: string): number {
  try {
    const files = fs.readdirSync(dir);
    let max = 0;
    for (const f of files) {
      const mt = fs.statSync(path.join(dir, f)).mtimeMs;
      if (mt > max) max = mt;
    }
    return max;
  } catch {
    return 0;
  }
}

/**
 * List all agent output files in a tasks directory.
 * Agent files have JSONL content starting with a JSON object.
 * Filter out persisted bash output files (which start with plain text).
 */
export function listAgentFiles(tasksDir: string): string[] {
  try {
    return fs.readdirSync(tasksDir)
      .filter(f => f.endsWith('.output'))
      .filter(f => {
        // Quick check: agent JSONL files start with '{'
        try {
          const fd = fs.openSync(path.join(tasksDir, f), 'r');
          const buf = Buffer.alloc(1);
          fs.readSync(fd, buf, 0, 1, 0);
          fs.closeSync(fd);
          return buf[0] === 0x7b; // '{'
        } catch {
          return false;
        }
      })
      .map(f => path.join(tasksDir, f));
  } catch {
    return [];
  }
}

/**
 * Parse an agent output file into an AgentTask.
 * Supports incremental parsing via _readOffset.
 */
export function parseAgentFile(filePath: string, existing?: AgentTask): AgentTask {
  const basename = path.basename(filePath);
  const agentId = basename.replace(/^agent-/, '').replace(/\.(output|jsonl)$/, '');
  const offset = existing?._readOffset ?? 0;

  let raw: string;
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (offset >= stat.size) {
      // No new data — but if still marked running, re-check completion
      if (existing && existing.status === 'running') {
        const staleMs = Date.now() - stat.mtimeMs;
        // Scan tail of file for end_turn or pending tool calls
        const TAIL = 32768;
        const tailOffset = Math.max(0, stat.size - TAIL);
        const tailBuf = Buffer.alloc(stat.size - tailOffset);
        try { fs.readSync(fd, tailBuf, 0, tailBuf.length, tailOffset); } catch {}
        const tailLines = tailBuf.toString('utf-8').split('\n').filter(Boolean);

        // Check for clean end_turn with no pending tool calls
        let hasEndTurn = false;
        for (let i = tailLines.length - 1; i >= Math.max(0, tailLines.length - 10); i--) {
          try {
            const e = JSON.parse(tailLines[i]);
            if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') {
              const c = e.message?.content ?? [];
              if (!c.some((b: Record<string, unknown>) => b.type === 'tool_use')) {
                hasEndTurn = true;
                break;
              }
            }
          } catch {}
        }
        if (hasEndTurn && staleMs > 15_000) {
          fs.closeSync(fd);
          return { ...existing, status: 'completed' };
        }

        // Stale fallback — only if no unresolved tool calls (agent waiting for a long-running tool)
        if (staleMs > 300_000) {
          // Hard cap: after 1 hour, mark completed regardless of pending tool_use balance
          if (staleMs > 3_600_000) {
            fs.closeSync(fd);
            return { ...existing, status: 'completed' };
          }
          const toolUseIds = new Set<string>();
          const toolResultIds = new Set<string>();
          for (const l of tailLines) {
            try {
              const e = JSON.parse(l);
              if (e.type === 'assistant') {
                for (const b of e.message?.content ?? []) {
                  if (b.type === 'tool_use') toolUseIds.add(b.id);
                }
              } else if (e.type === 'user') {
                for (const b of e.message?.content ?? []) {
                  if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id);
                }
              }
            } catch {}
          }
          const hasPending = [...toolUseIds].some(id => !toolResultIds.has(id));
          if (!hasPending) {
            fs.closeSync(fd);
            return { ...existing, status: 'completed' };
          }
        }
      }
      fs.closeSync(fd);
      return existing ?? createEmptyTask(agentId, filePath);
    }
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    raw = buf.toString('utf-8');
  } catch {
    return existing ?? createEmptyTask(agentId, filePath);
  }

  const lines = raw.split('\n').filter(Boolean);
  const newBlocks: ContentBlock[] = [];
  let lastTimestamp = existing?.lastActivity ?? '';
  let sessionId = existing?.sessionId ?? '';
  let description = existing?.description ?? '';
  let prompt = existing?.prompt ?? '';
  let model = existing?.model;
  let slug = existing?.slug;
  const tokenAcc: AgentTokenUsage = {
    input: existing?.tokenUsage?.input ?? 0,
    output: existing?.tokenUsage?.output ?? 0,
    cacheRead: existing?.tokenUsage?.cacheRead ?? 0,
    cacheCreate: existing?.tokenUsage?.cacheCreate ?? 0,
    lastContext: existing?.tokenUsage?.lastContext ?? 0,
  };
  // Keep completed only if no new data arrived; otherwise re-evaluate from running
  let status: AgentTask['status'] = (existing?.status === 'completed' && offset === existing._readOffset) ? 'completed' : 'running';
  let startedAt = existing?.startedAt ?? '';
  let activeState: AgentTask['activeState'] = existing?.activeState;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry['type'] as string;
    const ts = (entry['timestamp'] as string) ?? '';
    if (ts) lastTimestamp = ts;
    if (!sessionId) sessionId = (entry['sessionId'] as string) ?? '';
    if (!slug) slug = (entry['slug'] as string) ?? '';

    if (type === 'user') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      const content = msg['content'] as unknown;
      // Tool results mean Claude is about to compute next response
      if (Array.isArray(content) && content.some((b: Record<string,unknown>) => b['type'] === 'tool_result')) {
        activeState = 'processing';
      }

      // First user message = the prompt
      if (!prompt && typeof content === 'string') {
        prompt = content;
        description = content.slice(0, 120);
        startedAt = ts;
      } else if (!prompt && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            prompt = block.text;
            description = block.text.slice(0, 120);
            startedAt = ts;
            break;
          }
        }
      }

      // Tool results
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const resultText = extractToolResultText(block.content);
            if (resultText) {
              const bgCmd = detectBackgroundCommand(resultText);
              newBlocks.push({
                type: 'tool_result',
                toolUseId: block.tool_use_id ?? '',
                content: resultText,
                isError: block.is_error === true,
                timestamp: ts,
                ...(bgCmd ? { backgroundCommand: bgCmd } : {}),
              });
            }
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      if (!model) model = (msg['model'] as string) ?? undefined;

      // Accumulate token usage — only count the final chunk per API request
      // (streaming chunks have stop_reason: null; final chunks have a string like "end_turn" / "tool_use")
      const stopReason = msg['stop_reason'];
      const usage = msg['usage'] as Record<string, unknown> | undefined;
      if (usage && stopReason !== null && stopReason !== undefined && Number(usage['output_tokens'] ?? 0) > 0) {
        tokenAcc.input += Number(usage['input_tokens'] ?? 0);
        tokenAcc.output += Number(usage['output_tokens'] ?? 0);
        tokenAcc.cacheRead += Number(usage['cache_read_input_tokens'] ?? 0);
        tokenAcc.cacheCreate += Number(usage['cache_creation_input_tokens'] ?? 0);
        // Track last turn's context window fill (overwrites each turn — we only need the latest)
        tokenAcc.lastContext = Number(usage['input_tokens'] ?? 0)
          + Number(usage['cache_read_input_tokens'] ?? 0)
          + Number(usage['cache_creation_input_tokens'] ?? 0);
      }

      const content = msg['content'] as unknown[];
      if (!Array.isArray(content)) continue;

      // Detect active state from this entry
      if (stopReason === 'tool_use') {
        // Tool call finalized — tool is now executing
        activeState = 'tool';
      } else if (stopReason === null || stopReason === undefined) {
        // Streaming chunk — detect thinking vs responding
        const hasThinking = content.some((b) => (b as Record<string,unknown>)['type'] === 'thinking');
        const hasText = content.some((b) => (b as Record<string,unknown>)['type'] === 'text');
        const hasToolUse = content.some((b) => (b as Record<string,unknown>)['type'] === 'tool_use');
        if (hasThinking && !hasText && !hasToolUse) activeState = 'thinking';
        else if (hasText || hasToolUse) activeState = 'responding';
      } else {
        // end_turn or other terminal stop_reason — turn complete
        activeState = undefined;
      }

      const isFinalTurn = usage && stopReason !== null && stopReason !== undefined && Number(usage['output_tokens'] ?? 0) > 0;
      const turnUsage: TurnUsage | undefined = isFinalTurn ? {
        input: Number(usage!['input_tokens'] ?? 0),
        output: Number(usage!['output_tokens'] ?? 0),
        cacheRead: Number(usage!['cache_read_input_tokens'] ?? 0),
        cacheCreate: Number(usage!['cache_creation_input_tokens'] ?? 0),
      } : undefined;

      const turnStartIdx = newBlocks.length;
      for (const block of content) {
        const btype = (block as Record<string, unknown>)['type'] as string;
        if (btype === 'text') {
          const text = (block as Record<string, unknown>)['text'] as string;
          if (text?.trim()) {
            newBlocks.push({ type: 'text', text, timestamp: ts });
          }
        } else if (btype === 'tool_use') {
          const b = block as Record<string, unknown>;
          newBlocks.push({
            type: 'tool_use',
            name: (b['name'] as string) ?? '',
            id: (b['id'] as string) ?? '',
            input: (b['input'] as Record<string, unknown>) ?? {},
            timestamp: ts,
          });
        }
      }

      // Attach turnUsage to the last block of this turn so we can render a token footer
      if (turnUsage && newBlocks.length > turnStartIdx) {
        (newBlocks[newBlocks.length - 1] as { turnUsage?: TurnUsage }).turnUsage = turnUsage;
      }
    }
  }

  // Detect completion using multiple signals
  if (status === 'running') {
    // Helper: check if a set of lines contains a terminal assistant turn
    const hasEndTurn = (checkLines: string[]) => {
      for (let i = checkLines.length - 1; i >= Math.max(0, checkLines.length - 10); i--) {
        try {
          const entry = JSON.parse(checkLines[i]);
          if (entry.type !== 'assistant') continue;
          const sr = entry.message?.stop_reason;
          const content: Record<string, unknown>[] = entry.message?.content ?? [];
          const hasToolUse = content.some(b => b.type === 'tool_use');
          if (hasToolUse) continue;
          // Explicit end_turn
          if (sr === 'end_turn') return true;
          // Claude Code sometimes writes the final summary message with stop_reason null/undefined
          // but no tool_use. Treat it as terminal if it has substantial text.
          if ((sr === null || sr === undefined) && content.some(b =>
            b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim().length > 20
          )) return true;
        } catch {}
      }
      return false;
    };

    // Helper: check if last meaningful assistant entry indicates cancelled/interrupted (stop_reason null)
    const hasInterruptedEnd = (checkLines: string[]) => {
      for (let i = checkLines.length - 1; i >= Math.max(0, checkLines.length - 5); i--) {
        try {
          const entry = JSON.parse(checkLines[i]);
          if (entry.type === 'assistant') {
            const sr = entry.message?.stop_reason;
            if (sr === null || sr === undefined) {
              // A null stop_reason on an entry that has substantial text content means the agent
              // finished its response — Claude Code sometimes writes the final assistant message
              // without setting stop_reason. Only flag as interrupted if there is no text content.
              const content = entry.message?.content ?? [];
              const hasText = content.some((b: Record<string, unknown>) =>
                b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim().length > 20
              );
              if (hasText) return false;
              return true;
            }
            return false; // found a non-null assistant entry — not interrupted
          }
          if (entry.type === 'user' || entry.type === 'progress') continue;
        } catch {}
      }
      return false;
    };

    // Signal 1: scan tail for end_turn — only trust it if the file is stale (>15s)
    // A text-only end_turn during active streaming doesn't mean the agent is done.
    let fileStaleSecs = 0;
    if (status === 'running') {
      try {
        const TAIL_SIZE = 4096;
        const fd = fs.openSync(filePath, 'r');
        const stat = fs.fstatSync(fd);
        fileStaleSecs = (Date.now() - stat.mtimeMs) / 1000;
        const tailOffset = Math.max(0, stat.size - TAIL_SIZE);
        const tailBuf = Buffer.alloc(stat.size - tailOffset);
        fs.readSync(fd, tailBuf, 0, tailBuf.length, tailOffset);
        fs.closeSync(fd);
        const tailLines = tailBuf.toString('utf-8').split('\n').filter(Boolean);
        if (fileStaleSecs > 15 && hasEndTurn(tailLines)) status = 'completed';
        // Only treat as errored if file is stale — active agents can have transient null stop_reason
        // mid-stream when they are about to call a tool
        else if (fileStaleSecs > 30 && hasInterruptedEnd(tailLines)) status = 'errored';
      } catch {}
    }

    // Signal 2: file stale → completed (catch agents that ended without end_turn)
    // Skip if the tail shows unresolved tool_use calls — agent is waiting for a tool result
    if (status === 'running') {
      try {
        const staleMs = fileStaleSecs > 0 ? fileStaleSecs * 1000 : (Date.now() - fs.statSync(filePath).mtimeMs);
        // Use a generous timeout: long-running commands (builds, eslint) can take many minutes
        if (staleMs > 300_000 && lines.length > 1) {
          // Hard cap: after 1 hour of inactivity, always mark completed regardless of tool balance
          // (agents interrupted mid-stream can have permanently unresolved tool_use IDs)
          if (staleMs > 3_600_000) {
            status = 'completed';
          } else {
            // Only mark completed if there are no pending tool calls in the tail
            const hasPendingToolUse = (checkLines: string[]) => {
              const toolUseIds = new Set<string>();
              const toolResultIds = new Set<string>();
              for (const l of checkLines) {
                try {
                  const e = JSON.parse(l);
                  if (e.type === 'assistant') {
                    for (const b of e.message?.content ?? []) {
                      if (b.type === 'tool_use') toolUseIds.add(b.id);
                    }
                  } else if (e.type === 'user') {
                    for (const b of e.message?.content ?? []) {
                      if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id);
                    }
                  }
                } catch {}
              }
              return [...toolUseIds].some(id => !toolResultIds.has(id));
            };
            // Read full tail to check tool balance
            const TAIL2 = 32768;
            const fd2 = fs.openSync(filePath, 'r');
            const stat2 = fs.fstatSync(fd2);
            const tailOff2 = Math.max(0, stat2.size - TAIL2);
            const tailBuf2 = Buffer.alloc(stat2.size - tailOff2);
            fs.readSync(fd2, tailBuf2, 0, tailBuf2.length, tailOff2);
            fs.closeSync(fd2);
            const tailLines2 = tailBuf2.toString('utf-8').split('\n').filter(Boolean);
            if (!hasPendingToolUse(tailLines2)) {
              status = 'completed';
            }
          }
        }
      } catch {}
    }
  }

  // Track file mtime
  let mtime = existing?._lastMtime ?? 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch {}

  const newOffset = offset + Buffer.byteLength(raw, 'utf-8');

  const hasTokens = tokenAcc.input > 0 || tokenAcc.output > 0;

  return {
    agentId,
    sessionId,
    description,
    prompt,
    status,
    startedAt: startedAt || existing?.startedAt || '',
    lastActivity: lastTimestamp,
    contentBlocks: [...(existing?.contentBlocks ?? []), ...newBlocks],
    model,
    slug,
    tokenUsage: hasTokens ? tokenAcc : undefined,
    activeState: status === 'running' ? activeState : undefined,
    _readOffset: newOffset,
    _lastMtime: mtime,
  };
}

function createEmptyTask(agentId: string, _filePath: string): AgentTask {
  return {
    agentId,
    sessionId: '',
    description: '',
    prompt: '',
    status: 'running',
    startedAt: '',
    lastActivity: '',
    contentBlocks: [],
    _readOffset: 0,
    _lastMtime: 0,
  };
}

const SESSION_READ_BYTES = 64 * 1024;

/**
 * Extract a display name for a session, matching Claude Code's logic:
 * customTitle > aiTitle > lastPrompt > summary (from tail) > first user message (from head)
 */
export function getSessionDisplayName(workspacePath: string, sessionId: string): string {
  const projectKey = pathToProjectKey(workspacePath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);

  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const stat = fs.fstatSync(fd);
    const headBuf = Buffer.alloc(Math.min(SESSION_READ_BYTES, stat.size));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('utf-8');

    // Read tail if file is larger than buffer
    let tail = head;
    if (stat.size > SESSION_READ_BYTES) {
      const tailBuf = Buffer.alloc(SESSION_READ_BYTES);
      fs.readSync(fd, tailBuf, 0, tailBuf.length, stat.size - SESSION_READ_BYTES);
      tail = tailBuf.toString('utf-8');
    }
    fs.closeSync(fd);

    // Priority 1: customTitle or aiTitle (check tail first for most recent)
    const customTitle = extractJsonField(tail, 'customTitle') || extractJsonField(head, 'customTitle');
    if (customTitle) return truncateDisplay(customTitle);

    const aiTitle = extractJsonField(tail, 'aiTitle') || extractJsonField(head, 'aiTitle');
    if (aiTitle) return truncateDisplay(aiTitle);

    // Priority 2: lastPrompt or summary from tail
    const lastPrompt = extractJsonField(tail, 'lastPrompt');
    if (lastPrompt) return truncateDisplay(lastPrompt);

    const summary = extractJsonField(tail, 'summary');
    if (summary) return truncateDisplay(summary);

    // Priority 3: First real user message from head
    const firstMsg = extractFirstUserMessage(head);
    if (firstMsg) return truncateDisplay(firstMsg);
  } catch {}

  return sessionId.slice(0, 8);
}

/**
 * Extract the most recent permissionMode from a session JSONL.
 * Reads the tail of the file to find the last "permissionMode":"..." value.
 * Returns undefined if not found.
 */
export function getSessionPermissionMode(workspacePath: string, sessionId: string): string | undefined {
  const projectKey = pathToProjectKey(workspacePath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);

  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const stat = fs.fstatSync(fd);
    // Read tail (most recent entries have the current mode)
    const readSize = Math.min(SESSION_READ_BYTES, stat.size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const tail = buf.toString('utf-8');

    // Search backwards through lines for the last permissionMode
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('permissionMode')) continue;
      const mode = extractJsonField(line, 'permissionMode');
      if (mode) return mode;
    }
  } catch {}
  return undefined;
}

/** @internal Exported for testing */
export function truncateDisplay(s: string): string {
  const line = s.replace(/\n/g, ' ').trim();
  return line.length > 80 ? line.slice(0, 77) + '...' : line;
}

/** @internal Fast string-based field extraction (matches Claude Code's B5 function). Exported for testing. */
export function extractJsonField(text: string, field: string): string | undefined {
  const patterns = [`"${field}":"`, `"${field}": "`];
  for (const pat of patterns) {
    let pos = 0;
    while (true) {
      const idx = text.indexOf(pat, pos);
      if (idx < 0) break;
      const start = idx + pat.length;
      let end = start;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '"') {
          const val = text.slice(start, end).replace(/\\"/g, '"').replace(/\\n/g, ' ');
          if (val) return val;
          break;
        }
        end++;
      }
      pos = end + 1;
    }
  }
  return undefined;
}

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/;
const SKIP_MESSAGE_RE = /^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|\[Request interrupted by user[^\]]*\]|\s*<ide_opened_file>[\s\S]*<\/ide_opened_file>\s*$|\s*<ide_selection>[\s\S]*<\/ide_selection>\s*$)/;

/** @internal Extract first non-meta, non-tool_result user message text (matches Claude Code's Y66). Exported for testing. */
export function extractFirstUserMessage(head: string): string | undefined {
  let commandFallback = '';
  const lines = head.split('\n');
  for (const line of lines) {
    if (!line) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const content = entry.message?.content;
      const texts: string[] = [];
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          }
        }
      }
      for (const raw of texts) {
        const trimmed = raw.replace(/\n/g, ' ').trim();
        if (!trimmed) continue;
        // <command-name>X</command-name> → store X as fallback, skip
        const cmdMatch = COMMAND_NAME_RE.exec(trimmed);
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1];
          continue;
        }
        // Skip system/meta messages
        if (SKIP_MESSAGE_RE.test(trimmed)) continue;
        return trimmed;
      }
    } catch {}
  }
  return commandFallback || undefined;
}

export interface ConvToolBlock {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  backgroundCommand?: BackgroundCommand;
}

export interface ConvTokenUsage {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: string[];
  toolBlocks?: ConvToolBlock[];
  model?: string;
  timestamp?: string;
  isCompact?: boolean;
  thinking?: string[];
  thinkingCount?: number; // number of thinking blocks (content redacted by Claude Code)
  tokenUsage?: ConvTokenUsage;
}

/** Fast byte-count of "type":"user"/"type":"assistant" occurrences in a string */
function countTypeMarkers(raw: string): { user: number; assistant: number } {
  let user = 0;
  let assistant = 0;
  let idx = 0;
  while (true) {
    const i1 = raw.indexOf('"type":"user"', idx);
    const i2 = raw.indexOf('"type": "user"', idx);
    const i3 = raw.indexOf('"type":"assistant"', idx);
    const i4 = raw.indexOf('"type": "assistant"', idx);
    const candidates = [i1, i2, i3, i4].filter(i => i >= 0);
    if (candidates.length === 0) break;
    const min = Math.min(...candidates);
    if (min === i1 || min === i2) { user++; idx = min + 10; }
    else { assistant++; idx = min + 14; }
  }
  return { user, assistant };
}

/**
 * Fast conversation turn count — scans JSONL for "type":"user" / "type":"assistant"
 * markers without parsing JSON. Returns { user, assistant } counts.
 */
export function countConversationTurns(workspacePath: string, sessionId: string): { user: number; assistant: number } {
  const projectKey = pathToProjectKey(workspacePath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);
  try {
    const stat = fs.statSync(jsonlPath);
    // For large files, sample head+tail to estimate
    if (stat.size > 512 * 1024) {
      const fd = fs.openSync(jsonlPath, 'r');
      const headBuf = Buffer.alloc(256 * 1024);
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      const tailBuf = Buffer.alloc(256 * 1024);
      fs.readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, stat.size - 256 * 1024));
      fs.closeSync(fd);
      const head = countTypeMarkers(headBuf.toString('utf-8'));
      const tail = countTypeMarkers(tailBuf.toString('utf-8'));
      // If file > 512K, rough estimate: head + tail (may double-count overlap, acceptable for display)
      return { user: head.user + tail.user, assistant: head.assistant + tail.assistant };
    }
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    return countTypeMarkers(raw);
  } catch {
    return { user: 0, assistant: 0 };
  }
}

/**
 * Count assistant message entries in an agent output file without full parsing.
 * Checks the persistent subagents directory first, falls back to the /tmp tasks dir.
 */
export function countAgentBlocks(workspacePath: string, sessionId: string, agentId: string): number {
  // Try persistent subagents dir first
  const subagentsDir = getSubagentsDir(workspacePath, sessionId);
  const persistentPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const tmpPath = path.join(getTasksDir(workspacePath, sessionId), `${agentId}.output`);

  let filePath: string;
  if (fs.existsSync(persistentPath)) {
    filePath = persistentPath;
  } else if (fs.existsSync(tmpPath)) {
    filePath = tmpPath;
  } else {
    return 0;
  }

  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);
    const raw = buf.toString('utf-8');
    const counts = countTypeMarkers(raw);
    return counts.user + counts.assistant;
  } catch {
    return 0;
  }
}

// Safety valve only — client-side pagination (50 msgs/page) handles display performance.
// Keep this high enough that normal sessions (even heavy tool use) are never truncated.
const CONV_MAX_READ_BYTES = 100 * 1024 * 1024; // 100MB safety limit

/**
 * Parse a session JSONL file into a list of conversation messages
 * for display in the agent panel's conversation tab.
 * Reads at most CONV_MAX_READ_BYTES from the file and caps at CONV_MAX_MESSAGES.
 */
export function parseSessionConversation(workspacePath: string, sessionId: string): ConversationMessage[] {
  const projectKey = pathToProjectKey(workspacePath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);

  try {
    const stat = fs.statSync(jsonlPath);
    let raw: string;

    if (stat.size <= CONV_MAX_READ_BYTES) {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } else {
      // Read only the tail of large files
      const fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(CONV_MAX_READ_BYTES);
      fs.readSync(fd, buf, 0, buf.length, stat.size - CONV_MAX_READ_BYTES);
      fs.closeSync(fd);
      raw = buf.toString('utf-8');
      // Drop first partial line
      const nl = raw.indexOf('\n');
      if (nl > 0) raw = raw.slice(nl + 1);
    }

    return parseConversationFromRaw(raw);
  } catch {
    return [];
  }
}

/**
 * Resolve the active branch of a JSONL conversation using uuid/parentUuid links.
 * Claude Code uses last-child-wins: when a user edits/retries, the new message
 * replaces the old one. Each parentUuid maps to multiple children; the last one
 * written is the active branch.
 * @internal
 */
export function resolveActiveBranch(entries: Array<{ uuid: string | null; parentUuid: string | null; type?: string }>): number[] {
  // Build parent → all children list (preserving file order).
  // We need all children, not just the last, because Claude Code can write both
  // an assistant streaming continuation AND a user tool_result as children of the
  // same parent (parallel tool call pattern). Simple last-child-wins would clobber
  // the assistant continuation with the user entry, orphaning the rest of the chain.
  const childrenOf = new Map<string, number[]>();
  const rootIndices: number[] = [];

  for (let i = 0; i < entries.length; i++) {
    const { uuid, parentUuid } = entries[i];
    if (!uuid) continue;
    if (parentUuid === null) {
      rootIndices.push(i);
    } else {
      if (!childrenOf.has(parentUuid)) childrenOf.set(parentUuid, []);
      childrenOf.get(parentUuid)!.push(i);
    }
  }

  // Pick the "next" child to follow from a given node:
  // - If there is only one child, follow it.
  // - If there are multiple children (retry/parallel), prefer the last assistant entry
  //   (most recent retry wins). Fall back to the last child of any type.
  // User/tool_result children of the same parent are collected alongside the assistant
  // continuation so they all appear in the output.
  const pickNext = (parentUuid: string): number[] => {
    const children = childrenOf.get(parentUuid);
    if (!children || children.length === 0) return [];
    if (children.length === 1) return children;

    // Separate assistant-type children from others
    const assistantChildren = children.filter(i => entries[i].type === 'assistant');
    const otherChildren = children.filter(i => entries[i].type !== 'assistant');

    if (assistantChildren.length > 0) {
      // Follow the last assistant child (most recent retry); include all others too
      const lastAssistant = assistantChildren[assistantChildren.length - 1];
      // Other non-assistant siblings (e.g. tool_result) are also part of this turn
      return [...otherChildren, lastAssistant];
    }
    // No assistant children — follow last child of any type
    return [children[children.length - 1]];
  };

  const result: number[] = [];
  const visited = new Set<string>();

  const walk = (uuid: string) => {
    const nexts = pickNext(uuid);
    for (const idx of nexts) {
      const childUuid = entries[idx].uuid!;
      if (!childUuid || visited.has(childUuid)) continue;
      visited.add(childUuid);
      result.push(idx);
      walk(childUuid);
    }
  };

  for (const rootIdx of rootIndices) {
    const rootUuid = entries[rootIdx].uuid!;
    if (visited.has(rootUuid)) continue;
    visited.add(rootUuid);
    result.push(rootIdx);
    walk(rootUuid);
  }

  // Re-sort by original file position so entries appear in chronological order
  result.sort((a, b) => a - b);
  return result;
}

/** @internal Exported for testing */
export function parseConversationFromRaw(raw: string): ConversationMessage[] {
  const lines = raw.split('\n').filter(Boolean);

  // Phase 1: parse all lines into raw entries
  const parsedEntries: Array<{ uuid: string | null; parentUuid: string | null; type?: string; entry: Record<string, unknown> }> = [];
  let hasAnyUuid = false;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    const uuid = (entry['uuid'] as string | undefined) ?? null;
    const parentUuid = (entry['parentUuid'] as string | undefined) ?? null;
    if (uuid) hasAnyUuid = true;
    parsedEntries.push({ uuid, parentUuid, type: entry['type'] as string | undefined, entry });
  }

  // Phase 2: resolve active branch (if entries have uuids) or use all in order
  let activeEntries: Record<string, unknown>[];
  if (hasAnyUuid) {
    const branchIndices = resolveActiveBranch(parsedEntries);
    activeEntries = branchIndices.map(i => parsedEntries[i].entry);
  } else {
    activeEntries = parsedEntries.map(p => p.entry);
  }

  // Phase 3: convert active entries into ConversationMessage[]
  const messages: ConversationMessage[] = [];
  for (const entry of activeEntries) {

    const type = entry['type'] as string;
    const ts = entry['timestamp'] as string | undefined;

    if (type === 'user') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      // Skip meta messages but keep compact summaries
      if (msg['isMeta'] === true) continue;
      const isCompact = msg['isCompactSummary'] === true;

      const content = msg['content'];

      // Tool results — attach to the assistant message whose toolBlocks contain the matching tool_use_id
      if (Array.isArray(content) && content.some((b: Record<string, unknown>) => b.type === 'tool_result')) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_result') continue;
          const tuId = b['tool_use_id'] as string;
          const resultText = extractToolResultText(b['content']);
          const isErr = b['is_error'] === true;
          // Search backwards through all assistant messages to find the matching tool_use_id
          for (let mi = messages.length - 1; mi >= 0; mi--) {
            const assistMsg = messages[mi];
            if (assistMsg.role !== 'assistant' || !assistMsg.toolBlocks) continue;
            const match = assistMsg.toolBlocks.find(tb => tb.toolUseId === tuId);
            if (match) {
              match.result = resultText.slice(0, 2000);
              match.isError = isErr;
              const bgCmd = detectBackgroundCommand(resultText);
              if (bgCmd) match.backgroundCommand = bgCmd;
              break;
            }
          }
        }
        // If the content ONLY has tool_results, skip rendering as a user message
        if (content.every((b: Record<string, unknown>) => b.type === 'tool_result')) {
          continue;
        }
        // Otherwise fall through to render the text parts as a user message
      }

      const texts = extractConvTexts(content);
      if (!texts.length) continue;

      messages.push({
        role: 'user',
        text: texts.join('\n'),
        timestamp: ts,
        ...(isCompact ? { isCompact: true } : {}),
      });
    } else if (type === 'assistant') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      // Skip synthetic placeholder entries that Claude Code inserts before queued user messages
      if ((msg['model'] as string) === '<synthetic>') continue;

      const content = msg['content'] as unknown[];
      if (!Array.isArray(content)) continue;

      const model = (msg['model'] as string)?.replace('claude-', '') ?? undefined;
      const textParts: string[] = [];
      const toolNames: string[] = [];
      const toolBlocks: ConvToolBlock[] = [];
      const thinkingParts: string[] = [];
      let thinkingCount = 0;

      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text') {
          const text = b['text'] as string;
          if (text?.trim()) textParts.push(text);
        } else if (b['type'] === 'thinking') {
          thinkingCount++;
          const t = b['thinking'] as string;
          if (t?.trim()) thinkingParts.push(t);
        } else if (b['type'] === 'tool_use') {
          toolNames.push(b['name'] as string);
          toolBlocks.push({
            name: b['name'] as string,
            toolUseId: b['id'] as string,
            input: (b['input'] as Record<string, unknown>) ?? {},
          });
        }
      }

      if (!textParts.length && !toolNames.length && !thinkingParts.length) continue;

      const rawUsage = msg['usage'] as Record<string, unknown> | undefined;
      // Only attach token usage to the final chunk of each API request.
      // Streaming chunks have stop_reason: null; final chunks have a string
      // like "end_turn" or "tool_use". This avoids duplicate footers on
      // intermediate parallel chunks while still capturing usage when the
      // final chunk is tool-only (no text).
      const stopReason = msg['stop_reason'];
      const isFinalChunk = typeof stopReason === 'string';
      const tokenUsage: ConvTokenUsage | undefined = (rawUsage && isFinalChunk) ? {
        input: Number(rawUsage['input_tokens'] ?? 0),
        cacheRead: Number(rawUsage['cache_read_input_tokens'] ?? 0),
        cacheCreate: Number(rawUsage['cache_creation_input_tokens'] ?? 0),
        output: Number(rawUsage['output_tokens'] ?? 0),
      } : undefined;

      messages.push({
        role: 'assistant',
        text: textParts.join('\n'),
        tools: toolNames.length > 0 ? toolNames : undefined,
        toolBlocks: toolBlocks.length > 0 ? toolBlocks : undefined,
        model,
        timestamp: ts,
        ...(thinkingParts.length > 0 ? { thinking: thinkingParts } : {}),
        ...(thinkingCount > 0 ? { thinkingCount } : {}),
        ...(tokenUsage ? { tokenUsage } : {}),
      });
    }
  }

  return messages;
}

function extractConvTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      const text = (b['text'] as string).trim();
      if (text) texts.push(text);
    }
  }
  return texts;
}

const BG_COMMAND_RE = /Command running in background with ID: (\w+)\.\s*Output is being written to:\s*(.+)/;

function detectBackgroundCommand(text: string): BackgroundCommand | undefined {
  const m = text.match(BG_COMMAND_RE);
  if (m) return { commandId: m[1], outputPath: m[2].trim() };
  return undefined;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: Record<string, unknown>) => {
        if (c.type === 'text') return c.text as string;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Find agent descriptions from the main session JSONL.
 * Maps agentId -> description from Agent tool calls.
 */
export function findAgentDescriptions(workspacePath: string, sessionId: string): Map<string, string> {
  const projectKey = pathToProjectKey(workspacePath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);
  const map = new Map<string, string>();

  try {
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);

    // First pass: collect Agent tool_use calls with their tool_use_id -> description
    const toolUseToDesc = new Map<string, { description: string; runInBg: boolean }>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Agent') {
            toolUseToDesc.set(block.id, {
              description: block.input?.description ?? block.input?.prompt?.slice(0, 100) ?? '',
              runInBg: block.input?.run_in_background === true,
            });
          }
        }
      } catch {}
    }

    // Second pass: find tool_results that contain agentId references
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user') continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === 'tool_result' && toolUseToDesc.has(block.tool_use_id)) {
            const text = extractToolResultText(block.content);
            const agentIdMatch = text.match(/agentId:\s*(\S+)/);
            if (agentIdMatch) {
              const desc = toolUseToDesc.get(block.tool_use_id)!;
              map.set(agentIdMatch[1], desc.description);
            }
          }
        }
      } catch {}
    }
  } catch {}

  return map;
}

/**
 * Reconstruct the original workspace filesystem path from a Claude Code project key.
 *
 * Claude Code stores project data under ~/.claude/projects/ using directory names
 * that are the workspace path with every '/' replaced by '-'. This means the
 * transformation is lossy: a path like "/my-project" and "/my/project" both map
 * to "-my-project", so we cannot perfectly reverse it.
 *
 * This function does a best-effort reconstruction by:
 * 1. Starting from the home directory (which we know precisely from os.homedir()).
 * 2. Stripping the home prefix from the key and trying all combinations of
 *    merging consecutive segments with '-' for the remaining suffix.
 * 3. Falling back to the naive full reconstruction if the home-anchored approach
 *    yields no existing path.
 */
export function reconstructWsPath(key: string): string {
  // Naive reconstruction: treat every '-' as a '/'.
  const naive = key.replace(/^-/, '/').replace(/-/g, '/');

  if (fs.existsSync(naive)) {
    return naive;
  }

  // Anchor on the home directory. Claude Code converts the path to a key by
  // replacing '/' with '-'. It also replaces other special characters like '.'
  // with '-', so "/Users/juan.cruz" becomes "-Users-juan-cruz" in the key.
  // We normalize both the home path and the key to a common form for prefix
  // matching, then use the real home path for filesystem reconstruction.
  const home = os.homedir();
  // Normalize: replace '/' and '.' with '-' to match Claude Code's key format.
  const homePrefixNorm = home.replace(/[/.]/g, '-');
  // Also normalize the key for comparison (it already has '-' for '/').
  const keyNorm = key.replace(/\./g, '-');

  if (keyNorm.startsWith(homePrefixNorm)) {
    // The part of the key after the home prefix (e.g. "-workspaces-claude-usage-bar").
    const suffix = key.slice(homePrefixNorm.length);
    // Strip leading '-' and split into naive segments.
    const suffixSegments = suffix.replace(/^-/, '').split('-').filter(Boolean);

    // Try all combinations of merging consecutive suffix segments with '-'.
    // We use recursive DFS to generate all possible path reconstructions and
    // return the first candidate that exists on the filesystem.
    function trySegments(parts: string[], builtPath: string): string | undefined {
      if (parts.length === 0) {
        return fs.existsSync(builtPath) ? builtPath : undefined;
      }
      // Try consuming 1..N parts as a single path segment joined by '-'.
      for (let take = 1; take <= parts.length; take++) {
        const segment = parts.slice(0, take).join('-');
        const candidate = builtPath + '/' + segment;
        // Prune: the intermediate directory must exist before recursing.
        if (take < parts.length) {
          if (!fs.existsSync(candidate)) continue;
        }
        const result = trySegments(parts.slice(take), candidate);
        if (result !== undefined) return result;
      }
      return undefined;
    }

    const found = trySegments(suffixSegments, home);
    if (found !== undefined) {
      return found;
    }
  }

  return naive;
}

export interface SessionTokenUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  /** Average cache_read per message — indicates context bloat when high */
  avgCacheRead: number;
}

const USAGE_CHUNK_SIZE = 1024 * 1024; // 1MB
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024; // 2MB

/**
 * Extract all numeric fields from a usage block string like:
 * `"input_tokens":3,"cache_creation_input_tokens":17414,...`
 * Returns null if any required field is missing.
 */
function extractUsageFields(block: string): { input: number; cacheCreate: number; cacheRead: number; output: number } | null {
  const get = (field: string): number | null => {
    const idx = block.indexOf(`"${field}":`);
    if (idx < 0) return null;
    const start = idx + field.length + 3; // skip `"field":`
    let end = start;
    while (end < block.length && block[end] >= '0' && block[end] <= '9') end++;
    if (end === start) return null;
    return parseInt(block.slice(start, end), 10);
  };
  const input = get('input_tokens');
  const cacheCreate = get('cache_creation_input_tokens');
  const cacheRead = get('cache_read_input_tokens');
  const output = get('output_tokens');
  if (input === null || output === null) return null;
  return { input, cacheCreate: cacheCreate ?? 0, cacheRead: cacheRead ?? 0, output };
}

/**
 * Scan a string buffer for `"usage":{...}` blocks and accumulate token counts.
 * Returns accumulated totals added to the provided accumulator.
 */
export function scanUsageInBuffer(
  raw: string,
  acc: { input: number; cacheCreate: number; cacheRead: number; output: number; count: number },
): void {
  const USAGE_MARKER = '"usage":{';
  let pos = 0;
  while (true) {
    const idx = raw.indexOf(USAGE_MARKER, pos);
    if (idx < 0) break;
    // Skip streaming chunks (stop_reason: null) — only count final message per API request.
    // Look backwards from the usage marker to the start of this JSON line entry.
    const lineStart = raw.lastIndexOf('\n', idx);
    const preContext = raw.slice(Math.max(0, lineStart), idx);
    if (preContext.includes('"stop_reason":null')) {
      pos = idx + USAGE_MARKER.length;
      continue;
    }
    // Find the matching closing brace for this usage object (handles nested objects)
    const blockStart = idx + USAGE_MARKER.length - 1; // points to '{'
    let depth = 0;
    let closeIdx = -1;
    for (let ci = blockStart; ci < Math.min(blockStart + 2048, raw.length); ci++) {
      if (raw[ci] === '{') depth++;
      else if (raw[ci] === '}') { depth--; if (depth === 0) { closeIdx = ci; break; } }
    }
    if (closeIdx < 0) break;
    const block = raw.slice(blockStart, closeIdx + 1);
    const fields = extractUsageFields(block);
    if (fields !== null) {
      acc.input += fields.input;
      acc.cacheCreate += fields.cacheCreate;
      acc.cacheRead += fields.cacheRead;
      acc.output += fields.output;
      acc.count++;
    }
    pos = closeIdx + 1;
  }
}

/**
 * Parse a session's JSONL file and return token usage totals.
 * For files > 2MB, reads in 1MB chunks to avoid loading the entire file into memory.
 * Uses fast string scanning (no JSON.parse per line) for performance.
 */
export function getSessionTokenUsage(workspacePath: string, sessionId: string): SessionTokenUsage {
  const zero: SessionTokenUsage = {
    inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    outputTokens: 0, totalTokens: 0, messageCount: 0, avgCacheRead: 0,
  };

  const projectKey = pathToProjectKey(workspacePath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);

  try {
    const stat = fs.statSync(jsonlPath);
    // Skip very large files (> 10MB) — too slow to scan in the session tree context.
    if (stat.size > 10 * 1024 * 1024) return zero;
    const acc = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, count: 0 };

    if (stat.size <= LARGE_FILE_THRESHOLD) {
      const raw = fs.readFileSync(jsonlPath, 'utf-8');
      scanUsageInBuffer(raw, acc);
    } else {
      // Streaming chunked read: overlap chunks by the max possible usage-block size
      // to avoid missing blocks that straddle chunk boundaries.
      const OVERLAP = 512; // bytes — larger than any usage block
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        let offset = 0;
        let leftover = '';
        while (offset < stat.size) {
          const readSize = Math.min(USAGE_CHUNK_SIZE, stat.size - offset);
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, offset);
          const chunk = leftover + buf.toString('utf-8');
          // Keep a trailing overlap for the next iteration to handle boundary splits
          const scanEnd = chunk.length - (offset + readSize < stat.size ? OVERLAP : 0);
          scanUsageInBuffer(chunk.slice(0, scanEnd), acc);
          leftover = chunk.slice(scanEnd);
          offset += readSize;
        }
        // Scan any remaining leftover
        if (leftover) scanUsageInBuffer(leftover, acc);
      } finally {
        fs.closeSync(fd);
      }
    }

    const total = acc.input + acc.cacheCreate + acc.cacheRead + acc.output;
    return {
      inputTokens: acc.input,
      cacheCreationTokens: acc.cacheCreate,
      cacheReadTokens: acc.cacheRead,
      outputTokens: acc.output,
      totalTokens: total,
      messageCount: acc.count,
      avgCacheRead: acc.count > 0 ? Math.round(acc.cacheRead / acc.count) : 0,
    };
  } catch {
    return zero;
  }
}

/**
 * Get a short "last activity" summary for a running agent task.
 * Used to show what the agent is currently doing in the conversation tab.
 */
export function getAgentLastActivity(task: AgentTask): string {
  const blocks = task.contentBlocks;
  if (!blocks || blocks.length === 0) return '';

  // Walk backwards to find the most recent tool_use
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'tool_use') {
      return summarizeToolUse(b.name, b.input, blocks.length);
    }
    if (b.type === 'text') {
      const text = b.text.trim();
      if (text) {
        return truncate(text.split('\n')[0], 50);
      }
    }
    // If tool_result, keep looking for the preceding tool_use
    if (b.type === 'tool_result') continue;
  }

  return blocks.length > 0 ? `${blocks.length} blocks` : '';
}

function summarizeToolUse(name: string, input: Record<string, unknown>, blockCount: number): string {
  switch (name) {
    case 'Read': {
      const fp = input['file_path'] as string;
      return fp ? truncate(`Reading ${basename2(fp)}`, 50) : 'Reading file';
    }
    case 'Edit': {
      const fp = input['file_path'] as string;
      return fp ? truncate(`Editing ${basename2(fp)}`, 50) : 'Editing file';
    }
    case 'Write': {
      const fp = input['file_path'] as string;
      return fp ? truncate(`Writing ${basename2(fp)}`, 50) : 'Writing file';
    }
    case 'Bash': {
      const cmd = (input['command'] as string) ?? '';
      return cmd ? truncate(`Running ${cmd}`, 50) : 'Running command';
    }
    case 'Grep': {
      const pat = (input['pattern'] as string) ?? '';
      return pat ? truncate(`Searching for '${pat}'`, 50) : 'Searching';
    }
    case 'Glob':
      return 'Finding files';
    case 'Agent': {
      const desc = (input['description'] as string) ?? '';
      return desc ? truncate(`Agent: ${desc}`, 50) : 'Running agent';
    }
    case 'Skill': {
      const skill = (input['skill'] as string) ?? '';
      return skill ? truncate(`Skill: ${skill}`, 50) : 'Running skill';
    }
    case 'WebSearch': {
      const q = (input['query'] as string) ?? '';
      return q ? truncate(`Searching '${q}'`, 50) : 'Web search';
    }
    case 'WebFetch': {
      const url = (input['url'] as string) ?? '';
      return url ? truncate(`Fetching ${url}`, 50) : 'Fetching URL';
    }
    default:
      return `${blockCount} blocks`;
  }
}

/** Get last 2 path segments (e.g. "src/parser.ts") */
function basename2(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

/** Fast scan of the tail of a session JSONL to get the last assistant turn's token usage (for ctx%). */
export function getSessionLastContext(workspacePath: string, sessionId: string): number {
  const projectKey = pathToProjectKey(workspacePath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);
  try {
    const stat = fs.statSync(jsonlPath);
    // Read last 64KB to find recent token usage (large tool results can push usage data back)
    const readSize = Math.min(65536, stat.size);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(jsonlPath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf-8');
    const lines = tail.split('\n').filter(l => l.trim().startsWith('{'));
    // Walk lines from end to find last assistant message with token usage
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'assistant' && obj.message?.usage) {
          // Check if a /compact happened after this message (new parentUuid:null root follows it)
          for (let j = i + 1; j < lines.length; j++) {
            try {
              const next = JSON.parse(lines[j]);
              if (next.parentUuid === null && next.uuid) return 0; // compacted, no new usage yet
            } catch {}
          }
          const u = obj.message.usage;
          return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
      } catch {}
    }
  } catch {}
  return 0;
}
