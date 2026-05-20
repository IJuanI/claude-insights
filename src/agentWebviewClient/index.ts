// @ts-nocheck
// Extracted from htmlTemplate.ts inline <script> block
// This file is bundled by esbuild as an IIFE for the webview

declare function acquireVsCodeApi(): any;
declare var __PANEL_DATA__: { initialTab: string };

// ── Canary: always hide immediately if ANY JS runs ──
(function() {
  var canary = document.getElementById('jsCanary');
  if (canary) canary.style.display = 'none';
})();

// ── Error capture ──
var _allErrors = [];
var _ERRORS_CAP = 100;
function _showCanaryError(text) {
  var canary = document.getElementById('jsCanary');
  var errEl = document.getElementById('jsCanaryError');
  var titleEl = document.getElementById('jsCanaryTitle');
  var hintEl = document.getElementById('jsCanaryHint');
  if (canary) canary.style.display = '';
  if (titleEl) titleEl.textContent = 'Webview JS error';
  if (errEl) {
    var prev = errEl.textContent;
    errEl.textContent = prev ? prev + '\\n---\\n' + text : text;
    errEl.style.display = '';
  }
  if (hintEl) hintEl.style.display = '';
}
window.onerror = function(msg, src, line, col, err) {
  var parts = [];
  if (msg) parts.push(String(msg));
  if (err && err.stack) parts.push(err.stack);
  else if (err) parts.push(String(err));
  if (src) parts.push('at ' + src + ':' + line + ':' + col);
  var text = parts.join('\\n') || 'Unknown error';
  if (_allErrors.length >= _ERRORS_CAP) _allErrors.splice(0, _allErrors.length - _ERRORS_CAP + 1);
  _allErrors.push(text);
  _showCanaryError(text);
};
window.addEventListener('unhandledrejection', function(ev) {
  var text = 'Unhandled promise rejection: ' + (ev.reason && ev.reason.stack ? ev.reason.stack : String(ev.reason || 'unknown'));
  if (_allErrors.length >= _ERRORS_CAP) _allErrors.splice(0, _allErrors.length - _ERRORS_CAP + 1);
  _allErrors.push(text);
  _showCanaryError(text);
});

const vscode = acquireVsCodeApi();
const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2zm2-2v2h2a2 2 0 0 1 2 2v2h2V2H6zM2 8v6h6V8H2z"/><\\/svg>';

// ── Per-session ctx% data ──
var _sessionCtx = {};
var _sessionJsonlBytes = {};
var _activeChipSessionId = null;

// ── Error capture & diagnostics state ──
var _capturedErrors = [];
var _diagLogEntries = [];
var _diagHealthChecks = [];
var _postMessageCount = 0;
var _DIAG_LOG_CAP = 500;
function _pushDiagEntry(entry) {
  if (_diagLogEntries.length >= _DIAG_LOG_CAP) _diagLogEntries.splice(0, _diagLogEntries.length - _DIAG_LOG_CAP + 1);
  _diagLogEntries.push(entry);
}

// Runtime errors are already captured by the early window.onerror + _showCanaryError above

// Wrap vscode.postMessage to count outgoing messages.
// acquireVsCodeApi() returns a non-writable object, so we can't monkey-patch it directly.
// Instead, shadow it with a local wrapper used everywhere in this module.
var _origPostMessage = vscode.postMessage.bind(vscode);
var _vsPostMessage = function(msg) {
  _postMessageCount++;
  return _origPostMessage(msg);
};

// Monkey-patch console.error and console.warn to also capture to diag log
var _origConsoleError = console.error.bind(console);
var _origConsoleWarn = console.warn.bind(console);
console.error = function() {
  _origConsoleError.apply(console, arguments);
  var msg = Array.prototype.slice.call(arguments).map(function(a) { return String(a); }).join(' ');
  var entry = { timestamp: new Date().toISOString(), level: 'error', source: 'console', message: msg };
  _capturedErrors.push(new Date().toISOString().slice(11,23) + ' ' + msg);
  _pushDiagEntry(entry);
  updateDiagErrors();
};
console.warn = function() {
  _origConsoleWarn.apply(console, arguments);
  var msg = Array.prototype.slice.call(arguments).map(function(a) { return String(a); }).join(' ');
  _pushDiagEntry({ timestamp: new Date().toISOString(), level: 'warn', source: 'console', message: msg });
};

window.onerror = function(msg, src, line, col, err) {
  var text = String(msg) + ' at ' + (src||'?') + ':' + (line||'?') + ':' + (col||'?');
  var tsShort = new Date().toISOString().slice(11,23);
  _capturedErrors.push(tsShort + ' ' + text);
  _pushDiagEntry({ timestamp: new Date().toISOString(), level: 'error', source: 'window.onerror', message: text });
  try { _vsPostMessage({ command: 'webviewError', error: text }); } catch(e) {}
  updateDiagErrors();
  return false;
};
window.addEventListener('unhandledrejection', function(e) {
  var text = 'Unhandled rejection: ' + String(e.reason);
  var tsShort = new Date().toISOString().slice(11,23);
  _capturedErrors.push(tsShort + ' ' + text);
  _pushDiagEntry({ timestamp: new Date().toISOString(), level: 'error', source: 'unhandledrejection', message: text });
  try { _vsPostMessage({ command: 'webviewError', error: text }); } catch(e) {}
  updateDiagErrors();
});

// Periodic self-check: verify task count matches DOM
setInterval(function() {
  if (!currentTasks || currentTasks.length === 0) return;
  var domCount = document.querySelectorAll('.task').length;
  if (domCount !== currentTasks.length) {
    var msg = 'Task count mismatch: data=' + currentTasks.length + ' dom=' + domCount;
    _pushDiagEntry({ timestamp: new Date().toISOString(), level: 'warn', source: 'self-check', message: msg });
    try { _vsPostMessage({ command: 'webviewError', error: msg }); } catch(e2) {}
    if (_diagPanelVisible) { renderDiagFooter(); }
  }
}, 10000);

// Diagnostics data will arrive via postMessage
let _diagData = null;
let _diagPanelVisible = false;

function updateDiagErrors() {
  const el = document.getElementById('diagErrorLog');
  if (!el) return;
  if (_capturedErrors.length > 0) {
    el.textContent = _capturedErrors.join('\\n');
    el.classList.add('has-errors');
  }
}

function toggleDiagPanel() {
  _diagPanelVisible = !_diagPanelVisible;
  const panel = document.getElementById('diagPanel');
  if (panel) panel.classList.toggle('visible', _diagPanelVisible);
  const btn = document.getElementById('diagToggleBtn');
  if (btn) btn.style.opacity = _diagPanelVisible ? '1' : '';
}

function renderDiagFooter() {
  var summary = document.getElementById('diagSummary');
  var panel = document.getElementById('diagPanel');
  if (!summary || !panel) return;

  var d = _diagData || {};
  // Count agents and file size for the active session only
  var taskCount = _activeChipSessionId
    ? (currentTasks || []).filter(function(t) { return t.sessionId === _activeChipSessionId; }).length
    : (d.taskCount ?? 0);
  var jsonlBytesForSession = _activeChipSessionId
    ? ((_sessionJsonlBytes[_activeChipSessionId]) || 0)
    : 0;
  var convCount = typeof conversationHtmlArr !== 'undefined' && conversationHtmlArr.length > 0
    ? conversationHtmlArr.length
    : (conversationData ? conversationData.length : (d.conversationCount ?? 0));
  var errCount = _capturedErrors.length;

  // Total billed tokens and last-turn context window fill
  var totalTok = 0;
  var billedTok = 0;
  var lastContextTok = 0; // input_tokens of last assistant turn = context window fill
  var lastModel = '';
  if (conversationData) {
    for (var _ci = 0; _ci < conversationData.length; _ci++) {
      var _cm = conversationData[_ci];
      if (_cm.model) lastModel = _cm.model;
      if (_cm.tokenUsage) {
        var _u = _cm.tokenUsage;
        totalTok += (_u.input || 0) + (_u.output || 0) + (_u.cacheRead || 0) + (_u.cacheCreate || 0);
        // billed = input + output + cacheCreate + 10% cacheRead
        billedTok += (_u.input || 0) + (_u.output || 0) + (_u.cacheCreate || 0) + Math.round((_u.cacheRead || 0) * 0.1);
        // last context = input (includes cache hits) from the most recent turn
        if ((_u.input || 0) > 0) {
          lastContextTok = (_u.input || 0) + (_u.cacheRead || 0) + (_u.cacheCreate || 0);
        }
      }
    }
  }

  // JSONL file size — session-scoped when available, global fallback
  var jsonlBytes = jsonlBytesForSession || (d.jsonlBytes ?? 0);

  // All Claude models have 200K context window; extended context (1M) is a separate tier.
  // Infer the tier from the observed context size rather than the model name.
  var CTX_LIMIT = lastContextTok > 200000 ? 1000000 : 200000;

  function _fmtNum(n) {
    if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
    if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
    if (n >= 1e3) return (n/1e3).toFixed(0)+'k';
    return String(n);
  }
  function _fmtBytes(b) {
    if (b >= 1e9) return (b/1e9).toFixed(1)+' GB';
    if (b >= 1e6) return (b/1e6).toFixed(1)+' MB';
    if (b >= 1e3) return (b/1e3).toFixed(0)+' KB';
    return b+' B';
  }

  var parts = [];
  if (convCount) parts.push(convCount + ' msgs');
  if (taskCount) parts.push(taskCount + ' agents');
  if (jsonlBytes > 0) parts.push(_fmtBytes(jsonlBytes));
  if (totalTok > 0) parts.push(_fmtNum(totalTok) + ' tok');
  if (billedTok > 0) parts.push(_fmtNum(billedTok) + ' billed');
  if (errCount > 0) parts.push(errCount + ' err');

  // Context window badge
  // Color thresholds based on empirical compaction data:
  // Sonnet (200K): compaction observed at ~87% → warn at 65%, alert at 80%
  // Opus (500K): compaction observed at ~74% → same relative thresholds
  var ctxBadge = '';
  if (lastContextTok > 0) {
    var ctxPct = Math.round(lastContextTok / CTX_LIMIT * 100);
    var ctxColorVal = ctxColor(ctxPct);
    var ctxModelNote = lastModel ? ' · ' + lastModel.replace('claude-', '').replace(/-\\d{8}$/, '') : '';
    ctxBadge = ' <span title="Context window at last turn: ' + _fmtNum(lastContextTok) + ' / ' + _fmtNum(CTX_LIMIT) + ' tokens' + ctxModelNote + '. Compaction typically triggers at 80–87%." style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:3px;background:' + ctxColorVal + ';color:#fff;font-size:10px;vertical-align:middle;font-weight:600">'
      + ctxPct + '% ctx</span>';
  }

  // Sync the active chip's ctx% to match what we computed from conversation data
  // This ensures chip badge and diag footer always agree (single source of truth: conversation)
  if (_activeChipSessionId && lastContextTok > 0) {
    _sessionCtx[_activeChipSessionId] = lastContextTok;
  }

  var partsHtml = escHtml(parts.join(', '));
  summary.innerHTML = ctxBadge ? ctxBadge + ' · ' + partsHtml : partsHtml;
  updateChipCtx();

  var warnings = (d.warnings || []).map(function(w) { return '<div class="diag-warning">⚠ ' + escHtml(w) + '</div>'; }).join('');
  var sessions = (d.sessionIds || []).join(', ') || 'none';

  // Notification mode controls
  var modeSection = '<div class="diag-section">'
    + '<div class="diag-label">Notification Modes</div>'
    + '<div style="display:flex;gap:8px;align-items:center;margin:4px 0;">'
    + '<span style="font-size:10px;min-width:55px;">Local:</span>'
    + _buildModeToggle('local', _notifModeLocal)
    + '</div>'
    + '<div style="display:flex;gap:8px;align-items:center;margin:4px 0;">'
    + '<span style="font-size:10px;min-width:55px;">External:</span>'
    + _buildModeToggle('external', _notifModeExternal)
    + '</div>'
    + '</div>';

  // Health checks section
  var healthHtml = '<div class="diag-section-title">Health</div>';
  if (_diagHealthChecks.length === 0) {
    healthHtml += '<div class="diag-empty">No checks yet</div>';
  }
  for (var hi = 0; hi < _diagHealthChecks.length; hi++) {
    var h = _diagHealthChecks[hi];
    var dotCls = h.status === 'ok' ? 'dot-ok' : h.status === 'warn' ? 'dot-warn' : 'dot-critical';
    healthHtml += '<div class="diag-health-item"><span class="diag-health-dot ' + dotCls + '"></span>' +
      '<span class="diag-health-name">' + escHtml(h.name) + '</span>' +
      '<span class="diag-health-msg">' + escHtml(h.message) + '</span></div>';
  }

  // Log stream section (last 50 entries)
  var logHtml = '<div class="diag-section-title">Log <span class="diag-log-count">(' + _diagLogEntries.length + ')</span></div>';
  var logEntries = _diagLogEntries.slice(-50).reverse();
  for (var li = 0; li < logEntries.length; li++) {
    var le = logEntries[li];
    var ts = '';
    if (le.timestamp) {
      var tsParts = le.timestamp.split('T');
      if (tsParts[1]) { var dotIdx = tsParts[1].indexOf('.'); ts = dotIdx >= 0 ? tsParts[1].slice(0, dotIdx) : tsParts[1]; }
    }
    logHtml += '<div class="diag-log-entry level-' + escHtml(le.level || 'info') + '">' +
      '<span class="diag-log-ts">' + escHtml(ts) + '</span>' +
      '<span class="diag-level-badge level-' + escHtml(le.level || 'info') + '">' + escHtml(le.level || 'info') + '</span>' +
      '<span class="diag-log-source">' + escHtml(le.source || '') + '</span>' +
      '<span class="diag-log-msg">' + escHtml(le.message || '') + '</span></div>';
  }

  panel.innerHTML =
    '<div class="diag-row"><span class="diag-label">Tasks:</span><span class="diag-value">' + taskCount + '</span></div>' +
    '<div class="diag-row"><span class="diag-label">Messages:</span><span class="diag-value">' + convCount + '</span></div>' +
    '<div class="diag-row"><span class="diag-label">Sessions:</span><span class="diag-value">' + escHtml(sessions) + '</span></div>' +
    '<div class="diag-row"><span class="diag-label">Workspace:</span><span class="diag-value">' + escHtml(d.workspace || 'none') + '</span></div>' +
    '<div class="diag-row"><span class="diag-label">DOM tasks:</span><span class="diag-value" id="diagDomCount">?</span></div>' +
    '<div class="diag-row"><span class="diag-label">JS errors:</span><span class="diag-value" id="diagErrCount">' + errCount + '</span></div>' +
    warnings +
    modeSection +
    healthHtml +
    logHtml +
    '<div class="diag-error-log" id="diagErrorLog"></div>' +
    '<div class="diag-btns">' +
      '<button class="diag-btn" onclick="exportDiagnostics()">Copy diagnostics</button>' +
      '<button class="diag-btn" onclick="_vsPostMessage({command:&apos;showOutput&apos;})">Show logs</button>' +
      '<button class="diag-btn" onclick="clearDiagLog()">Clear</button>' +
    '</div>';
}

