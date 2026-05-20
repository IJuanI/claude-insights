import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSessionDisplayName,
  findSessionsWithTasks,
  getTasksDir,
  getSubagentsDir,
  listAgentFiles,
  listSubagentFiles,
  loadAgentMeta,
  findAgentDescriptions,
  reconstructWsPath,
  countConversationTurns,
  countAgentBlocks,
  getSessionPermissionMode,
  getSessionTokenUsage,
} from '../agentParser';
import { WorkspaceInfo, SessionMeta, AgentMeta } from './types';

export class SessionRepository {
  /** Per-session metadata cache keyed by "{projectKey}/{sessionId}" — only recomputed when mtime changes */
  private _sessionMetaCache = new Map<string, { mtime: number; meta: SessionMeta }>();

  loadWorkspaces(): WorkspaceInfo[] {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    let entries: string[];
    try {
      entries = fs.readdirSync(projectsDir).filter(d => {
        try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
    } catch {
      return [];
    }

    const workspaces: WorkspaceInfo[] = [];

    for (const key of entries) {
      const wsPath = reconstructWsPath(key);
      const dir = path.join(projectsDir, key);

      let jsonlFiles: { name: string; mtime: number; size: number }[];
      try {
        jsonlFiles = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            try {
              const st = fs.statSync(path.join(dir, f));
              return { name: f, mtime: st.mtimeMs, size: st.size };
            } catch { return null; }
          })
          .filter((f): f is { name: string; mtime: number; size: number } => f !== null)
          .sort((a, b) => b.mtime - a.mtime);
      } catch { continue; }

      if (jsonlFiles.length === 0) continue;

      const sessionsWithTasks = new Set(findSessionsWithTasks(wsPath));

      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const sessions: SessionMeta[] = jsonlFiles.map(f => {
        const sessionId = f.name.replace('.jsonl', '');
        const cacheKey = `${key}/${sessionId}`;
        const cached = this._sessionMetaCache.get(cacheKey);
        // Reuse cached metadata if the file hasn't changed since last read
        if (cached && cached.mtime === f.mtime) {
          // Always refresh hasAgents/agents (cheap — just checks /tmp dir existence)
          const hasAgents = sessionsWithTasks.has(sessionId);
          if (cached.meta.hasAgents !== hasAgents) {
            const agents = hasAgents ? this.loadAgentMetas(wsPath, sessionId) : [];
            cached.meta = { ...cached.meta, hasAgents, agents };
          }
          return cached.meta;
        }
        // File changed or not cached — do the full (expensive) read
        const hasAgents = sessionsWithTasks.has(sessionId);
        const displayName = getSessionDisplayName(wsPath, sessionId);
        const agents = hasAgents ? this.loadAgentMetas(wsPath, sessionId) : [];
        const turns = countConversationTurns(wsPath, sessionId);
        const convTurns = turns.user + turns.assistant;
        const permissionMode = getSessionPermissionMode(wsPath, sessionId);
        const tokenUsage = f.mtime > sevenDaysAgo ? getSessionTokenUsage(wsPath, sessionId) : undefined;
        const meta: SessionMeta = { sessionId, displayName, mtime: f.mtime, fileSize: f.size, hasAgents, agents, convTurns, permissionMode, tokenUsage };
        this._sessionMetaCache.set(cacheKey, { mtime: f.mtime, meta });
        return meta;
      });

      workspaces.push({ projectKey: key, wsPath, sessions });
    }

    return workspaces;
  }

  loadAgentMetas(wsPath: string, sessionId: string): AgentMeta[] {
    const agents: AgentMeta[] = [];

    // Get descriptions from parent session's Agent tool calls (most reliable source)
    const parentDescs = findAgentDescriptions(wsPath, sessionId);

    // --- Primary: persistent subagents directory ---
    const subagentsDir = getSubagentsDir(wsPath, sessionId);
    const subagentFiles = listSubagentFiles(subagentsDir);
    const processedAgentIds = new Set<string>();

    for (const file of subagentFiles) {
      // File name: agent-{id}.jsonl — strip prefix and extension to get agentId
      const basename = path.basename(file);
      const agentId = basename.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      processedAgentIds.add(agentId);

      try {
        const stat = fs.statSync(file);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);

        const raw = buf.toString('utf-8', 0, bytesRead);
        const firstLine = raw.split('\n')[0];

        // Read meta.json for description and agentType (fast, no JSONL parsing needed)
        const meta = loadAgentMeta(subagentsDir, `agent-${agentId}`);
        let description = meta?.description ?? parentDescs.get(agentId) ?? '';
        const agentType = meta?.agentType;
        let model: string | undefined;
        let startedAt = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();

        // Fall back to parsing the first JSONL line for description/model/startedAt
        try {
          const entry = JSON.parse(firstLine);
          if (!description && entry.message?.content) {
            const content = entry.message.content;
            if (typeof content === 'string') {
              description = content.slice(0, 100).split('\n')[0];
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  description = block.text.slice(0, 100).split('\n')[0];
                  break;
                }
              }
            }
          }
          if (entry.model) model = entry.model;
          if (entry.timestamp) startedAt = entry.timestamp;
        } catch {}
        if (!description) description = agentId.slice(0, 12);

