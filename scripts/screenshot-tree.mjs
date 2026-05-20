#!/usr/bin/env node
/**
 * Screenshot the Session Browser tree view.
 *
 * Usage: node scripts/screenshot-tree.mjs [outfile] [--width=N] [--height=N] [--theme=dark|light]
 *
 * Defaults: outfile=/tmp/claude-tree.png  width=420 height=900 theme=dark
 *
 * Requires npm install to have run (uses playwright).
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
const outFile = positional[0] || '/tmp/claude-tree.png';
const width = parseInt(flags.width || '420', 10);
const height = parseInt(flags.height || '900', 10);
const theme = flags.theme || 'dark';

// ── Bundle treeProvider so we can call SessionTreeProvider.getHtml() ──
const tmpBundle = path.join('/tmp', `tree-bundle-${Date.now()}.mjs`);
// Stub vscode module — getHtml is static and doesn't use vscode APIs, but
// the file imports vscode at the top so esbuild needs SOMETHING to resolve.
const vscodeStub = path.join('/tmp', `vscode-stub-${Date.now()}.mjs`);
fs.writeFileSync(vscodeStub, `export default {}; export const window = {}; export const workspace = {}; export const commands = {}; export const Uri = {};`);
try {
  execSync(
    `npx esbuild src/sessionTree/treeProvider.ts --bundle --outfile=${tmpBundle} --format=esm --platform=node --alias:vscode=${vscodeStub}`,
    { cwd: ROOT, stdio: 'pipe' },
  );
} catch (e) {
  console.error('esbuild failed:', e.stderr?.toString() || e.message);
  process.exit(1);
}

const { SessionTreeProvider } = await import(tmpBundle);
const templateHtml = SessionTreeProvider.getHtml();

// ── Sample workspace data ──
function ago(min) { return Date.now() - min * 60_000; }

const workspaces = [
  {
    projectKey: '-Users-juani-workspaces-claude-insights',
    wsPath: '/Users/juani/workspaces/claude-insights',
    folderName: 'claude-insights',
    shortPath: '~/workspaces/claude-insights',
    sessionCount: 3,
    hasRunning: true,
    isCurrent: true,
    sessions: [
      {
        sessionId: 'sess-aaa', wsPath: '/Users/juani/workspaces/claude-insights',
        displayName: 'Rebrand to Claude Code Insights',
        mtime: ago(2), fileSize: 184320, hasAgents: true, convTurns: 12,
        permissionMode: 'auto', permissionModeLabel: 'auto',
        timeAgo: '2m ago', agentCount: 2, hasRunning: true, iconType: 'running',
        tokenUsage: { totalTokens: 184320, outputTokens: 4200, cacheReadTokens: 162000, avgCacheRead: 13500, messageCount: 12 },
        agents: [
          { agentId: 'task-001', sessionId: 'sess-aaa', wsPath: '/Users/juani/workspaces/claude-insights', description: 'Refactor session tree for screenshot script', model: 'opus-4', status: 'running', messageCount: 8, timeAgo: '30s ago', modelShort: 'opus-4' },
          { agentId: 'task-002', sessionId: 'sess-aaa', wsPath: '/Users/juani/workspaces/claude-insights', description: 'Update README with new features', model: 'sonnet-4', status: 'completed', messageCount: 14, timeAgo: '4m ago', modelShort: 'sonnet-4' },
        ],
      },
      {
        sessionId: 'sess-bbb', wsPath: '/Users/juani/workspaces/claude-insights',
        displayName: 'Build VSIX and clean up old artifacts',
        mtime: ago(45), fileSize: 32000, hasAgents: false, convTurns: 5,
        permissionMode: 'ask', permissionModeLabel: 'ask',
        timeAgo: '45m ago', agentCount: 0, hasRunning: false, iconType: 'conversation',
        tokenUsage: { totalTokens: 32000, outputTokens: 800, cacheReadTokens: 28000, avgCacheRead: 5600, messageCount: 5 },
        agents: [],
      },
      {
        sessionId: 'sess-ccc', wsPath: '/Users/juani/workspaces/claude-insights',
        displayName: 'Investigate permission proxy timeout edge case',
        mtime: ago(180), fileSize: 96000, hasAgents: true, convTurns: 8,
        permissionMode: 'plan', permissionModeLabel: 'plan',
        timeAgo: '3h ago', agentCount: 1, hasRunning: false, iconType: 'agents',
        tokenUsage: { totalTokens: 96000, outputTokens: 2100, cacheReadTokens: 84000, avgCacheRead: 10500, messageCount: 8 },
        agents: [
          { agentId: 'task-003', sessionId: 'sess-ccc', wsPath: '/Users/juani/workspaces/claude-insights', description: 'Trace fallback path in PermissionProxyWatcher', model: 'opus-4', status: 'errored', messageCount: 6, timeAgo: '3h ago', modelShort: 'opus-4' },
        ],
      },
    ],
  },
  {
    projectKey: '-Users-juani-workspaces-api-gateway',
    wsPath: '/Users/juani/workspaces/api-gateway',
    folderName: 'api-gateway',
    shortPath: '~/workspaces/api-gateway',
    sessionCount: 2,
    hasRunning: false,
    isCurrent: false,
    sessions: [
      {
        sessionId: 'sess-ddd', wsPath: '/Users/juani/workspaces/api-gateway',
        displayName: 'Add OpenAPI spec validation',
        mtime: ago(600), fileSize: 124000, hasAgents: false, convTurns: 22,
        timeAgo: '10h ago', agentCount: 0, hasRunning: false, iconType: 'conversation',
        agents: [],
      },
      {
        sessionId: 'sess-eee', wsPath: '/Users/juani/workspaces/api-gateway',
        displayName: 'Fix flaky rate-limit test',
        mtime: ago(1440), fileSize: 48000, hasAgents: false, convTurns: 7,
        timeAgo: '1d ago', agentCount: 0, hasRunning: false, iconType: 'conversation',
        agents: [],
      },
    ],
  },
  {
    projectKey: '-Users-juani-workspaces-marketing-site',
    wsPath: '/Users/juani/workspaces/marketing-site',
    folderName: 'marketing-site',
    shortPath: '~/workspaces/marketing-site',
    sessionCount: 1, hasRunning: false, isCurrent: false,
    sessions: [
      {
        sessionId: 'sess-fff', wsPath: '/Users/juani/workspaces/marketing-site',
        displayName: 'Update landing page hero',
        mtime: ago(2880), fileSize: 18000, hasAgents: false, convTurns: 3,
        timeAgo: '2d ago', agentCount: 0, hasRunning: false, iconType: 'conversation',
        agents: [],
      },
    ],
  },
];

// ── Theme vars ──
const DARK = `
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #252526;
  --vscode-sideBarSectionHeader-border: #1e1e1e;
  --vscode-panel-border: #2b2b2b;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #888;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-descriptionForeground: #858585;
  --vscode-textLink-foreground: #3794ff;
  --vscode-charts-green: #89d185;
  --vscode-charts-red: #f48771;
  --vscode-charts-blue: #4fc1ff;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-orange: #d18616;
  --vscode-charts-purple: #b180d7;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #cccccc;
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
  --vscode-sideBarSectionHeader-border: #e7e7e7;
  --vscode-panel-border: #e0e0e0;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #333333;
  --vscode-input-border: #cecece;
  --vscode-input-placeholderForeground: #767676;
  --vscode-list-hoverBackground: #e8e8e8;
  --vscode-list-activeSelectionBackground: #0060c0;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-descriptionForeground: #717171;
  --vscode-textLink-foreground: #006ab1;
  --vscode-charts-green: #388a34;
  --vscode-charts-red: #a1260d;
  --vscode-charts-blue: #1a85ff;
  --vscode-charts-yellow: #bf8803;
  --vscode-charts-orange: #d18616;
  --vscode-charts-purple: #652d90;
  --vscode-badge-background: #c4c4c4;
  --vscode-badge-foreground: #333333;
  --vscode-focusBorder: #0090f1;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-editor-font-size: 12px;
`;
const vars = theme === 'light' ? LIGHT : DARK;
const bg = theme === 'light' ? '#f3f3f3' : '#252526';

// ── Inject theme + sample data ──
let html = templateHtml.replace(
  '</head>',
  `<style>:root{${vars}} body{background:${bg};}</style></head>`,
);

// Mock acquireVsCodeApi and post sample data
html = html.replace(
  '<body>',
  `<body>
<script>
  function acquireVsCodeApi() { return { postMessage: () => {}, getState: () => null, setState: () => {} }; }
</script>`,
);
html = html.replace(
  '</body>',
  `<script>
    window.addEventListener('load', () => {
      setTimeout(() => {
        window.postMessage({ command: 'updateTree', workspaces: ${JSON.stringify(workspaces)}, searchQuery: '' }, '*');
      }, 100);
    });
  </script>
</body>`,
);

// ── Render ──
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
page.on('pageerror', e => console.error('[browser err]', e.message));

const tmp = path.join('/tmp', `tree-${Date.now()}.html`);
fs.writeFileSync(tmp, html);
try {
  await page.goto(`file://${tmp}`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: outFile, fullPage: false });
  console.log(`Saved ${outFile} (${width}x${height}, ${theme})`);
} finally {
  fs.unlinkSync(tmp);
  fs.unlinkSync(tmpBundle);
  fs.unlinkSync(vscodeStub);
  await browser.close();
}
