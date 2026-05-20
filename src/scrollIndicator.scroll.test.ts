/**
 * Visual regression tests for conversation scroll indicator.
 *
 * These tests use a real Chromium browser (via Playwright) because scroll behavior
 * (scrollTop, scrollHeight, clientHeight, scroll events) is not reliably emulated
 * by jsdom/happy-dom. The tests reproduce the "always live, never jump" bug where
 * #tabConversation doesn't actually scroll due to a CSS min-height flex issue.
 */
import { test, expect } from 'playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const SCRIPT_PATH = path.resolve(__dirname, '../dist/agentWebviewClient.js');

/**
 * Build a minimal HTML page that mirrors the real webview structure.
 * Only the elements needed for the scroll indicator are included.
 */
function buildHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    font-family: sans-serif;
    font-size: 13px;
  }
  /* Mirrors .tab-content / .tab-content.active from agentWebview.css */
  .tab-content { display: none; }
  .tab-content.active {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    overflow-anchor: none;
  }
  #convMessages { overflow-anchor: auto; }
  /* Mirrors .conv-container — must not shrink so #tabConversation can scroll */
  #convFull { flex-shrink: 0; }
  .conv-scroll-nav {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  .conv-live-pill { pointer-events: none; }
  .conv-jump-btn  { pointer-events: all; cursor: pointer; }
</style>
</head>
<body>
  <!-- Stub elements the script references at startup -->
  <div id="toolbarContainer"></div>
  <div id="headerBar"><span id="diagSummary"></span></div>
  <div id="diagPanel"></div>
  <div id="tabBar" class="tab-bar"></div>
  <div id="approvalBanner"></div>
  <div id="runningTasksBar" style="display:none"></div>

  <!-- Agents tab (inactive) -->
  <div class="tab-content" id="tabAgents">
    <div id="convSection"></div>
    <div id="controlsBar" style="display:none">
      <div class="search-box"><input id="searchInput" /></div>
    </div>
    <div id="taskList"></div>
    <div id="noResults"></div>
    <div id="emptyState"></div>
  </div>

  <!-- Conversation tab (active) — the scroll container under test -->
  <div class="tab-content active" id="tabConversation">
    <div id="convSearchBar" style="display:none">
      <div class="conv-search-row">
        <input id="convSearchInput" />
        <button id="convSearchScope"></button>
      </div>
    </div>
    <div id="convSearchResults" style="display:none"></div>
    <div id="convAnchor"></div>
    <div id="convFull">
      <div id="convLoadMore" style="display:none"></div>
      <!-- convMessages populated by JS after script loads -->
      <div id="convMessages"></div>
    </div>
    <!-- Scroll indicator -->
    <div class="conv-scroll-nav" id="convScrollNav">
      <div class="conv-live-pill" id="convLivePill" style="display:none">Live</div>
      <button class="conv-jump-btn" id="convJumpBtn" style="display:none">Jump to bottom</button>
    </div>
  </div>

  <!-- jsCanary stub -->
  <div id="jsCanary" style="display:none">
    <span id="jsCanaryTitle"></span>
    <pre id="jsCanaryError" style="display:none"></pre>
    <p id="jsCanaryHint" style="display:none"></p>
  </div>

  <script>
    // Mock the VS Code extension host API
    window.acquireVsCodeApi = function() {
      return {
        postMessage: function() {},
        getState:    function() { return null; },
        setState:    function() {},
      };
    };
    window.__PANEL_DATA__ = { initialTab: 'conversation' };
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the computed display value of an element. */
async function getDisplay(page: any, id: string): Promise<string> {
  return page.evaluate((id: string) => {
    const el = document.getElementById(id);
    if (!el) return 'missing';
    return el.style.display;
  }, id);
}

/** Fills #convMessages with enough <p> elements to make #tabConversation scrollable. */
async function fillConversation(page: any, paragraphs = 80) {
  await page.evaluate((n: number) => {
    const container = document.getElementById('convMessages')!;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('p');
      p.style.cssText = 'margin: 8px 0; line-height: 1.5;';
      p.textContent = `Message ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit.`;
      container.appendChild(p);
    }
  }, paragraphs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Conversation scroll indicator', () => {
  test.beforeEach(async ({ page }) => {
    // Capture console errors to diagnose init failures
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));

    await page.setContent(buildHTML());
    // Inject bundled client script AFTER mocks are set up in the HTML
    await page.addScriptTag({ path: SCRIPT_PATH });
    // Script is an IIFE that runs synchronously; give rAF callbacks a chance to settle
    await page.waitForTimeout(100);

    if (errors.length) {
      throw new Error(`Client script init errors:\n${errors.join('\n')}`);
    }
  });

  test('indicator starts as "live" when at bottom (initial state)', async ({ page }) => {
    await fillConversation(page);
    // Give the script a chance to call updateConvScrollNav()
    await page.waitForTimeout(50);

    const livePillDisplay = await getDisplay(page, 'convLivePill');
    const jumpBtnDisplay  = await getDisplay(page, 'convJumpBtn');

    // At startup we should be locked to bottom → live shown, jump hidden
    expect(livePillDisplay).not.toBe('none');
    expect(jumpBtnDisplay).toBe('none');
  });

  test('indicator switches to "jump to bottom" after scrolling up', async ({ page }) => {
    await fillConversation(page, 80);   // ~80 paragraphs — well past viewport height
    await page.waitForTimeout(50);

    // Verify #tabConversation is actually scrollable (scrollHeight > clientHeight)
    const { scrollHeight, clientHeight } = await page.evaluate(() => {
      const el = document.getElementById('tabConversation')!;
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    // This assertion fails if the CSS min-height flex bug is present
    // (tabConversation expands to content height, so scrollHeight === clientHeight)
    expect(scrollHeight).toBeGreaterThan(clientHeight + 30);

    // Scroll up by 200px from the bottom
    await page.evaluate(() => {
      const el = document.getElementById('tabConversation')!;
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 200);
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(50);

    const livePillDisplay = await getDisplay(page, 'convLivePill');
    const jumpBtnDisplay  = await getDisplay(page, 'convJumpBtn');

    expect(livePillDisplay).toBe('none');
    expect(jumpBtnDisplay).not.toBe('none');
  });

  test('indicator returns to "live" when scrolled back to bottom', async ({ page }) => {
    await fillConversation(page, 80);
    await page.waitForTimeout(50);

    // Scroll up then back to bottom
    await page.evaluate(() => {
      const el = document.getElementById('tabConversation')!;
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const el = document.getElementById('tabConversation')!;
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(50);

    const livePillDisplay = await getDisplay(page, 'convLivePill');
    const jumpBtnDisplay  = await getDisplay(page, 'convJumpBtn');

    expect(livePillDisplay).not.toBe('none');
    expect(jumpBtnDisplay).toBe('none');
  });
});