function updateChipCtx() {
  var chips = document.querySelectorAll('.session-chip');
  chips.forEach(function(chip) {
    var sid = chip.getAttribute('data-session-id');
    var lastCtx = (_sessionCtx && sid && _sessionCtx[sid]) || 0;
    var existing = chip.querySelector('.chip-ctx');
    if (lastCtx <= 0) { if (existing) existing.remove(); return; }
    var CTX_LIMIT = lastCtx > 200000 ? 1000000 : 200000;
    var pct = Math.round(lastCtx / CTX_LIMIT * 100);
    var color = ctxColor(pct);
    if (!existing) { existing = document.createElement('span'); existing.className = 'chip-ctx'; chip.appendChild(existing); }
    existing.style.background = color;
    existing.style.color = '#fff';
    existing.style.fontWeight = '700';
    existing.textContent = pct + '%';
  });
}

function updateDiagDomCount() {
  const el = document.getElementById('diagDomCount');
  if (el) el.textContent = String(document.querySelectorAll('.task').length);
  const errEl = document.getElementById('diagErrCount');
  if (errEl) errEl.textContent = String(_capturedErrors.length);
  // Also update summary
  if (_diagData) renderDiagFooter();
}

function copyDiagnostics() {
  const d = _diagData || {};
  const info = {
    ...d,
    domTaskCount: document.querySelectorAll('.task').length,
    jsErrors: _capturedErrors,
    currentTasksLength: currentTasks ? currentTasks.length : 'undefined',
    conversationLength: conversationData ? conversationData.length : 'undefined',
    canaryHidden: document.getElementById('jsCanary')?.style.display === 'none',
    userAgent: navigator.userAgent,
  };
  _vsPostMessage({ command: 'copyDiagnostics', diagnostics: info });
}

// ── Diagnostics tab rendering ──
function exportDiagnostics() {
  var blob = {
    meta: { timestamp: new Date().toISOString(), userAgent: navigator.userAgent },
    healthChecks: _diagHealthChecks,
    log: _diagLogEntries.slice(-500),
    errors: _diagLogEntries.filter(function(e) { return e.level === 'error'; }),
    taskCount: currentTasks ? currentTasks.length : 0,
    conversationCount: conversationData ? conversationData.length : 0,
    domTaskCount: document.querySelectorAll('.task').length,
    capturedErrors: _capturedErrors
  };
  _vsPostMessage({ command: 'copyToClipboard', text: JSON.stringify(blob, null, 2) });
}

function clearDiagLog() {
  _diagLogEntries = [];
  if (_diagPanelVisible) { renderDiagFooter(); }
  _vsPostMessage({ command: 'clearDiagLog' });
}

function renderFallback(error) {
  // Capture the error for the canary
  var errText = String(error);
  if (error && error.stack) errText = error.stack;
  _allErrors.push(errText);

  // Build a compact diagnostic summary (no large data structures)
  var diagSummary = 'tasks=' + (currentTasks ? currentTasks.length : '?')
    + ' conv=' + (conversationData ? conversationData.length : '?')
    + (_capturedErrors.length > 0 ? ' prev_errors=' + _capturedErrors.length : '');

  var fullError = errText + '  [' + diagSummary + ']';

  // Show in the canary (which has the copy button)
  _showCanaryError(fullError);

  // Also update the title to be clearer
  var titleEl = document.getElementById('jsCanaryTitle');
  if (titleEl) titleEl.textContent = 'Rendering error';

  // Report to extension host (shows in output channel + enables copy)
  try {
    _vsPostMessage({ command: 'webviewError', error: fullError });
  } catch(e) {}
}

// ── State (received via postMessage from extension) ──
let currentTasks = [];
let conversationData = [];
let expandedTasks = new Set();
let currentFilter = 'all';
let scrollPositions = {};
let lockedToBottom = new Set();

// Restore persisted webview state
var _savedState = vscode.getState() || {};
// Don't restore expandedTasks — all tasks start collapsed by default.
// Only user clicks should expand task cards.
if (_savedState.currentFilter) currentFilter = _savedState.currentFilter;
var _restoredSearchScope = _savedState.searchScope || 'workspace';
var _restoredSearchQuery = _savedState.searchQuery || '';
var _restoredPreviewMode = _savedState.searchPreviewMode || 'compact';
if (_savedState.activeTab) {
  // Will be applied after DOM is ready
  var _restoredTab = _savedState.activeTab;
}

var _saveStateTimer = null;
function _saveWebviewState() {
  if (_saveStateTimer) return; // debounce — only flush once per animation frame batch
  _saveStateTimer = setTimeout(function() {
    _saveStateTimer = null;
    vscode.setState({
      expandedTasks: Array.from(expandedTasks),
      currentFilter: currentFilter,
      activeTab: currentTab,
      isGroupedView: isGroupedView,
      searchScope: _searchScope,
      searchQuery: (document.getElementById('convSearchInput') || {}).value || '',
      searchPreviewMode: _searchPreviewMode || 'compact',
    });
  }, 100);
}

// Agents start collapsed — user expands on demand

// ── Search (with debounce) ──
let searchTimeout = null;
const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(applyVisibility, 150);
});

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  applyVisibility();
  _saveWebviewState();
}

function applyVisibility() {
  const query = (searchInput.value || '').toLowerCase().trim();
  let visible = 0;
  document.querySelectorAll('.task').forEach(el => {
    const search = (el.dataset.search || '').toLowerCase();
    const status = el.dataset.status || '';
    const matchSearch = !query || search.includes(query);
    const matchStatus = currentFilter === 'all' || status === currentFilter;
    const show = matchSearch && matchStatus;
    el.style.display = show ? '' : 'none';
    if (show) visible++;
  });

  // In grouped view, hide empty groups
  if (isGroupedView) {
    document.querySelectorAll('.session-group').forEach(group => {
      const hasTasks = group.querySelectorAll('.task:not([style*="display: none"])').length > 0;
      group.style.display = hasTasks ? '' : 'none';
    });
  }

  document.getElementById('noResults').style.display =
    visible === 0 && currentTasks.length > 0 ? '' : 'none';
}

// Returns the activity indicator HTML for a running agent based on its activeState
function buildActivityIndicator(activeState) {
  if (activeState === 'thinking') {
    return '<div class="activity-indicator activity-thinking"><span class="activity-thinking-icon"></span><span class="activity-thinking-label">Thinking</span></div>';
  }
  if (activeState === 'tool' || activeState === 'processing') {
    // Tool executing or waiting for tool result — dots with muted color
    return '<div class="typing-indicator activity-tool"><span></span><span></span><span></span></div>';
  }
  // 'responding' or unknown — standard blue dots
  return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
}

// ── Build a task card ──
function buildTaskCard(t) {
  const isRunning = t.status === 'running';
  const statusCls = isRunning ? 'status-running' : t.status === 'completed' ? 'status-completed' : 'status-errored';
  const statusLabel = isRunning ? 'Running' : t.status === 'completed' ? 'Completed' : 'Errored';
  const statusIcon = isRunning ? '◉' : t.status === 'completed' ? '✓' : '✗';
  const isExpanded = expandedTasks.has(t.agentId);
  const searchable = [t.description, t.agentId, t.model || '', t.sessionLabel || '', t.searchText || ''].join(' ');

  const div = document.createElement('div');
  div.className = 'task ' + statusCls + (isExpanded ? ' expanded' : '');
  div.dataset.agentId = t.agentId;
  div.dataset.sessionId = t.sessionId;
  div.dataset.status = t.status;
  div.dataset.search = searchable;
  div.dataset.blockCount = String(t.blockCount);

  const model = t.model ? '<span class="task-model">' + escHtml(t.model) + '</span>' : '';

  // Token usage line: total and billed
  var tokenLine = '';
  if (t.tokenUsage) {
    var u = t.tokenUsage;
    var fmtK = function(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n); };
    var total = u.input + u.output + u.cacheRead + u.cacheCreate;
    // Billed = input + output + cacheCreate (cache writes billed at full input rate; reads at ~10%)
    var billed = u.input + u.output + u.cacheCreate + Math.round(u.cacheRead * 0.1);
    var ctxBadge = '';
    if (u.lastContext && u.lastContext > 0) {
      var ctx = u.lastContext;
      var ctxLimit = ctx > 200000 ? 1000000 : 200000;
      var ctxPct = Math.round(ctx / ctxLimit * 100);
      var ctxColorVal = ctxColor(ctxPct);
      ctxBadge = '<span style="opacity:0.4"> · </span>'
        + '<span title="Context window: ' + fmtK(ctx) + ' / ' + fmtK(ctxLimit) + ' tokens (' + ctxPct + '%)" style="display:inline-block;padding:1px 5px;border-radius:3px;background:' + ctxColorVal + ';color:#fff;font-weight:600">' + ctxPct + '% ctx</span>';
    }
    tokenLine = '<div class="task-token-line">'
      + '<span title="Total tokens processed">' + fmtK(total) + ' total</span>'
      + '<span style="opacity:0.4"> · </span>'
      + '<span title="Estimated billed tokens (input + output + cache writes + 10% cache reads)">' + fmtK(billed) + ' billed</span>'
      + ctxBadge
      + '</div>';
  }

  const sessionLine = t.sessionLabel
    ? '<div class="task-session-label">Session: ' + escHtml(t.sessionLabel) + '</div>'
    : '';

  div.innerHTML =
    '<div class="task-clickable" data-action="toggle-task" data-agent-id="' + escAttr(t.agentId) + '">' +
      '<div class="task-header">' +
        '<span class="status-dot ' + statusCls + '">' + statusIcon + '</span>' +
        '<span class="task-desc">' + escHtml(t.description) + '</span>' +
        '<div class="task-meta">' +
          model +
          (isRunning
            ? '<span class="task-time pending-timer" data-start-ts="' + escAttr(t.startedAt) + '">' + formatElapsed(Date.now() - new Date(t.startedAt).getTime()) + '</span>'
            : '<span class="task-time">' + escHtml(t.lastActivity ? formatElapsed(new Date(t.lastActivity).getTime() - new Date(t.startedAt).getTime()) : timeAgo(t.startedAt)) + '</span>') +
          '<span class="task-block-count">' + t.blockCount + ' blocks</span>' +
          '<span class="task-chevron">▸</span>' +
        '</div>' +
      '</div>' +
      sessionLine +
      '<div class="task-id-row" data-action="noop">' +
        '<span class="task-id-text">' + escHtml(t.agentId) + '</span>' +
        '<button class="icon-btn" data-action="copy-agent-id" data-agent-id="' + escAttr(t.agentId) + '" title="Copy agent ID">' + COPY_ICON + '</button>' +
        (t.prompt ? '<button class="icon-btn task-prompt-btn" data-action="view-prompt" data-agent-id="' + escAttr(t.agentId) + '" data-prompt="' + escAttr(t.prompt) + '" title="View initial prompt"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 1h6l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm6 0v4h4M5 9h6M5 11.5h4"/></svg> prompt</button>' : '') +
        tokenLine +
      '</div>' +
    '</div>' +
    '<div class="task-content">' +
      '<div class="scroll-nav">' +
        '<button class="scroll-nav-btn" onclick="jumpTo(this,&apos;top&apos;)" title="Jump to start">↑ Start</button>' +
        '<button class="scroll-nav-btn" onclick="jumpTo(this,&apos;bottom&apos;)" title="Jump to end">↓ End</button>' +
      '</div>' +
      (t.hiddenCount > 0 ? '<button class="load-more-btn" data-action="load-more" data-agent-id="' + escAttr(t.agentId) + '">' + t.hiddenCount + ' earlier entries — click to load more</button>' : '') +
      (t.prompt ? '<details class="block-wrapper block-prompt"><summary class="block-prompt-label">Prompt</summary><pre class="block-prompt-text">' + _esc(t.prompt) + '</pre></details>' : '') +
      t.blocksHtml +
      (isRunning ? buildActivityIndicator(t.activeState) : '') +
    '</div>';

  return div;
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Lightweight markdown renderer for search result previews
// NOTE: This runs inside an esbuild-compiled template literal.
// All regex use new RegExp() to avoid literal escaping issues.
// In TypeScript template literal: '\\\\' compiles to '\\' in the JS string,
// which new RegExp sees as a single literal backslash.
var _mdRules = null;
function _getMdRules() {
  if (_mdRules) return _mdRules;
  var bt = String.fromCharCode(96); // backtick
  _mdRules = {
    codeBlock: new RegExp(bt+bt+bt+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+bt+bt+bt, 'g'),
    inlineCode: new RegExp(bt+'([^'+bt+'\\\\n]+)'+bt, 'g'),
    h4: new RegExp('^#{4}\\\\s+(.+)$', 'gm'),
    h3: new RegExp('^#{3}\\\\s+(.+)$', 'gm'),
    h2: new RegExp('^#{2}\\\\s+(.+)$', 'gm'),
    h1: new RegExp('^#{1}\\\\s+(.+)$', 'gm'),
    boldItalic: new RegExp('\\\\*\\\\*\\\\*(.+?)\\\\*\\\\*\\\\*', 'g'),
    bold: new RegExp('\\\\*\\\\*(.+?)\\\\*\\\\*', 'g'),
    ul: new RegExp('^[-*]\\\\s+(.+)$', 'gm'),
    ol: new RegExp('^\\\\d+\\\\.\\\\s+(.+)$', 'gm'),
    hr: new RegExp('^---$', 'gm'),
    link: new RegExp('\\\\[([^\\\\]]+)\\\\]\\\\(([^)]+)\\\\)', 'g'),
  };
  return _mdRules;
}
function formatMd(text) {
  if (!text) return '';
  var R = _getMdRules();
  var codeBlocks = [];
  var inlineCodes = [];
  var result = text.replace(R.codeBlock, function(_m, _lang, code) {
    var idx = codeBlocks.length;
    codeBlocks.push('<pre class="codeblock">' + code + '</pre>');
    return '\\x00CB' + idx + '\\x00';
  });
  result = result.replace(R.inlineCode, function(_m, code) {
    var idx = inlineCodes.length;
    inlineCodes.push('<code>' + code + '</code>');
    return '\\x00IC' + idx + '\\x00';
  });
  result = result.replace(R.h4, '<div class="md-h4">$1</div>');
  result = result.replace(R.h3, '<div class="md-h3">$1</div>');
  result = result.replace(R.h2, '<div class="md-h2">$1</div>');
  result = result.replace(R.h1, '<div class="md-h1">$1</div>');
  result = result.replace(R.boldItalic, '<strong><em>$1</em></strong>');
  result = result.replace(R.bold, '<strong>$1</strong>');
  result = result.replace(R.ul, '<div class="md-li">\\u2022 $1</div>');
  result = result.replace(R.ol, '<div class="md-li">$1</div>');
  result = result.replace(R.hr, '<hr class="md-hr">');
  result = result.replace(R.link, '<a class="md-link" href="$2" title="$2">$1</a>');
  result = result.replace(new RegExp('\\\\n', 'g'), '<br>');
  result = result.replace(new RegExp('<br>\\\\s*(<(?:pre|div|hr))', 'g'), '$1');
  result = result.replace(new RegExp('(</(?:pre|div)>)\\\\s*<br>', 'g'), '$1');
  result = result.replace(new RegExp('\\x00IC(\\\\d+)\\x00', 'g'), function(_m, idx) { return inlineCodes[parseInt(idx)]; });
  result = result.replace(new RegExp('\\x00CB(\\\\d+)\\x00', 'g'), function(_m, idx) { return codeBlocks[parseInt(idx)]; });
  return result;
}

