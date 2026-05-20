import { describe, it, expect, beforeEach } from 'vitest';
import { serializeTask, expandBlockLimit, getAgentPanelHtml, SerializedTask, PanelInfo, clearTaskRenderCache } from './agentWebview';
import { AgentTask, ContentBlock } from './agentParser';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    agentId: overrides.agentId ?? 'test-agent',
    sessionId: overrides.sessionId ?? 'sess-1',
    description: overrides.description ?? 'Test task',
    prompt: overrides.prompt ?? 'Do something',
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt ?? '2026-03-18T10:00:00Z',
    lastActivity: overrides.lastActivity ?? '2026-03-18T10:05:00Z',
    contentBlocks: overrides.contentBlocks ?? [],
    model: overrides.model,
    slug: overrides.slug,
    _readOffset: overrides._readOffset ?? 0,
    _lastMtime: overrides._lastMtime ?? 0,
  };
}

function makeBlocks(count: number): ContentBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'text' as const,
    text: `Block ${i}`,
    timestamp: '2026-03-18T10:00:00Z',
  }));
}

// ── serializeTask ────────────────────────────────────────────

describe('serializeTask', () => {
  beforeEach(() => {
    clearTaskRenderCache();
  });

  it('serializes a basic task', () => {
    const task = makeTask();
    const s = serializeTask(task);
    expect(s.agentId).toBe('test-agent');
    expect(s.sessionId).toBe('sess-1');
    expect(s.status).toBe('running');
    expect(s.description).toBe('Test task');
    expect(s.blockCount).toBe(0);
    expect(s.hiddenCount).toBe(0);
    expect(s.blocksHtml).toBe('');
  });

  it('uses descOverride when provided', () => {
    const task = makeTask({ description: 'original' });
    const s = serializeTask(task, 'Custom description');
    expect(s.description).toBe('Custom description');
  });

  it('uses sessionLabel when provided', () => {
    const task = makeTask();
    const s = serializeTask(task, undefined, 'My Session');
    expect(s.sessionLabel).toBe('My Session');
  });

  it('falls back to agentId prefix when no description', () => {
    const task = makeTask({ description: '' });
    const s = serializeTask(task);
    expect(s.description).toBe('test-agent'.slice(0, 12));
  });

  it('strips claude- prefix from model', () => {
    const task = makeTask({ model: 'claude-sonnet-4-5-20250514' });
    const s = serializeTask(task);
    expect(s.model).toBe('sonnet-4-5-20250514');
  });

  it('renders content blocks as HTML', () => {
    const task = makeTask({
      contentBlocks: [
        { type: 'text', text: 'Hello world', timestamp: 'T1' },
      ],
    });
    const s = serializeTask(task);
    expect(s.blockCount).toBe(1);
    expect(s.blocksHtml).toContain('block-wrapper');
    expect(s.blocksHtml).toContain('data-block-idx="0"');
    expect(s.blocksHtml).toContain('Hello world');
  });

  it('wraps each block in a block-wrapper with sequential data-block-idx', () => {
    const task = makeTask({ contentBlocks: makeBlocks(3) });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('data-block-idx="0"');
    expect(s.blocksHtml).toContain('data-block-idx="1"');
    expect(s.blocksHtml).toContain('data-block-idx="2"');
  });

  it('caps visible blocks at DEFAULT_VISIBLE_BLOCKS (50)', () => {
    const task = makeTask({ contentBlocks: makeBlocks(75) });
    const s = serializeTask(task);
    expect(s.blockCount).toBe(75);
    expect(s.hiddenCount).toBe(25);
    // First visible block should be index 25
    expect(s.blocksHtml).toContain('data-block-idx="25"');
    expect(s.blocksHtml).not.toContain('data-block-idx="24"');
  });

  it('renders tool_use blocks', () => {
    const task = makeTask({
      contentBlocks: [
        { type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'echo hi' }, timestamp: 'T1' },
      ],
    });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('block-tool');
    expect(s.blocksHtml).toContain('Bash');
    expect(s.blocksHtml).toContain('echo hi');
  });

  it('renders tool_result blocks', () => {
    const task = makeTask({
      contentBlocks: [
        { type: 'tool_result', toolUseId: 't1', content: 'success output', isError: false, timestamp: 'T1' },
      ],
    });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('block-result');
    expect(s.blocksHtml).toContain('tool-result-ok');
    expect(s.blocksHtml).toContain('success output');
  });

  it('renders error tool_result with error class', () => {
    const task = makeTask({
      contentBlocks: [
        { type: 'tool_result', toolUseId: 't1', content: 'ENOENT', isError: true, timestamp: 'T1' },
      ],
    });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('tool-result-error');
  });

  it('shows expandable button for long tool_result content', () => {
    const task = makeTask({
      contentBlocks: [
        { type: 'tool_result', toolUseId: 't1', content: 'x'.repeat(3000), isError: false, timestamp: 'T1' },
      ],
    });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('show-more-btn');
    expect(s.blocksHtml).toContain('remaining');
  });

  it('builds searchText from block content', () => {
    const task = makeTask({
      contentBlocks: [
        { type: 'text', text: 'Important analysis', timestamp: 'T1' },
        { type: 'tool_use', name: 'Grep', id: 't1', input: { pattern: 'TODO' }, timestamp: 'T2' },
      ],
    });
    const s = serializeTask(task);
    expect(s.searchText).toContain('Important analysis');
    expect(s.searchText).toContain('Grep');
    expect(s.searchText).toContain('TODO');
  });

  it('adds collapsible class for long text blocks', () => {
    const longText = Array(15).fill('line').join('\n');
    const task = makeTask({
      contentBlocks: [
        { type: 'text', text: longText, timestamp: 'T1' },
      ],
    });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('collapsible');
    expect(s.blocksHtml).toContain('Show more');
  });

  it('does not add collapsible class for short text blocks', () => {
    const task = makeTask({
      contentBlocks: [
        { type: 'text', text: 'short', timestamp: 'T1' },
      ],
    });
    const s = serializeTask(task);
    expect(s.blocksHtml).not.toContain('collapsible');
  });
});

