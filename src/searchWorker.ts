import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';

interface SearchRequest {
  seq: number;
  query: string;
  scope: 'workspace' | 'global';
  claudeDir: string;
  currentKey: string | null;
  currentSessionIds: string[];
  displayNameCache: Record<string, string>;
  maxResults: number;
  matchCase?: boolean;
  matchWholeWord?: boolean;
}

// Current search state — allows cancellation
let currentSeq = 0;
let activeStreams: fs.ReadStream[] = [];
let activeRls: readline.Interface[] = [];

function cancelActive() {
  for (const rl of activeRls) try { rl.close(); } catch {}
  for (const s of activeStreams) try { s.destroy(); } catch {}
  activeRls = [];
  activeStreams = [];
}

parentPort?.on('message', (req: SearchRequest) => {
  cancelActive();
  currentSeq = req.seq;
  run(req);
});

async function run(req: SearchRequest) {
  const seq = req.seq;
  let pattern = escapeRegex(req.query);
  if (req.matchWholeWord) pattern = '\\b' + pattern + '\\b';
  const flags = req.matchCase ? '' : 'i';
  const queryRe = new RegExp(pattern, flags);
  const MAX = req.maxResults || 200;
  let resultCount = 0;
  let pendingResults = 0;
  const seenSessionIds = new Set<string>();

  function cancelled() { return seq !== currentSeq; }

  function sendResult(result: Record<string, unknown>) {
    if (cancelled()) return;
    resultCount++;
    pendingResults++;
    parentPort?.postMessage({ type: 'result', seq, data: result });
    if (pendingResults >= 5) { flush(); }
  }

  function flush() {
    if (cancelled()) return;
    pendingResults = 0;
    parentPort?.postMessage({ type: 'flush', seq });
  }

  async function searchFile(filePath: string, sessionId: string, sessionName: string, projectKey: string, wsLabel?: string): Promise<void> {
    if (cancelled() || seenSessionIds.has(sessionId) || resultCount >= MAX) return;
    seenSessionIds.add(sessionId);

    return new Promise<void>((resolve) => {
      try {
        const stat = fs.statSync(filePath);
        const startOffset = stat.size > 2 * 1024 * 1024 ? stat.size - 2 * 1024 * 1024 : 0;
        const stream = fs.createReadStream(filePath, { encoding: 'utf-8', start: startOffset });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        activeStreams.push(stream);
        activeRls.push(rl);

        let messageIndex = 0;
        let firstLine = startOffset > 0;

        rl.on('line', (line) => {
          if (cancelled() || resultCount >= MAX) { rl.close(); stream.destroy(); return; }
          if (firstLine && startOffset > 0) { firstLine = false; messageIndex++; return; }

          if (!queryRe.test(line)) { messageIndex++; return; }

          try {
            const entry = JSON.parse(line);
            const msg = entry.message;
            if (!msg) { messageIndex++; return; }

            // Determine accurate role: tool_result blocks have role='user' but are really tool output
            let role = msg.role || entry.type || 'unknown';
            if (role === 'user' && Array.isArray(msg.content) && msg.content.some((b: { type: string }) => b.type === 'tool_result')) {
              role = 'tool';
            } else if (role === 'assistant' && Array.isArray(msg.content) && msg.content.some((b: { type: string }) => b.type === 'tool_use') && !msg.content.some((b: { type: string; text?: string }) => b.type === 'text' && b.text)) {
              role = 'tool_call';
            }
            // Classify user messages into sub-types
            let isTaskNotification = false;
            if (role === 'user') {
              const rawText = typeof msg.content === 'string' ? msg.content :
                Array.isArray(msg.content) ? msg.content.filter((b: { type: string; text?: string }) => b.type === 'text').map((b: { text: string }) => b.text).join(' ') : '';
              if (/<task-notification>/.test(rawText)) {
                role = 'task_notification';
                isTaskNotification = true;
              } else if (/^\[Request interrupted by user/.test(rawText.trim())) {
                role = 'interrupted';
              } else if (/<command-name>/.test(rawText)) {
                role = 'command';
              } else if (/<local-command-stdout>/.test(rawText)) {
                role = 'stdout';
              } else if (/<local-command-caveat>/.test(rawText)) {
                role = 'system';
              } else if ((/(context.*compress|conversation.*compact|messages.*summar|prior messages.*compress)/i.test(rawText) && rawText.length < 500) ||
                         (rawText.startsWith('<system-reminder>') && /(summar|compact|context)/i.test(rawText))) {
                role = 'compaction';
              } else if (/^This session is being continued from a previous conversation/i.test(rawText.trim())) {
                role = 'context_summary';
              }
            }
            const entryTs = entry.timestamp as string | undefined;

            let text = '';
            if (typeof msg.content === 'string') {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              const parts: string[] = [];
              for (const block of msg.content) {
                if (block.type === 'text' && block.text) parts.push(block.text);
                else if (block.type === 'tool_use' && block.name) parts.push(block.name + ' ' + formatToolPreview(block.name, block.input ?? {}));
                else if (block.type === 'tool_result') {
                  const rc = block.content;
                  if (typeof rc === 'string') parts.push(rc);
                  else if (Array.isArray(rc)) { for (const rb of rc) { if (rb.text) parts.push(rb.text); } }
                }
              }
              text = parts.join(' ');
            }

            // Clean text for special user message types
            if (role === 'command') {
              const cmdName = text.match(/<command-name>(.*?)<\/command-name>/)?.[1] || '';
              const cmdArgs = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() || '';
              text = '/' + cmdName + (cmdArgs ? ' ' + cmdArgs : '');
            } else if (role === 'stdout') {
              text = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim() || text;
            } else if (role === 'system') {
              // local-command-caveat: skip entirely (no searchable content)
              messageIndex++; return;
            } else if (role === 'compaction') {
              text = 'Context compacted';
            } else if (role === 'context_summary') {
              // Strip XML/HTML tags, keep the summary text
              text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            } else if (role === 'interrupted') {
              // Already clean text: "[Request interrupted by user...]"
            }

            if (isTaskNotification) {
              const statusMatch = text.match(/<status>([\s\S]*?)<\/status>/);
              const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
              const taskIdMatch = text.match(/<task-id>([\s\S]*?)<\/task-id>/);
              const resultMatch = text.match(/<result>([\s\S]*?)<\/result>/);
              const parts: string[] = [];
              if (statusMatch) parts.push(`Status: ${statusMatch[1].trim()}`);
              if (taskIdMatch) parts.push(`Task: ${taskIdMatch[1].trim()}`);
              if (summaryMatch) parts.push(summaryMatch[1].trim());
              if (resultMatch) parts.push(resultMatch[1].trim());
              // Also include any text outside the XML tags
              const afterXml = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
              if (afterXml) parts.push(afterXml);
              text = parts.join('\n') || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }

            if (!queryRe.test(text)) { messageIndex++; return; }

            const matchResult = text.match(queryRe);
            const matchIdx = matchResult?.index ?? 0;
            const snippetStart = Math.max(0, matchIdx - 40);
            const snippetEnd = Math.min(text.length, matchIdx + req.query.length + 80);
            const snippet = (snippetStart > 0 ? '...' : '') + text.slice(snippetStart, snippetEnd).trim() + (snippetEnd < text.length ? '...' : '');

            // Center richText around the match so the keyword is always visible
            let richText: string;
            if (matchIdx <= 400) {
              richText = text.slice(0, 800);
            } else {
              const richStart = Math.max(0, matchIdx - 400);
              richText = (richStart > 0 ? '...\n' : '') + text.slice(richStart, richStart + 800);
            }
            // For task notifications, extract structured fields for rich rendering
            let taskMeta: Record<string, string> | undefined;
            if (isTaskNotification) {
              const rawText = typeof msg.content === 'string' ? msg.content :
                Array.isArray(msg.content) ? msg.content.filter((b: { type: string; text?: string }) => b.type === 'text').map((b: { text: string }) => b.text).join(' ') : '';
              const tnInner = rawText.match(/<task-notification>([\s\S]*?)<\/task-notification>/)?.[1] || '';
              const tnStatus = tnInner.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() || '';
              const tnTaskId = tnInner.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]?.trim() || '';
              const tnSummary = tnInner.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '';
              const tnOutputFile = tnInner.match(/<output-file>([\s\S]*?)<\/output-file>/)?.[1]?.trim() || '';
              const tnCmdMatch = tnSummary.match(/[Bb]ackground command "([^"]+)"/);
              const tnExitMatch = tnSummary.match(/exit code (\d+)/);
              taskMeta = {
                status: tnStatus,
                taskId: tnTaskId,
                summary: tnSummary,
                commandName: tnCmdMatch?.[1] || '',
                exitCode: tnExitMatch?.[1] || '',
                outputFile: tnOutputFile,
              };
            }
            // For tool calls, extract tool name
            let toolName: string | undefined;
            if (role === 'tool_call' && Array.isArray(msg.content)) {
              const toolUse = msg.content.find((b: { type: string }) => b.type === 'tool_use');
              if (toolUse?.name) toolName = toolUse.name;
            }
            sendResult({
              role,
              text: snippet,
              richText,
              sessionId,
              sessionName,
              projectKey,
              workspace: wsLabel,
              messageIndex,
              timestamp: entryTs,
              model: msg.model ? String(msg.model).replace('claude-', '') : undefined,
              taskMeta,
              toolName,
            });
          } catch {}
          messageIndex++;
        });

        rl.on('close', resolve);
        rl.on('error', () => resolve());
      } catch {
        resolve();
      }
    });
  }

  try {
    // Tier 1: Session titles
    if (req.currentKey && !cancelled()) {
      const dir = path.join(req.claudeDir, req.currentKey);
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          if (cancelled()) break;
          const sid = f.replace('.jsonl', '');
          const name = req.displayNameCache[sid] || sid.slice(0, 8);
          if (queryRe.test(name)) {
            sendResult({ role: 'session', text: name, sessionId: sid, sessionName: name, projectKey: req.currentKey, messageIndex: 0 });
          }
        }
      } catch {}
      flush();
    }

    // Tier 2: Current session
    if (req.currentKey && !cancelled()) {
      const dir = path.join(req.claudeDir, req.currentKey);
      for (const sid of req.currentSessionIds) {
        if (cancelled()) break;
        await searchFile(path.join(dir, `${sid}.jsonl`), sid, req.displayNameCache[sid] || sid.slice(0, 8), req.currentKey!);
      }
      flush();
    }

    // Tier 3: Other sessions in current workspace
    if (req.currentKey && !cancelled()) {
      const dir = path.join(req.claudeDir, req.currentKey);
      try {
        const jsonlFiles = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 30);
        for (const jf of jsonlFiles) {
          if (cancelled() || resultCount >= MAX) break;
          const sid = jf.name.replace('.jsonl', '');
          const prevCount = resultCount;
          await searchFile(path.join(dir, jf.name), sid, req.displayNameCache[sid] || sid.slice(0, 8), req.currentKey!);
          if (resultCount > prevCount) flush();
        }
      } catch {}
      flush();
    }

    // Tier 4: Global scope
    if (req.scope === 'global' && !cancelled()) {
      try {
        const dirs = fs.readdirSync(req.claudeDir);
        for (const d of dirs) {
          if (cancelled() || resultCount >= MAX) break;
          if (d === req.currentKey) continue;
          const full = path.join(req.claudeDir, d);
          try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
          const wsName = d.replace(/-/g, '/').replace(/^\//, '');
          try {
            const files = fs.readdirSync(full)
              .filter(f => f.endsWith('.jsonl'))
              .map(f => ({ name: f, mtime: fs.statSync(path.join(full, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)
              .slice(0, 15);
            for (const jf of files) {
              if (cancelled() || resultCount >= MAX) break;
              const sid = jf.name.replace('.jsonl', '');
              await searchFile(path.join(full, jf.name), sid, sid.slice(0, 8), d, wsName);
            }
          } catch {}
          flush();
        }
      } catch {}
    }

    if (!cancelled()) {
      parentPort?.postMessage({ type: 'done', seq });
    }
  } catch (e) {
    if (!cancelled()) {
      parentPort?.postMessage({ type: 'error', seq, message: String(e) });
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatToolPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': return String(input.command ?? '');
    case 'Read': return String(input.file_path ?? '');
    case 'Write': case 'Edit': return String(input.file_path ?? '');
    case 'Grep': return `${input.pattern ?? ''} ${input.path ?? ''}`.trim();
    case 'Glob': return `${input.pattern ?? ''} ${input.path ?? ''}`.trim();
    case 'Agent': return String(input.description ?? input.prompt ?? '').slice(0, 150);
    case 'WebSearch': return String(input.query ?? '');
    case 'WebFetch': return String(input.url ?? '');
    case 'TodoWrite': {
      const todos = input.todos as Array<Record<string, string>> | undefined;
      if (todos && Array.isArray(todos)) {
        return todos.map(t => {
          const s = t.status || '?';
          const icon = s === 'completed' ? '\u2713' : s === 'in_progress' ? '\u25C9' : '\u25CB';
          return icon + ' ' + (t.content || '');
        }).join(' | ');
      }
      return '';
    }
    default: {
      const desc = input.description ?? input.query ?? input.prompt;
      if (desc) return String(desc).slice(0, 150);
      // Fallback: show key=value pairs
      return Object.entries(input).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(', ');
    }
  }
}