function timeAgo(ts) {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
  return Math.floor(ms / 86400000) + 'd ago';
}

// Smooth HSL gradient: 0%→green(120°), 50%→yellow(60°), 80%→orange(30°), 100%→red(0°)
// Uses a non-linear curve so low% stays green, rapid shift starts around 60%
function ctxColor(pct) {
  var t = Math.max(0, Math.min(100, pct)) / 100;
  // Ease the curve: slow at low%, accelerates toward red
  var eased = t * t * (3 - 2 * t); // smoothstep
  // Hue: 120 (green) → 0 (red)
  var hue = Math.round(120 * (1 - eased));
  // Saturation: muted green at low% (35%), ramps to vivid red at high% (95%)
  var sat = Math.round(35 + 60 * eased);
  // Lightness: darker in yellow zone for white-text contrast (WCAG AA)
  // 50% at green, dips to 40% through yellow/orange, 42% at red
  var lit = Math.round(50 - 10 * eased + 2 * eased * eased);
  return 'hsl(' + hue + ',' + sat + '%,' + lit + '%)';
}

function formatElapsed(ms) {
  if (ms < 1000) return ms + 'ms';
  var s = ms / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  var m = Math.floor(s / 60);
  var sec = Math.round(s % 60);
  if (m < 60) return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
  var h = Math.floor(m / 60);
  m = m % 60;
  return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
}

// Tick all pending timers. Under 10s: update every 100ms for ms/decimal precision.
// At 10s+: update every 1s (whole seconds only, no need for sub-second refresh).
setInterval(function() {
  requestAnimationFrame(function() {
    var timers = document.querySelectorAll('.pending-timer');
    if (timers.length === 0) return;
    var now = Date.now();
    for (var i = 0; i < timers.length; i++) {
      var startTs = timers[i].getAttribute('data-start-ts');
      if (!startTs) continue;
      var elapsed = now - new Date(startTs).getTime();
      if (elapsed > 0 && elapsed < 10000) {
        var newText = formatElapsed(elapsed);
        if (timers[i].textContent !== newText) timers[i].textContent = newText;
      }
    }
  });
}, 100);
setInterval(function() {
  requestAnimationFrame(function() {
    var timers = document.querySelectorAll('.pending-timer');
    if (timers.length === 0) return;
    var now = Date.now();
    for (var i = 0; i < timers.length; i++) {
      var startTs = timers[i].getAttribute('data-start-ts');
      if (!startTs) continue;
      var elapsed = now - new Date(startTs).getTime();
      if (elapsed >= 10000) {
        var newText = formatElapsed(elapsed);
        if (timers[i].textContent !== newText) timers[i].textContent = newText;
      }
    }
  });
}, 1000);

function copyText(text) {
  _vsPostMessage({ command: 'copyToClipboard', text: text });
}

function loadMore(agentId) {
  // Mark the button as loading
  const card = document.querySelector('.task[data-agent-id="' + agentId + '"]');
  if (card) {
    const btn = card.querySelector('.load-more-btn');
    if (btn) { btn.classList.add('loading'); btn.textContent = 'Loading...'; }
  }
  _vsPostMessage({ command: 'loadMore', agentId: agentId });
}

function expandResult(btn) {
  var targetId = btn.getAttribute('data-target');
  var pre = document.getElementById(targetId);
  if (!pre) return;
  var fullB64 = btn.getAttribute('data-full');
  try {
    // fullB64 contains pre-highlighted HTML, decode and show progressively
    var fullHtml = decodeURIComponent(escape(atob(fullB64)));
    // Show full content at once (HTML can't be sliced safely)
    pre.innerHTML = fullHtml;
    pre.removeAttribute('data-shown');
    btn.remove();
  } catch (e) {
    btn.textContent = 'Error expanding';
  }
}

// ── Focus agent by description (called from "View agent" button) ──
function loadTaskOutput(btn, filePath) {
  btn.textContent = 'Loading...';
  btn.disabled = true;
  _vsPostMessage({ command: 'loadTaskOutput', filePath: filePath });
  // Store reference for response handler
  btn._filePath = filePath;
  window._pendingTaskOutputBtn = btn;
}

function focusAgent(agentId) {
  switchTab('agents');
  var el = document.querySelector('.task[data-agent-id="' + agentId + '"]');
  if (el) {
    if (!expandedTasks.has(agentId)) expandedTasks.add(agentId);
    el.classList.add('expanded');
    // Populate content that arrived while the card was collapsed
    var focusTask = currentTasks.find(function(t) { return t.agentId === agentId; });
    if (focusTask) updateTaskCard(el, focusTask);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('task-highlighted');
    void (el as HTMLElement).offsetWidth; // force reflow to restart animation
    el.classList.add('task-highlighted');
    el.addEventListener('animationend', function() { el.classList.remove('task-highlighted'); }, { once: true });
    requestAnimationFrame(function() { setupScrollTracking(el); });
  }
}

function focusAgentByDesc(description) {
  switchTab('agents');
  var cards = document.querySelectorAll('.task');
  var el = null;
  var agentId = null;
  for (var ci = 0; ci < cards.length; ci++) {
    var descEl = cards[ci].querySelector('.task-desc');
    if (descEl && descEl.textContent && descEl.textContent.indexOf(description) !== -1) {
      el = cards[ci];
      agentId = el.getAttribute('data-agent-id');
      break;
    }
  }
  if (el && agentId) {
    focusAgent(agentId);
  }
}

function scrollToBgCommand(commandId) {
  switchTab('conversation');
  // Try to find the bg command output element in the conversation
  var el = document.querySelector('.bg-command-output[data-command-id="' + commandId + '"]');
  if (!el) {
    // The tool pair may not be in visible range — load all messages
    convVisibleCount = conversationHtmlArr.length;
    renderConvPage(true);
    // Try again after re-render
    el = document.querySelector('.bg-command-output[data-command-id="' + commandId + '"]');
  }
  if (el) {
    // Expand the parent details element and scroll to its top so the command is visible
    var details = el.closest('details');
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: 'smooth', block: 'start' });
      details.style.outline = '2px solid var(--vscode-focusBorder)';
      setTimeout(function() { (details as HTMLElement).style.outline = ''; }, 2000);
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

// ── Toggle task expand/collapse ──
function toggleTask(agentId) {
  if (expandedTasks.has(agentId)) {
    expandedTasks.delete(agentId);
  } else {
    expandedTasks.add(agentId);
  }
  _saveWebviewState();
  const el = document.querySelector('.task[data-agent-id="' + agentId + '"]');
  if (el) {
    el.classList.toggle('expanded', expandedTasks.has(agentId));
    if (expandedTasks.has(agentId)) {
      // Populate content that arrived while the card was collapsed
      const task = currentTasks.find(function(t) { return t.agentId === agentId; });
      if (task) updateTaskCard(el, task);
      // setupScrollTracking handles initial scroll-to-bottom (only runs once)
      requestAnimationFrame(() => setupScrollTracking(el));
    }
  }
}

// ── Scroll tracking (called once per card on first expand) ──
function setupScrollTracking(taskEl) {
  const content = taskEl.querySelector('.task-content');
  const id = taskEl.dataset.agentId;
  if (!content || !id) return;

  // Only set up the handler once
  if (content._scrollTracked) return;
  content._scrollTracked = true;

  // Initial: scroll to bottom
  content.scrollTop = content.scrollHeight;
  lockedToBottom.add(id);

  content.onscroll = () => {
    const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 30;
    if (nearBottom) {
      lockedToBottom.add(id);
    } else {
      lockedToBottom.delete(id);
    }
    scrollPositions[id] = content.scrollTop;
    updateScrollNav(content);
  };
  updateScrollNav(content);
}

function updateScrollNav(content) {
  const nav = content.querySelector('.scroll-nav');
  if (!nav) return;
  const startBtn = nav.children[0];
  const endBtn = nav.children[1];
  if (startBtn) startBtn.classList.toggle('hidden', content.scrollTop < 10);
  if (endBtn) endBtn.classList.toggle('hidden', content.scrollHeight - content.scrollTop - content.clientHeight < 10);
}

function jumpTo(btn, dir) {
  const content = btn.closest('.task-content');
  if (!content) return;
  const id = content.closest('.task')?.dataset.agentId;
  if (dir === 'top') {
    content.scrollTop = 0;
    if (id) lockedToBottom.delete(id);
  } else {
    content.scrollTop = content.scrollHeight;
    if (id) lockedToBottom.add(id);
  }
}

function expandMore(bar) {
  const block = bar.closest('.collapsible');
  if (!block) return;
  const content = block.querySelector('.text-content');
  if (!content) return;

  const currentMax = parseInt(block.dataset.maxLines || '10', 10);
  const totalLines = parseInt(block.dataset.totalLines || '999', 10);

  // Progressive backoff: roughly double each time
  const nextMax = Math.min(totalLines, Math.ceil(currentMax * 2));

  if (nextMax >= totalLines) {
    // Show all — remove clamping
    content.style.webkitLineClamp = '';
    content.style.display = '';
    content.style.webkitBoxOrient = '';
    block.dataset.maxLines = String(totalLines);
    const label = bar.querySelector('.collapse-label');
    if (label) label.textContent = 'Show less';
    bar.onclick = function() { collapseBack(bar); };
  } else {
    content.style.webkitLineClamp = String(nextMax);
    block.dataset.maxLines = String(nextMax);
    const remaining = totalLines - nextMax;
    const label = bar.querySelector('.collapse-label');
    if (label) label.textContent = 'Show more (' + remaining + ' lines remaining)';
  }
}

function collapseBack(bar) {
  const block = bar.closest('.collapsible');
  if (!block) return;
  const content = block.querySelector('.text-content');
  if (!content) return;

  const initMax = 10;
  content.style.webkitLineClamp = String(initMax);
  content.style.display = '-webkit-box';
  content.style.webkitBoxOrient = 'vertical';
  block.dataset.maxLines = String(initMax);
  const label = bar.querySelector('.collapse-label');
  if (label) label.textContent = 'Show more';
  bar.onclick = function() { expandMore(bar); };
}

// ── View mode ──
let isGroupedView = _savedState.isGroupedView === true;
let expandedGroups = new Set();

function toggleViewMode() {
  isGroupedView = !isGroupedView;
  const btn = document.getElementById('viewToggle');
  if (btn) btn.textContent = isGroupedView ? '☰' : '▦';
  if (btn) btn.title = isGroupedView ? 'Switch to flat view' : 'Switch to grouped view';
  renderTasks(currentTasks);
  _saveWebviewState();
}

function toggleSessionGroup(sessionId) {
  if (expandedGroups.has(sessionId)) {
    expandedGroups.delete(sessionId);
  } else {
    expandedGroups.add(sessionId);
  }
  const el = document.querySelector('.session-group[data-session-id="' + sessionId + '"]');
  if (el) el.classList.toggle('expanded', expandedGroups.has(sessionId));
}

// The rest of the JS continues inline from the original file...
// (renderTasks, renderFlat, renderGrouped, updateTaskCard, message handler, etc.)
// This is too large to include here — it continues verbatim from the original.