// ── Edit diff rendering ───────────────────────────────────────

describe('serializeTask Edit diff rendering', () => {
  beforeEach(() => {
    clearTaskRenderCache();
  });

  function makeEditPair(oldStr: string, newStr: string) {
    return [
      { type: 'tool_use' as const, name: 'Edit', id: 'e1', input: { file_path: 'foo.ts', old_string: oldStr, new_string: newStr }, timestamp: 'T1' },
      { type: 'tool_result' as const, toolUseId: 'e1', content: 'Applied', isError: false, timestamp: 'T2' },
    ];
  }

  it('renders inline diff for Edit tool', () => {
    const task = makeTask({ contentBlocks: makeEditPair('old line\n', 'new line\n') });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('tool-pair-diff');
    expect(s.blocksHtml).toContain('diff-del');
    expect(s.blocksHtml).toContain('diff-add');
  });

  it('shows removed line with - sign', () => {
    const task = makeTask({ contentBlocks: makeEditPair('remove me', 'add me') });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('diff-sign');
    expect(s.blocksHtml).toContain('-</span>remove me');
    expect(s.blocksHtml).toContain('+</span>add me');
  });

  it('shows context lines around changes', () => {
    const task = makeTask({ contentBlocks: makeEditPair(
      'line1\nline2\nold\nline4\nline5',
      'line1\nline2\nnew\nline4\nline5',
    ) });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('diff-ctx'); // context lines visible
    expect(s.blocksHtml).toContain('line1'); // within 3-line context of change
  });

  it('skips diff and shows truncation notice for very large edits', () => {
    const bigOld = Array.from({ length: 150 }, (_, i) => `old line ${i}`).join('\n');
    const bigNew = Array.from({ length: 150 }, (_, i) => `new line ${i}`).join('\n');
    const task = makeTask({ contentBlocks: makeEditPair(bigOld, bigNew) });
    const s = serializeTask(task);
    expect(s.blocksHtml).toContain('diff-truncated');
    expect(s.blocksHtml).toContain('too large');
  });

  it('renders nothing for empty old/new strings', () => {
    const task = makeTask({ contentBlocks: makeEditPair('', '') });
    const s = serializeTask(task);
    // No diff section when both strings are empty
    expect(s.blocksHtml).not.toContain('tool-pair-diff');
  });
});

// ── expandBlockLimit ─────────────────────────────────────────

describe('expandBlockLimit', () => {
  it('increases the visible block count for a task', () => {
    const task = makeTask({ agentId: 'expand-test', contentBlocks: makeBlocks(120) });

    const s1 = serializeTask(task);
    expect(s1.hiddenCount).toBe(70); // 120 - 50

    expandBlockLimit('expand-test');
    const s2 = serializeTask(task);
    expect(s2.hiddenCount).toBe(20); // 120 - 100

    expandBlockLimit('expand-test');
    const s3 = serializeTask(task);
    expect(s3.hiddenCount).toBe(0); // 120 - 150, capped at 0
  });
});

// ── getAgentPanelHtml ────────────────────────────────────────

