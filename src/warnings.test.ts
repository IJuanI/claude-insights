import { describe, it, expect } from 'vitest';
import { evaluateWarnings, evaluateContextBloat, freshWarningState } from './warnings';
import { UsageData } from './rateLimits';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function makeUsage(overrides: Partial<{
  fiveHourPct: number;
  fiveHourResetsIn: number;
  weeklyPct: number;
  weeklyResetsIn: number;
}>, now = Date.now()): { usage: UsageData; now: number } {
  return {
    now,
    usage: {
      fiveHour: overrides.fiveHourPct != null
        ? { utilization: overrides.fiveHourPct, resetsAt: new Date(now + (overrides.fiveHourResetsIn ?? 2 * HOUR)) }
        : null,
      sevenDay: overrides.weeklyPct != null
        ? { utilization: overrides.weeklyPct, resetsAt: new Date(now + (overrides.weeklyResetsIn ?? 3 * DAY)) }
        : null,
      sevenDaySonnet: null,
      extraUsage: null,
    },
  };
}

describe('evaluateWarnings', () => {
  describe('session hot (>=80%, >=1h to reset)', () => {
    it('warns when session is at 80% with 2h left', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 2 * HOUR }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('warning');
      expect(result[0].message).toContain('session at 85%');
      expect(warned.sessionHotCount).toBe(1);
    });

    it('does not warn when session is at 80% but less than 1h to reset', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 30 * 60_000 }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not warn when session is below 80%', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 70, fiveHourResetsIn: 3 * HOUR }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('fires at exactly 80% with exactly 1h', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 80, fiveHourResetsIn: HOUR }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
    });

    it('does not fire at 79.5% session', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 79.5, fiveHourResetsIn: 2 * HOUR }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('weekly hot (>=80%, >=24h to reset)', () => {
    it('warns when weekly is at 80% with 3 days left', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 82, weeklyResetsIn: 3 * DAY }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('warning');
      expect(result[0].message).toContain('weekly usage at 82%');
    });

    it('does not warn when weekly is high but less than 24h to reset', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 90, weeklyResetsIn: 12 * HOUR }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not warn when weekly is below 80%', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 75, weeklyResetsIn: 5 * DAY }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('weekly underuse (<60%, <2 days to reset)', () => {
    it('shows info when weekly at 40% with 1 day left', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 40, weeklyResetsIn: DAY }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('info');
      expect(result[0].message).toContain('60% capacity');
      expect(result[0].message).toContain('Use it or lose it');
    });

    it('does not show when weekly at 40% but 3 days left', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 40, weeklyResetsIn: 3 * DAY }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not show when weekly at 70% with 1 day left', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 70, weeklyResetsIn: DAY }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('fires at exactly 59% with just under 2 days', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 59, weeklyResetsIn: 2 * DAY - 1 }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('info');
    });

    it('does not fire at exactly 60%', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 60, weeklyResetsIn: DAY }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('scheduled re-firing (startup, +1h, +2h, then stop)', () => {
    it('fires on first evaluation (startup)', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 3 * HOUR }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(warned.sessionHotCount).toBe(1);
    });

    it('does not fire again before 1h', () => {
      const now = Date.now();
      const warned = freshWarningState(now);

      const { usage } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 3 * HOUR }, now);
      evaluateWarnings(usage, warned, now);

      const at30m = now + 30 * 60_000;
      const { usage: u2 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 3 * HOUR }, at30m);
      const result = evaluateWarnings(u2, warned, at30m);
      expect(result).toHaveLength(0);
      expect(warned.sessionHotCount).toBe(1);
    });

    it('fires second time at 1h', () => {
      const now = Date.now();
      const warned = freshWarningState(now);

      const { usage } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 4 * HOUR }, now);
      evaluateWarnings(usage, warned, now);

      const at1h = now + HOUR;
      const { usage: u2 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 4 * HOUR }, at1h);
      const result = evaluateWarnings(u2, warned, at1h);
      expect(result).toHaveLength(1);
      expect(warned.sessionHotCount).toBe(2);
    });

    it('fires third time at 2h', () => {
      const now = Date.now();
      const warned = freshWarningState(now);

      const { usage } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 5 * HOUR }, now);
      evaluateWarnings(usage, warned, now);

      const at1h = now + HOUR;
      const { usage: u2 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 5 * HOUR }, at1h);
      evaluateWarnings(u2, warned, at1h);

      const at2h = now + 2 * HOUR;
      const { usage: u3 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 5 * HOUR }, at2h);
      const result = evaluateWarnings(u3, warned, at2h);
      expect(result).toHaveLength(1);
      expect(warned.sessionHotCount).toBe(3);
    });

    it('does not fire a 4th time after 2h', () => {
      const now = Date.now();
      const warned = freshWarningState(now);

      const { usage } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 5 * HOUR }, now);
      evaluateWarnings(usage, warned, now);

      const at1h = now + HOUR;
      const { usage: u2 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 5 * HOUR }, at1h);
      evaluateWarnings(u2, warned, at1h);

      const at2h = now + 2 * HOUR;
      const { usage: u3 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 5 * HOUR }, at2h);
      evaluateWarnings(u3, warned, at2h);

      const at3h = now + 3 * HOUR;
      const { usage: u4 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 5 * HOUR }, at3h);
      const result = evaluateWarnings(u4, warned, at3h);
      expect(result).toHaveLength(0);
      expect(warned.sessionHotCount).toBe(3);
    });

    it('schedule works independently per warning type', () => {
      const now = Date.now();
      const warned = freshWarningState(now);

      // Fire session at startup
      const { usage: u1 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 3 * HOUR, weeklyPct: 40, weeklyResetsIn: DAY }, now);
      const r1 = evaluateWarnings(u1, warned, now);
      expect(r1).toHaveLength(2); // session hot + underuse

      // At 1h, fire both again
      const at1h = now + HOUR;
      const { usage: u2 } = makeUsage({ fiveHourPct: 90, fiveHourResetsIn: 3 * HOUR, weeklyPct: 40, weeklyResetsIn: DAY }, at1h);
      const r2 = evaluateWarnings(u2, warned, at1h);
      expect(r2).toHaveLength(2);

      expect(warned.sessionHotCount).toBe(2);
      expect(warned.weeklyUnderuseCount).toBe(2);
    });
  });

  describe('evaluateContextBloat', () => {
    it('returns null when avgCacheRead is below threshold', () => {
      const now = Date.now();
      const warned = freshWarningState(now);
      const result = evaluateContextBloat(200_000, 'session-1', warned, now);
      expect(result).toBeNull();
      expect(warned.contextBloatCount).toBe(0);
    });

    it('returns null when avgCacheRead equals threshold', () => {
      const now = Date.now();
      const warned = freshWarningState(now);
      const result = evaluateContextBloat(300_000, 'session-1', warned, now);
      expect(result).toBeNull();
    });

    it('fires warning when avgCacheRead exceeds 300K', () => {
      const now = Date.now();
      const warned = freshWarningState(now);
      const result = evaluateContextBloat(350_000, 'session-1', warned, now);
      expect(result).not.toBeNull();
      expect(result!.level).toBe('warning');
      expect(result!.message).toContain('350K');
      expect(result!.message).toContain('tokens/msg avg');
      expect(warned.contextBloatCount).toBe(1);
    });

    it('fires at most 3 times (startup, +1h, +2h)', () => {
      const now = Date.now();
      const warned = freshWarningState(now);

      expect(evaluateContextBloat(400_000, 'sid', warned, now)).not.toBeNull();
      expect(evaluateContextBloat(400_000, 'sid', warned, now)).toBeNull(); // too soon
      expect(evaluateContextBloat(400_000, 'sid', warned, now + HOUR)).not.toBeNull();
      expect(evaluateContextBloat(400_000, 'sid', warned, now + 2 * HOUR)).not.toBeNull();
      expect(evaluateContextBloat(400_000, 'sid', warned, now + 3 * HOUR)).toBeNull(); // maxed out
      expect(warned.contextBloatCount).toBe(3);
    });
  });

  describe('combined scenarios', () => {
    it('can fire session hot and weekly hot simultaneously', () => {
      const now = Date.now();
      const { usage } = makeUsage({
        fiveHourPct: 90,
        fiveHourResetsIn: 2 * HOUR,
        weeklyPct: 85,
        weeklyResetsIn: 3 * DAY,
      }, now);
      const warned = freshWarningState(now);
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(2);
      expect(result.map(w => w.level)).toEqual(['warning', 'warning']);
    });

    it('returns empty when no data is present', () => {
      const usage: UsageData = { fiveHour: null, sevenDay: null, sevenDaySonnet: null, extraUsage: null };
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned);
      expect(result).toHaveLength(0);
    });
  });
});