// ── Running tasks bar ──
function updateRunningTasksBar(tasks) {
  var bar = document.getElementById('runningTasksBar');
  var countEl = document.getElementById('runningTasksCount');
  var listEl = document.getElementById('runningTasksList');
  if (!bar) return;

  var items = [];

  // Agent tasks that are running
  var runningAgents = tasks.filter(function(t) { return t.status === 'running'; });
  runningAgents.forEach(function(t) {
    var desc = t.description || t.agentId.slice(0,8);
    if (desc.length > 60) desc = desc.slice(0,57) + '...';
    var model = t.model ? '<span class="running-task-model">' + t.model.replace('claude-','') + '</span>' : '';
    var elapsed = t.startedAt ? formatElapsed(Date.now() - new Date(t.startedAt).getTime()) : '';
    items.push('<div class="running-task-item" onclick="focusAgent(&quot;' + t.agentId + '&quot;)">'
      + '<span>⟳</span> <span class="running-task-desc">' + _esc(desc) + '</span>' + model
      + '<span class="running-task-time">' + elapsed + '</span></div>');
  });

  // Background Bash commands from conversation (run_in_background)
  if (conversationData && conversationData.length > 0) {
    for (var ci = 0; ci < conversationData.length; ci++) {
      var convMsg = conversationData[ci];
      if (!convMsg.toolBlocks) continue;
      for (var ti = 0; ti < convMsg.toolBlocks.length; ti++) {
        var tb = convMsg.toolBlocks[ti];
        if (tb.backgroundCommand && !_bgCommandComplete[tb.backgroundCommand.commandId]) {
          var cmdDesc = tb.input.description || tb.input.command || tb.name;
          if (typeof cmdDesc === 'string' && cmdDesc.length > 60) cmdDesc = cmdDesc.slice(0,57) + '...';
          var bgCmdId = tb.backgroundCommand.commandId;
          items.push('<div class="running-task-item" onclick="scrollToBgCommand(&quot;' + _esc(bgCmdId) + '&quot;)">'
            + '<span>⟳</span> <span class="running-task-desc">' + _esc(String(cmdDesc)) + '</span>'
            + '<span class="running-task-model">bg</span>'
            + '<button class="icon-btn" title="Copy command ID" onclick="event.stopPropagation();copyText(&#39;' + _esc(bgCmdId) + '&#39;)" style="font-size:9px;opacity:0.6;padding:1px 4px;">' + COPY_ICON + '</button>'
            + '</div>');
        }
      }
    }
  }

  if (items.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  countEl.textContent = items.length;
  listEl.innerHTML = items.join('');
}

// Track which background commands have completed
var _bgCommandComplete = {};
// Track initial prompts per agent
var _agentPrompts = {};

function showPromptModal(agentId, prompt) {
  var existing = document.getElementById('promptModal');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'promptModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:32px;box-sizing:border-box;';
  overlay.innerHTML = '<div style="background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border,rgba(128,128,128,0.3));border-radius:6px;padding:20px;max-width:700px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:12px;">'
    + '<div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:12px;">'
    + '<span>Initial prompt</span>'
    + '<code style="font-size:10px;opacity:0.6;background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:3px;">' + _esc(agentId) + '</code>'
    + '<button onclick="document.getElementById(&#39;promptModal&#39;).remove()" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--vscode-foreground);font-size:16px;line-height:1;opacity:0.7;">×</button>'
    + '</div>'
    + '<pre style="background:var(--vscode-textCodeBlock-background);padding:12px;border-radius:4px;overflow-y:auto;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0;flex:1;font-family:var(--vscode-editor-font-family,monospace);border:1px solid var(--vscode-widget-border,rgba(128,128,128,0.15));">' + _esc(prompt) + '</pre>'
    + '</div>';
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(overlay);
}

function _timeAgoShort(ts) {
  var ms = Date.now() - new Date(ts).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h';
  return Math.floor(ms / 86400000) + 'd';
}

function _esc(s) {
  return s.replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Incremental render ──
function renderTasks(tasks) {
  var list = document.getElementById('taskList');
  var controlsBar = document.getElementById('controlsBar');
  var emptyState = document.getElementById('emptyState');
  var viewToggle = document.getElementById('viewToggle');

  updateRunningTasksBar(tasks);

  if (tasks.length === 0) {
    list.innerHTML = '';
    controlsBar.style.display = 'none';
    emptyState.style.display = '';
    return;
  }

  controlsBar.style.display = '';
  emptyState.style.display = 'none';

  // Show view toggle only when multiple sessions
  const sessionIds = new Set(tasks.map(t => t.sessionId));
  if (viewToggle) viewToggle.style.display = sessionIds.size > 1 ? '' : 'none';

  if (isGroupedView && sessionIds.size > 1) {
    renderGrouped(tasks, list);
  } else {
    renderFlat(tasks, list);
  }

  applyVisibility();
  updateDiagDomCount();
}

function renderFlat(tasks, list) {
  // Remove session-group wrappers if switching from grouped view
  list.querySelectorAll('.session-group').forEach(g => {
    // Move task cards out before removing the group
    g.querySelectorAll('.task').forEach(t => list.appendChild(t));
    g.remove();
  });

  // Build a map of existing DOM cards
  const existingCards = new Map();
  list.querySelectorAll(':scope > .task').forEach(el => {
    existingCards.set(el.dataset.agentId, el);
  });

  // Reconcile: update existing, insert new, reorder to match tasks array
  const desiredIds = tasks.map(t => t.agentId);
  const desiredSet = new Set(desiredIds);

  // Remove cards no longer in list
  for (const [id, el] of existingCards) {
    if (!desiredSet.has(id)) el.remove();
  }

  // Insert/update in order
  let prevNode = null;
  for (const t of tasks) {
    let card = existingCards.get(t.agentId);
    if (card) {
      updateTaskCard(card, t);
    } else {
      card = buildTaskCard(t);
      if (expandedTasks.has(t.agentId)) {
        requestAnimationFrame(() => setupScrollTracking(card));
      }
    }
    // Ensure correct order: card should come after prevNode
    const nextSibling = prevNode ? prevNode.nextSibling : list.firstChild;
    if (card !== nextSibling) {
      list.insertBefore(card, nextSibling);
    }
    prevNode = card;
  }
}

function renderGrouped(tasks, list) {
  // Group by session
  const groups = new Map();
  for (const t of tasks) {
    const sid = t.sessionId || 'unknown';
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(t);
  }

  // Sort: sessions with running tasks first, then by most recent activity
  const sorted = [...groups.entries()].sort((a, b) => {
    const aRun = a[1].some(t => t.status === 'running');
    const bRun = b[1].some(t => t.status === 'running');
    if (aRun && !bRun) return -1;
    if (!aRun && bRun) return 1;
    return 0;
  });

  // Auto-expand groups with running tasks
  for (const [sid, grpTasks] of sorted) {
    if (grpTasks.some(t => t.status === 'running') && !expandedGroups.has(sid)) {
      expandedGroups.add(sid);
    }
  }

  // Collect existing cards from anywhere in the list (flat or grouped)
  const existingCards = new Map();
  list.querySelectorAll('.task').forEach(el => {
    existingCards.set(el.dataset.agentId, el);
  });

  // Collect existing session groups
  const existingGroups = new Map();
  list.querySelectorAll(':scope > .session-group').forEach(g => {
    existingGroups.set(g.dataset.sessionId, g);
  });

  // Remove bare task cards (from flat view) that are direct children of list
  list.querySelectorAll(':scope > .task').forEach(t => t.remove());

  const desiredGroupIds = sorted.map(([sid]) => sid);
  const desiredGroupSet = new Set(desiredGroupIds);

  // Remove groups no longer needed
  for (const [sid, g] of existingGroups) {
    if (!desiredGroupSet.has(sid)) g.remove();
  }

  // Build/update groups in order
  let prevGroup = null;
  for (const [sid, grpTasks] of sorted) {
    const name = grpTasks[0].sessionLabel || sid.slice(0, 8);
    const runCount = grpTasks.filter(t => t.status === 'running').length;
    const isExpGrp = expandedGroups.has(sid);

    let group = existingGroups.get(sid);
    if (!group) {
      group = document.createElement('div');
      group.dataset.sessionId = sid;
      const tasksContainer = document.createElement('div');
      tasksContainer.className = 'session-tasks';
      group.appendChild(document.createElement('div')); // placeholder for header
      group.appendChild(tasksContainer);
    }

    group.className = 'session-group' + (isExpGrp ? ' expanded' : '');

    // Update header
    const runBadge = runCount > 0 ? '<span class="session-running-badge">' + runCount + ' running</span>' : '';
    const header = group.children[0];
    header.className = 'session-header';
    header.setAttribute('onclick', "toggleSessionGroup('" + sid + "')");
    header.innerHTML =
      '<span class="session-chevron">▸</span>' +
      '<span class="session-name" title="' + escHtml(name) + '">' + escHtml(name) + '</span>' +
      runBadge +
      '<span class="session-count">' + grpTasks.length + '</span>';

    // Get or create tasks container
    let tasksContainer = group.querySelector('.session-tasks');
    if (!tasksContainer) {
      tasksContainer = document.createElement('div');
      tasksContainer.className = 'session-tasks';
      group.appendChild(tasksContainer);
    }

    // Reconcile task cards within this group
    let prevCard = null;
    for (const t of grpTasks) {
      let card = existingCards.get(t.agentId);
      if (card) {
        updateTaskCard(card, t);
      } else {
        card = buildTaskCard(t);
        if (expandedTasks.has(t.agentId)) {
          requestAnimationFrame(() => setupScrollTracking(card));
        }
      }
      const nextSibling = prevCard ? prevCard.nextSibling : tasksContainer.firstChild;
      if (card !== nextSibling) {
        tasksContainer.insertBefore(card, nextSibling);
      }
      prevCard = card;
    }

    // Ensure group is in correct position
    const nextGroupSibling = prevGroup ? prevGroup.nextSibling : list.firstChild;
    if (group !== nextGroupSibling) {
      list.insertBefore(group, nextGroupSibling);
    }
    prevGroup = group;
  }
}

function updateTaskCard(el, t) {
  const isRunning = t.status === 'running';
  const statusCls = isRunning ? 'status-running' : t.status === 'completed' ? 'status-completed' : 'status-errored';

  // Update class
  el.className = 'task ' + statusCls + (expandedTasks.has(t.agentId) ? ' expanded' : '');
  el.dataset.status = t.status;
  el.dataset.search = [t.description, t.agentId, t.model || '', t.sessionLabel || '', t.searchText || ''].join(' ');
  el.dataset.blockCount = String(t.blockCount);

  // Update status dot
  const statusDot = el.querySelector('.status-dot');
  if (statusDot) {
    statusDot.className = 'status-dot ' + statusCls;
    statusDot.textContent = isRunning ? '◉' : t.status === 'completed' ? '✓' : '✗';
  }

  // Update time
  const timeEl = el.querySelector('.task-time');
  if (timeEl) {
    if (isRunning) {
      timeEl.classList.add('pending-timer');
      timeEl.setAttribute('data-start-ts', t.startedAt || '');
      timeEl.textContent = formatElapsed(Date.now() - new Date(t.startedAt).getTime());
    } else {
      timeEl.classList.remove('pending-timer');
      timeEl.removeAttribute('data-start-ts');
      timeEl.textContent = t.lastActivity ? formatElapsed(new Date(t.lastActivity).getTime() - new Date(t.startedAt).getTime()) : timeAgo(t.startedAt);
    }
  }

  // Update block count badge
  const countEl = el.querySelector('.task-block-count');
  if (countEl) countEl.textContent = t.blockCount + ' blocks';

  // Update token line (including context badge)
  if (t.tokenUsage) {
    var u = t.tokenUsage;
    var fmtK = function(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n); };
    var total = u.input + u.output + u.cacheRead + u.cacheCreate;
    var billed = u.input + u.output + u.cacheCreate + Math.round(u.cacheRead * 0.1);
    var ctxBadge = '';
    if (u.lastContext && u.lastContext > 0) {
      var ctx = u.lastContext;
      var ctxLimit = ctx > 200000 ? 1000000 : 200000;
      var ctxPct = Math.round(ctx / ctxLimit * 100);
      var ctxColorVal = ctxColor(ctxPct);
      ctxBadge = '<span style="opacity:0.4"> · </span>'
        + '<span title="Context window: ' + fmtK(ctx) + ' / ' + fmtK(ctxLimit) + ' tokens (' + ctxPct + '%)" style="display:inline-block;padding:1px 5px;border-radius:3px;background:' + ctxColorVal + ';color:#fff;font-weight:600">' + ctxPct + '% ctx</span>';
    }
    var existingTokenLine = el.querySelector('.task-token-line');
    if (existingTokenLine) {
      existingTokenLine.innerHTML =
        '<span title="Total tokens processed">' + fmtK(total) + ' total</span>'
        + '<span style="opacity:0.4"> · </span>'
        + '<span title="Estimated billed tokens (input + output + cache writes + 10% cache reads)">' + fmtK(billed) + ' billed</span>'
        + ctxBadge;
    }
  }

  // Always update pending blocks — even when task is collapsed — so stale timers don't
  // persist when the user expands the card after the tool has already completed.
  const pendingInCard = el.querySelectorAll('.block-wrapper[data-pending="1"]');
  if (pendingInCard.length > 0 && t.blocksHtml) {
    const tempPending = document.createElement('div');
    tempPending.innerHTML = t.blocksHtml;
    pendingInCard.forEach(function(existing) {
      const idx = (existing as HTMLElement).dataset.blockIdx;
      const fresh = tempPending.querySelector('.block-wrapper[data-block-idx="' + idx + '"]');
      // Replace only when the result has arrived (fresh no longer has data-pending)
      if (fresh && !(fresh as HTMLElement).dataset.pending) {
        existing.replaceWith(fresh);
      }
    });
  }

  // Update content — incremental append, never replace
  if (expandedTasks.has(t.agentId)) {
    const content = el.querySelector('.task-content');
    if (content) {
      const wasLocked = lockedToBottom.has(t.agentId);

      // Find min/max block index already rendered
      const existingBlocks = content.querySelectorAll('.block-wrapper[data-block-idx]');
      let maxRenderedIdx = -1;
      let minRenderedIdx = Infinity;
      existingBlocks.forEach(b => {
        const idx = parseInt(b.dataset.blockIdx, 10);
        const count = parseInt(b.dataset.blockCount || '1', 10);
        const endIdx = idx + count - 1;
        if (endIdx > maxRenderedIdx) maxRenderedIdx = endIdx;
        if (idx < minRenderedIdx) minRenderedIdx = idx;
      });

      // Update load-more button
      const loadMoreEl = content.querySelector('.load-more-btn');
      if (t.hiddenCount > 0) {
        if (loadMoreEl) {
          loadMoreEl.textContent = t.hiddenCount + ' earlier entries — click to load more';
          loadMoreEl.classList.remove('loading');
        } else if (!content.querySelector('.load-more-btn')) {
          const nav = content.querySelector('.scroll-nav');
          const btn = document.createElement('button');
          btn.className = 'load-more-btn';
          btn.textContent = t.hiddenCount + ' earlier entries — click to load more';
          btn.onclick = () => loadMore(t.agentId);
          if (nav) nav.after(btn);
          else content.prepend(btn);
        }
      } else if (loadMoreEl) {
        loadMoreEl.remove();
      }
      // Also remove old hidden-count divs if any
      const oldHidden = content.querySelector('.hidden-count');
      if (oldHidden) oldHidden.remove();

      // Parse new blocks from blocksHtml
      const temp = document.createElement('div');
      temp.innerHTML = t.blocksHtml;
      const newWrappers = temp.querySelectorAll('.block-wrapper[data-block-idx]');
      let appended = false;

      // Remove activity indicator before appending
      const typingEl = content.querySelector('.typing-indicator, .activity-indicator');
      if (typingEl) typingEl.remove();

      // Find insertion point for earlier blocks (after load-more btn or scroll-nav)
      const insertAnchor = content.querySelector('.load-more-btn') || content.querySelector('.scroll-nav');
      const firstBlock = content.querySelector('.block-wrapper[data-block-idx]');

      // Measure scroll before prepending earlier blocks
      var prependScrollH = content.scrollHeight;
      var hasPrepended = false;

      newWrappers.forEach(wrapper => {
        const idx = parseInt(wrapper.dataset.blockIdx, 10);
        if (idx > maxRenderedIdx) {
          // New block at the end — append
          content.appendChild(wrapper);
          appended = true;
        } else if (idx < minRenderedIdx) {
          // Earlier block revealed by load-more — prepend before existing blocks
          if (firstBlock) {
            content.insertBefore(wrapper, firstBlock);
          } else if (insertAnchor) {
            insertAnchor.after(wrapper);
          } else {
            content.appendChild(wrapper);
          }
          appended = true;
          hasPrepended = true;
        } else {
          // Existing block — replace if html changed (e.g., tool_use gained its result)
          const existing = content.querySelector('.block-wrapper[data-block-idx="' + idx + '"]');
          if (existing && existing.innerHTML !== wrapper.innerHTML) {
            // Save open state of every <details> element before replacing so user-expanded
            // tool results (bash output, edit diffs, etc.) survive incremental updates
            const prevDetails = existing.querySelectorAll('details');
            const openStates = Array.prototype.map.call(prevDetails, function(d) { return d.open; });
            existing.replaceWith(wrapper);
            if (openStates.some(Boolean)) {
              const newDetails = wrapper.querySelectorAll('details');
              openStates.forEach(function(wasOpen, i) {
                if (wasOpen && newDetails[i]) newDetails[i].open = true;
              });
            }
          }
        }
      });

      // After prepending earlier blocks, adjust scroll to keep current view stable
      if (hasPrepended) {
        var scrollDelta = content.scrollHeight - prependScrollH;
        if (scrollDelta > 0) {
          content.scrollTop += scrollDelta;
        }
      }

      // Remove blocks that are no longer in the visible window (hidden due to cap)
      existingBlocks.forEach(b => {
        const idx = parseInt(b.dataset.blockIdx, 10);
        if (idx < t.hiddenCount) {
          b.remove();
        }
      });

      // Add/remove activity indicator
      if (isRunning) {
        var temp2 = document.createElement('div');
        temp2.innerHTML = buildActivityIndicator(t.activeState);
        content.appendChild(temp2.firstChild);
      }

      // Scroll: only auto-scroll if locked to bottom and new content was added
      if (appended && wasLocked) {
        content.scrollTop = content.scrollHeight;
      }
    }
  }
}

// ── Message handler ──
let _initReceived = false;
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'initData') {
    currentTasks = msg.tasks || [];
    (msg.tasks || []).forEach(function(t) { if (t.prompt) _agentPrompts[t.agentId] = t.prompt; });
    conversationData = msg.conversation || [];
    conversationHtmlArr = msg.conversationHtml || [];
    _diagData = msg.diagnostics || null;
    if (msg.diagLog) { _diagLogEntries = msg.diagLog; }
    if (msg.healthChecks) { _diagHealthChecks = msg.healthChecks; }
    if (msg.sessionCtx) { _sessionCtx = msg.sessionCtx; }
    if (msg.sessionJsonlBytes) { _sessionJsonlBytes = msg.sessionJsonlBytes; }
    // Sync backend-known completed commands
    if (msg.bgCommandComplete) {
      msg.bgCommandComplete.forEach(function(id) { _bgCommandComplete[id] = true; });
    }
    // Restore pending permissions immediately on reload
    if (msg.pendingPermissions) { renderPermWidget(msg.pendingPermissions); }
    try { renderTasks(currentTasks); } catch(renderErr) { renderFallback(renderErr); return; }
    _fixupBgCommandStatuses();
    try { renderConversation(); } catch(renderErr) { renderFallback(renderErr); return; }
    // Restore active chip
    if (msg.activeChipSessionId !== undefined) {
      _activeChipSessionId = msg.activeChipSessionId;
      document.querySelectorAll('.session-chip').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.sessionId === msg.activeChipSessionId);
      });
    }
    updateChipCtx();
    renderDiagFooter();
    updateDiagDomCount();
    if (_diagPanelVisible) { renderDiagFooter(); }
    _initReceived = true;
  } else if (msg.command === 'updateTasks') {
    currentTasks = msg.tasks;
    (msg.tasks || []).forEach(function(t) { if (t.prompt) _agentPrompts[t.agentId] = t.prompt; });
    if (msg.sessionCtx) { _sessionCtx = msg.sessionCtx; }
    if (msg.sessionJsonlBytes) { _sessionJsonlBytes = msg.sessionJsonlBytes; }
    // Sync backend-known completed commands
    if (msg.bgCommandComplete) {
      msg.bgCommandComplete.forEach(function(id) { _bgCommandComplete[id] = true; });
    }
    try { renderTasks(currentTasks); } catch(renderErr) { renderFallback(renderErr); return; }
    _fixupBgCommandStatuses();
    _updateConvAgentSummaries(currentTasks);
    // Update active chip without replacing HTML
    if (msg.activeChipSessionId !== undefined) {
      _activeChipSessionId = msg.activeChipSessionId;
      document.querySelectorAll('.session-chip').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.sessionId === msg.activeChipSessionId);
      });
    }
    // Also update conversation if included
    if (msg.conversationHtml) {
      conversationData = msg.conversation || [];
      conversationHtmlArr = msg.conversationHtml;
      try { renderConversation(); } catch(renderErr) { renderFallback(renderErr); return; }
    }
    updateChipCtx();
    renderDiagFooter();
  } else if (msg.command === 'taskOutputResult') {
    var btn = window._pendingTaskOutputBtn;
    if (btn) {
      var parent = btn.closest('.task-notification-msg');
      if (parent) {
        var existing = parent.querySelector('.notif-output-content');
        if (existing) existing.remove();
        var pre = document.createElement('pre');
        pre.className = 'notif-output-content';
        pre.textContent = msg.content || '(empty)';
        parent.appendChild(pre);
      }
      btn.textContent = 'Loaded';
      window._pendingTaskOutputBtn = null;
    }
  } else if (msg.command === 'bgCommandOutput') {
    // Update live background command output
    if (msg.isComplete) {
      _bgCommandComplete[msg.commandId] = true;
      // Refresh running tasks bar
      updateRunningTasksBar(currentTasks);
    }
    var bgEls = document.querySelectorAll('[data-command-id="' + msg.commandId + '"]');
    bgEls.forEach(function(el) {
      if (el.classList.contains('bg-command-output')) {
        var pre = el.querySelector('.bg-output-content');
        if (pre) {
          if (msg.isComplete && !msg.output) {
            // Completed with no output — collapse the section
            el.style.display = 'none';
          } else {
            pre.textContent = msg.output;
            pre.scrollTop = pre.scrollHeight;
          }
        }
      }
      if (el.classList.contains('bg-command-status')) {
        if (msg.isComplete) {
          el.textContent = '✓ complete';
          el.classList.add('complete');
          // Update inline header status color to green
          if (el.style.color) {
            el.style.color = 'var(--vscode-charts-green, #89d185)';
          }
        } else {
          el.textContent = '⟳ running';
        }
      }
    });
  } else if (msg.command === 'searchStatus') {
    showSearchStatus(msg.status);
  } else if (msg.command === 'searchResults') {
    renderSearchResults(msg.results, msg.query, msg.streaming, !!msg.incremental);
  } else if (msg.command === 'scrollToMessage') {
    var targetIdx = msg.messageIndex || 0;
    var targetEl = document.querySelector('[data-midx="' + targetIdx + '"]');
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('search-jump-highlight');
      setTimeout(function() { targetEl.classList.remove('search-jump-highlight'); }, 2000);
    }
  } else if (msg.command === 'clearSearch') {
    clearSearch();
    _saveWebviewState();
  } else if (msg.command === 'ping') {
    _vsPostMessage({ command: 'pong' });
  } else if (msg.command === 'diagLogEntries') {
    if (msg.entries && Array.isArray(msg.entries)) {
      for (var _di = 0; _di < msg.entries.length; _di++) {
        _pushDiagEntry(msg.entries[_di]);
      }
    }
    if (_diagPanelVisible) { renderDiagFooter(); }
  } else if (msg.command === 'diagHealthUpdate') {
    if (msg.checks) { _diagHealthChecks = msg.checks; }
    if (_diagPanelVisible) { renderDiagFooter(); }
  } else if (msg.command === 'pendingPermissions') {
    renderPermWidget(msg.items || []);
  } else if (msg.command === 'foregroundNotifications') {
    renderForegroundNotify(msg.items || []);
  } else if (msg.command === 'notificationModes') {
    _notifModeLocal = msg.local || 'panel';
    _notifModeExternal = msg.external || 'notifications';
    renderApprovalBanner();
  } else if (msg.command === 'switchTab') {
    switchTab(msg.tab);
  } else if (msg.command === 'focusAgent') {
    // Switch to agents tab first
    switchTab('agents');
    // Find agent by ID or by description match
    var agentId = msg.agentId;
    var el = null;
    if (agentId) {
      el = document.querySelector('.task[data-agent-id="' + agentId + '"]');
    }
    if (!el && msg.description) {
      // Search task cards for matching description
      var cards = document.querySelectorAll('.task');
      for (var ci = 0; ci < cards.length; ci++) {
        var descEl = cards[ci].querySelector('.task-desc');
        if (descEl && descEl.textContent && descEl.textContent.indexOf(msg.description) !== -1) {
          el = cards[ci];
          agentId = el.getAttribute('data-agent-id');
          break;
        }
      }
    }
    if (el && agentId) {
      if (!expandedTasks.has(agentId)) {
        expandedTasks.add(agentId);
      }
      el.classList.add('expanded');
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight effect
      el.style.outline = '2px solid var(--vscode-focusBorder)';
      setTimeout(() => { el.style.outline = ''; }, 2000);
      requestAnimationFrame(() => setupScrollTracking(el));
    }
  }
});

