#!/usr/bin/env node
/**
 * Screenshot the Claude Usage sidebar webview.
 * Usage: node scripts/screenshot-sidebar.mjs [outfile] [--width=N] [--height=N] [--theme=dark|light]
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? 'true'; }
  else positional.push(a);
}
const outFile = positional[0] || '/tmp/claude-sidebar.png';
const width = parseInt(flags.width || '380', 10);
const height = parseInt(flags.height || '900', 10);
const theme = flags.theme || 'dark';

// ── Bundle webview.ts ──
const tmpBundle = path.join('/tmp', `sidebar-bundle-${Date.now()}.mjs`);
try {
  execSync(
    `npx esbuild src/webview.ts --bundle --outfile=${tmpBundle} --format=esm --platform=node`,
    { cwd: ROOT, stdio: 'pipe' },
  );
} catch (e) {
  console.error('esbuild failed:', e.stderr?.toString() || e.message);
  process.exit(1);
}

const { getWebviewHtml } = await import(tmpBundle);

// ── Sample data ──
const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const usage = {
  fiveHour: { utilization: 38, resetsAt: new Date(now + 1.75 * HOUR) },
  sevenDay: { utilization: 20, resetsAt: new Date(now + 46.7 * HOUR) },
  sevenDaySonnet: { utilization: 22, resetsAt: new Date(now + 42.7 * HOUR) },
  extraUsage: { isEnabled: true, monthlyLimit: 2000, usedCredits: 2003, utilization: 100 },
};

const stats = { todayMessages: 28, weekMessages: 77 };

function genTurns(startAgo, count, baseInput, baseOutput, baseCacheRead) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      ts: now - (startAgo - i * 5) * 60_000,
      input: baseInput + Math.floor(Math.random() * 200),
      output: baseOutput + Math.floor(Math.random() * 300),
      cacheRead: baseCacheRead + Math.floor(Math.random() * 4000),
      cacheWrite: 0,
    });
  }
  return out;
}

const sessionBreakdown = [
  {
    sessionId: 'a1b2c3d4-rebrand', projectKey: '-Users-juani-workspaces-claude-insights',
    displayName: 'Rebrand to Claude Code Insights', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 18,
    lastTs: now - 3 * 60_000, turnTokens: genTurns(60, 18, 800, 1400, 22000),
  },
  {
    sessionId: 'e5f6a7b8-vsix', projectKey: '-Users-juani-workspaces-claude-insights',
    displayName: 'Build VSIX and clean up artifacts', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 6,
    lastTs: now - 35 * 60_000, turnTokens: genTurns(80, 6, 400, 600, 8000),
  },
  {
    sessionId: 'c9d0e1f2-perm', projectKey: '-Users-juani-workspaces-claude-insights',
    displayName: 'Investigate permission proxy edge case', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 11,
    lastTs: now - 2.8 * HOUR, turnTokens: genTurns(180, 11, 700, 900, 14000),
  },
  {
    sessionId: 'b3c4d5e6-api', projectKey: '-Users-juani-workspaces-api-gateway',
    displayName: 'Add OpenAPI spec validation', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 22,
    lastTs: now - 10 * HOUR, turnTokens: genTurns(640, 22, 600, 1100, 18000),
  },
  {
    sessionId: 'f7a8b9c0-flaky', projectKey: '-Users-juani-workspaces-api-gateway',
    displayName: 'Fix flaky rate-limit test', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 7,
    lastTs: now - DAY, turnTokens: genTurns(1450, 7, 500, 700, 9000),
  },
  {
    sessionId: 'd1e2f3a4-hero', projectKey: '-Users-juani-workspaces-marketing-site',
    displayName: 'Update landing page hero', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 3,
    lastTs: now - 2 * DAY, turnTokens: genTurns(2890, 3, 300, 500, 5000),
  },
];

// Sum turn tokens into the top-level fields
for (const s of sessionBreakdown) {
  for (const t of s.turnTokens) {
    s.input += t.input; s.output += t.output; s.cacheRead += t.cacheRead; s.cacheWrite += t.cacheWrite;
  }
}

const updatedAt = new Date();
let html = getWebviewHtml(usage, stats, null, updatedAt, sessionBreakdown);

// ── Theme vars ──
const DARK = `
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #181818;
  --vscode-panel-border: #2b2b2b;
  --vscode-descriptionForeground: #858585;
  --vscode-textLink-foreground: #3794ff;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #cccccc;
  --vscode-charts-green: #89d185;
  --vscode-charts-red: #f48771;
  --vscode-charts-blue: #4fc1ff;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-orange: #d18616;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-focusBorder: #007fd4;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-editor-font-size: 12px;
`;
const LIGHT = `
  --vscode-foreground: #333333;
  --vscode-editor-background: #ffffff;
  --vscode-sideBar-background: #f3f3f3;
  --vscode-panel-border: #e0e0e0;
  --vscode-descriptionForeground: #717171;
  --vscode-textLink-foreground: #006ab1;
  --vscode-button-background: #007acc;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0062a3;
  --vscode-badge-background: #c4c4c4;
  --vscode-badge-foreground: #333333;
  --vscode-charts-green: #388a34;
  --vscode-charts-red: #a1260d;
  --vscode-charts-blue: #1a85ff;
  --vscode-charts-yellow: #bf8803;
  --vscode-charts-orange: #d18616;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #333333;
  --vscode-input-border: #cecece;
  --vscode-focusBorder: #0090f1;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-editor-font-size: 12px;
`;
const vars = theme === 'light' ? LIGHT : DARK;
const bg = theme === 'light' ? '#f3f3f3' : '#181818';

html = html.replace(
  '</head>',
  `<style>:root{${vars}} body{background:${bg};}</style></head>`,
);
// Mock vscode API for any refresh button etc.
html = html.replace('<body>', `<body><script>function acquireVsCodeApi(){return {postMessage:()=>{},getState:()=>null,setState:()=>{}};}</script>`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
page.on('pageerror', e => console.error('[browser err]', e.message));

const tmp = path.join('/tmp', `sidebar-${Date.now()}.html`);
fs.writeFileSync(tmp, html);
try {
  await page.goto(`file://${tmp}`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: outFile, fullPage: false });
  console.log(`Saved ${outFile} (${width}x${height}, ${theme})`);
} finally {
  fs.unlinkSync(tmp);
  fs.unlinkSync(tmpBundle);
  await browser.close();
}
