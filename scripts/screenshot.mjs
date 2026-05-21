#!/usr/bin/env node
/**
 * Capture a screenshot of the Claude Lens webview panel.
 *
 * Usage:
 *   node scripts/screenshot.mjs [outfile] [--width=N] [--height=N] [--theme=dark|light] [--tab=agents|conversation]
 *
 * Defaults:
 *   outfile:  /tmp/claude-lens-screenshot.png
 *   width:    420
 *   height:   900
 *   theme:    dark
 *   tab:      agents
 *
 * Requires `npm run bundle` to have been run first (needs dist/agentWebviewClient.js).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Parse CLI args ──────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? 'true';
  } else {
    positional.push(a);
  }
}

const outFile = positional[0] || '/tmp/claude-lens-screenshot.png';
const width = parseInt(flags.width || '420', 10);
const height = parseInt(flags.height || '900', 10);
const theme = flags.theme || 'dark';
const tab = flags.tab || 'agents';

// ── Load the real template ──────────────────────────────────

// We need to import the TS modules. Use a dynamic approach: compile the
// template function inline by reading the dist bundle which is CJS.
// Actually simpler: read the template TS source and extract the HTML string.
// Simplest: just use the real getAgentPanelHtml via tsx/ts-node.
// But we want zero extra deps. Instead, read the built dist and generate
// the HTML by calling it, OR just read the template source and build HTML manually
// using the ACTUAL template output.

// Best approach: use the compiled agentWebview exports from a quick esbuild bundle.

import { execSync } from 'child_process';

// Build a temp ESM bundle of the server renderers
const tmpBundle = path.join('/tmp', `screenshot-bundle-${Date.now()}.mjs`);
try {
  execSync(
    `npx esbuild src/agentWebview/index.ts --bundle --outfile=${tmpBundle} --format=esm --platform=node --external:vscode --define:process.env.HOME='"${process.env.HOME}"'`,
    { cwd: ROOT, stdio: 'pipe' },
  );
} catch (e) {
  console.error('esbuild failed:', e.stderr?.toString());
  process.exit(1);
}

const { getAgentPanelHtml, serializeConversation } = await import(tmpBundle);

const cssPath = path.join(ROOT, 'media', 'agentWebview.css');
const jsPath = path.join(ROOT, 'dist', 'agentWebviewClient.js');

if (!fs.existsSync(jsPath)) {
  console.error('dist/agentWebviewClient.js not found — run `npm run bundle` first');
  process.exit(1);
}

const css = fs.readFileSync(cssPath, 'utf-8');
const clientJs = fs.readFileSync(jsPath, 'utf-8').replace(/<\/script>/g, '<\\/script>');

// ── Sample data ─────────────────────────────────────────────

function ago(m) {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function sampleTasks() {
  return [
    {
      agentId: 'abc123', sessionId: 'sess-1',
      description: 'Refactor authentication module',
      prompt: 'Refactor the auth module to use the new Cognito SDK',
      status: 'running', model: 'opus-4',
      startedAt: ago(12), lastActivity: ago(0.5),
      hiddenCount: 0, blockCount: 3, searchText: '',
      blocksHtml: `
        <div class="block-wrapper" data-block-idx="0">
          <details class="block block-tool-pair tool-result-ok">
            <summary class="tool-pair-header">
              <span class="tool-pair-icon">🔍</span><span class="tool-pair-name">Grep</span>
              <span class="tool-pair-preview">pattern: &quot;AuthService&quot;</span>
              <span class="tool-pair-result-icon">✓</span><span class="tool-pair-lines">12 matches</span>
              <div class="tool-pair-result-line tool-result-ok">Found 12 matches across 4 files</div>
            </summary>
            <div class="tool-pair-body">
              <div class="tool-pair-input"><div class="tool-pair-section-label">Command</div><pre>pattern: "AuthService", type: "ts"</pre></div>
            </div>
          </details>
        </div>
        <div class="block-wrapper" data-block-idx="1">
          <details class="block block-tool-pair tool-result-ok">
            <summary class="tool-pair-header">
              <span class="tool-pair-icon">📄</span><span class="tool-pair-name">Read</span>
              <span class="tool-pair-preview">src/auth/auth.service.ts</span>
              <span class="tool-pair-result-icon">✓</span><span class="tool-pair-lines">89 lines</span>
              <div class="tool-pair-result-line tool-result-ok">89 lines</div>
            </summary>
          </details>
        </div>
        <div class="block-wrapper" data-block-idx="2">
          <details class="block block-tool-pair tool-result-pending">
            <summary class="tool-pair-header">
              <span class="tool-pair-icon">✏️</span><span class="tool-pair-name">Edit</span>
              <span class="tool-pair-preview">src/auth/auth.service.ts</span>
              <span class="tool-pair-result-icon">⋯</span>
              <div class="tool-pair-result-line tool-result-pending"><span class="pending-indicator" style="opacity:0.5"><span class="pending-spinner"></span> running...</span></div>
            </summary>
          </details>
        </div>`,
    },
    {
      agentId: 'def456', sessionId: 'sess-1',
      description: 'Add unit tests for UserService',
      prompt: 'Write unit tests for UserService',
      status: 'completed', model: 'sonnet-4',
      startedAt: ago(25), lastActivity: ago(8),
      hiddenCount: 0, blockCount: 1, searchText: '',
      blocksHtml: `<div class="block-wrapper" data-block-idx="0"><div class="block block-text">Created 14 test cases covering all UserService methods.</div></div>`,
    },
    {
      agentId: 'ghi789', sessionId: 'sess-1',
      description: 'Fix N+1 query in orders endpoint',
      prompt: 'Fix the N+1 query problem in GET /orders',
      status: 'error', model: 'haiku-4',
      startedAt: ago(5), lastActivity: ago(3),
      hiddenCount: 0, blockCount: 1, searchText: '',
      blocksHtml: `<div class="block-wrapper" data-block-idx="0">
        <details class="block block-tool-pair tool-result-error">
          <summary class="tool-pair-header">
            <span class="tool-pair-icon">💻</span><span class="tool-pair-name">Bash</span>
            <span class="tool-pair-preview">npx nx run orders-api:test</span>
            <span class="tool-pair-result-icon">✗</span>
            <div class="tool-pair-result-line tool-result-error">TypeError: Cannot read property &#39;relations&#39;</div>
          </summary>
        </details>
      </div>`,
    },
  ];
}

function sampleConversation() {
  return [
    { role: 'user', text: 'Can you refactor the auth module to use the new Cognito SDK and add tests?', timestamp: ago(15) },
    { role: 'assistant', text: 'I\'ll break this into parallel tasks:\n\n1. Refactor the auth module\n2. Add unit tests for UserService\n3. Fix the N+1 query I noticed', model: 'opus-4', timestamp: ago(14) },
    { role: 'user', text: 'Looks good, also make sure to update the migration if any entity fields change.', timestamp: ago(10) },
    { role: 'assistant', text: 'Noted. I\'ll generate a migration if any entity schema changes. The auth refactor agent is currently reading the existing service. Tests agent has already completed with 14 passing tests.', model: 'opus-4', timestamp: ago(9), tokenUsage: { input: 1200, output: 89, cacheRead: 45200, cacheCreate: 0 } },
  ];
}

const convHtml = serializeConversation(sampleConversation());

// ── Generate real HTML via template ─────────────────────────

const panelInfo = {
  workspace: process.env.HOME + '/workspaces/my-project',
  sessions: [{ id: 'sess-1', displayName: 'refactor-auth' }],
  sessionNames: new Map(),
  isOverride: false,
  nonce: 'screenshot-nonce',
  cspSource: '',
  scriptUri: '',
  cssUri: '',
  conversation: sampleConversation(),
};

const options = { autoConversationTab: tab === 'conversation' };
const templateHtml = getAgentPanelHtml([], panelInfo, options);

// ── Patch the HTML to be standalone ─────────────────────────

const DARK_THEME = `
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #252526;
  --vscode-panel-background: #1e1e1e;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #cccccc;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-textLink-foreground: #3794ff;
  --vscode-descriptionForeground: #858585;
  --vscode-errorForeground: #f48771;
  --vscode-charts-green: #89d185;
  --vscode-charts-red: #f48771;
  --vscode-charts-blue: #4fc1ff;
  --vscode-charts-yellow: #cca700;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-focusBorder: #007fd4;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-editor-font-size: 12px;
`;

const LIGHT_THEME = `
  --vscode-foreground: #333333;
  --vscode-editor-background: #ffffff;
  --vscode-sideBar-background: #f3f3f3;
  --vscode-panel-background: #ffffff;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #333333;
  --vscode-input-border: #cecece;
  --vscode-button-background: #007acc;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0062a3;
  --vscode-badge-background: #c4c4c4;
  --vscode-badge-foreground: #333333;
  --vscode-list-hoverBackground: #e8e8e8;
  --vscode-list-activeSelectionBackground: #0060c0;
  --vscode-textLink-foreground: #006ab1;
  --vscode-descriptionForeground: #717171;
  --vscode-errorForeground: #a1260d;
  --vscode-charts-green: #388a34;
  --vscode-charts-red: #a1260d;
  --vscode-charts-blue: #1a85ff;
  --vscode-charts-yellow: #bf8803;
  --vscode-inputValidation-errorBackground: #f2dede;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-editorWidget-background: #f3f3f3;
  --vscode-editorWidget-border: #c8c8c8;
  --vscode-focusBorder: #0090f1;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-editor-font-size: 12px;
`;

const themeVars = theme === 'light' ? LIGHT_THEME : DARK_THEME;
const bgColor = theme === 'light' ? '#ffffff' : '#1e1e1e';

// Replace the empty stylesheet link with inline styles
let html = templateHtml.replace(
  '<link rel="stylesheet" href="">',
  // The bundled CSS sets `body{background:transparent}` (VS Code provides the
  // host background). Put our background on html, and use !important on body
  // so the cascade can't override it. Append our overrides AFTER the bundled
  // CSS for the same reason.
  `<style>html{background:${bgColor};} :root{${themeVars}} ${css}
  html, body { background: ${bgColor} !important; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; padding: 0; }
  </style>`,
);

// Replace the empty script src with inline client JS + VS Code mock.
// Use a function replacer so that '$' characters in the JS bundle (or in the
// JSON payloads) are not interpreted as String.replace back-references.
const replacement = `<script nonce="screenshot-nonce">
    // Mock VS Code API before client JS runs
    function acquireVsCodeApi() {
      return {
        postMessage: function(msg) {},
        getState: function() { return null; },
        setState: function() {},
      };
    }
  </script>
  <script nonce="screenshot-nonce">${clientJs}</script>
  <script nonce="screenshot-nonce">
    // Send initData after client JS attaches its message listener
    setTimeout(function() {
      window.postMessage({
        command: 'initData',
        tasks: ${JSON.stringify(sampleTasks())},
        conversation: ${JSON.stringify(sampleConversation())},
        conversationHtml: ${JSON.stringify(convHtml)},
        diagnostics: {
          workspace: '~/workspaces/my-project',
          sessions: ['sess-1'],
          taskCount: 3,
          watcherCount: 2,
          pollMs: 1000,
        },
      }, '*');
    }, 50);
  </script>`;
html = html.replace(
  `<script nonce="screenshot-nonce" src=""></script>`,
  () => replacement,
);

// ── Screenshot with Playwright ──────────────────────────────

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });

page.on('console', msg => {
  if (msg.type() === 'error') console.error(`[browser]`, msg.text());
});
page.on('pageerror', err => console.error('[browser error]', err.message));

const tmpHtml = path.join('/tmp', `claude-lens-${Date.now()}.html`);
fs.writeFileSync(tmpHtml, html);

try {
  await page.goto(`file://${tmpHtml}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Hide jsCanary
  await page.evaluate(() => {
    const c = document.getElementById('jsCanary');
    if (c) c.style.display = 'none';
  });

  await page.screenshot({ path: outFile, fullPage: false });
  console.log(`Screenshot saved to ${outFile} (${width}x${height}, ${theme} theme, ${tab} tab)`);
} finally {
  fs.unlinkSync(tmpHtml);
  fs.unlinkSync(tmpBundle);
  await browser.close();
}
