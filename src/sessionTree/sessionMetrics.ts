import * as os from 'os';

// ── Token formatting helper ──

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

// ── Helpers ──

export function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

/** Returns the last meaningful folder name (e.g. "titan" from "/Users/x/workspaces/titan") */
export function folderName(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function permissionModeLabel(mode: string): string {
  switch (mode) {
    case 'acceptEdits': return 'auto-edit';
    case 'bypassPermissions': return 'bypass';
    case 'dontAsk': return 'yolo';
    case 'plan': return 'plan';
    case 'auto': return 'auto';
    default: return mode;
  }
}