// ── Tab switching (with scroll position persistence) ──
let currentTab = window.__PANEL_DATA__.initialTab;
const tabScrollPositions = { agents: 0, conversation: 0 };

var _searchCleared = false;
var _savedSearchState = null;

function restoreSearch() {
  if (!_savedSearchState) return;
  var s = _savedSearchState;
  _savedSearchState = null;
  // Restore search UI directly without a backend roundtrip
  // (clearSearch + jumpToSession would wipe the results we're about to restore)
  var results = document.getElementById('convSearchResults');
  var convFull = document.getElementById('convFull');
  var anchor = document.getElementById('convAnchor');
  if (convFull) convFull.style.display = 'none';
  if (anchor) anchor.style.display = 'none';
  if (results) results.style.display = '';
  var input = document.getElementById('convSearchInput');
  if (input && s.query) { input.value = s.query; }
  _lastSearchQuery = s.query || '';
  _searchCleared = false;
  _searchScope = s.scope || 'workspace';
  _searchPreviewMode = s.mode || 'compact';
  if (s.results && s.query) {
    renderSearchResults(s.results, s.query, false, false);
  }
}

function clearSearch() {
  var input = document.getElementById('convSearchInput');
  var results = document.getElementById('convSearchResults');
  var convFull = document.getElementById('convFull');
  var anchor = document.getElementById('convAnchor');
  if (input) input.value = '';
  if (results) { results.style.display = 'none'; results.innerHTML = ''; }
  if (convFull) convFull.style.display = '';
  if (anchor) anchor.style.display = '';
  _lastSearchResults = null;
  _lastSearchQuery = '';
  _searchCleared = true;
  // Show "back to search" banner if we have saved search state
  updateBackToSearchBanner();
}

function updateBackToSearchBanner() {
  var existing = document.getElementById('backToSearchBanner');
  if (existing) existing.remove();
  if (!_savedSearchState || !_savedSearchState.query) return;
  var convFull = document.getElementById('convFull');
  if (!convFull) return;
  var banner = document.createElement('div');
  banner.id = 'backToSearchBanner';
  banner.className = 'back-to-search-banner';
  banner.innerHTML = '<span class="back-to-search-arrow">←</span> Back to search: <strong>' + escHtml(_savedSearchState.query) + '</strong>';
  banner.onclick = function() { restoreSearch(); };
  convFull.parentElement.insertBefore(banner, convFull);
}

function switchTab(tab) {
  // Save current conversation scroll position before switching away
  if (currentTab === 'conversation') {
    var convEl = _getConvEl();
    tabScrollPositions['conversation'] = convEl ? convEl.scrollTop : 0;
  }

  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.getElementById('tabAgents').classList.toggle('active', tab === 'agents');
  document.getElementById('tabConversation').classList.toggle('active', tab === 'conversation');

  // Restore conversation scroll position; default to bottom on first visit
  if (tab === 'conversation') {
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        var convEl = _getConvEl();
        if (!convEl) return;
        if (_convLockedToBottom || !tabScrollPositions['conversation']) {
          _scrollConvToBottom();
        } else {
          convEl.scrollTop = tabScrollPositions['conversation'] || 0;
        }
        updateConvScrollNav();
      });
    });
  }
  _saveWebviewState();
}

// ── Conversation display mode toggle ──
let convDisplayMode = 'tabs'; // 'tabs' or 'inline'

function toggleConvMode() {
  convDisplayMode = convDisplayMode === 'tabs' ? 'inline' : 'tabs';
  applyConvMode();
}

function applyConvMode() {
  var tabBar = document.getElementById('tabBar');
  var convSection = document.getElementById('convSection');
  var tabConv = document.getElementById('tabConversation');
  var tabAgents = document.getElementById('tabAgents');
  var toggle = document.getElementById('convModeToggle');
  var hasConv = conversationData && conversationData.length > 0;

  // Show/hide toggle button based on whether conversation exists
  if (toggle) toggle.style.display = hasConv ? '' : 'none';

  if (convDisplayMode === 'inline') {
    // Inline mode: hide tab bar, show inline section, force agents tab active
    if (tabBar) { tabBar.classList.remove('visible'); }
    if (tabAgents) tabAgents.classList.add('active');
    if (tabConv) tabConv.classList.remove('active');
    if (toggle) { toggle.textContent = '⊞'; toggle.title = 'Switch to tab view'; }
    currentTab = 'agents';
    // Force section visible (full rebuild when toggling to inline)
    _lastSectionRenderKey = '';
    _sectionForceRebuild = true;
    renderConvSection();
  } else {
    // Tabs mode: show tab bar if conversation exists, hide inline section
    if (tabBar) {
      if (hasConv) tabBar.classList.add('visible');
      else tabBar.classList.remove('visible');
    }
    if (convSection) convSection.style.display = 'none';
    if (toggle) { toggle.textContent = '⊟'; toggle.title = 'Switch to inline view'; }
  }
}

// ── Conversation rendering (uses pre-rendered HTML from extension) ──
const CONV_PAGE_SIZE = 50;
let convVisibleCount = CONV_PAGE_SIZE;
let convAutoLoad = false;
let convInitialized = false;
let convSectionVisibleCount = 5;
let _lastSectionRenderKey = '';
// Pre-rendered HTML strings, one per message (set via postMessage)
let conversationHtmlArr = [];

let _lastSectionTotal = 0;
let _sectionForceRebuild = false;