        // Check completion: read tail for stop_reason
        const isStale = (Date.now() - stat.mtimeMs) > 30_000;
        let completed = false;
        {
          const tailBuf = Buffer.alloc(4096);
          const tailFd = fs.openSync(file, 'r');
          const tailOffset = Math.max(0, stat.size - 4096);
          fs.readSync(tailFd, tailBuf, 0, tailBuf.length, tailOffset);
          fs.closeSync(tailFd);
          const tail = tailBuf.toString('utf-8');
          completed = tail.includes('"stop_reason":"end_turn"') || tail.includes('"stop_reason": "end_turn"');
        }

        const messageCount = countAgentBlocks(wsPath, sessionId, agentId);
        agents.push({
          agentId,
          description,
          model,
          agentType,
          status: completed || isStale ? 'completed' : 'running',
          startedAt,
          messageCount,
        });
      } catch {}
    }

    // --- Fallback: ephemeral /tmp tasks directory (for currently-running agents) ---
    const tasksDir = getTasksDir(wsPath, sessionId);
    const tmpFiles = listAgentFiles(tasksDir);

    for (const file of tmpFiles) {
      const agentId = path.basename(file).replace('.output', '');
      // Skip agents already loaded from the persistent dir
      if (processedAgentIds.has(agentId)) continue;

      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const stat = fs.fstatSync(fd);
        fs.closeSync(fd);

        const raw = buf.toString('utf-8', 0, bytesRead);
        const firstLine = raw.split('\n')[0];
        let description = parentDescs.get(agentId) ?? '';
        let model: string | undefined;
        let startedAt = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();

        try {
          const entry = JSON.parse(firstLine);
          if (!description && entry.message?.content) {
            const content = entry.message.content;
            if (typeof content === 'string') {
              description = content.slice(0, 100).split('\n')[0];
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  description = block.text.slice(0, 100).split('\n')[0];
                  break;
                }
              }
            }
          }
          if (entry.model) model = entry.model;
          if (entry.timestamp) startedAt = entry.timestamp;
        } catch {}
        if (!description) description = agentId.slice(0, 12);

        const isStale = (Date.now() - stat.mtimeMs) > 30_000;
        let completed = false;
        {
          const tailBuf = Buffer.alloc(4096);
          const tailFd = fs.openSync(file, 'r');
          const tailOffset = Math.max(0, stat.size - 4096);
          fs.readSync(tailFd, tailBuf, 0, tailBuf.length, tailOffset);
          fs.closeSync(tailFd);
          const tail = tailBuf.toString('utf-8');
          completed = tail.includes('"stop_reason":"end_turn"') || tail.includes('"stop_reason": "end_turn"');
        }

        const messageCount = countAgentBlocks(wsPath, sessionId, agentId);
        agents.push({
          agentId,
          description,
          model,
          status: completed || isStale ? 'completed' : 'running',
          startedAt,
          messageCount,
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

  /** Load a search-friendly text snippet from session JSONL head+tail */
  loadSessionSearchContent(s: SessionMeta, cache: WorkspaceInfo[]): string {
    const ws = cache.find(w => w.sessions.includes(s));
    if (!ws) return '';
    const projectDir = path.join(os.homedir(), '.claude', 'projects', ws.projectKey);
    const filePath = path.join(projectDir, `${s.sessionId}.jsonl`);

    try {
      const fd = fs.openSync(filePath, 'r');
      const stat = fs.fstatSync(fd);
      const headSize = Math.min(32768, stat.size);
      const headBuf = Buffer.alloc(headSize);
      fs.readSync(fd, headBuf, 0, headSize, 0);

      let tail = '';
      if (stat.size > 32768) {
        const tailBuf = Buffer.alloc(32768);
        fs.readSync(fd, tailBuf, 0, 32768, stat.size - 32768);
        tail = tailBuf.toString('utf-8');
      }
      fs.closeSync(fd);

      const head = headBuf.toString('utf-8');
      const parts: string[] = [];

      // Extract text from both user and assistant messages
      for (const chunk of [head, tail]) {
        const lines = chunk.split('\n');
        for (const line of lines) {
          // Match user or assistant messages
          const isUser = line.includes('"type":"user"') || line.includes('"type": "user"');
          const isAssistant = line.includes('"type":"assistant"') || line.includes('"type": "assistant"');
          if (!isUser && !isAssistant) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'user' && entry.type !== 'assistant') continue;
            // Skip meta/system messages
            if (entry.message?.isMeta || entry.message?.isCompactSummary) continue;
            const content = entry.message?.content;
            if (typeof content === 'string') {
              parts.push(content.slice(0, 300));
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  parts.push(block.text.slice(0, 300));
                } else if (block.type === 'tool_use' && block.name) {
                  // Index tool names and key inputs
                  parts.push(block.name);
                  if (block.input?.description) parts.push(String(block.input.description).slice(0, 100));
                  if (block.input?.file_path) parts.push(String(block.input.file_path));
                  if (block.input?.command) parts.push(String(block.input.command).slice(0, 100));
                  if (block.input?.pattern) parts.push(String(block.input.pattern));
                }
              }
            }
          } catch {}
          if (parts.join('').length > 4000) break;
        }
        if (parts.join('').length > 4000) break;
      }

      return parts.join(' ').toLowerCase().slice(0, 5000);
    } catch {
      return '';
    }
  }
}
