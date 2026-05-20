import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageData } from './rateLimits';

export interface SessionMetrics {
  session_id: string;
  model: {
    id: string;
    display_name: string;
  };
  context_window: {
    context_window_size: number;
    total_input_tokens: number;
    total_output_tokens: number;
    used_percentage: number;
  };
  tool_count?: number;
}

export interface CacheEntry {
  usage: UsageData | null;
  error: string | null;
  backoffUntil: number; // epoch ms, 0 = no backoff
  fetchedAt: number;    // epoch ms
  session?: SessionMetrics | null;
}

const CACHE_PATH = path.join(os.homedir(), '.claude', 'claude-code-insights-cache.json');

/** All VS Code windows share this TTL — only one window fetches per interval */
export const CACHE_TTL_MS = 90_000;

export function readSharedCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const c = JSON.parse(raw) as CacheEntry;
    // Rehydrate Date objects (JSON serialises them as ISO strings)
    if (c.usage?.fiveHour)
      (c.usage.fiveHour as any).resetsAt = new Date(c.usage.fiveHour.resetsAt);
    if (c.usage?.sevenDay)
      (c.usage.sevenDay as any).resetsAt = new Date(c.usage.sevenDay.resetsAt);
    if (c.usage?.sevenDaySonnet)
      (c.usage.sevenDaySonnet as any).resetsAt = new Date(c.usage.sevenDaySonnet.resetsAt);
    return c;
  } catch {
    return null;
  }
}

export function writeSharedCache(entry: CacheEntry): void {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf-8');

    // Also write to ccburn's cache format so ccburn doesn't hit the API when we have fresh data
    if (entry.usage) {
      const ccburnCache = {
        ts: new Date().toISOString(),
        has_rate_limits: true,
        keys: ['rate_limits'],
        rate_limits: {
          five_hour: entry.usage.fiveHour ? {
            used_percentage: Math.round(entry.usage.fiveHour.utilization),
            resets_at: Math.floor(entry.usage.fiveHour.resetsAt.getTime() / 1000),
          } : null,
          seven_day: entry.usage.sevenDay ? {
            used_percentage: Math.round(entry.usage.sevenDay.utilization),
            resets_at: Math.floor(entry.usage.sevenDay.resetsAt.getTime() / 1000),
          } : null,
          seven_day_sonnet: entry.usage.sevenDaySonnet ? {
            used_percentage: Math.round(entry.usage.sevenDaySonnet.utilization),
            resets_at: Math.floor(entry.usage.sevenDaySonnet.resetsAt.getTime() / 1000),
          } : null,
        },
      };

      const ccburnPath = path.join(os.homedir(), '.ccburn', 'collect_last.json');
      try {
        fs.writeFileSync(ccburnPath, JSON.stringify(ccburnCache), 'utf-8');
      } catch {
        // ~/.ccburn might not exist — silently ignore
      }
    }
  } catch {
    // ~/.claude might not exist on first run — silently ignore
  }
}