function getConvAnchorHtml() {
  if (!conversationData || conversationData.length === 0) return '';
  var lastUser = null;
  for (var i = conversationData.length - 1; i >= 0; i--) {
    var m = conversationData[i];
    if (m.role === 'user' && m.text && m.text.trim().length > 0) {
      var t = m.text.trim();
      if (t.startsWith('<task-notification>')) continue;
      if (t.startsWith('<') && (t.includes('system-reminder') || t.includes('ide_selection'))) continue;
      if (new RegExp('^/(compact|clear|help|config)').test(t)) continue;
      lastUser = m;
      break;
    }
  }
  if (!lastUser) return '';
  var text = lastUser.text.trim().replace(/<[^>]+>/g, '').trim();
  if (!text) return '';
  var timeStr = '';
  if (lastUser.timestamp) {
    try { timeStr = new Date(lastUser.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch(e) {}
  }
  return '<div class="conv-anchor" style="display:block">' +
    '<div class="anchor-label">Latest prompt' + (timeStr ? '<span class="anchor-time">' + escHtml(timeStr) + '</span>' : '') + '</div>' +
    '<div class="anchor-text">' + escHtml(text) + '</div>' +
  '</div>';
}

function renderConvSection() {
  const section = document.getElementById('convSection');
  if (!section) return;

  const total = conversationHtmlArr.length;
  if (total === 0 || convDisplayMode !== 'inline') {
    section.style.display = 'none';
    return;
  }

  const renderKey = total + ':' + convSectionVisibleCount;
  if (renderKey === _lastSectionRenderKey && !_sectionForceRebuild) return;

  const wasExpanded = section.querySelector('.conversation-section.expanded') !== null;
  const body = section.querySelector('.conversation-body');
  const canIncrement = body && !_sectionForceRebuild && _lastSectionTotal > 0 && total > _lastSectionTotal;

  if (canIncrement) {
    // Incremental: just append new messages
    const newCount = total - _lastSectionTotal;
    const newHtml = conversationHtmlArr.slice(total - newCount);
    var frag = document.createRange().createContextualFragment(newHtml.join(''));
    body.appendChild(frag);
    // Update message count
    var countEl = section.querySelector('.conversation-count');
    if (countEl) countEl.textContent = total + ' messages';
    _lastSectionRenderKey = renderKey;
    _lastSectionTotal = total;
    _sectionForceRebuild = false;
    return;
  }

  _sectionForceRebuild = false;
  _lastSectionRenderKey = renderKey;
  _lastSectionTotal = total;

  // Save scroll position before rebuild
  var prevBody = section.querySelector('.conversation-body');
  var savedScroll = prevBody ? prevBody.scrollTop : 0;

  // Save open <details> states before full rebuild
  var openDetailsInSection = new Set();
  if (prevBody) prevBody.querySelectorAll('details').forEach(function(d, i) { if (d.open) openDetailsInSection.add(i); });

  section.style.display = '';
  const visibleHtml = conversationHtmlArr.slice(-convSectionVisibleCount);
  const remaining = total - visibleHtml.length;

  var anchorHtml = getConvAnchorHtml();
  section.innerHTML = '<div class="conversation-section' + (wasExpanded ? ' expanded' : '') + '">' +
    '<div class="conversation-header">' +
      '<span class="conversation-chevron">▸</span>' +
      'Session Conversation' +
      '<span class="conversation-count">' + total + ' messages</span>' +
    '</div>' +
    '<div class="conversation-body" onclick="event.stopPropagation()">' +
      anchorHtml +
      (remaining > 0 ? '<button class="conv-load-more-btn" style="margin-bottom:6px;width:100%" onclick="event.stopPropagation();loadMoreConvSection()">Load ' + Math.min(remaining, convSectionVisibleCount) + ' earlier (' + remaining + ' remaining)</button>' : '') +
      visibleHtml.join('') +
      '<div class="conv-section-scroll-nav">' +
        '<button onclick="event.stopPropagation();var b=this.closest(&apos;.conversation-body&apos;);if(b)b.scrollTop=0">↑ Start</button>' +
        '<button onclick="event.stopPropagation();var b=this.closest(&apos;.conversation-body&apos;);if(b)b.scrollTop=b.scrollHeight">↓ End</button>' +
      '</div>' +
    '</div>' +
  '</div>';

  section.querySelector('.conversation-header').addEventListener('click', function() {
    section.querySelector('.conversation-section').classList.toggle('expanded');
  });

  // Restore open <details> states and scroll position after rebuild
  var newBody = section.querySelector('.conversation-body');
  if (newBody) {
    if (openDetailsInSection.size > 0) {
      newBody.querySelectorAll('details').forEach(function(d, i) { if (openDetailsInSection.has(i)) d.open = true; });
    }
    if (savedScroll > 0) newBody.scrollTop = savedScroll;
  }
}

function loadMoreConvSection() {
  convSectionVisibleCount = Math.min(conversationHtmlArr.length, convSectionVisibleCount * 2);
  _lastSectionRenderKey = '';
  _sectionForceRebuild = true;
  renderConvSection();
}

function renderConversation() {
  if (!conversationData || conversationData.length === 0) return;

  // Apply mode (shows/hides tab bar and toggle as needed)
  applyConvMode();

  // Render inline section if in inline mode
  renderConvSection();

  // Full conversation tab — lazy loaded
  renderConvPage();

  // Anchor latest user message at top
  updateConvAnchor();

  // Fix up completed bg command statuses (HTML is pre-rendered as "running")
  _fixupBgCommandStatuses();
}

var _lastAnchorText = '';
function updateConvAnchor() {
  var anchor = document.getElementById('convAnchor');
  if (!anchor || !conversationData || conversationData.length === 0) return;

  // Find the last real user message (skip system, commands, task notifications, etc.)
  var lastUser = null;
  for (var i = conversationData.length - 1; i >= 0; i--) {
    var m = conversationData[i];
    if (m.role === 'user' && m.text && m.text.trim().length > 0) {
      // Skip special system messages
      var t = m.text.trim();
      if (t.startsWith('<task-notification>')) continue;
      if (t.startsWith('<') && (t.includes('system-reminder') || t.includes('ide_selection'))) continue;
      if (new RegExp('^/(compact|clear|help|config)').test(t)) continue;
      lastUser = m;
      break;
    }
  }

  if (!lastUser) {
    anchor.style.display = 'none';
    return;
  }

  // Skip re-render if same text
  var anchorKey = lastUser.text.slice(0, 200) + (lastUser.timestamp || '');
  if (anchorKey === _lastAnchorText) return;
  _lastAnchorText = anchorKey;

  var text = lastUser.text.trim();
  // Strip any remaining XML tags for cleaner display
  text = text.replace(/<[^>]+>/g, '').trim();
  if (!text) { anchor.style.display = 'none'; return; }

  var timeStr = '';
  if (lastUser.timestamp) {
    try {
      var d = new Date(lastUser.timestamp);
      timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch(e) {}
  }

  anchor.style.display = '';
  anchor.innerHTML = '<div class="anchor-label">Latest prompt' + (timeStr ? '<span class="anchor-time">' + escHtml(timeStr) + '</span>' : '') + '</div>' +
    '<div class="anchor-text">' + escHtml(text) + '</div>';
}

function _fixupBgCommandStatuses() {
  // Open details for actively running bg commands; close when complete
  document.querySelectorAll('details[data-bg-running]').forEach(function(det) {
    var cmdId = det.getAttribute('data-bg-running');
    if (!cmdId) return;
    if (_bgCommandComplete[cmdId]) {
      det.removeAttribute('data-bg-running');
      det.open = false;
    } else {
      det.open = true;
    }
  });

  for (var cmdId in _bgCommandComplete) {
    if (!_bgCommandComplete[cmdId]) continue;
    var els = document.querySelectorAll('[data-command-id="' + cmdId + '"]');
    els.forEach(function(el) {
      if (el.classList.contains('bg-command-status')) {
        el.textContent = '✓ complete';
        el.classList.add('complete');
        if (el.style.color) {
          el.style.color = 'var(--vscode-charts-green, #89d185)';
        }
      }
      if (el.classList.contains('bg-command-output')) {
        var pre = el.querySelector('.bg-output-content');
        if (pre && !pre.textContent) {
          el.style.display = 'none';
        }
      }
    });
  }
}

/** Update pending Agent tool blocks in conversation tab with last activity summary */
function _updateConvAgentSummaries(tasks) {
  var pendingAgents = document.querySelectorAll('.conv-tool-pair .pending-indicator');
  if (!pendingAgents.length || !tasks || !tasks.length) return;

  pendingAgents.forEach(function(indicator) {
    var pair = indicator.closest('.conv-tool-pair');
    if (!pair) return;
    var preview = pair.querySelector('.tool-pair-preview');
    if (!preview) return;
    var desc = preview.textContent.trim();

    // Find matching running task by description
    var task = tasks.find(function(t) { return t.status === 'running' && t.description === desc; });
    if (!task || !task.lastActivitySummary) return;

    // Add or update summary element
    var parent = indicator.parentElement;
    if (!parent) return;
    var existing = parent.querySelector('.agent-activity-summary');
    if (!existing) {
      existing = document.createElement('span');
      existing.className = 'agent-activity-summary';
      existing.style.cssText = 'display:block;opacity:0.5;font-size:11px;margin-top:2px;';
      parent.appendChild(existing);
    }
    existing.textContent = task.lastActivitySummary;
  });
}

let _lastConvTotal = 0;
let _lastConvStartIdx = -1;
let _lastConvHash = '';
let _convLockedToBottom = true; // sticky: true until user intentionally scrolls up
function _scrollConvToBottom() {
  var convEl = _getConvEl();
  if (!convEl || convEl.clientHeight === 0) return;
  convEl.scrollTop = convEl.scrollHeight;
}
function _convHash(arr) {
  // Quick hash of the last N visible entries to detect content changes (e.g. tool_result arriving)
  var n = Math.min(arr.length, 8);
  var h = '';
  for (var i = arr.length - n; i < arr.length; i++) h += arr[i].length + ',';
  return h;
}
function _getConvEl() { return document.getElementById('tabConversation'); }
function _convIsNearBottom() {
  var el = _getConvEl();
  if (!el) return true;
  // Use a strict 30px threshold: only re-dock when user scrolls to near the very bottom.
  // This prevents accidental re-locking while reading nearby messages.
  return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}
function renderConvPage(force) {
  const container = document.getElementById('convMessages');
  const loadMoreDiv = document.getElementById('convLoadMore');
  if (!container) return;

  const total = conversationHtmlArr.length;
  const newMessages = total - _lastConvTotal;

  // CRITICAL: Never evict messages while user is reading.
  // If new messages arrived and user isn't locked to bottom, grow the window
  // so startIdx stays constant — old messages remain in the DOM.
  if (!_convLockedToBottom && newMessages > 0) {
    convVisibleCount += newMessages;
  }

  const startIdx = Math.max(0, total - convVisibleCount);
  const visible = conversationHtmlArr.slice(startIdx);
  const hash = _convHash(visible);

  if (!force && total === _lastConvTotal && startIdx === _lastConvStartIdx && hash === _lastConvHash) return;

  var shouldScrollToBottom = _convLockedToBottom;
  var convEl = _getConvEl();
  var prevStartIdx = _lastConvStartIdx;
  var prevTotal = _lastConvTotal;

  _lastConvTotal = total;
  _lastConvStartIdx = startIdx;
  _lastConvHash = hash;

  if (convInitialized && !force && startIdx === prevStartIdx && total > prevTotal) {
    // Incremental: only append truly new messages — no re-render, no scroll jump
    var newHtml = conversationHtmlArr.slice(prevTotal);
    var frag = document.createRange().createContextualFragment(newHtml.join(''));
    container.appendChild(frag);
  } else if (convInitialized && !force && startIdx === prevStartIdx && total === prevTotal) {
    // Content-only change (streaming update to last message) — replace just the last element
    // to avoid full re-render flicker while user is reading
    var lastEl = container.lastElementChild;
    if (lastEl && visible.length > 0) {
      var tmp = document.createElement('div');
      tmp.innerHTML = visible[visible.length - 1];
      var newChild = tmp.firstElementChild;
      if (newChild) container.replaceChild(newChild, lastEl);
      else lastEl.outerHTML = visible[visible.length - 1];
    }
  } else {
    // Full re-render: first load, forced, or startIdx changed (load-more)
    var savedScroll = convEl ? convEl.scrollTop : 0;
    var openDetails = new Set();
    container.querySelectorAll('details').forEach(function(d, i) { if (d.open) openDetails.add(i); });
    container.innerHTML = visible.join('');
    if (openDetails.size > 0) {
      container.querySelectorAll('details').forEach(function(d, i) { if (openDetails.has(i)) d.open = true; });
    }
    // Restore scroll position after full re-render
    if (convInitialized && !shouldScrollToBottom && convEl) {
      convEl.scrollTop = savedScroll;
    }
  }

  // Show/hide load more button
  if (loadMoreDiv) {
    loadMoreDiv.style.display = startIdx > 0 ? '' : 'none';
    var btn = loadMoreDiv.querySelector('.conv-load-more-btn');
    if (btn) btn.textContent = 'Load ' + Math.min(CONV_PAGE_SIZE, startIdx) + ' earlier (' + startIdx + ' remaining)';
  }

  // Scroll to bottom if needed — double-rAF ensures layout is fully computed.
  // Re-check _convLockedToBottom inside the rAF: the user may have scrolled up
  // during the 2-frame delay (race condition) — don't yank them back to bottom.
  if (shouldScrollToBottom) {
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        if (!_convLockedToBottom) { updateConvScrollNav(); return; }
        _scrollConvToBottom();
        updateConvScrollNav();
      });
    });
  } else {
    requestAnimationFrame(updateConvScrollNav);
  }

  if (!convInitialized) convInitialized = true;
}

function loadMoreConversation() {
  const total = conversationHtmlArr.length;
  convVisibleCount = Math.min(total, convVisibleCount + CONV_PAGE_SIZE);

  // Remember scroll height to maintain position
  var convEl = _getConvEl();
  var oldScrollHeight = convEl ? convEl.scrollHeight : 0;
  renderConvPage(true);
  if (convEl) {
    var newScrollHeight = convEl.scrollHeight;
    convEl.scrollTop += (newScrollHeight - oldScrollHeight);
  }
}

// ── Unified approval banner ──
var _permItems = [];
var _fgNotifyItems = [];
var _permCountdownTimer = null;
var _notifModeLocal = 'panel';
var _notifModeExternal = 'notifications';

function _buildModeToggle(scope, current) {
  var modes = ['silent', 'notifications', 'panel'];
  var icons = { silent: '\uD83D\uDD07', notifications: '\uD83D\uDD14', panel: '\uD83D\uDCCB' };
  var html = '<div class="mode-toggle">';
  for (var i = 0; i < modes.length; i++) {
    var m = modes[i];
    var active = m === current ? ' active' : '';
    html += '<button class="mode-btn' + active + '" '
      + 'onclick="_vsPostMessage({command:&#39;setNotificationMode&#39;,scope:&#39;' + scope + '&#39;,mode:&#39;' + m + '&#39;})" '
      + 'title="' + m + '">'
      + icons[m] + '</button>';
  }
  html += '</div>';
  return html;
}

function _setBannerState(mode) {
  // mode: '' | 'user-pending' | 'fg-waiting'
  var el = document.getElementById('approvalBanner');
  if (!el) return;
  el.classList.remove('visible', 'user-pending', 'fg-waiting');
  if (mode) { el.classList.add('visible', mode); }
}

