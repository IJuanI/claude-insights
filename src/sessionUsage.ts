import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function getRecentSessionStats(): {
  todayMessages: number;
  weekMessages: number;
} {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    let todayMessages = 0;
    let weekMessages = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { timestamp?: number };
        const ts = entry.timestamp;
        if (!ts) continue;
        if (ts >= weekAgoMs) weekMessages++;
        if (ts >= startOfToday.getTime()) todayMessages++;
      } catch {
        // skip malformed lines
      }
    }

    return { todayMessages, weekMessages };
  } catch {
    return { todayMessages: 0, weekMessages: 0 };
  }
}

export interface SessionTurnStat {
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionUsageStat {
  sessionId: string;
  projectKey: string;
  displayName: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  lastTs: number;
  turnTokens: SessionTurnStat[];
}

const SESSION_HEAD_BYTES = 8 * 1024; // 8KB from start for title extraction

/** Scan all project JSONL files modified within the last 7 days and return per-session token usage */
export function getSessionUsageBreakdown(): SessionUsageStat[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const weekAgoMs = Date.now() - 15 * 24 * 60 * 60 * 1000; // scan 15d to cover all breakdown windows
  const results: SessionUsageStat[] = [];

  let projectKeys: string[];
  try {
    projectKeys = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const projectKey of projectKeys) {
    const projDir = path.join(projectsDir, projectKey);
    let files: string[];
    try {
      const stat = fs.statSync(projDir);
      if (!stat.isDirectory()) continue;
      files = fs.readdirSync(projDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -6);
      // Skip subagent/compact files
      if (sessionId.startsWith('agent-')) continue;

      const filePath = path.join(projDir, file);
      let mtime: number;
      let fileSize: number;
      try {
        const stat = fs.statSync(filePath);
        mtime = stat.mtimeMs;
        fileSize = stat.size;
      } catch {
        continue;
      }

      if (mtime < weekAgoMs) continue;

      // Read head for title extraction (small fixed chunk)
      // Read full file for token counting (streamed line-by-line to avoid large allocations)
      let headRaw = '';
      let raw = '';
      try {
        if (fileSize <= SESSION_HEAD_BYTES * 4) {
          // Small file: read everything once
          raw = fs.readFileSync(filePath, 'utf-8');
          headRaw = raw;
        } else {
          // Large file: read head for titles, full content for tokens
          const fd = fs.openSync(filePath, 'r');
          const headBuf = Buffer.alloc(Math.min(SESSION_HEAD_BYTES, fileSize));
          fs.readSync(fd, headBuf, 0, headBuf.length, 0);
          headRaw = headBuf.toString('utf-8');
          fs.closeSync(fd);
          raw = fs.readFileSync(filePath, 'utf-8');
        }
      } catch {
        continue;
      }

      // Extract display name from the first real user message in the head chunk
      let displayName = '';
      const searchRaw = headRaw || raw;
      for (const ln of searchRaw.split('\n')) {
        if (!ln || !ln.includes('"type":"user"')) continue;
        try {
          const entry = JSON.parse(ln) as Record<string, unknown>;
          if (entry['type'] !== 'user') continue;
          if (entry['isMeta']) continue;
          const msg = entry['message'] as Record<string, unknown> | undefined;
          const content = msg?.['content'];
          if (typeof content !== 'string' || !content.trim()) continue;
          // Skip internal command/system messages
          if (content.startsWith('<')) continue;
          displayName = content.replace(/\s+/g, ' ').trim().slice(0, 80);
          break;
        } catch { /* skip malformed */ }
      }

      const stat: SessionUsageStat = {
        sessionId,
        projectKey,
        displayName,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        turns: 0,
        lastTs: mtime,
        turnTokens: [],
      };

      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry['type'] !== 'assistant') continue;
          const msg = entry['message'] as Record<string, unknown> | undefined;
          if (!msg) continue;
          const model = msg['model'] as string | undefined;
          if (model === '<synthetic>') continue;
          // Skip streaming chunks — only count the final message per API request
          // (streaming chunks have stop_reason: null; final chunks have a string value)
          const stopReason = msg['stop_reason'];
          if (stopReason === null || stopReason === undefined) continue;
          const usage = msg['usage'] as Record<string, unknown> | undefined;
          if (!usage) continue;
          const input = Number(usage['input_tokens'] ?? 0);
          const output = Number(usage['output_tokens'] ?? 0);
          if (input === 0 && output === 0) continue;
          const cacheRead = Number(usage['cache_read_input_tokens'] ?? 0);
          const cacheWrite = Number(usage['cache_creation_input_tokens'] ?? 0);
          stat.input += input;
          stat.output += output;
          stat.cacheRead += cacheRead;
          stat.cacheWrite += cacheWrite;
          stat.turns++;
          const ts = entry['timestamp'] as string | undefined;
          const tsMs = ts ? new Date(ts).getTime() : mtime;
          if (tsMs > stat.lastTs) stat.lastTs = tsMs;
          stat.turnTokens.push({ ts: tsMs, input, output, cacheRead, cacheWrite });
        } catch {
          // skip
        }
      }

      if (stat.turns > 0) {
        results.push(stat);
      }
    }
  }

  // Sort by most recent first
  results.sort((a, b) => b.lastTs - a.lastTs);
  return results;
}
