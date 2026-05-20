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
  reconstructWsPath,
} from '../agentParser';
import { SearchResult } from './types';

// ── Deep content search (for command palette search) ──

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
    const wsPath = reconstructWsPath(key);
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

    // Also search agent output files (persistent subagents dir + /tmp fallback)
    const sessionsWithTasks = findSessionsWithTasks(wsPath);
    for (const sessionId of sessionsWithTasks) {
      if (results.length >= maxResults) break;

      // Collect files from persistent subagents dir (preferred) and /tmp tasks dir
      const subagentsDir = getSubagentsDir(wsPath, sessionId);
      const subAgentFiles = listSubagentFiles(subagentsDir);
      const tasksDir = getTasksDir(wsPath, sessionId);
      const tmpFiles = listAgentFiles(tasksDir);

      // Deduplicate: persistent files take priority; only add /tmp files with unseen agentIds
      const seenIds = new Set<string>();
      const allAgentFiles: Array<{ file: string; agentId: string }> = [];
      for (const file of subAgentFiles) {
        const agentId = path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
        seenIds.add(agentId);
        allAgentFiles.push({ file, agentId });
      }
      for (const file of tmpFiles) {
        const agentId = path.basename(file).replace('.output', '');
        if (!seenIds.has(agentId)) {
          allAgentFiles.push({ file, agentId });
        }
      }

      for (const { file, agentId } of allAgentFiles) {
        if (results.length >= maxResults) break;

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

          // Get agent description: try meta.json first, then first line of JSONL
          const meta = loadAgentMeta(subagentsDir, `agent-${agentId}`);
          let agentDesc = meta?.description ?? agentId.slice(0, 12);
          if (!agentDesc || agentDesc === agentId.slice(0, 12)) {
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
          }

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