function renderApprovalBanner() {
  var el = document.getElementById('approvalBanner');
  if (!el) return;
  if (_permCountdownTimer) { clearInterval(_permCountdownTimer); _permCountdownTimer = null; }

  // User-side pending takes priority
  if (_permItems && _permItems.length > 0) {
    _setBannerState('user-pending');
    var items = _permItems;
    var first = items[0];
    var n = items.length;

    function fmtRem(item) {
      if (item.timedOut) return { str: 'Denied (timed out)', rem: 0 };
      var rem = Math.max(0, Math.round(item.timeout - (Date.now() - item.startTs) / 1000));
      var m = Math.floor(rem / 60), s = rem % 60;
      return { str: (m > 0 ? m + 'm ' : '') + s + 's', rem: rem };
    }

    function buildHtml() {
      var firstRem = fmtRem(first);
      var urgentCls = firstRem.rem < 60 ? ' urgent' : '';
      var html = '<div class="appr-header">'
        + '<span class="appr-title">⏳ ' + (n + ' pending') + '</span>'
        + '<span class="appr-timeout' + urgentCls + '" id="permTimerEl">⏱ ' + _esc(firstRem.str) + '</span>'
        + '<span class="appr-header-spacer"></span>'
        + '<button class="appr-header-btn" onclick="_vsPostMessage({command:&#39;openPermPanel&#39;})" title="Open dedicated approval panel">Open panel</button>'
        + '</div>';
      html += '<div class="appr-list">';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var r = fmtRem(it);
        var activeCls = i === 0 ? ' appr-item-active' : '';
        var timerCls = it.timedOut ? ' expired' : (r.rem < 60 ? ' urgent' : '');
        html += '<div class="appr-item' + activeCls + (it.timedOut ? ' appr-item-timedout' : '') + '">'
          + '<div class="appr-item-meta">'
          + '<span class="appr-item-agent">' + _esc(it.agentId.slice(0, 8)) + '</span>'
          + (it.toolName !== 'Bash' ? '<span>' + _esc(it.toolName) + '</span>' : '')
          + '<span class="appr-item-timer' + timerCls + '">' + (it.timedOut ? '⌛' : '⏱') + ' ' + _esc(r.str) + '</span>'
          + '</div>'
          + '<span class="appr-cmd">$ ' + _esc(it.command.trim()) + '</span>'
          + '</div>';
      }
      html += '</div>';
      // Only show Allow/Deny for the first non-timed-out item
      var actionableFirst = items[0];
      html += '<div class="appr-actions">';
      if (actionableFirst) {
        html += '<button class="btn-allow" onclick="sendPermDecision(&#39;' + _esc(actionableFirst.uuid) + '&#39;,&#39;allow&#39;)">Allow</button>'
          + '<button class="btn-deny" onclick="sendPermDecision(&#39;' + _esc(actionableFirst.uuid) + '&#39;,&#39;deny&#39;)">Deny</button>';
      }
      html += '<button class="appr-view-agent-btn" onclick="_vsPostMessage({command:&#39;switchTab&#39;,tab:&#39;agents&#39;});focusAgentByDesc(&#39;' + _esc(first.agentId) + '&#39;)" title="View agent">View agent</button>'
        + '</div>';
      return html;
    }

    el.innerHTML = buildHtml();

    // Always focus — the extension handles typing debounce before showing the banner
    var firstBtn = el.querySelector('.btn-allow');
    if (firstBtn) {
      (firstBtn as HTMLElement).focus();
    } else {
      el.setAttribute('tabindex', '-1');
      (el as HTMLElement).focus();
    }

    _permCountdownTimer = setInterval(function() {
      if (!_permItems.length) { clearInterval(_permCountdownTimer); _permCountdownTimer = null; return; }
      var fi = _permItems[0];
      var firstRem = Math.max(0, Math.round(fi.timeout - (Date.now() - fi.startTs) / 1000));
      var m = Math.floor(firstRem / 60), s = firstRem % 60;
      var timerEl = document.getElementById('permTimerEl');
      if (timerEl) {
        timerEl.textContent = '⏱ ' + (m > 0 ? m + 'm ' : '') + s + 's';
        timerEl.className = 'appr-timeout' + (firstRem < 60 ? ' urgent' : '');
      }
      var itemEls = el.querySelectorAll('.appr-item-timer');
      _permItems.forEach(function(it, idx) {
        var r = Math.max(0, Math.round(it.timeout - (Date.now() - it.startTs) / 1000));
        var im = Math.floor(r / 60), is = r % 60;
        if (itemEls[idx]) {
          itemEls[idx].textContent = '⏱ ' + (im > 0 ? im + 'm ' : '') + is + 's';
          itemEls[idx].className = 'appr-item-timer' + (r < 60 ? ' urgent' : '');
        }
      });
      if (firstRem <= 0) { clearInterval(_permCountdownTimer); _permCountdownTimer = null; }
    }, 1000);

  } else if (_fgNotifyItems && _fgNotifyItems.length > 0) {
    // Claude-code-side waiting (foreground session)
    _setBannerState('fg-waiting');
    var items = _fgNotifyItems;
    var html = '<div class="appr-header">'
      + '<span class="appr-title">⏳ Awaiting</span>'
      + '<span class="appr-header-spacer"></span>'
      + '</div>';
    html += '<div class="appr-list">';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var sid = item.sessionId ? item.sessionId.slice(0, 8) : '';
      html += '<div class="appr-item">'
        + '<div class="appr-item-meta">'
        + (sid ? '<code style="font-size:10px;opacity:0.6;background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:3px;">' + _esc(sid) + '</code>' : '')
        + '<button class="appr-item-dismiss" title="Dismiss" onclick="_vsPostMessage({command:&#39;dismissForegroundNotification&#39;,toolUseId:&#39;' + _esc(item.toolUseId) + '&#39;})">✕</button>'
        + '</div>'
        + '<span class="appr-cmd">$ ' + _esc(item.command.trim()) + '</span>'
        + '</div>';
    }
    html += '</div>';
    el.innerHTML = html;

  } else {
    _setBannerState('');
    el.innerHTML = '';
  }
}

function renderPermWidget(items) {
  _permItems = items || [];
  renderApprovalBanner();
}

function renderForegroundNotify(items) {
  _fgNotifyItems = items || [];
  renderApprovalBanner();
}

function sendPermDecision(uuid, decision) {
  _vsPostMessage({ command: 'permDecision', uuid: uuid, decision: decision });
  _permItems = _permItems.filter(function(i) { return i.uuid !== uuid; });
  renderApprovalBanner();
}

// Keyboard shortcuts for inline approval: 1/Enter/Space=allow, 3=deny first actionable item
document.addEventListener('keydown', function(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var isAllow = e.key === '1' || e.key === 'Enter' || e.key === ' ';
  var isDeny  = e.key === '3';
  if (!isAllow && !isDeny) return;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  var actionable = _permItems;
  if (actionable.length === 0) return;
  e.preventDefault();
  sendPermDecision(actionable[0].uuid, isAllow ? 'allow' : 'deny');
  // Restore focus to editor only once all pending approvals are resolved
  if (_permItems.length === 0) _vsPostMessage({ command: 'restoreFocus' });
});

function convScrollTo(dir) {
  var convEl = _getConvEl();
  if (!convEl) return;
  if (dir === 'top') {
    _convLockedToBottom = false;
    convEl.scrollTop = 0;
    updateConvScrollNav();
  } else {
    _convLockedToBottom = true;
    _scrollConvToBottom();
  }
}

// ── Conversation search ──
var _searchScope = _restoredSearchScope; // 'workspace' | 'global'
var _searchPreviewMode = _restoredPreviewMode; // 'compact' | 'rich'
var _searchDebounce = null;
var _matchCase = false;
var _matchWholeWord = false;

// Track has-query class for keeping controls visible when search has text
(function() {
  var input = document.getElementById('convSearchInput');
  var bar = document.getElementById('convSearchBar');
  if (!input || !bar) return;
  input.addEventListener('input', function() {
    bar.classList.toggle('has-query', !!input.value.trim());
  });
})();

function toggleMatchCase() {
  _matchCase = !_matchCase;
  document.getElementById('matchCaseBtn').classList.toggle('active', _matchCase);
  _rerunSearch();
}
function toggleMatchWholeWord() {
  _matchWholeWord = !_matchWholeWord;
  document.getElementById('matchWholeWordBtn').classList.toggle('active', _matchWholeWord);
  _rerunSearch();
}
function _rerunSearch() {
  var input = document.getElementById('convSearchInput');
  if (input && input.value.trim()) {
    doConvSearch(input.value.trim());
  }
}

function toggleSearchScope() {
  _searchScope = _searchScope === 'workspace' ? 'global' : 'workspace';
  updateScopeButtons();
  _saveWebviewState();
  // Re-run search if there's a query
  var input = document.getElementById('convSearchInput');
  if (input && input.value.trim()) {
    doConvSearch(input.value.trim());
  }
}

function setSearchScope(scope) {
  _searchScope = scope;
  updateScopeButtons();
  _saveWebviewState();
  var input = document.getElementById('convSearchInput');
  if (input && input.value.trim()) {
    doConvSearch(input.value.trim());
  }
}

function updateScopeButtons() {
  document.querySelectorAll('.scope-seg-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.scope === _searchScope);
  });
}

function setSearchPreviewMode(mode) {
  _searchPreviewMode = mode;
  document.querySelectorAll('.search-view-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  _saveWebviewState();
  // Re-render current results if any
  if (_lastSearchResults && _lastSearchQuery) {
    renderSearchResults(_lastSearchResults, _lastSearchQuery);
  }
}

var _lastSearchResults = null;
var _lastSearchQuery = '';

(function() {
  var input = document.getElementById('convSearchInput');
  if (!input) return;
  input.addEventListener('input', function() {
    clearTimeout(_searchDebounce);
    var q = input.value.trim();
    if (!q) {
      var results = document.getElementById('convSearchResults');
      var container = document.getElementById('convFull');
      if (results) results.style.display = 'none';
      if (container) container.style.display = '';
      _saveWebviewState();
      return;
    }
    // Show spinner immediately for instant feedback (before debounce fires)
    showSearchStatus('searching');
    _searchDebounce = setTimeout(function() { doConvSearch(q); _saveWebviewState(); }, 300);
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      input.value = '';
      var results = document.getElementById('convSearchResults');
      var container = document.getElementById('convFull');
      if (results) results.style.display = 'none';
      if (container) container.style.display = '';
      _saveWebviewState();
    }
  });
})();

// Restore search state from saved webview state
(function() {
  updateScopeButtons();
  // Restore preview mode buttons
  document.querySelectorAll('.search-view-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.mode === _searchPreviewMode);
  });
  if (_restoredSearchQuery) {
    var input = document.getElementById('convSearchInput');
    if (input) {
      input.value = _restoredSearchQuery;
      // Trigger search after data arrives (slight delay to let messages load)
      setTimeout(function() {
        if (_searchCleared) return; // Skip if clearSearch was called (e.g. jumpToSession)
        doConvSearch(_restoredSearchQuery);
      }, 500);
    }
  }
})();

function doConvSearch(query) {
  _vsPostMessage({ command: 'searchConversations', query: query, scope: _searchScope, matchCase: _matchCase, matchWholeWord: _matchWholeWord });
}

function showSearchStatus(status) {
  var container = document.getElementById('convSearchResults');
  var convFull = document.getElementById('convFull');
  if (!container) return;
  var convAnchor = document.getElementById('convAnchor');
  if (status === 'searching') {
    container.innerHTML = '<div class="search-status"><span class="search-status-spinner"></span>Searching...</div>';
    container.style.display = '';
    if (convFull) convFull.style.display = 'none';
    if (convAnchor) convAnchor.style.display = 'none';
    // Reset accumulated results for new search
    _lastSearchResults = null;
    // Hide back banner when starting a new search
    var banner = document.getElementById('backToSearchBanner');
    if (banner) banner.remove();
    _savedSearchState = null;
  }
}

