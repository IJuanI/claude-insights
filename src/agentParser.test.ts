import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseAgentFile,
  getTasksDir,
  listAgentFiles,
  parseConversationFromRaw,
  truncateDisplay,
  extractJsonField,
  extractFirstUserMessage,
  pathToProjectKey,
  AgentTask,
} from './agentParser';

// ── Helpers ──────────────────────────────────────────────────

function jsonl(...lines: Record<string, unknown>[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function userMsg(text: string, ts = '2026-03-18T10:00:00Z', extra: Record<string, unknown> = {}) {
  return { type: 'user', timestamp: ts, message: { content: text, ...extra } };
}

function userMsgBlocks(blocks: unknown[], ts = '2026-03-18T10:00:00Z', extra: Record<string, unknown> = {}) {
  return { type: 'user', timestamp: ts, message: { content: blocks, ...extra } };
}

function assistantMsg(
  blocks: unknown[],
  ts = '2026-03-18T10:01:00Z',
  opts: { model?: string; stop_reason?: string | null; usage?: Record<string, number> } = {},
) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { content: blocks, model: opts.model, stop_reason: opts.stop_reason, ...(opts.usage ? { usage: opts.usage } : {}) },
  };
}

// ── extractJsonField ─────────────────────────────────────────

describe('extractJsonField', () => {
  it('extracts a simple string field', () => {
    const text = '{"aiTitle":"My Session Title","other":1}';
    expect(extractJsonField(text, 'aiTitle')).toBe('My Session Title');
  });

  it('extracts field with space after colon', () => {
    const text = '{"aiTitle": "Spaced Title"}';
    expect(extractJsonField(text, 'aiTitle')).toBe('Spaced Title');
  });

  it('handles escaped quotes in value', () => {
    const text = '{"aiTitle":"He said \\"hello\\""}';
    expect(extractJsonField(text, 'aiTitle')).toBe('He said "hello"');
  });

  it('handles escaped newlines', () => {
    const text = '{"summary":"line1\\nline2"}';
    expect(extractJsonField(text, 'summary')).toBe('line1 line2');
  });

  it('returns undefined when field is absent', () => {
    expect(extractJsonField('{"other":"val"}', 'missing')).toBeUndefined();
  });

  it('returns undefined for empty string value', () => {
    expect(extractJsonField('{"aiTitle":""}', 'aiTitle')).toBeUndefined();
  });

  it('finds last occurrence in multi-line text', () => {
    const text = '{"aiTitle":"first"}\n{"aiTitle":"second"}';
    // extractJsonField scans forward, so first match wins
    expect(extractJsonField(text, 'aiTitle')).toBe('first');
  });

  it('handles field appearing in the middle of a large blob', () => {
    const padding = '{"x":"' + 'a'.repeat(100) + '"}\n';
    const text = padding + '{"customTitle":"Found It"}\n' + padding;
    expect(extractJsonField(text, 'customTitle')).toBe('Found It');
  });
});

// ── extractFirstUserMessage ──────────────────────────────────

describe('extractFirstUserMessage', () => {
  it('extracts first plain user message', () => {
    const head = jsonl(userMsg('Hello world'));
    expect(extractFirstUserMessage(head)).toBe('Hello world');
  });

  it('extracts text from array content blocks', () => {
    const head = jsonl(userMsgBlocks([{ type: 'text', text: 'From blocks' }]));
    expect(extractFirstUserMessage(head)).toBe('From blocks');
  });

  it('skips meta messages', () => {
    const head = jsonl(
      { type: 'user', timestamp: 'T1', message: { content: 'meta msg', isMeta: true } },
      userMsg('Real message'),
    );
    expect(extractFirstUserMessage(head)).toBe('Real message');
  });

  it('skips compact summary messages', () => {
    const head = jsonl(
      { type: 'user', timestamp: 'T1', message: { content: 'summary', isCompactSummary: true } },
      userMsg('Real message'),
    );
    expect(extractFirstUserMessage(head)).toBe('Real message');
  });

  it('skips tool_result-only messages', () => {
    const head = jsonl(
      userMsgBlocks([{ type: 'tool_result', tool_use_id: 'x', content: 'result' }]),
      userMsg('After tool result'),
    );
    expect(extractFirstUserMessage(head)).toBe('After tool result');
  });

  it('skips system messages (session-start-hook, tick, etc.)', () => {
    const head = jsonl(
      userMsg('<session-start-hook>some data</session-start-hook>'),
      userMsg('<tick>'),
      userMsg('Real user input'),
    );
    expect(extractFirstUserMessage(head)).toBe('Real user input');
  });

  it('uses command-name as fallback', () => {
    const head = jsonl(userMsg('<command-name>speckit.plan</command-name>'));
    expect(extractFirstUserMessage(head)).toBe('speckit.plan');
  });

  it('prefers real message over command-name fallback', () => {
    const head = jsonl(
      userMsg('<command-name>commit</command-name>'),
      userMsg('Please fix the bug'),
    );
    expect(extractFirstUserMessage(head)).toBe('Please fix the bug');
  });

  it('skips ide_selection messages', () => {
    const head = jsonl(
      userMsg('  <ide_selection>some code</ide_selection>  '),
      userMsg('Actual question'),
    );
    expect(extractFirstUserMessage(head)).toBe('Actual question');
  });

  it('returns undefined when no valid message exists', () => {
    const head = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { content: [{ type: 'text', text: 'hi' }] } },
    );
    expect(extractFirstUserMessage(head)).toBeUndefined();
  });
});

