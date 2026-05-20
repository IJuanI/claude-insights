import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionTokenUsage, findAgentDescriptions, pathToProjectKey } from './agentParser';

// ── helpers ───────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a fake session JSONL at ~/.claude/projects/{key}/{sessionId}.jsonl
 * using a tmpDir-relative project root instead of the real home dir.
 */
function writeSession(workspacePath: string, sessionId: string, lines: object[]): void {
  const key = pathToProjectKey(workspacePath);
  const dir = path.join(tmpDir, '.claude', 'projects', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
  );
}

// We need to point the functions at our tmpDir instead of os.homedir().
// The functions build path as: path.join(os.homedir(), '.claude', 'projects', key, sessionId+'.jsonl')
// We'll symlink the fixture into the real home-relative path under our tmpDir
// by monkey-patching is hard — instead, use a workspace path that causes the key
// to match a path inside our tmpDir.

// Simpler approach: write directly to the expected path by computing it the same way.
function sessionPath(workspacePath: string, sessionId: string): string {
  const key = pathToProjectKey(workspacePath);
  return path.join(os.homedir(), '.claude', 'projects', key, `${sessionId}.jsonl`);
}

function usageLine(input: number, output: number, cacheRead = 0, cacheCreate = 0): object {
  return {
    type: 'assistant',
    message: {
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate },
    },
  };
}

// ── getSessionTokenUsage ──────────────────────────────────────

describe('getSessionTokenUsage', () => {
  it('returns zeros for non-existent file', () => {
    const result = getSessionTokenUsage('/nonexistent/path', 'no-session');
    expect(result.totalTokens).toBe(0);
    expect(result.messageCount).toBe(0);
  });

  it('scans usage blocks and sums tokens', () => {
    // Write a real session file and point function at real home path
    const wsPath = tmpDir;
    const sessionId = 'test-sess-1';
    const key = pathToProjectKey(wsPath);
    const dir = path.join(os.homedir(), '.claude', 'projects', key);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    try {
      const lines = [
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } } }),
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 } } }),
      ].join('\n') + '\n';
      fs.writeFileSync(filePath, lines);

      const result = getSessionTokenUsage(wsPath, sessionId);
      expect(result.inputTokens).toBe(180);
      expect(result.outputTokens).toBe(80);
      expect(result.cacheReadTokens).toBe(200);
      expect(result.cacheCreationTokens).toBe(50);
      expect(result.totalTokens).toBe(180 + 80 + 200 + 50);
      expect(result.messageCount).toBe(2);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('handles file with no usage blocks', () => {
    const wsPath = tmpDir;
    const sessionId = 'test-sess-empty';
    const key = pathToProjectKey(wsPath);
    const dir = path.join(os.homedir(), '.claude', 'projects', key);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    try {
      fs.writeFileSync(filePath, '{"type":"user","message":{"content":"hello"}}\n');
      const result = getSessionTokenUsage(wsPath, sessionId);
      expect(result.totalTokens).toBe(0);
      expect(result.messageCount).toBe(0);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('computes avgCacheRead correctly', () => {
    const wsPath = tmpDir;
    const sessionId = 'test-sess-avg';
    const key = pathToProjectKey(wsPath);
    const dir = path.join(os.homedir(), '.claude', 'projects', key);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    try {
      const lines = [
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } }),
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } } }),
      ].join('\n') + '\n';
      fs.writeFileSync(filePath, lines);

      const result = getSessionTokenUsage(wsPath, sessionId);
      expect(result.avgCacheRead).toBe(150); // (100 + 200) / 2
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

// ── findAgentDescriptions ─────────────────────────────────────

describe('findAgentDescriptions', () => {
  it('returns empty map for non-existent session', () => {
    const map = findAgentDescriptions('/nonexistent', 'no-session');
    expect(map.size).toBe(0);
  });

  it('maps agentId to description from Agent tool call + result', () => {
    const wsPath = tmpDir;
    const sessionId = 'desc-sess';
    const key = pathToProjectKey(wsPath);
    const dir = path.join(os.homedir(), '.claude', 'projects', key);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    try {
      const lines = [
        // Assistant sends Agent tool call
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-abc',
              name: 'Agent',
              input: { description: 'Run the tests', run_in_background: true },
            }],
          },
        }),
        // User responds with tool result containing agentId
        JSON.stringify({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-abc',
              content: 'Started agent with agentId: agent-xyz123',
            }],
          },
        }),
      ].join('\n') + '\n';
      fs.writeFileSync(filePath, lines);

      const map = findAgentDescriptions(wsPath, sessionId);
      expect(map.get('agent-xyz123')).toBe('Run the tests');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('falls back to prompt slice when no description', () => {
    const wsPath = tmpDir;
    const sessionId = 'desc-sess2';
    const key = pathToProjectKey(wsPath);
    const dir = path.join(os.homedir(), '.claude', 'projects', key);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    try {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-xyz',
              name: 'Agent',
              input: { prompt: 'Search for all TODO comments in the codebase and summarize', run_in_background: false },
            }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-xyz',
              content: 'agentId: myagent456',
            }],
          },
        }),
      ].join('\n') + '\n';
      fs.writeFileSync(filePath, lines);

      const map = findAgentDescriptions(wsPath, sessionId);
      // Should use first 100 chars of prompt as fallback
      expect(map.get('myagent456')).toContain('Search for all TODO');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});