function renderSearchResults(results, query, streaming, incremental) {
  _lastSearchQuery = query;

  var container = document.getElementById('convSearchResults');
  var convFull = document.getElementById('convFull');
  if (!container) return;

  // Accumulate results for incremental mode
  if (incremental) {
    if (!_lastSearchResults) _lastSearchResults = [];
    _lastSearchResults = _lastSearchResults.concat(results || []);
  } else {
    _lastSearchResults = results;
  }

  var allResults = _lastSearchResults || [];

  if (allResults.length === 0) {
    container.innerHTML = '<div class="conv-search-no-results">' + (streaming ? '<span class="search-status-spinner"></span> Searching...' : 'No results for "' + escHtml(query) + '"') + '</div>';
    container.style.display = '';
    if (convFull) convFull.style.display = 'none';
    var anch1 = document.getElementById('convAnchor'); if (anch1) anch1.style.display = 'none';
    return;
  }

  var isRich = _searchPreviewMode === 'rich';
  var limit = isRich ? 50 : 100;
  var re = new RegExp('(' + escHtml(query).replace(/[.*+?^\\\$\\{\\}()|[\\]\\\\]/g, '\\\\$$&') + ')', 'gi');

  var html = '';
  if (streaming) {
    html += '<div class="search-streaming-count"><span class="search-status-spinner"></span> ' + allResults.length + ' results so far...</div>';
  }

  for (var i = 0; i < allResults.length && i < limit; i++) {
    var r = allResults[i];
    var sid = escHtml(r.sessionId || '');
    var mIdx = r.messageIndex || 0;
    var sessionLabel = escHtml(r.sessionName || r.sessionId?.slice(0,8) || '');
    var wsLabel = r.workspace ? '<span style="opacity:0.4;margin-left:auto;font-size:10px">' + escHtml(r.workspace) + '</span>' : '';

    // Role display: map internal roles to user-friendly labels
    var roleDisplay = r.role || '';
    var roleCls = '';
    if (roleDisplay === 'tool') { roleDisplay = 'Tool Output'; roleCls = ' role-tool'; }
    else if (roleDisplay === 'tool_call') { roleDisplay = 'Tool Call'; roleCls = ' role-tool-call'; }
    else if (roleDisplay === 'task_notification') { roleDisplay = 'Task'; roleCls = ' role-task'; }
    else if (roleDisplay === 'command') { roleDisplay = 'Command'; roleCls = ' role-command'; }
    else if (roleDisplay === 'stdout') { roleDisplay = 'Output'; roleCls = ' role-stdout'; }
    else if (roleDisplay === 'interrupted') { roleDisplay = 'Interrupted'; roleCls = ' role-interrupted'; }
    else if (roleDisplay === 'compaction') { roleDisplay = 'System'; roleCls = ' role-compaction'; }
    else if (roleDisplay === 'context_summary') { roleDisplay = 'Summary'; roleCls = ' role-compaction'; }
    else if (roleDisplay === 'user') roleDisplay = 'User';
    else if (roleDisplay === 'assistant') roleDisplay = 'Assistant';
    else if (roleDisplay === 'session') roleDisplay = 'Session';

    if (isRich) {
      // Rich mode: show context around match, with "show more" for long messages
      var richText = r.richText || r.text || '';
      var resultId = 'search-rich-' + i;

      // ── Task notification: render with fancy card UI + match snippet ──
      if (r.role === 'task_notification' && r.taskMeta) {
        var tm = r.taskMeta;
        var tnStatusIcon = tm.status === 'completed' ? '\\u2713' : tm.status === 'failed' ? '\\u2717' : '\\u27F3';
        var tnStatusCls = tm.status === 'completed' ? 'notif-ok' : tm.status === 'failed' ? 'notif-err' : 'notif-pending';
        var tnTitle = escHtml(tm.commandName || 'Background command');
        var tnIdBadge = tm.taskId ? '<span class="notif-task-id">' + escHtml(tm.taskId.slice(0, 8)) + '</span>' : '';
        var tnStatusBadge = '<span class="notif-status-badge ' + tnStatusCls + '">' + tnStatusIcon + ' ' + escHtml(tm.status || 'running') + '</span>';
        var tnExitBadge = tm.exitCode ? '<span class="notif-exit-code">exit ' + escHtml(tm.exitCode) + '</span>' : '';
        // Show the matched text snippet below the card
        var tnSnippetHtml = escHtml(r.text || '').replace(re, '<mark>$1</mark>');

        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<div class="conv-msg task-notification-msg ' + tnStatusCls + '" style="margin:4px 0 0">' +
            '<div class="notif-header"><span class="notif-title">' + tnTitle + '</span>' + tnIdBadge + tnStatusBadge + tnExitBadge + '</div>' +
            (tnSnippetHtml ? '<div class="notif-match-snippet">' + tnSnippetHtml + '</div>' : '') +
          '</div>' +
        '</div>';

      // ── Tool call: render with conversation-style tool header ──
      } else if (r.role === 'tool_call' && r.toolName) {
        var _toolIcons = {Bash:'\\u203A_',Read:'\\u229E',Write:'\\u270F',Edit:'\\u270F',Grep:'\\u2295',Glob:'\\u229F',Agent:'\\u229B',WebSearch:'\\u2299',WebFetch:'\\u2299',TodoWrite:'\\u2611'};
        var tIcon = _toolIcons[r.toolName] || '\\u2699';
        // Remove the tool name prefix from the preview text
        var toolBodyText = richText;
        if (toolBodyText.indexOf(r.toolName + ' ') === 0) {
          toolBodyText = toolBodyText.slice(r.toolName.length + 1);
        }
        var toolPreviewHtml = escHtml(toolBodyText.slice(0, 300)).replace(re, '<mark>$1</mark>');

        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<div class="block-tool-pair search-tool-pair" style="margin:4px 0 0">' +
            '<div class="tool-pair-header" style="cursor:default">' +
              '<span class="tool-pair-icon">' + tIcon + '</span>' +
              '<span class="tool-pair-name">' + escHtml(r.toolName) + '</span>' +
              '<span class="tool-pair-preview">' + toolPreviewHtml + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';

      // ── Slash command: show as command badge ──
      } else if (r.role === 'command') {
        var cmdHighlighted = escHtml(r.text || '').replace(re, '<mark>$1</mark>');
        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-role' + roleCls + '">' + escHtml(roleDisplay) + '</span>' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<div class="conv-msg command-msg" style="margin:4px 0 0;padding:4px 8px"><span class="conv-command-badge">' + cmdHighlighted + '</span></div>' +
        '</div>';

      // ── Command output (stdout): show as pre block ──
      } else if (r.role === 'stdout') {
        var stdoutHtml = escHtml((richText || r.text || '').slice(0, 400)).replace(re, '<mark>$1</mark>');
        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-role' + roleCls + '">' + escHtml(roleDisplay) + '</span>' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<pre class="search-result-conv" id="' + resultId + '" style="opacity:0.8">' + stdoutHtml + '</pre>' +
        '</div>';

      // ── Interrupted: show styled message ──
      } else if (r.role === 'interrupted') {
        var intHighlighted = escHtml(r.text || '').replace(re, '<mark>$1</mark>');
        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-role' + roleCls + '">' + escHtml(roleDisplay) + '</span>' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<div class="conv-search-result-text" style="opacity:0.7;font-style:italic">' + intHighlighted + '</div>' +
        '</div>';

      // ── Compaction / context summary: show as system badge ──
      // ── Tool output: show as result block with match context ──
      } else if (r.role === 'tool') {
        var toolOutLines = richText.split('\\n');
        var toolOutVisible;
        var toolOutNeedsMore = false;
        var TOOL_CTX = 4;
        var TOOL_MAX = 12;
        if (toolOutLines.length <= TOOL_MAX) {
          toolOutVisible = richText;
        } else {
          var toolMatchIdx = 0;
          var toolQueryLower = query.toLowerCase();
          for (var tli = 0; tli < toolOutLines.length; tli++) {
            if (toolOutLines[tli].toLowerCase().indexOf(toolQueryLower) !== -1) {
              toolMatchIdx = tli;
              break;
            }
          }
          var toolCtxStart = Math.max(0, toolMatchIdx - TOOL_CTX);
          var toolCtxEnd = Math.min(toolOutLines.length, toolMatchIdx + TOOL_CTX + 1);
          toolOutVisible = (toolCtxStart > 0 ? '...\\n' : '') +
            toolOutLines.slice(toolCtxStart, toolCtxEnd).join('\\n') +
            (toolCtxEnd < toolOutLines.length ? '\\n...' : '');
          toolOutNeedsMore = true;
        }
        var toolOutHtml = escHtml(toolOutVisible).replace(re, '<mark>$1</mark>');

        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-role' + roleCls + '">' + escHtml(roleDisplay) + '</span>' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<div class="block-tool-pair search-tool-pair" style="margin:4px 0 0">' +
            '<div class="tool-pair-body" style="border-radius:4px;padding:4px 0">' +
              '<div class="tool-pair-output tool-result-ok"><pre id="' + resultId + '" style="max-height:200px;overflow-y:auto">' + toolOutHtml + '</pre></div>' +
            '</div>' +
          '</div>';
        if (toolOutNeedsMore) {
          html += '<button class="search-show-more-btn" data-result-id="' + resultId + '" data-full-text="' + escAttr(richText) + '">Show more (' + toolOutLines.length + ' lines)</button>';
        }
        html += '</div>';

      } else if (r.role === 'compaction' || r.role === 'context_summary') {
        var compHighlighted = escHtml(r.text || '').replace(re, '<mark>$1</mark>');
        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-role' + roleCls + '">' + escHtml(roleDisplay) + '</span>' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<div class="conv-msg compaction-msg" style="margin:4px 0 0;padding:4px 8px"><span class="conv-compaction-badge">\\u2298 ' + compHighlighted + '</span></div>' +
        '</div>';

      // ── Default: user/assistant with markdown rendering ──
      } else {
        var richLines = richText.split('\\n');
        var visibleText;
        var needsShowMore = false;
        var CONTEXT_LINES = 4;
        var MAX_FULL_LINES = 12;

        if (richLines.length <= MAX_FULL_LINES) {
          visibleText = richText;
        } else {
          var matchLineIdx = 0;
          var queryLower = query.toLowerCase();
          for (var li = 0; li < richLines.length; li++) {
            if (richLines[li].toLowerCase().indexOf(queryLower) !== -1) {
              matchLineIdx = li;
              break;
            }
          }
          var contextStart = Math.max(0, matchLineIdx - CONTEXT_LINES);
          var contextEnd = Math.min(richLines.length, matchLineIdx + CONTEXT_LINES + 1);
          visibleText = (contextStart > 0 ? '...\\n' : '') +
            richLines.slice(contextStart, contextEnd).join('\\n') +
            (contextEnd < richLines.length ? '\\n...' : '');
          needsShowMore = true;
        }

        // Use markdown rendering for user/assistant, plain for others
        var useMarkdown = (r.role === 'assistant' || r.role === 'user');
        var visibleHtml;
        if (useMarkdown) {
          visibleHtml = formatMd(escHtml(visibleText)).replace(re, '<mark>$1</mark>');
        } else {
          visibleHtml = escHtml(visibleText).replace(re, '<mark>$1</mark>');
        }

        var contentTag = useMarkdown ? 'div' : 'pre';
        html += '<div class="conv-search-result-rich" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
          '<div class="search-result-meta conv-search-result-header">' +
            '<span class="conv-search-result-role' + roleCls + '">' + escHtml(roleDisplay) + '</span>' +
            '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
            wsLabel +
          '</div>' +
          '<' + contentTag + ' class="search-result-conv' + (useMarkdown ? ' search-result-md' : '') + '" id="' + resultId + '">' + visibleHtml + '</' + contentTag + '>';
        if (needsShowMore) {
          html += '<button class="search-show-more-btn" data-result-id="' + resultId + '" data-full-text="' + escAttr(richText) + '" data-md="' + (useMarkdown ? '1' : '') + '">Show more (' + richLines.length + ' lines)</button>';
        }
        html += '</div>';
      }
    } else {
      var text = escHtml(r.text || '').slice(0, 200);
      var highlighted = text.replace(re, '<mark>$1</mark>');
      html += '<div class="conv-search-result" data-sid="' + sid + '" data-midx="' + mIdx + '" data-project-key="' + escAttr(r.projectKey || '') + '">' +
        '<div class="conv-search-result-header">' +
          '<span class="conv-search-result-role' + roleCls + '">' + escHtml(roleDisplay) + '</span>' +
          '<span class="conv-search-result-session">' + sessionLabel + '</span>' +
          wsLabel +
        '</div>' +
        '<div class="conv-search-result-text">' + highlighted + '</div>' +
      '</div>';
    }
  }
  if (!streaming && allResults.length > limit) {
    html += '<div class="conv-search-no-results">' + (allResults.length - limit) + ' more results not shown</div>';
  }
  container.innerHTML = html;
  container.style.display = '';
  if (convFull) convFull.style.display = 'none';
  var anch2 = document.getElementById('convAnchor'); if (anch2) anch2.style.display = 'none';
}

// Event delegation for search result clicks (avoids inline onclick escaping issues)
(function() {
  var container = document.getElementById('convSearchResults');
  if (!container) return;
  container.addEventListener('click', function(e) {
    var el = e.target;
    // Handle "show more" button
    if (el.classList && el.classList.contains('search-show-more-btn')) {
      e.stopPropagation();
      var resultEl = document.getElementById(el.getAttribute('data-result-id'));
      var fullText = el.getAttribute('data-full-text');
      if (resultEl && fullText) {
        var useMd = el.getAttribute('data-md') === '1';
        var escaped = escHtml(fullText);
        var fullHtml = useMd ? formatMd(escaped) : escaped;
        var highlighted = fullHtml.replace(new RegExp('(' + escHtml(_lastSearchQuery || '').replace(/[.*+?^\\\\$$\\{\\}()|[\\]\\\\]/g, '\\\\$$&') + ')', 'gi'), '<mark>$1</mark>');
        // Show full content at once (HTML can't be sliced safely)
        resultEl.innerHTML = highlighted;
        el.remove();
      }
      return;
    }
    // Walk up to find the result div with data-sid
    while (el && el !== container) {
      if (el.dataset && el.dataset.sid) {
        // Highlight clicked result
        container.querySelectorAll('.search-result-active').forEach(function(prev) { prev.classList.remove('search-result-active'); });
        el.classList.add('search-result-active');
        // Save search state for "back to search"
        _savedSearchState = { query: _lastSearchQuery, results: _lastSearchResults, scope: _searchScope, mode: _searchPreviewMode };
        _vsPostMessage({ command: 'jumpToSession', sessionId: el.dataset.sid, messageIndex: parseInt(el.dataset.midx || '0', 10), projectKey: el.dataset.projectKey || '', searchQuery: _lastSearchQuery });
        return;
      }
      el = el.parentElement;
    }
  });
})();

// Global event delegation for data-action elements (avoids esbuild quote-escaping in onclick)
document.addEventListener('click', function(e) {
  var el = e.target;
  while (el && el !== document.body) {
    var action = el.getAttribute('data-action');
    if (action === 'toggle-task') {
      toggleTask(el.getAttribute('data-agent-id'));
      return;
    }
    if (action === 'copy-agent-id') {
      e.stopPropagation();
      copyText(el.getAttribute('data-agent-id'));
      return;
    }
    if (action === 'view-prompt') {
      e.stopPropagation();
      var agId = el.getAttribute('data-agent-id');
      var prompt = el.getAttribute('data-prompt') || _agentPrompts[agId] || '';
      if (prompt) showPromptModal(agId, prompt);
      return;
    }
    if (action === 'load-more') {
      loadMore(el.getAttribute('data-agent-id'));
      return;
    }
    if (action === 'noop') {
      return;
    }
    el = el.parentElement;
  }
});

// Update the live/jump indicator based on lock state
function updateConvScrollNav() {
  var livePill = document.getElementById('convLivePill');
  var jumpBtn = document.getElementById('convJumpBtn');
  if (!livePill || !jumpBtn) return;
  if (_convLockedToBottom) {
    livePill.style.display = '';
    jumpBtn.style.display = 'none';
  } else {
    livePill.style.display = 'none';
    jumpBtn.style.display = '';
  }
}

// Wire up the "Jump to bottom" button
(function() {
  var btn = document.getElementById('convJumpBtn');
  if (!btn) return;
  btn.addEventListener('click', function() {
    _convLockedToBottom = true;
    _scrollConvToBottom();
    updateConvScrollNav();
  });
})();

// Scroll listener: only update lock state on genuine user scrolls, not programmatic ones
let convScrollTimeout = null;
(function() {
  var convEl = document.getElementById('tabConversation');
  if (!convEl) return;
  convEl.addEventListener('scroll', function() {
    var nearBottom = _convIsNearBottom();
    // Only unlock when user scrolls UP (not near bottom); re-lock when they scroll back down
    if (!nearBottom) {
      _convLockedToBottom = false;
    } else {
      _convLockedToBottom = true;
    }
    updateConvScrollNav();
    if (!convAutoLoad) return;
    clearTimeout(convScrollTimeout);
    convScrollTimeout = setTimeout(function() {
      var el = _getConvEl();
      if (el && el.scrollTop < 50) {
        const total = conversationHtmlArr.length;
        const startIdx = Math.max(0, total - convVisibleCount);
        if (startIdx > 0) {
          loadMoreConversation();
        }
      }
    }, 200);
  });
})();

// Scroll-on-height-change: when docked to bottom, follow the bottom as content height grows.
// We use a ResizeObserver on the convMessages container itself — it fires when content grows
// (details expand, bg command output grows, etc.) WITHOUT being triggered by in-place text updates.
// This replaces the old MutationObserver which fired on every textContent update and caused
// constant re-scrolling even when the user was reading history.
(function() {
  var convMessages = document.getElementById('convMessages');
  if (!convMessages || typeof ResizeObserver === 'undefined') return;
  var obs = new ResizeObserver(function() {
    if (!_convLockedToBottom) return;
    // Use rAF to ensure layout is fully settled before reading scrollHeight,
    // which prevents stopping mid-message when large content chunks arrive.
    requestAnimationFrame(function() {
      if (!_convLockedToBottom) return;
      _scrollConvToBottom();
    });
  });
  obs.observe(convMessages);
})();

// Restore saved tab if available (after all functions defined)
if (typeof _restoredTab !== 'undefined' && _restoredTab) {
  switchTab(_restoredTab);
}

// Restore grouped view button state
if (isGroupedView) {
  var _vBtn = document.getElementById('viewToggle');
  if (_vBtn) { _vBtn.textContent = '☰'; _vBtn.title = 'Switch to flat view'; }
}

// Persist initial state so VS Code can serialize this panel on reload
_saveWebviewState();

// Show initial scroll indicator state
updateConvScrollNav();

// ── Expose globals needed by inline onclick handlers in server-rendered HTML ──
// The IIFE scope is not the global scope, so functions called from onclick="fn()"
// attributes in dynamically-rendered HTML must be attached to window explicitly.
(window as any).vscode = { postMessage: _vsPostMessage, getState: vscode.getState.bind(vscode), setState: vscode.setState.bind(vscode) };
(window as any)._vsPostMessage = _vsPostMessage;
(window as any).sendPermDecision     = sendPermDecision;
(window as any).focusAgent           = focusAgent;
(window as any).focusAgentByDesc     = focusAgentByDesc;
(window as any).expandMore           = expandMore;
(window as any).collapseBack         = collapseBack;
(window as any).loadTaskOutput       = loadTaskOutput;
(window as any).loadMore             = loadMore;
(window as any).loadMoreConvSection  = loadMoreConvSection;
(window as any).loadMoreConversation = loadMoreConversation;
(window as any).scrollToBgCommand    = scrollToBgCommand;
(window as any).jumpTo               = jumpTo;
(window as any).clearDiagLog        = clearDiagLog;
(window as any).exportDiagnostics    = exportDiagnostics;
(window as any).copyText             = copyText;
(window as any).switchTab            = switchTab;

// Signal to extension that webview is ready for data
_vsPostMessage({ command: 'webviewReady' });
