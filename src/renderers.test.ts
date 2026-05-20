import { describe, it, expect } from 'vitest';
import {
  renderConvMessageHtml,
  serializeConversation,
  renderSessionChips,
} from './agentWebview';
import type { ConversationMessage, SessionInfo } from './agentWebview';

// ── helpers ───────────────────────────────────────────────────

function msg(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    role: overrides.role ?? 'user',
    text: overrides.text ?? 'Hello',
    ...overrides,
  };
}

function assistantMsg(text: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return msg({ role: 'assistant', text, ...overrides });
}

// ── renderConvMessageHtml ─────────────────────────────────────

describe('renderConvMessageHtml', () => {
  describe('role labels', () => {
    it('renders user role label', () => {
      const html = renderConvMessageHtml(msg({ text: 'hi' }));
      expect(html).toContain('User');
      expect(html).toContain('conv-msg user');
    });

    it('renders assistant role label', () => {
      const html = renderConvMessageHtml(assistantMsg('hi'));
      expect(html).toContain('Assistant');
      expect(html).toContain('conv-msg assistant');
    });

    it('compact message uses Compact label', () => {
      const html = renderConvMessageHtml(msg({ isCompact: true, text: 'summary' }));
      expect(html).toContain('Compact');
      expect(html).toContain('conv-compact-badge');
    });
  });

  describe('continuation messages', () => {
    it('omits role header for same-role continuation', () => {
      const html = renderConvMessageHtml(assistantMsg('follow-up'), 'assistant');
      expect(html).toContain('continuation');
      expect(html).not.toContain('<div class="conv-role">');
    });

    it('shows role header when role changes', () => {
      const html = renderConvMessageHtml(assistantMsg('response'), 'user');
      expect(html).not.toContain('continuation');
      expect(html).toContain('conv-role');
    });
  });

  describe('user message classification', () => {
    it('renders interrupted message with System label', () => {
      const html = renderConvMessageHtml(msg({ text: '[Request interrupted by user]' }));
      expect(html).toContain('interrupted');
      expect(html).toContain('System');
      expect(html).toContain('[Request interrupted by user]');
    });

    it('returns empty string for local-command-caveat messages', () => {
      const html = renderConvMessageHtml(msg({ text: '<local-command-caveat>...</local-command-caveat>' }));
      expect(html).toBe('');
    });

    it('renders slash command with badge', () => {
      const html = renderConvMessageHtml(msg({ text: '<command-name>/compact</command-name>' }));
      expect(html).toContain('Command');
      expect(html).toContain('conv-command-badge');
      expect(html).toContain('/compact');
    });

    it('renders command stdout in pre tag', () => {
      const html = renderConvMessageHtml(msg({ text: '<local-command-stdout>output text</local-command-stdout>' }));
      expect(html).toContain('<pre class="conv-text">');
      expect(html).toContain('output text');
    });

    it('renders compaction notice', () => {
      const html = renderConvMessageHtml(msg({ text: 'context compressed for new conversation' }));
      expect(html).toContain('compaction-msg');
      expect(html).toContain('⊘');
    });

    it('renders context summary as collapsible details', () => {
      const html = renderConvMessageHtml(msg({ text: 'This session is being continued from a previous conversation that ran out of context.' }));
      expect(html).toContain('<details');
      expect(html).toContain('context-summary-msg');
      expect(html).toContain('Context summary from previous session');
    });

    it('renders task-notification with status badge', () => {
      const html = renderConvMessageHtml(msg({
        text: '<task-notification><task-id>abc123</task-id><status>completed</status><summary>Background command "build" completed (exit code 0)</summary></task-notification>',
      }));
      expect(html).toContain('task-notification-msg');
      expect(html).toContain('notif-ok');
      expect(html).toContain('build');
      expect(html).toContain('✓');
    });

    it('renders failed task-notification with error badge', () => {
      const html = renderConvMessageHtml(msg({
        text: '<task-notification><task-id>def456</task-id><status>failed</status><summary>Background command "test" completed (exit code 1)</summary></task-notification>',
      }));
      expect(html).toContain('notif-err');
      expect(html).toContain('✗');
    });

    it('strips ide_opened_file tag and shows remaining text', () => {
      const html = renderConvMessageHtml(msg({ text: '<ide_opened_file>path/to/file</ide_opened_file>\nActual message' }));
      expect(html).toContain('Actual message');
      expect(html).not.toContain('ide_opened_file');
    });

    it('hides message entirely when ide_opened_file has no remaining text', () => {
      // When only IDE context and no real text, classifies as system with no cleanText → empty
      const html = renderConvMessageHtml(msg({ text: '<ide_opened_file>path/to/file</ide_opened_file>' }));
      expect(html).toBe('');
    });
  });

  describe('assistant messages', () => {
    it('shows model badge', () => {
      const html = renderConvMessageHtml(assistantMsg('response', { model: 'claude-3-opus' }));
      expect(html).toContain('conv-model');
      expect(html).toContain('claude-3-opus');
    });

    it('shows thinking indicator when thinkingCount > 0 but no content', () => {
      const html = renderConvMessageHtml(assistantMsg('text', { thinkingCount: 2 }));
      expect(html).toContain('conv-thinking-indicator');
      expect(html).toContain('Extended thinking');
    });

    it('shows thinking content in details when available', () => {
      const html = renderConvMessageHtml(assistantMsg('text', { thinkingCount: 1, thinking: ['thought A'] }));
      expect(html).toContain('<details class="conv-thinking">');
      expect(html).toContain('thought A');
    });

    it('renders token usage footer when output tokens > 0', () => {
      const html = renderConvMessageHtml(assistantMsg('text', {
        tokenUsage: { input: 100, output: 50, cacheRead: 200, cacheCreate: 0 },
      }));
      expect(html).toContain('conv-token-footer');
      expect(html).toContain('100');
      expect(html).toContain('50 out');
      expect(html).toContain('200');
    });

    it('omits token footer when output is 0', () => {
      const html = renderConvMessageHtml(assistantMsg('text', {
        tokenUsage: { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 },
      }));
      expect(html).not.toContain('conv-token-footer');
    });
  });

  describe('long text collapsing', () => {
    it('wraps long messages in collapsible div', () => {
      const longText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
      const html = renderConvMessageHtml(msg({ text: longText }));
      expect(html).toContain('collapsible');
      expect(html).toContain('Show more');
    });

    it('does not collapse short messages', () => {
      const html = renderConvMessageHtml(msg({ text: 'short message\nsecond line' }));
      expect(html).not.toContain('collapsible');
    });
  });

  describe('timestamp', () => {
    it('shows timestamp span when provided', () => {
      const html = renderConvMessageHtml(msg({ timestamp: '2026-03-18T10:00:00Z' }));
      expect(html).toContain('conv-time');
    });

    it('omits timestamp when not provided', () => {
      const html = renderConvMessageHtml(msg());
      expect(html).not.toContain('conv-time');
    });
  });
});