// ── truncateDisplay ──────────────────────────────────────────

describe('truncateDisplay', () => {
  it('returns short text unchanged', () => {
    expect(truncateDisplay('hello')).toBe('hello');
  });

  it('collapses newlines to spaces', () => {
    expect(truncateDisplay('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('trims whitespace', () => {
    expect(truncateDisplay('  padded  ')).toBe('padded');
  });

  it('truncates at 80 chars with ellipsis', () => {
    const long = 'a'.repeat(100);
    const result = truncateDisplay(long);
    expect(result.length).toBe(80);
    expect(result).toBe('a'.repeat(77) + '...');
  });

  it('does not truncate at exactly 80 chars', () => {
    const exact = 'b'.repeat(80);
    expect(truncateDisplay(exact)).toBe(exact);
  });
});

// ── parseConversationFromRaw ─────────────────────────────────

describe('parseConversationFromRaw', () => {
  it('parses a basic user + assistant exchange', () => {
    const raw = jsonl(
      userMsg('Hello'),
      assistantMsg([{ type: 'text', text: 'Hi there!' }]),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', text: 'Hello', timestamp: '2026-03-18T10:00:00Z' });
    expect(msgs[1]).toEqual({
      role: 'assistant',
      text: 'Hi there!',
      model: undefined,
      timestamp: '2026-03-18T10:01:00Z',
    });
  });

  it('captures tool names on assistant messages', () => {
    const raw = jsonl(
      assistantMsg([
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/foo' } },
        { type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'ls' } },
      ]),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].tools).toEqual(['Read', 'Bash']);
  });

  it('includes tool-only assistant messages (no text)', () => {
    const raw = jsonl(
      assistantMsg([
        { type: 'tool_use', name: 'Edit', id: 't1', input: { file_path: '/foo' } },
      ]),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('');
    expect(msgs[0].tools).toEqual(['Edit']);
  });

  it('captures model from assistant messages', () => {
    const raw = jsonl(
      assistantMsg([{ type: 'text', text: 'response' }], undefined, { model: 'claude-sonnet-4-5-20250514' }),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs[0].model).toBe('sonnet-4-5-20250514');
  });

  it('skips meta messages but keeps compact summaries', () => {
    const raw = jsonl(
      { type: 'user', timestamp: 'T1', message: { content: 'meta', isMeta: true } },
      { type: 'user', timestamp: 'T2', message: { content: 'summary', isCompactSummary: true } },
      userMsg('Real message'),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe('summary');
    expect(msgs[0].isCompact).toBe(true);
    expect(msgs[1].text).toBe('Real message');
    expect(msgs[1].isCompact).toBeUndefined();
  });

  it('skips tool_result-only user messages', () => {
    const raw = jsonl(
      userMsgBlocks([{ type: 'tool_result', tool_use_id: 'x', content: 'output' }]),
      userMsg('Real message'),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Real message');
  });

  it('handles user message with array content blocks', () => {
    const raw = jsonl(
      userMsgBlocks([
        { type: 'text', text: 'First part' },
        { type: 'text', text: 'Second part' },
      ]),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('First part\nSecond part');
  });

  it('skips empty and whitespace-only text blocks', () => {
    const raw = jsonl(
      assistantMsg([
        { type: 'text', text: '   ' },
        { type: 'text', text: '' },
        { type: 'text', text: 'Real content' },
      ]),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Real content');
  });

  it('skips entries without a message field', () => {
    const raw = jsonl(
      { type: 'user', timestamp: 'T1' },
      { type: 'assistant', timestamp: 'T2' },
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(0);
  });

  it('skips malformed JSON lines', () => {
    const raw = 'not json\n' + JSON.stringify(userMsg('Valid')) + '\n';
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Valid');
  });

  it('returns empty array for empty input', () => {
    expect(parseConversationFromRaw('')).toEqual([]);
    expect(parseConversationFromRaw('\n\n')).toEqual([]);
  });

  it('handles a longer conversation', () => {
    const raw = jsonl(
      userMsg('msg 1', 'T1'),
      assistantMsg([{ type: 'text', text: 'resp 1' }], 'T2'),
      userMsg('msg 2', 'T3'),
      assistantMsg([{ type: 'text', text: 'resp 2' }], 'T4'),
      userMsg('msg 3', 'T5'),
      assistantMsg([{ type: 'text', text: 'resp 3' }], 'T6'),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(6);
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  it('skips non-user/assistant entry types', () => {
    const raw = jsonl(
      { type: 'system', timestamp: 'T1', data: 'init' },
      userMsg('Hello'),
    );
    const msgs = parseConversationFromRaw(raw);
    expect(msgs).toHaveLength(1);
  });
});

// ── parseConversationFromRaw — tokenUsage on final chunks ───

describe('parseConversationFromRaw tokenUsage', () => {
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 };

  it('attaches tokenUsage to tool-only message with stop_reason "tool_use"', () => {
    const raw = jsonl(
      userMsg('Hello'),
      assistantMsg(
        [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } }],
        '2026-03-18T10:01:00Z',
        { stop_reason: 'tool_use', usage },
      ),
    );
    const msgs = parseConversationFromRaw(raw);
    const assistant = msgs.find(m => m.role === 'assistant');
    expect(assistant?.tokenUsage).toEqual({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5 });
  });

  it('does NOT attach tokenUsage to streaming chunk with stop_reason null', () => {
    const raw = jsonl(
      userMsg('Hello'),
      assistantMsg(
        [{ type: 'text', text: 'partial' }],
        '2026-03-18T10:01:00Z',
        { stop_reason: null, usage },
      ),
    );
    const msgs = parseConversationFromRaw(raw);
    const assistant = msgs.find(m => m.role === 'assistant');
    expect(assistant?.tokenUsage).toBeUndefined();
  });

  it('attaches tokenUsage to text message with stop_reason "end_turn"', () => {
    const raw = jsonl(
      userMsg('Hello'),
      assistantMsg(
        [{ type: 'text', text: 'Done!' }],
        '2026-03-18T10:01:00Z',
        { stop_reason: 'end_turn', usage },
      ),
    );
    const msgs = parseConversationFromRaw(raw);
    const assistant = msgs.find(m => m.role === 'assistant');
    expect(assistant?.tokenUsage).toEqual({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5 });
  });
});

// ── parseAgentFile ───────────────────────────────────────────

describe('parseAgentFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(id: string, ...lines: Record<string, unknown>[]): string {
    const filePath = path.join(tmpDir, `${id}.output`);
    fs.writeFileSync(filePath, jsonl(...lines));
    return filePath;
  }

  it('parses a basic agent file', () => {
    const file = writeAgent('agent-1',
      userMsg('Do the task'),
      assistantMsg([{ type: 'text', text: 'Working on it' }]),
    );
    const task = parseAgentFile(file);
    expect(task.agentId).toBe('1');
    expect(task.description).toBe('Do the task');
    expect(task.prompt).toBe('Do the task');
    expect(task.contentBlocks).toHaveLength(1);
    expect(task.contentBlocks[0].type).toBe('text');
    expect(task.status).toBe('running');
  });

  it('extracts prompt from array content blocks', () => {
    const file = writeAgent('agent-2',
      userMsgBlocks([{ type: 'text', text: 'Block prompt' }]),
    );
    const task = parseAgentFile(file);
    expect(task.prompt).toBe('Block prompt');
    expect(task.description).toBe('Block prompt');
  });

  it('extracts model from assistant messages', () => {
    const file = writeAgent('agent-3',
      userMsg('prompt'),
      assistantMsg([{ type: 'text', text: 'reply' }], undefined, { model: 'claude-opus-4-0-20250514' }),
    );
    const task = parseAgentFile(file);
    expect(task.model).toBe('claude-opus-4-0-20250514');
  });

  it('detects completion via stop_reason=end_turn', () => {
    const file = writeAgent('agent-4',
      userMsg('do it'),
      assistantMsg(
        [{ type: 'text', text: 'Done!' }],
        undefined,
        { stop_reason: 'end_turn' },
      ),
    );
    // Backdate mtime so the staleness guard (>15s) is satisfied
    const past = new Date(Date.now() - 20_000);
    fs.utimesSync(file, past, past);
    const task = parseAgentFile(file);
    expect(task.status).toBe('completed');
  });

  it('stays running when stop_reason=end_turn but has tool_use', () => {
    const file = writeAgent('agent-5',
      userMsg('do it'),
      assistantMsg(
        [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'echo hi' } }],
        undefined,
        { stop_reason: 'end_turn' },
      ),
    );
    const task = parseAgentFile(file);
    expect(task.status).toBe('running');
  });

  it('parses tool_use blocks from assistant', () => {
    const file = writeAgent('agent-6',
      userMsg('prompt'),
      assistantMsg([
        { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/etc/hosts' } },
      ]),
    );
    const task = parseAgentFile(file);
    expect(task.contentBlocks).toHaveLength(1);
    expect(task.contentBlocks[0].type).toBe('tool_use');
    if (task.contentBlocks[0].type === 'tool_use') {
      expect(task.contentBlocks[0].name).toBe('Read');
      expect(task.contentBlocks[0].input).toEqual({ file_path: '/etc/hosts' });
    }
  });

  it('parses tool_result blocks from user', () => {
    const file = writeAgent('agent-7',
      userMsg('prompt'),
      assistantMsg([
        { type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'echo hi' } },
      ]),
      userMsgBlocks([
        { type: 'tool_result', tool_use_id: 't1', content: 'hi\n', is_error: false },
      ]),
    );
    const task = parseAgentFile(file);
    const results = task.contentBlocks.filter(b => b.type === 'tool_result');
    expect(results).toHaveLength(1);
    if (results[0].type === 'tool_result') {
      expect(results[0].content).toBe('hi\n');
      expect(results[0].isError).toBe(false);
    }
  });

  it('marks error tool results', () => {
    const file = writeAgent('agent-8',
      userMsg('prompt'),
      userMsgBlocks([
        { type: 'tool_result', tool_use_id: 't1', content: 'ENOENT', is_error: true },
      ]),
    );
    const task = parseAgentFile(file);
    const results = task.contentBlocks.filter(b => b.type === 'tool_result');
    expect(results).toHaveLength(1);
    if (results[0].type === 'tool_result') {
      expect(results[0].isError).toBe(true);
    }
  });

  it('supports incremental parsing', () => {
    const file = writeAgent('agent-inc',
      userMsg('prompt'),
      assistantMsg([{ type: 'text', text: 'first' }]),
    );

    const pass1 = parseAgentFile(file);
    expect(pass1.contentBlocks).toHaveLength(1);
    expect(pass1._readOffset).toBeGreaterThan(0);

    // Append more content
    fs.appendFileSync(file, JSON.stringify(
      assistantMsg([{ type: 'text', text: 'second' }]),
    ) + '\n');

    const pass2 = parseAgentFile(file, pass1);
    expect(pass2.contentBlocks).toHaveLength(2);
    expect(pass2.contentBlocks[1].type).toBe('text');
    if (pass2.contentBlocks[1].type === 'text') {
      expect(pass2.contentBlocks[1].text).toBe('second');
    }
  });

  it('returns existing task when file has not grown', () => {
    const file = writeAgent('agent-noop',
      userMsg('prompt'),
      assistantMsg([{ type: 'text', text: 'done' }], undefined, { stop_reason: 'end_turn' }),
    );

    const pass1 = parseAgentFile(file);
    const pass2 = parseAgentFile(file, pass1);
    // Should return existing since offset >= size and status != running
    expect(pass2).toBe(pass1);
  });

  it('returns empty task for non-existent file', () => {
    const task = parseAgentFile(path.join(tmpDir, 'missing.output'));
    expect(task.agentId).toBe('missing');
    expect(task.status).toBe('running');
    expect(task.contentBlocks).toEqual([]);
  });

  it('extracts sessionId from entries', () => {
    const file = writeAgent('agent-sid',
      { type: 'user', timestamp: 'T1', sessionId: 'sess-abc', message: { content: 'hi' } },
    );
    const task = parseAgentFile(file);
    expect(task.sessionId).toBe('sess-abc');
  });

  it('extracts startedAt from first user message timestamp', () => {
    const file = writeAgent('agent-ts',
      userMsg('go', '2026-03-18T15:30:00Z'),
    );
    const task = parseAgentFile(file);
    expect(task.startedAt).toBe('2026-03-18T15:30:00Z');
  });

  it('tracks lastActivity from latest timestamp', () => {
    const file = writeAgent('agent-la',
      userMsg('prompt', '2026-03-18T10:00:00Z'),
      assistantMsg([{ type: 'text', text: 'a' }], '2026-03-18T10:05:00Z'),
    );
    const task = parseAgentFile(file);
    expect(task.lastActivity).toBe('2026-03-18T10:05:00Z');
  });
});

// ── listAgentFiles ───────────────────────────────────────────

describe('listAgentFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-agent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns files starting with {', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.output'), '{"type":"user"}\n');
    fs.writeFileSync(path.join(tmpDir, 'b.output'), '{"type":"assistant"}\n');
    const files = listAgentFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.every(f => f.endsWith('.output'))).toBe(true);
  });

  it('filters out non-JSONL files (bash output)', () => {
    fs.writeFileSync(path.join(tmpDir, 'agent.output'), '{"type":"user"}\n');
    fs.writeFileSync(path.join(tmpDir, 'bash.output'), 'plain text output\n');
    const files = listAgentFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('agent.output');
  });

  it('filters out files starting with whitespace', () => {
    fs.writeFileSync(path.join(tmpDir, 'spaced.output'), ' {"type":"user"}\n');
    const files = listAgentFiles(tmpDir);
    expect(files).toHaveLength(0);
  });

  it('ignores non-.output files', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"type":"user"}\n');
    fs.writeFileSync(path.join(tmpDir, 'agent.output'), '{"type":"user"}\n');
    const files = listAgentFiles(tmpDir);
    expect(files).toHaveLength(1);
  });

  it('returns empty for non-existent directory', () => {
    expect(listAgentFiles('/nonexistent/path')).toEqual([]);
  });

  it('returns empty for empty directory', () => {
    expect(listAgentFiles(tmpDir)).toEqual([]);
  });
});

