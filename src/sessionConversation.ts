import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionDisplayName, pathToProjectKey } from './agentParser';

export const SESSION_SCHEME = 'claude-session';

/**
 * Virtual document provider that renders a Claude Code session JSONL
 * as a readable markdown conversation.
 */
export class SessionDocumentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const wsPath = params.get('ws') ?? '';
    const sessionId = params.get('id') ?? '';

    const projectKey = pathToProjectKey(wsPath);
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);

    try {
      const raw = fs.readFileSync(jsonlPath, 'utf-8');
      return formatConversation(raw, wsPath, sessionId);
    } catch (e) {
      return `# Error\n\nCould not read session: ${e}`;
    }
  }
}

function formatConversation(raw: string, wsPath: string, sessionId: string): string {
  const displayName = getSessionDisplayName(wsPath, sessionId);
  const lines = raw.split('\n').filter(Boolean);
  const parts: string[] = [];

  parts.push(`# ${displayName}\n`);
  parts.push(`Session: \`${sessionId}\`\n`);
  parts.push('---\n');

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry['type'] as string;
    const ts = entry['timestamp'] as string | undefined;

    if (type === 'user') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      // Skip meta/system messages
      if (msg['isMeta'] === true || msg['isCompactSummary'] === true) continue;

      const content = msg['content'];
      const texts = extractTexts(content);
      if (!texts.length) continue;

      // Skip tool results (shown under assistant tool calls)
      if (Array.isArray(content) && content.every((b: Record<string, unknown>) => b.type === 'tool_result')) {
        continue;
      }

      const timeLabel = ts ? formatTime(ts) : '';
      parts.push(`\n## 👤 User ${timeLabel}\n`);
      for (const t of texts) {
        parts.push(t + '\n');
      }
    } else if (type === 'assistant') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      const content = msg['content'] as unknown[];
      if (!Array.isArray(content)) continue;

      const model = (msg['model'] as string)?.replace('claude-', '') ?? '';
      const timeLabel = ts ? formatTime(ts) : '';
      const modelLabel = model ? ` (${model})` : '';

      let hasText = false;
      const textParts: string[] = [];
      const toolParts: string[] = [];

      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text') {
          const text = b['text'] as string;
          if (text?.trim()) {
            textParts.push(text);
            hasText = true;
          }
        } else if (b['type'] === 'tool_use') {
          const name = b['name'] as string;
          const input = b['input'] as Record<string, unknown>;
          toolParts.push(formatToolUse(name, input));
        }
      }

      if (!hasText && toolParts.length === 0) continue;

      parts.push(`\n## 🤖 Assistant${modelLabel} ${timeLabel}\n`);
      for (const t of textParts) {
        parts.push(t + '\n');
      }
      for (const t of toolParts) {
        parts.push(t + '\n');
      }
    }
  }

  return parts.join('\n');
}

function extractTexts(content: unknown): string[] {
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

function formatToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `\`\`\`bash\n# ${name}\n${input['command'] ?? ''}\n\`\`\``;
    case 'Read':
      return `> 📄 Read: \`${input['file_path'] ?? ''}\``;
    case 'Write':
      return `> ✏️ Write: \`${input['file_path'] ?? ''}\``;
    case 'Edit':
      return `> ✏️ Edit: \`${input['file_path'] ?? ''}\``;
    case 'Grep':
      return `> 🔍 Grep: \`${input['pattern'] ?? ''}\` in \`${input['path'] ?? '.'}\``;
    case 'Glob':
      return `> 🔍 Glob: \`${input['pattern'] ?? ''}\``;
    case 'Agent':
      return `> 🤖 Agent: ${input['description'] ?? (input['prompt'] as string)?.slice(0, 100) ?? ''}`;
    default: {
      const summary = JSON.stringify(input).slice(0, 200);
      return `> ⚙️ ${name}: \`${summary}\``;
    }
  }
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `_${d.toLocaleTimeString()}_`;
  } catch {
    return '';
  }
}