// ── serializeConversation ─────────────────────────────────────

describe('serializeConversation', () => {
  it('returns an HTML string per message', () => {
    const messages: ConversationMessage[] = [
      msg({ role: 'user', text: 'Hello' }),
      assistantMsg('Hi there'),
    ];
    const result = serializeConversation(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('Hello');
    expect(result[1]).toContain('Hi there');
  });

  it('passes prevRole for continuation detection', () => {
    const messages: ConversationMessage[] = [
      assistantMsg('First'),
      assistantMsg('Second'),
    ];
    const result = serializeConversation(messages);
    expect(result[1]).toContain('continuation');
  });

  it('returns empty array for no messages', () => {
    expect(serializeConversation([])).toEqual([]);
  });
});

// ── renderSessionChips ────────────────────────────────────────

describe('renderSessionChips', () => {
  it('returns empty string with no sessions', () => {
    const html = renderSessionChips({ sessions: [], conversationSessionId: undefined });
    expect(html).toBe('');
  });

  it('returns empty string for single session', () => {
    const sessions: SessionInfo[] = [{ id: 'sess-1', displayName: 'Session 1' }];
    const html = renderSessionChips({ sessions, conversationSessionId: 'sess-1' });
    expect(html).toBe('');
  });

  it('renders chips for multiple sessions', () => {
    const sessions: SessionInfo[] = [
      { id: 'sess-1', displayName: 'Session 1' },
      { id: 'sess-2', displayName: 'Session 2' },
    ];
    const html = renderSessionChips({ sessions, conversationSessionId: 'sess-1' });
    expect(html).toContain('session-chip');
    expect(html).toContain('Session 1');
    expect(html).toContain('Session 2');
  });

  it('marks active session with active class', () => {
    const sessions: SessionInfo[] = [
      { id: 'sess-1', displayName: 'S1' },
      { id: 'sess-2', displayName: 'S2' },
    ];
    const html = renderSessionChips({ sessions, conversationSessionId: 'sess-2' });
    expect(html).toContain('active');
  });
});