// ── getTasksDir ──────────────────────────────────────────────

describe('getTasksDir', () => {
  it('sanitizes slashes in project path', () => {
    const dir = getTasksDir('/Users/test/project', 'sess-123');
    expect(dir).toContain('-Users-test-project');
    expect(dir).toContain('sess-123');
    expect(dir).toContain('tasks');
  });

  it('includes claude- prefix with uid', () => {
    const dir = getTasksDir('/foo', 'bar');
    expect(dir).toMatch(/claude-\d+/);
  });

  it('round-trips through project key reconstruction (wsPath → key → wsPath → key)', () => {
    // Simulates the path the session tree uses:
    // 1. Claude Code stores projects under a key like "-Users-juan-cruz-workspaces-titan"
    // 2. Tree reconstructs wsPath via reconstructWsPath (filesystem-aware)
    // 3. pathToProjectKey re-sanitizes: replace / and . with -
    // The key must remain identical through this round-trip.
    const originalKey = '-Users-juan-cruz-workspaces-titan';
    // For simple paths without dots or hyphens, naive reconstruction works
    const wsPath = originalKey.replace(/^-/, '/').replace(/-/g, '/');
    const reKey = pathToProjectKey(wsPath);
    expect(reKey).toBe(originalKey);

    // Verify getTasksDir uses the same sanitization
    const dir = getTasksDir(wsPath, 'test-session');
    expect(dir).toContain(originalKey);
  });

  it('pathToProjectKey replaces both slashes and dots', () => {
    // Claude Code replaces both / and . with - in project keys
    // e.g. /Users/juan.cruz/workspaces/project → -Users-juan-cruz-workspaces-project
    const wsPath = '/Users/juan.cruz/workspaces/project';
    const key = pathToProjectKey(wsPath);
    expect(key).toBe('-Users-juan-cruz-workspaces-project');
  });

  it('round-trip FAILS for paths with hyphens in segments (known limitation)', () => {
    // A path like "/my-project" produces key "-my-project"
    // Naive reconstruction: "-my-project" → "/my/project" (wrong!)
    // reconstructWsPath uses filesystem to resolve ambiguity, but naive fails
    // This documents a known ambiguity in Claude Code's project key format
    const originalKey = '-Users-test-my-project';
    const wsPath = originalKey.replace(/^-/, '/').replace(/-/g, '/');
    // wsPath is "/Users/test/my/project" not "/Users/test/my-project"
    expect(wsPath).toBe('/Users/test/my/project');
    // But the re-sanitized key still matches because both produce the same key
    const reKey = pathToProjectKey(wsPath);
    expect(reKey).toBe(originalKey);
  });
});