describe('getAgentPanelHtml', () => {
  function makePanelInfo(overrides: Partial<PanelInfo> = {}): PanelInfo {
    return {
      workspace: overrides.workspace ?? '/test/workspace',
      sessions: overrides.sessions ?? [{ id: 'sess-1', displayName: 'Test Session' }],
      sessionNames: overrides.sessionNames ?? new Map(),
      isOverride: overrides.isOverride ?? false,
      conversation: overrides.conversation,
      error: overrides.error,
    };
  }

  it('returns valid HTML', () => {
    const html = getAgentPanelHtml([], makePanelInfo());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('includes toolbar with workspace path', () => {
    const home = process.env.HOME ?? '';
    const html = getAgentPanelHtml([], makePanelInfo({ workspace: home + '/project' }));
    expect(html).toContain('~/project');
  });

  it('shows empty state when no tasks', () => {
    const html = getAgentPanelHtml([], makePanelInfo());
    expect(html).toContain('No active tasks');
  });

  it('does not embed task data in HTML (delivered via postMessage)', () => {
    const tasks: SerializedTask[] = [{
      agentId: 'a1',
      sessionId: 's1',
      status: 'running',
      description: 'Test',
      startedAt: 'T1',
      hiddenCount: 0,
      blockCount: 0,
      blocksHtml: '',
      searchText: '',
    }];
    const html = getAgentPanelHtml(tasks, makePanelInfo());
    // Task data is now sent via postMessage, not embedded in HTML
    expect(html).not.toContain('"agentId":"a1"');
    // But the HTML shell should still contain the panel data bootstrap
    expect(html).toContain('__PANEL_DATA__');
  });

  it('always includes tab bar element (visibility managed via JS)', () => {
    const html = getAgentPanelHtml([], makePanelInfo());
    expect(html).toContain('id="tabBar"');
  });

  it('includes tab buttons in tab bar', () => {
    const html = getAgentPanelHtml([], makePanelInfo({
      conversation: [{ role: 'user', text: 'Hello' }],
    }));
    expect(html).toContain('data-tab="agents"');
    expect(html).toContain('data-tab="conversation"');
  });

  it('shows error banner when error is set', () => {
    const html = getAgentPanelHtml([], makePanelInfo({ error: 'Something broke' }));
    expect(html).toContain('Something broke');
  });

  it('does not show error banner when no error', () => {
    const html = getAgentPanelHtml([], makePanelInfo());
    expect(html).not.toContain('Something broke');
  });

  it('always shows diagnostics bar', () => {
    const html = getAgentPanelHtml([], makePanelInfo());
    expect(html).toContain('headerBar');
    expect(html).toContain('diagToggleBtn');
  });

  it('shows reset button when overrides active', () => {
    const html = getAgentPanelHtml([], makePanelInfo({ isOverride: true }));
    expect(html).toContain('clearOverrides');
  });

  it('does not show reset button without overrides', () => {
    const html = getAgentPanelHtml([], makePanelInfo({ isOverride: false }));
    expect(html).not.toContain('clearOverrides');
  });

  it('auto-switches to conversation tab with autoConversationTab option', () => {
    const html = getAgentPanelHtml([], makePanelInfo({
      conversation: [{ role: 'user', text: 'Hello' }],
    }), { autoConversationTab: true });
    // Conversation tab should be active
    expect(html).toContain('tab-btn active" data-tab="conversation"');
    // Agents tab should not be active
    expect(html).toContain('tab-btn" data-tab="agents"');
    // tabConversation should be active
    expect(html).toContain('tab-content active" id="tabConversation"');
  });

  it('defaults to agents tab without autoConversationTab', () => {
    const html = getAgentPanelHtml([], makePanelInfo({
      conversation: [{ role: 'user', text: 'Hello' }],
    }));
    expect(html).toContain('tab-btn active" data-tab="agents"');
    expect(html).toContain('tab-content active" id="tabAgents"');
  });

  it('escapes HTML in workspace path', () => {
    const html = getAgentPanelHtml([], makePanelInfo({ workspace: '/test/<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not embed conversation data in HTML (delivered via postMessage)', () => {
    const html = getAgentPanelHtml([], makePanelInfo({
      conversation: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hi', model: 'sonnet', tools: ['Read'] },
      ],
    }));
    // Conversation data is now sent via postMessage, not embedded in HTML
    expect(html).not.toContain('"role":"user"');
    // But tab bar should be visible when conversation exists
    expect(html).toContain('tab-bar');
  });

  it('includes multiple session names in toolbar', () => {
    const html = getAgentPanelHtml([], makePanelInfo({
      sessions: [
        { id: 's1', displayName: 'Session One' },
        { id: 's2', displayName: 'Session Two' },
      ],
    }));
    expect(html).toContain('Session One');
    expect(html).toContain('Session Two');
  });
});
