/**
 * Regression tests for 4 client-side bug fixes in agentWebviewClient/index.ts.
 *
 * The client code is a @ts-nocheck IIFE that cannot be unit-tested directly,
 * so we verify:
 *   (a) the server-side serialized data that feeds the client (serializeTask),
 *   (b) patterns in the client source code that correspond to the fixes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { serializeTask } from './agentWebview';
import { AgentTask } from './agentParser';

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

const CLIENT_SOURCE = readFileSync(
  resolve(__dirname, 'agentWebviewClient/index.ts'),
  'utf-8',
);

// ── Fix 1: Agent duration display ────────────────────────────

describe('Fix 1: agent duration display', () => {
  it('serializeTask passes through startedAt for running tasks', () => {
    const task = makeTask({ status: 'running', startedAt: '2026-03-18T10:00:00Z' });
    const s = serializeTask(task);
    expect(s.startedAt).toBe('2026-03-18T10:00:00Z');
    expect(s.status).toBe('running');
  });

  it('serializeTask passes through lastActivity for completed tasks', () => {
    const task = makeTask({
      status: 'completed',
      startedAt: '2026-03-18T10:00:00Z',
      lastActivity: '2026-03-18T10:05:00Z',
    });
    const s = serializeTask(task);
    expect(s.startedAt).toBe('2026-03-18T10:00:00Z');
    expect(s.lastActivity).toBe('2026-03-18T10:05:00Z');
  });

  it('client buildTaskCard adds pending-timer class and data-start-ts for running tasks', () => {
    // The buildTaskCard function should output pending-timer + data-start-ts when isRunning
    expect(CLIENT_SOURCE).toContain('pending-timer');
    expect(CLIENT_SOURCE).toContain('data-start-ts');
    // Verify the pattern: running tasks get pending-timer with data-start-ts from startedAt
    expect(CLIENT_SOURCE).toMatch(/isRunning[\s\S]*?pending-timer.*data-start-ts/);
  });

  it('client has a timer loop that updates pending-timer elements', () => {
    // The setInterval + rAF loop that ticks pending-timer elements
    expect(CLIENT_SOURCE).toMatch(/setInterval.*pending-timer/s);
    expect(CLIENT_SOURCE).toMatch(/getAttribute.*data-start-ts/);
    expect(CLIENT_SOURCE).toContain('formatElapsed');
  });

  it('client shows duration (not timeAgo) for completed tasks with lastActivity', () => {
    // Completed tasks: formatElapsed(lastActivity - startedAt), not timeAgo
    expect(CLIENT_SOURCE).toMatch(
      /lastActivity\s*\?\s*formatElapsed\(\s*new Date\(t\.lastActivity\)/,
    );
  });
});

// ── Fix 2: Tasks collapsed by default ────────────────────────

describe('Fix 2: tasks collapsed by default', () => {
  it('expandedTasks starts as an empty Set', () => {
    expect(CLIENT_SOURCE).toMatch(/let expandedTasks\s*=\s*new Set\(\)/);
  });

  it('expandedTasks is NOT restored from persisted state', () => {
    // The fix explicitly comments out restoring expandedTasks from saved state
    expect(CLIENT_SOURCE).toContain(
      "Don't restore expandedTasks",
    );
    // There must be no line like: expandedTasks = new Set(_savedState.expandedTasks)
    expect(CLIENT_SOURCE).not.toMatch(
      /expandedTasks\s*=\s*new Set\(\s*_savedState\.expandedTasks/,
    );
  });

  it('buildTaskCard only adds expanded class when expandedTasks contains the agentId', () => {
    // The card class starts without expanded unless expandedTasks.has(agentId)
    expect(CLIENT_SOURCE).toMatch(
      /isExpanded\s*=\s*expandedTasks\.has\(t\.agentId\)/,
    );
    expect(CLIENT_SOURCE).toMatch(
      /isExpanded\s*\?\s*' expanded'\s*:\s*''/,
    );
  });
});

// ── Fix 3: "1 pending" instead of "awaiting" ────────────────

describe('Fix 3: pending count label uses "N pending" consistently', () => {
  it('client source does not contain the old "awaiting" label for single pending', () => {
    // Old code: (n === 1 ? 'awaiting' : n + ' pending')
    // The word "awaiting" should not appear as a permission/pending label
    const lines = CLIENT_SOURCE.split('\n');
    const awaitingLines = lines.filter(
      (l) => l.includes("'awaiting'") || l.includes('"awaiting"'),
    );
    expect(awaitingLines).toHaveLength(0);
  });

  it('client uses n + " pending" for all counts (including 1)', () => {
    // The fix: always use n + ' pending' regardless of count
    expect(CLIENT_SOURCE).toMatch(/n\s*\+\s*' pending'/);
    // Should NOT have the ternary that special-cases n===1
    expect(CLIENT_SOURCE).not.toMatch(/n\s*===\s*1\s*\?\s*'awaiting'/);
  });
});

// ── Fix 4: Prompt button click handler + SVG icon ────────────

describe('Fix 4: prompt button uses data-action instead of onclick stopPropagation', () => {
  it('task-id-row uses data-action="noop" instead of onclick stopPropagation', () => {
    // The fix: parent row uses data-action="noop" for event delegation
    expect(CLIENT_SOURCE).toContain('data-action="noop"');
    // The task-id-row specifically should NOT use onclick="event.stopPropagation()"
    const taskIdRowMatch = CLIENT_SOURCE.match(/task-id-row[^>]*>/);
    expect(taskIdRowMatch).toBeTruthy();
    expect(taskIdRowMatch![0]).toContain('data-action="noop"');
    expect(taskIdRowMatch![0]).not.toContain('onclick');
  });

  it('prompt button uses data-action="view-prompt"', () => {
    expect(CLIENT_SOURCE).toContain('data-action="view-prompt"');
    // The prompt button should have data-action, not onclick
    const promptBtnMatch = CLIENT_SOURCE.match(/task-prompt-btn[^>]*>/);
    expect(promptBtnMatch).toBeTruthy();
    expect(promptBtnMatch![0]).toContain('data-action="view-prompt"');
  });

  it('prompt SVG icon uses fill="none" (not fill="currentColor" on root)', () => {
    // Extract the SVG inside the prompt button
    const promptSvgMatch = CLIENT_SOURCE.match(
      /task-prompt-btn[^>]*>(<svg[^]*?<\/svg>)/,
    );
    expect(promptSvgMatch).toBeTruthy();
    const svg = promptSvgMatch![1];
    // The root <svg> element should have fill="none"
    const svgOpenTag = svg.match(/<svg[^>]*>/);
    expect(svgOpenTag).toBeTruthy();
    expect(svgOpenTag![0]).toContain('fill="none"');
    expect(svgOpenTag![0]).not.toContain('fill="currentColor"');
  });
});

// ── Fix 5: Auto-scroll stability (ResizeObserver, not MutationObserver) ──────

describe('Fix 5: conversation auto-scroll stability', () => {
  it('uses ResizeObserver instead of MutationObserver for scroll-follow', () => {
    // MutationObserver on convMessages fired on every textContent update (bg command),
    // causing constant re-scroll while reading history. ResizeObserver only fires when
    // the container's dimensions change (real content growth).
    expect(CLIENT_SOURCE).toContain('ResizeObserver');
    // No MutationObserver on convMessages (the conversation container)
    // A MutationObserver that observes convMessages is the old pattern
    expect(CLIENT_SOURCE).not.toMatch(/new MutationObserver[\s\S]{0,400}convMessages/);
  });

  it('_convLockedToBottom starts as true (docked by default)', () => {
    expect(CLIENT_SOURCE).toMatch(/_convLockedToBottom\s*=\s*true/);
  });

  it('unlock threshold uses <=30px gap (tight — prevents accidental unlock)', () => {
    // The threshold for treating scroll position as "near bottom" to re-lock
    expect(CLIENT_SOURCE).toMatch(/scrollHeight\s*-\s*\S+\.scrollTop\s*-\s*\S+\.clientHeight\s*<\s*30/);
  });

  it('ResizeObserver only scrolls when _convLockedToBottom is true', () => {
    // Guard prevents the observer from stealing scroll when user has scrolled up
    const roBlock = CLIENT_SOURCE.match(/new ResizeObserver[\s\S]{0,600}/);
    expect(roBlock).toBeTruthy();
    expect(roBlock![0]).toContain('_convLockedToBottom');
  });

  it('every scroll event updates _convLockedToBottom — no programmatic-scroll guard that skips indicator update', () => {
    // The old guard skipped scroll events matching a programmatic scrollTop, which could
    // cause the indicator to get stuck on "live" when user scrolls to a coincident position.
    // Now every scroll event runs _convIsNearBottom() and updates the indicator.
    const scrollBlock = CLIENT_SOURCE.match(/convEl\.addEventListener\('scroll'[\s\S]{0,700}/);
    expect(scrollBlock).toBeTruthy();
    // Must call updateConvScrollNav unconditionally (no early return path inside the listener)
    expect(scrollBlock![0]).toContain('updateConvScrollNav');
    // No early return before the nearBottom check
    expect(scrollBlock![0]).not.toMatch(/return[\s\S]{0,20}nearBottom/);
  });

  it('new messages while unlocked grow the visible window instead of evicting old messages', () => {
    // CRITICAL: when user is reading history, new messages must not push old messages out of DOM
    expect(CLIENT_SOURCE).toMatch(/!_convLockedToBottom[\s\S]{0,60}convVisibleCount\s*\+=/);
  });

  it('renderConvPage adjusts scrollTop when prepending earlier messages', () => {
    // When older messages load above, scroll position is compensated so view stays stable
    expect(CLIENT_SOURCE).toMatch(/prependScrollH[\s\S]{0,200}scrollDelta/);
    expect(CLIENT_SOURCE).toMatch(/scrollTop\s*\+=\s*scrollDelta/);
  });

  it('double-rAF re-checks _convLockedToBottom before scrolling (race condition fix)', () => {
    // CRITICAL: shouldScrollToBottom is captured at render time (when locked=true).
    // The user may scroll up during the 2-frame delay — if we don't re-check, we yank
    // them back to the bottom against their will.
    // Pattern: inside the inner rAF, check _convLockedToBottom before calling _scrollConvToBottom
    const rafBlock = CLIENT_SOURCE.match(/double-rAF[\s\S]{0,600}/);
    expect(rafBlock).toBeTruthy();
    expect(rafBlock![0]).toMatch(/_convLockedToBottom[\s\S]{0,120}_scrollConvToBottom/);
  });
});
