import { UsageData } from './rateLimits';
import { SessionUsageStat } from './sessionUsage';
import { computeTokenTotals } from './tokenCalc';

interface Stats {
  todayMessages: number;
  weekMessages: number;
}

export function getWebviewHtml(
  usage: UsageData | null,
  stats: Stats,
  error: string | null,
  updatedAt: Date,
  sessionBreakdown?: SessionUsageStat[]
): string {
  function formatReset(d: Date): string {
    if (!d || isNaN(d.getTime())) return '';
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) return 'resets soon';
    const h = Math.floor(diffMs / 3_600_000);
    const m = Math.round((diffMs % 3_600_000) / 60_000);
    if (h >= 48) {
      return `resets ${d.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
    }
    const days = Math.floor(h / 24);
    const rh = h % 24;
    if (days > 0) return `resets in ${days}d ${rh}h ${m}m`;
    return `resets in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
  }

  function pctColor(pct: number): string {
    if (pct >= 90) return 'var(--vscode-charts-red, #f44747)';
    if (pct >= 75) return 'var(--vscode-charts-yellow, #d7ba7d)';
    return 'var(--vscode-charts-blue, #4fc1ff)';
  }

  function row(label: string, sublabel: string, pct: number, resetDate: Date | null): string {
    const p = Math.round(pct);
    const color = pctColor(p);
    const resetStr = resetDate ? formatReset(resetDate) : '';
    return `
      <div class="row">
        <div class="row-left">
          <div class="row-label">${esc(label)}</div>
          ${sublabel ? `<div class="row-sub">${esc(sublabel)}</div>` : ''}
          ${resetStr ? `<div class="row-sub">${esc(resetStr)}</div>` : ''}
        </div>
        <div class="row-right">
          <span class="pct" style="color:${color}">${p}%</span>
        </div>
      </div>
      <div class="meter"><div class="meter-fill" style="width:${Math.min(p, 100)}%;background:${color}"></div></div>`;
  }

  const fh  = usage?.fiveHour;
  const sd  = usage?.sevenDay;
  const sds = usage?.sevenDaySonnet;
  const eu  = usage?.extraUsage?.isEnabled ? usage.extraUsage : null;

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
  }

  function fmtTimeAgo(ms: number): string {
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function shortProjectKey(key: string): string {
    // -Users-juan-cruz-workspaces-titan → titan
    // Works for multi-segment usernames (e.g. juan.cruz → juan-cruz in path encoding)
    const wsMatch = key.match(/-workspaces-(.+)$/);
    if (wsMatch) return wsMatch[1].replace(/-/g, ' ');
    // Fallback: strip -Users-{anything}- prefix
    return key.replace(/^-Users-.+-/, '').replace(/-/g, ' ') || key;
  }

  const now = Date.now();
  const window5hMs = 5 * 60 * 60 * 1000;
  const window15dMs = 15 * 24 * 60 * 60 * 1000;

  // Billing week: starts when the weekly limit last reset (resetsAt - 7d)
  const billingWeekStart = sd?.resetsAt
    ? sd.resetsAt.getTime() - 7 * 24 * 60 * 60 * 1000
    : now - 7 * 24 * 60 * 60 * 1000;

  // Capacity utilization per window — use the matching rate limit's utilization
  const capacity5h = fh?.utilization ?? 100;
  const capacityWeek = sd?.utilization ?? 100;

  let breakdownHtml = '';
  if (sessionBreakdown && sessionBreakdown.length > 0) {
    // Slice per-session tokens to only what falls within [windowStart, now]
    const sliceTokens = (s: SessionUsageStat, windowStart: number) => {
      const turns = s.turnTokens.filter(t => t.ts >= windowStart);
      if (turns.length === 0) return null;
      return turns.reduce((acc, t) => ({
        input: acc.input + t.input,
        output: acc.output + t.output,
        cacheRead: acc.cacheRead + t.cacheRead,
        cacheWrite: acc.cacheWrite + t.cacheWrite,
        turns: acc.turns + 1,
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
    };

    const items5h = sessionBreakdown.filter(s => s.lastTs >= now - window5hMs);
    const itemsWeek = sessionBreakdown.filter(s => s.lastTs >= billingWeekStart);
    const items15d = sessionBreakdown.filter(s => s.lastTs >= now - window15dMs);

    // Each item gets pct relative to window total (for "balanced to 100%")
    // and pctOfCap relative to total capacity (for "% of capacity" mode)
    const renderList = (items: SessionUsageStat[], windowStart: number, windowCap: number, fixed = false) => {
      if (items.length === 0) return '<div class="session-meta" style="padding:4px 0">No sessions in this window</div>';
      // Compute windowed tokens for each session
      const windowed = items.map(s => ({ s, w: sliceTokens(s, windowStart) })).filter(x => x.w !== null) as { s: SessionUsageStat; w: NonNullable<ReturnType<typeof sliceTokens>> }[];
      const sorted = [...windowed].sort((a, b) => (b.w.input + b.w.output) - (a.w.input + a.w.output));
      const grandTotal = windowed.reduce((acc, x) => {
        const { billed } = computeTokenTotals(x.w.input, x.w.output, x.w.cacheRead, x.w.cacheWrite);
        return acc + billed;
      }, 0);
      return sorted.map(({ s, w }) => {
        const { billed } = computeTokenTotals(w.input, w.output, w.cacheRead, w.cacheWrite);
        const pctRel = grandTotal > 0 ? Math.round(100 * billed / grandTotal) : 0;
        const pctAbs = grandTotal > 0 ? Math.round(windowCap * billed / grandTotal) : 0;
        const projName = shortProjectKey(s.projectKey);
        const displayName = s.displayName || projName;
        const sid = s.sessionId.slice(0, 8);
        const fixedAttr = fixed ? ' data-fixed="1"' : '';
        return `<div class="session-item" data-pct-rel="${pctRel}" data-pct-abs="${pctAbs}"${fixedAttr} style="--bar-pct:${pctRel}%">
          <div class="session-bar"></div>
          <div class="session-item-body">
            <div class="session-name" title="${esc(s.projectKey)} · ${esc(s.sessionId)}">${esc(displayName)}</div>
            <div class="session-meta">${esc(sid)} · ${esc(fmtTimeAgo(s.lastTs))} · ${w.turns} turns · ${esc(fmtTokens(billed))} billed</div>
          </div>
          <div class="session-pct"><span class="pct-val">${pctRel}%</span></div>
        </div>`;
      }).join('');
    };

    breakdownHtml = `
    <div class="divider"></div>
    <div class="section-label-row">
      <span class="section-label" style="margin:0">Session Breakdown</span>
      <button class="pct-mode-btn" id="pctModeBtn" title="Toggle % mode: relative to window total vs % of capacity">% of total</button>
    </div>
    <details class="session-breakdown" open>
      <summary>Current window (5h) — ${items5h.length} session${items5h.length !== 1 ? 's' : ''}</summary>
      <div class="session-list">${renderList(items5h, now - window5hMs, capacity5h)}</div>
    </details>
    <details class="session-breakdown" style="margin-top:6px">
      <summary>This billing week — ${itemsWeek.length} session${itemsWeek.length !== 1 ? 's' : ''}</summary>
      <div class="session-list">${renderList(itemsWeek, billingWeekStart, capacityWeek)}</div>
    </details>
    <details class="session-breakdown" style="margin-top:6px">
      <summary>Past 15 days — ${items15d.length} session${items15d.length !== 1 ? 's' : ''}</summary>
      <div class="session-list">${renderList(items15d, now - window15dMs, capacityWeek, true)}</div>
    </details>
    <script>
      (function() {
        var btn = document.getElementById('pctModeBtn');
        var mode = 'abs'; // 'rel' = % of window total, 'abs' = % of capacity (default)
        if (!btn) return;

        // Restore saved state
        try {
          var vsc = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;
          var saved = vsc && vsc.getState && vsc.getState();
          if (saved && saved.pctMode) { mode = saved.pctMode; }
          // Restore details open/closed state
          if (saved && saved.detailsOpen) {
            var details = document.querySelectorAll('.session-breakdown');
            details.forEach(function(el, i) {
              if (saved.detailsOpen[i] === false) el.removeAttribute('open');
              else if (saved.detailsOpen[i] === true) el.setAttribute('open', '');
            });
          }
        } catch(e) {}

        function applyMode() {
          btn.textContent = mode === 'rel' ? '% of total' : '% of capacity';
          btn.classList.toggle('active', mode === 'abs');
          document.querySelectorAll('.session-item').forEach(function(el) {
            if (el.dataset.fixed) return; // Past 15d stays as % of total
            var pct = mode === 'rel' ? el.dataset.pctRel : el.dataset.pctAbs;
            el.style.setProperty('--bar-pct', pct + '%');
            el.querySelector('.pct-val').textContent = pct + '%';
          });
        }

        function saveState() {
          try {
            if (!vsc) return;
            var detailsOpen = [];
            document.querySelectorAll('.session-breakdown').forEach(function(el) {
              detailsOpen.push(el.hasAttribute('open'));
            });
            vsc.setState(Object.assign({}, vsc.getState() || {}, { pctMode: mode, detailsOpen: detailsOpen }));
          } catch(e) {}
        }

        applyMode();

        btn.addEventListener('click', function() {
          mode = mode === 'rel' ? 'abs' : 'rel';
          applyMode();
          saveState();
        });

        document.querySelectorAll('.session-breakdown').forEach(function(el) {
          el.addEventListener('toggle', function() { saveState(); });
        });
      })();
    </script>`;
  }

  const rows = [
    fh  ? row('Current Session', '', fh.utilization, fh.resetsAt) : '',
    sd  ? row('Weekly · All Models', '', sd.utilization, sd.resetsAt) : '',
    sds ? row('Weekly · Sonnet', '', sds.utilization, sds.resetsAt) : '',
    eu  ? row(
      'Extra Credits (Org)',
      eu.usedCredits != null && eu.monthlyLimit != null
        ? `${Math.round(eu.usedCredits).toLocaleString()} / ${eu.monthlyLimit.toLocaleString()} used`
        : '',
      eu.utilization ?? 0,
      null
    ) : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Claude Usage</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: transparent;
      padding: 10px 14px 14px;
      user-select: none;
    }

    .section-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
      margin: 10px 0 6px;
    }
    .section-label:first-child { margin-top: 0; }

    /* ── Rate limit rows ── */
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .row-label { font-size: 13px; font-weight: 500; }

    .row-sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 1px;
    }

    .pct {
      font-size: 18px;
      font-weight: 700;
      line-height: 1;
      min-width: 42px;
      text-align: right;
    }

    .meter {
      height: 3px;
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .meter-fill {
      height: 100%;
      border-radius: 2px;
    }

    /* ── Activity ── */
    .stats-row {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }

    .stat {
      flex: 1;
      padding: 8px 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      border-radius: 5px;
    }

    .stat-value { font-size: 18px; font-weight: 700; }
    .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }

    /* ── Footer ── */
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.15));
    }

    .updated {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    button {
      font-family: var(--vscode-font-family);
      font-size: 12px;
      padding: 3px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.5; cursor: default; }

    /* ── Error ── */
    .error {
      padding: 7px 10px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 5px;
      font-size: 12px;
      margin-bottom: 8px;
    }

    .divider {
      height: 1px;
      background: var(--vscode-input-border, rgba(128,128,128,0.15));
      margin: 10px 0;
    }

    /* ── Session breakdown ── */
    .session-breakdown {
      margin-top: 4px;
    }
    .session-breakdown summary {
      cursor: pointer;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .session-breakdown summary::-webkit-details-marker { display: none; }
    .session-breakdown summary::before { content: '▶'; font-size: 9px; display: inline-block; transition: transform 0.15s; }
    .session-breakdown[open] summary::before { transform: rotate(90deg); }
    .session-list {
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .section-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .pct-mode-btn {
      font-family: var(--vscode-font-family);
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .pct-mode-btn:hover, .pct-mode-btn.active { color: var(--vscode-charts-blue, #4fc1ff); border-color: var(--vscode-charts-blue, #4fc1ff); }
    .session-item {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.15));
      border-radius: 4px;
      overflow: hidden;
    }
    .session-bar {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: var(--bar-pct, 0%);
      background: var(--vscode-charts-blue, #4fc1ff);
      opacity: 0.08;
      pointer-events: none;
      transition: width 0.3s ease;
    }
    .session-item-body {
      flex: 1;
      min-width: 0;
    }
    .session-name {
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .session-pct {
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      color: var(--vscode-charts-blue, #4fc1ff);
      flex-shrink: 0;
    }
  </style>
</head>
<body>

  ${error ? `<div class="error">⚠ ${esc(error)}</div>` : ''}

  ${rows ? `
    <div class="section-label">Rate Limits</div>
    ${rows}
    <div class="divider"></div>
  ` : ''}

  <div class="section-label">Activity</div>
  <div class="stats-row">
    <div class="stat">
      <div class="stat-value">${stats.todayMessages}</div>
      <div class="stat-label">prompts today</div>
    </div>
    <div class="stat">
      <div class="stat-value">${stats.weekMessages}</div>
      <div class="stat-label">this week</div>
    </div>
  </div>

  <div class="footer">
    <span class="updated">Updated ${updatedAt.toLocaleTimeString()}</span>
    <button id="btn" onclick="doRefresh()">↻ Refresh</button>
  </div>

  ${breakdownHtml}

  <script>
    const vscode = acquireVsCodeApi();
    function doRefresh() {
      const btn = document.getElementById('btn');
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      vscode.postMessage({ command: 'refresh' });
    }
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
