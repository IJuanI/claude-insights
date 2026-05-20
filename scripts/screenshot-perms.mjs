#!/usr/bin/env node
/**
 * Generate a screenshot of the permission approval panel.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = process.argv[2] || '/tmp/claude-lens-perms.png';

const DARK_THEME = `
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #252526;
  --vscode-widget-border: rgba(255,255,255,0.1);
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3a3c;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-descriptionForeground: #858585;
  --vscode-charts-green: #89d185;
  --vscode-charts-red: #f48771;
  --vscode-charts-yellow: #d7ba7d;
  --vscode-textBlockQuote-background: rgba(255,255,255,0.03);
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px;
`;

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  :root { ${DARK_THEME} }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
  .header { padding: 14px 20px 10px; border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0; display: flex; align-items: baseline; gap: 12px; }
  .header h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .timeout { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .commands { flex: 1; overflow-y: auto; padding: 12px 20px; display: flex; flex-direction: column; gap: 12px; }
  .cmd-card { border: 1px solid var(--vscode-widget-border); border-radius: 4px; overflow: hidden; }
  .cmd-card.decided-allow { border-color: var(--vscode-charts-green); opacity: 0.6; }
  .cmd-meta { padding: 8px 12px; background: var(--vscode-sideBar-background); display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .cmd-meta code { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
  .cmd-meta .badge { margin-left: auto; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; }
  .badge-allow { background: rgba(137,209,133,0.2); color: var(--vscode-charts-green); }
  .cmd-body { padding: 10px 12px; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-charts-yellow); max-height: 200px; overflow-y: auto; }
  .cmd-actions { padding: 8px 12px; display: flex; gap: 6px; }
  .footer { padding: 12px 20px; border-top: 1px solid var(--vscode-widget-border); flex-shrink: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .footer-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: auto; }
  button { padding: 5px 14px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .btn-allow { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-deny { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-bulk { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border); }
  .btn-submit { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
</style></head>
<body>
  <div class="header">
    <h2>Allow 2 commands</h2>
    <span class="timeout">&#9201; 47s remaining</span>
  </div>
  <div class="commands">
    <div class="cmd-card decided-allow">
      <div class="cmd-meta">
        <span>1/2</span>
        <code>a3f8c1d2</code>
        <span class="badge badge-allow">&#10003; Allow</span>
      </div>
      <div class="cmd-body">$ npm run test -- --filter=auth</div>
    </div>
    <div class="cmd-card">
      <div class="cmd-meta">
        <span>2/2</span>
        <code>b7e2f019</code>
      </div>
      <div class="cmd-body">$ rm -rf dist/ && npm run build</div>
      <div class="cmd-actions">
        <button class="btn-allow">Allow</button>
        <button class="btn-deny">Deny</button>
      </div>
    </div>
  </div>
  <div class="footer">
    <button class="btn-bulk">Allow all</button>
    <button class="btn-bulk">Deny all</button>
    <button class="btn-submit">Confirm all</button>
    <span class="footer-hint">1 / Enter = allow all &middot; 3 / Esc = deny all</span>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 340 } });
const tmp = `/tmp/perms-${Date.now()}.html`;
fs.writeFileSync(tmp, html);
try {
  await page.goto(`file://${tmp}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outFile, fullPage: false });
  console.log(`Screenshot saved to ${outFile}`);
} finally {
  fs.unlinkSync(tmp);
  await browser.close();
}
