import { SerializedTask, PanelInfo, PanelOptions, DiagnosticInfo } from './types';
import { esc } from './serverHelpers';
import { renderToolbar } from './serverRenderers';

const SEARCH_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>';

export function getAgentPanelHtml(tasks: SerializedTask[], panel?: PanelInfo, options?: PanelOptions, _diagnostics?: DiagnosticInfo): string {
  // Data is delivered via postMessage after webview loads — not embedded in HTML
  const autoConvTab = options?.autoConversationTab ?? false;
  const nonce = panel?.nonce ?? '';
  const cspSource = panel?.cspSource ?? '';
  const scriptUri = panel?.scriptUri ?? '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Claude Lens</title>
  <link rel="stylesheet" href="${panel?.cssUri || ''}">
</head>
<body>
  <div id="toolbarContainer">${panel ? renderToolbar(panel) : ''}</div>
  ${panel?.error ? `<div style="padding:8px 10px;margin-bottom:8px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder,#f44747);border-radius:4px;font-size:11px;color:var(--vscode-errorForeground);">${esc(panel.error)}</div>` : ''}

  <!-- Header bar: diagnostics + view toggle -->
  <div class="header-bar" id="headerBar">
    <button class="diag-toggle-btn" id="diagToggleBtn" onclick="toggleDiagPanel()" title="Toggle diagnostics"><span style="font-style:italic;font-weight:700;font-family:serif">i</span></button>
    <span class="diag-summary" id="diagSummary"></span>
    <button class="header-action-btn" onclick="copyDiagnostics()" title="Copy diagnostics to clipboard">copy</button>
    <button class="header-action-btn conv-mode-toggle" id="convModeToggle" onclick="toggleConvMode()" title="Switch view mode" style="display:none">⊟</button>
  </div>
  <div class="diag-panel" id="diagPanel"></div>

  <div class="tab-bar" id="tabBar">
    <button class="tab-btn${autoConvTab ? '' : ' active'}" data-tab="agents" onclick="switchTab('agents')">Tasks</button>
    <button class="tab-btn${autoConvTab ? ' active' : ''}" data-tab="conversation" onclick="switchTab('conversation')">Conversation</button>
  </div>

  <!-- Unified approval banner — covers user-side pending + claude-side waiting -->
  <div id="approvalBanner"></div>

  <!-- Running tasks bar — visible across both tabs, stacks below sticky tab bar -->
  <div class="running-tasks-bar" id="runningTasksBar" style="display:none">
    <div class="running-tasks-header"><span class="running-tasks-icon">⟳</span> <span id="runningTasksCount">0</span> running</div>
    <div class="running-tasks-list" id="runningTasksList"></div>
  </div>

  <!-- Agents tab -->
  <div class="tab-content${autoConvTab ? '' : ' active'}" id="tabAgents">

  <!-- Collapsible conversation summary at top of agents view -->
  <div id="convSection"></div>

  <div class="controls-bar" id="controlsBar" style="display:none">
    <div class="search-box">
      ${SEARCH_ICON}
      <input type="text" class="search-input" id="searchInput" placeholder="Filter agents..." />
    </div>
    <div class="filter-btns">
      <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
      <button class="filter-btn" data-filter="running" onclick="setFilter('running')">Active</button>
      <button class="filter-btn" data-filter="completed" onclick="setFilter('completed')">Done</button>
    </div>
    <button class="view-toggle" id="viewToggle" onclick="toggleViewMode()" title="Toggle flat/grouped view" style="display:none">☰</button>
  </div>

  <div id="taskList"></div>
  <div class="no-results" id="noResults">No matching agents</div>
  <div class="empty" id="emptyState">
    <div class="empty-icon">◎</div>
    <div>No active tasks</div>
    <div style="font-size:11px;margin-top:4px;">Agents will appear here when launched</div>
  </div>

  </div><!-- /tabAgents -->

  <!-- Conversation tab -->
  <div class="tab-content${autoConvTab ? ' active' : ''}" id="tabConversation">
    <div class="conv-search-bar" id="convSearchBar">
      <div class="conv-search-row">
        ${SEARCH_ICON}
        <input type="text" class="conv-search-input" id="convSearchInput" placeholder="Search messages, tools, agents..." />
        <button class="conv-search-scope-btn" id="convSearchScope" onclick="toggleSearchScope()" title="Toggle search scope">workspace</button>
      </div>
      <div class="search-controls-row">
        <div class="scope-segmented" id="scopeSegmented">
          <button class="scope-seg-btn active" data-scope="workspace" onclick="setSearchScope('workspace')" title="Search current workspace only">Workspace</button>
          <button class="scope-seg-btn" data-scope="global" onclick="setSearchScope('global')" title="Search all workspaces">Global</button>
        </div>
        <button class="search-match-toggle" id="matchCaseBtn" onclick="toggleMatchCase()" title="Match Case"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.026 3.342c.136-.408.812-.408.948 0l2 6a.252.252 0 0 0 .004.013l.996 2.988A.501.501 0 0 1 7.5 13a.5.5 0 0 1-.474-.342l-.886-2.658H2.86l-.886 2.658a.501.501 0 0 1-.948-.317l.996-2.987a.252.252 0 0 1 .004-.012l2-6.001ZM3.194 9h2.612L4.5 5.081 3.194 9ZM11.858 6.668c1.307.065 2.085.816 2.139 2.028l.003.137v3.675a.5.5 0 0 1-.432.487L13.5 13a.5.5 0 0 1-.495-.432L13 12.5v-.07c-.66.377-1.268.57-1.833.57C9.94 13 9 12.137 9 10.833c0-1.15.792-2.004 2.106-2.163A5.028 5.028 0 0 1 13 8.81c-.008-.738-.371-1.103-1.19-1.144-.642-.032-1.093.058-1.357.243a.5.5 0 1 1-.574-.818c.438-.308 1.036-.444 1.789-.43l.191.007Zm.938 3.147a4.036 4.036 0 0 0-1.57-.128c-.822.1-1.227.537-1.227 1.17 0 .731.475 1.167 1.167 1.167.454 0 1.012-.21 1.668-.642l.165-.112V9.876l-.203-.06Z"/></svg></button>
        <button class="search-match-toggle" id="matchWholeWordBtn" onclick="toggleMatchWholeWord()" title="Match Whole Word"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M15.5 12.5a.5.5 0 0 1 .5.5v.5c0 .827-.673 1.5-1.5 1.5h-13C.673 15 0 14.327 0 13.5V13a.5.5 0 0 1 1 0v.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V13a.5.5 0 0 1 .5-.5Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M4.858 5.67c1.307.066 2.085.817 2.14 2.03L7 7.835v3.675a.501.501 0 0 1-.432.487l-.068.005a.5.5 0 0 1-.495-.432L6 11.503v-.07c-.659.377-1.268.57-1.833.57C2.941 12.003 2 11.14 2 9.836c0-1.15.792-2.004 2.106-2.163A5.028 5.028 0 0 1 6 7.813c-.007-.738-.371-1.103-1.191-1.144-.641-.032-1.092.058-1.356.243a.5.5 0 1 1-.574-.818c.439-.308 1.036-.444 1.789-.43l.191.007Zm.939 3.148a4.039 4.039 0 0 0-1.571-.128c-.822.1-1.227.537-1.227 1.17 0 .731.475 1.167 1.167 1.167.454 0 1.012-.21 1.668-.642l.165-.112V8.879l-.202-.06ZM9.55 2.006a.5.5 0 0 1 .45.497v4.1c.418-.377.937-.6 1.5-.6 1.381 0 2.5 1.343 2.5 3s-1.119 3-2.5 3c-.563 0-1.082-.223-1.5-.6v.1a.5.5 0 0 1-.45.497c-.016.003-.033.003-.05.003a.5.5 0 0 1-.5-.5v-9c0-.017 0-.034.003-.05a.5.5 0 0 1 .548-.447Zm1.885 4.998c-.404.028-.858.311-1.145.818a2.439 2.439 0 0 0-.288 1.073C10 8.93 10 8.966 10 9.002l.002.107c.016.4.12.767.287 1.07.287.508.742.794 1.146.821a.684.684 0 0 0 .13 0c.404-.027.859-.313 1.146-.82.167-.304.271-.672.287-1.07.002-.036.002-.072.002-.108l-.002-.107a2.439 2.439 0 0 0-.288-1.073c-.287-.507-.74-.79-1.146-.818-.02-.002-.042-.002-.064-.002s-.043 0-.065.002Z"/></svg></button>
        <div class="search-view-toggle" id="searchViewToggle">
          <button class="search-view-btn active" data-mode="compact" onclick="setSearchPreviewMode('compact')" title="Compact result view">Compact</button>
          <button class="search-view-btn" data-mode="rich" onclick="setSearchPreviewMode('rich')" title="Rich preview with context">Rich</button>
        </div>
      </div>
    </div>
    <div class="conv-search-results" id="convSearchResults" style="display:none"></div>
    <div class="conv-anchor" id="convAnchor"></div>
    <div class="conv-container" id="convFull">
      <div class="conv-load-more" id="convLoadMore" style="display:none">
        <button class="conv-load-more-btn" onclick="loadMoreConversation()">Load earlier messages</button>
        <span style="flex:1"></span>
        <button class="conv-auto-load-btn" onclick="convAutoLoad=!convAutoLoad;this.classList.toggle('active',convAutoLoad)" title="Automatically load earlier messages when scrolling to top">Auto-load ↑</button>
      </div>
      <div id="convMessages"></div>
    </div>
    <!-- Nav sits directly inside the scroll container (#tabConversation) so sticky bottom works -->
    <div class="conv-scroll-nav" id="convScrollNav">
      <div class="conv-live-pill" id="convLivePill" style="display:none"><div class="conv-live-dot"></div>Live</div>
      <button class="conv-jump-btn" id="convJumpBtn" onclick="convScrollTo(&#39;bottom&#39;)" style="display:none">↓ Jump to bottom</button>
    </div>
  </div>

  <!-- Canary: if JS fails, this stays visible so user knows HTML loaded but JS broke -->
  <div id="jsCanary" style="padding:8px 10px;margin-top:8px;background:var(--vscode-inputValidation-errorBackground,#5a1d1d);border:1px solid var(--vscode-inputValidation-errorBorder,#be1100);border-radius:4px;font-size:11px;color:var(--vscode-foreground);">
    <strong id="jsCanaryTitle">Webview script failed to load</strong>
    <pre id="jsCanaryError" style="margin-top:6px;font-family:monospace;font-size:11px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;color:var(--vscode-errorForeground,#f48771);user-select:text;cursor:text;background:rgba(0,0,0,0.3);padding:8px;border-radius:3px;display:none;"></pre>
    <p id="jsCanaryHint" style="margin-top:6px;font-size:10px;color:var(--vscode-descriptionForeground);display:none;">Select the text above and press Cmd+C to copy</p>
  </div>

  <script nonce="${nonce}">window.__PANEL_DATA__ = ${JSON.stringify({ initialTab: autoConvTab ? 'conversation' : 'agents' })};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
