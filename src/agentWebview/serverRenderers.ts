import { AgentTask, BackgroundCommand, ContentBlock, ConversationMessage, ConvToolBlock, ToolUseBlock, ToolResultBlock, TurnUsage, getAgentLastActivity } from '../agentParser';
import { SerializedTask, PanelInfo, SessionInfo } from './types';
import {
  esc, escAttr, shortenPath, timeAgo,
  formatToolInput, formatMarkdown,
  effectiveToolIcon, compactToolPreview, compactResultLineCount, compactResultPreview,
  formatResultForDisplay, renderExpandableResult,
  COLLAPSE_LINE_THRESHOLD, COPY_ICON, FOLDER_ICON, SEARCH_ICON,
} from './serverHelpers';

/** Smooth HSL gradient matching the client-side ctxColor() function */
function ctxColorHsl(pct: number): string {
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const eased = t * t * (3 - 2 * t); // smoothstep
  const hue = Math.round(120 * (1 - eased));
  const sat = Math.round(35 + 60 * eased);
  const lit = Math.round(50 - 10 * eased + 2 * eased * eased);
  return `hsl(${hue},${sat}%,${lit}%)`;
}

function renderTurnUsageFooter(u: TurnUsage): string {
  const fmtK = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  const parts: string[] = [];
  if (u.input > 0) parts.push(`${fmtK(u.input)} new`);
  if (u.cacheRead > 0) parts.push(`<span class="token-cache-read" title="Cache read">${fmtK(u.cacheRead)} cached</span>`);
  if (u.cacheCreate > 0) parts.push(`<span class="token-cache-write" title="Cache write (new cache)">${fmtK(u.cacheCreate)} saved</span>`);
  parts.push(`${fmtK(u.output)} out`);
  const ctx = u.input + u.cacheRead + u.cacheCreate;
  const ctxLimit = ctx > 200000 ? 1000000 : 200000;
  const ctxPct = Math.round(ctx / ctxLimit * 100);
  const ctxColor = ctxColorHsl(ctxPct);
  const ctxBadge = `<span style="display:inline-flex;align-items:center;gap:2px;padding:0 4px;border-radius:3px;background:${ctxColor};opacity:0.85;border:none;color:#fff;font-size:10px;vertical-align:middle"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#fff;opacity:0.7"></span>${ctxPct}% ctx</span>`;
  return `<div class="conv-token-footer">${ctxBadge} <span style="opacity:0.4">·</span> ${parts.join(' <span style="opacity:0.4">·</span> ')}</div>`;
}

function renderTextBlock(block: ContentBlock & { type: 'text' }, index: number): string {
  const rendered = formatMarkdown(esc(block.text));
  const lineCount = block.text.split('\n').length;
  const turnFooter = block.turnUsage ? renderTurnUsageFooter(block.turnUsage) : '';
  if (lineCount > COLLAPSE_LINE_THRESHOLD) {
    const uid = `txt-${index}-${Date.now()}`;
    return `<div class="block block-text collapsible" data-uid="${uid}" data-max-lines="${COLLAPSE_LINE_THRESHOLD}" data-total-lines="${lineCount}">
      <div class="text-content" style="-webkit-line-clamp:${COLLAPSE_LINE_THRESHOLD};display:-webkit-box;-webkit-box-orient:vertical">${rendered}</div>
      <div class="collapse-bar" onclick="expandMore(this)">
        <span class="collapse-label">Show more</span>
      </div>
      ${turnFooter}
    </div>`;
  }
  return `<div class="block block-text">${rendered}${turnFooter}</div>`;
}

/** Render a grouped tool_use + tool_result pair as a single compact block */
function renderTodoList(use: ContentBlock & { type: 'tool_use' }, result: (ContentBlock & { type: 'tool_result' }) | undefined): string {
  const todos = use.input['todos'] as Array<Record<string, unknown>> | undefined;
  if (!todos || !Array.isArray(todos)) return '';
  const resultIcon = result ? (result.isError ? '✗' : '✓') : '⋯';
  const resultCls = result ? (result.isError ? 'tool-result-error' : 'tool-result-ok') : 'tool-result-pending';
  const inProgressItem = todos.find(t => t['status'] === 'in_progress');
  const activeLabel = inProgressItem ? esc(String((inProgressItem['activeForm'] ?? inProgressItem['content']) || '')) : '';
  const headerLabel = activeLabel || 'Tasks';
  const items = todos.map(t => {
    const status = String(t['status'] || '');
    const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '◉' : '○';
    const cls = status === 'completed' ? 'todo-done' : status === 'in_progress' ? 'todo-active' : 'todo-pending';
    return `<div class="todo-item ${cls}"><span class="todo-icon">${icon}</span><span class="todo-text">${esc(String(t['content'] || ''))}</span></div>`;
  }).join('');
  return `<div class="block block-todo ${resultCls}">
    <div class="todo-header"><span class="tool-pair-result-icon">${resultIcon}</span><span class="todo-header-label">${headerLabel}</span><span class="tool-pair-time">${timeAgo(use.timestamp)}</span></div>
    <div class="todo-items">${items}</div>
  </div>`;
}

/** Normalized shape for rendering a tool call — shared between agents tab and conversation tab */
interface NormalizedToolBlock {
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
  /** ISO timestamp of the tool result (for duration calculation) */
  resultTimestamp?: string;
  result?: string;
  isError?: boolean;
  backgroundCommand?: BackgroundCommand;
  /** Message-level timestamp used for pending timer in conversation tab */
  msgTimestamp?: string;
  /** Whether result text starts with "Command running in background" (auto-backgrounded) */
  resultIsBackground?: boolean;
  /** true = conversation tab (conv-tool-pair class), false = agents tab (block class) */
  isConvView?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/** Single implementation for rendering a tool_use + tool_result pair (used by both tabs) */
function renderToolBlockHtml(block: NormalizedToolBlock): string {
  const { name, input, result, isError, backgroundCommand: bgCmd, isConvView } = block;

  const icon = effectiveToolIcon(name, input);
  const preview = esc(compactToolPreview(name, input));
  const inputStr = formatToolInput(name, input);
  const hasResult = result !== undefined;
  // A command may be explicitly backgrounded (run_in_background=true in input) OR
  // auto-backgrounded by Claude Code when it times out (result starts with "Command running in background").
  const resultIsBackground = block.resultIsBackground ?? false;
  const isBgInput = (name === 'Bash' && input['run_in_background'] === true) || resultIsBackground;
  // Background command live output
  const isBgRunning = isBgInput && bgCmd != null;
  const resultCls = isBgRunning ? 'tool-result-pending' : (hasResult ? (isError ? 'tool-result-error' : 'tool-result-ok') : 'tool-result-pending');
  const resultIconStr = isBgRunning ? '⟳' : (hasResult ? (isError ? '✗' : '✓') : (isBgInput ? '⟳' : '⋯'));
  // For success: show line count inline with icon; for errors: full preview in result-line
  const successLineCount = hasResult && !isError && !isBgRunning ? compactResultLineCount(result!) : '';
  const isPending = !hasResult && !isBgInput;
  // Pending timer: agents tab uses tool timestamp, conv tab uses message timestamp
  const timerTs = isConvView ? block.msgTimestamp : block.timestamp;
  const pendingTimerHtml = isPending && timerTs && isConvView
    ? `<span class="pending-timer" data-start-ts="${escAttr(timerTs)}"></span>`
    : '';
  const pendingLabel = isBgInput
    ? '<span style="opacity:0.6">⟳ running in background...</span>'
    : `<span class="pending-indicator" style="opacity:0.5"><span class="pending-spinner"></span> running...${pendingTimerHtml}</span>`;
  const resultPreview = isBgRunning
    ? '<span style="opacity:0.6">⟳ running in background...</span>'
    : (hasResult
      ? esc(compactResultPreview(result!, isError ?? false))
      : pendingLabel);

  const displayResult = hasResult ? formatResultForDisplay(name, result!) : '';
  const bgCmdText = bgCmd ? String(input['command'] ?? input['description'] ?? '') : '';
  const bgHtml = bgCmd
    ? `<div class="bg-command-output" data-command-id="${esc(bgCmd.commandId)}" data-output-path="${escAttr(bgCmd.outputPath)}">
        <div class="tool-pair-section-label">Output <span class="bg-command-status" data-command-id="${esc(bgCmd.commandId)}">⟳ running</span></div>
        ${bgCmdText ? `<div class="bg-command-cmd"><code>${esc(bgCmdText)}</code></div>` : ''}
        <pre class="bg-output-content"></pre>
      </div>`
    : '';

  const resultLineHtml = bgCmd ? '<span style="opacity:0.6">⟳ background command running...</span>' : resultPreview;

  // For Agent tool, add a "Jump to agent" link (only if agent was actually spawned — no error)
  const agentDesc = String(input['description'] ?? '');
  const agentLink = name === 'Agent' && agentDesc && !isError
    ? `<div class="tool-pair-agent-link"><button class="agent-jump-btn" onclick="focusAgentByDesc('${escAttr(agentDesc)}')" title="Jump to agent card">⊛ View agent</button></div>`
    : '';

  // For Edit/Write/NotebookEdit: clickable file open button + diff view
  const isEditTool = name === 'Edit' || name === 'Write' || name === 'NotebookEdit';
  const editFilePath = isEditTool ? (input['file_path'] as string | undefined) ?? '' : '';
  const editOldString = name === 'Edit' ? (input['old_string'] as string | undefined) ?? '' : '';
  const fileOpenBtn = editFilePath
    ? `<button class="tool-open-file-btn" title="Open file in editor"
         onclick="event.stopPropagation();vscode.postMessage({command:'openFile',path:${JSON.stringify(editFilePath)},oldString:${JSON.stringify(editOldString)}})">↗</button>`
    : '';

  // Diff view for Edit/NotebookEdit tools (both tabs)
  const editDiffHtml = (name === 'Edit' || name === 'NotebookEdit')
    ? renderEditDiff(input)
    : '';

  // Build input section — with diff if available, file label for edit tools, "Command" otherwise
  let inputSection: string;
  if (editDiffHtml) {
    inputSection = `<div class="tool-pair-input"><div class="tool-pair-section-label">File${fileOpenBtn}</div><pre>${esc(inputStr)}</pre></div>${editDiffHtml}`;
  } else if (editFilePath) {
    inputSection = `<div class="tool-pair-input"><div class="tool-pair-section-label">File${fileOpenBtn}</div><pre>${esc(inputStr)}</pre></div>`;
  } else {
    inputSection = `<div class="tool-pair-input"><div class="tool-pair-section-label">Command</div><pre>${esc(inputStr)}</pre></div>`;
  }

  // Bug fix: show result section when bgCmd is set but result is NOT the "Command running in background" message
  // (i.e., the background command has completed and actual output is available)
  const bgResultIsPlaceholder = resultIsBackground || (result ?? '').startsWith('Command running in background with ID:');
  const showResultSection = hasResult && (!bgCmd || !bgResultIsPlaceholder);

  // CSS class differs between agents tab and conversation tab
  const outerCls = isConvView ? 'conv-tool-pair block-tool-pair' : 'block block-tool-pair';
  // Tag running bg commands for JS fixup (conv tab only, but harmless on agents tab)
  const bgRunningAttr = isBgRunning ? ` data-bg-running="${escAttr(bgCmd!.commandId)}"` : '';
  // Time badge (agents tab only — conv tab shows time on message level)
  // For completed tools with a result timestamp: show duration instead of timeAgo
  let timeHtml = '';
  if (!isConvView && block.timestamp) {
    if (hasResult && !isBgRunning && block.resultTimestamp) {
      const durationMs = new Date(block.resultTimestamp).getTime() - new Date(block.timestamp).getTime();
      if (durationMs >= 0) {
        const durationStr = formatDuration(durationMs);
        timeHtml = `<span class="tool-pair-time tool-pair-duration" title="Duration">${durationStr}</span>`;
      } else {
        timeHtml = `<span class="tool-pair-time">${timeAgo(block.timestamp)}</span>`;
      }
    } else if (isPending && block.timestamp) {
      // Live ticking timer — replaced by client when result arrives
      const timerStartTs = escAttr(block.timestamp);
      timeHtml = `<span class="tool-pair-time pending-timer" data-start-ts="${timerStartTs}"></span>`;
    } else {
      timeHtml = `<span class="tool-pair-time">${timeAgo(block.timestamp)}</span>`;
    }
  }

  const pendingAttr = isPending ? ' data-pending="1"' : '';
  return `<details class="${outerCls} ${resultCls}"${bgRunningAttr}${pendingAttr}>
    <summary class="tool-pair-header">
      <span class="tool-pair-icon">${icon}</span>
      <span class="tool-pair-name">${esc(name)}</span>
      <span class="tool-pair-preview">${preview}</span>
      <span class="tool-pair-result-icon">${resultIconStr}</span>${successLineCount ? `<span class="tool-pair-lines">${esc(successLineCount)}</span>` : ''}
      ${timeHtml}
      ${isBgRunning ? `<div class="bg-command-status" data-command-id="${esc(bgCmd!.commandId)}" style="flex-basis:100%;font-size:10px;padding:2px 0 1px 20px;color:var(--vscode-charts-blue,#4fc1ff);">⟳ running in background...</div>` : `<div class="tool-pair-result-line ${resultCls}">${resultLineHtml}</div>`}
    </summary>
    <div class="tool-pair-body">
      ${inputSection}
      ${agentLink}
      ${bgHtml}
      ${showResultSection ? `<div class="tool-pair-output ${resultCls}"><div class="tool-pair-section-label">${isError ? 'Error' : 'Result'}</div>${renderExpandableResult(name, input, displayResult, isError ?? false)}</div>` : ''}
    </div>
  </details>`;
}

function renderToolPair(use: ContentBlock & { type: 'tool_use' }, result: (ContentBlock & { type: 'tool_result' }) | undefined): string {
  // TodoWrite gets special flat rendering
  if (use.name === 'TodoWrite') {
    return renderTodoList(use, result);
  }

  const r = result as ToolResultBlock | undefined;
  const toolHtml = renderToolBlockHtml({
    name: use.name,
    input: use.input,
    timestamp: use.timestamp,
    resultTimestamp: r?.timestamp,
    result: r?.content,
    isError: r?.isError,
    backgroundCommand: r?.backgroundCommand,
    isConvView: false,
  });
  const turnFooter = use.turnUsage ? renderTurnUsageFooter(use.turnUsage) : '';
  return turnFooter ? toolHtml + turnFooter : toolHtml;
}

/** Render blocks, grouping tool_use + tool_result pairs by toolUseId (handles parallel calls) */
function renderBlockGroup(blocks: ContentBlock[], startIdx: number): { html: string; consumed: number }[] {
  const results: { html: string; consumed: number }[] = [];

  // Build a map of toolUseId → tool_result for non-consecutive matching
  const resultMap = new Map<string, { block: ContentBlock & { type: 'tool_result' }; index: number }>();
  for (let j = 0; j < blocks.length; j++) {
    const b = blocks[j];
    if (b.type === 'tool_result') {
      const tr = b as ToolResultBlock;
      if (tr.toolUseId) {
        resultMap.set(tr.toolUseId, { block: b as ContentBlock & { type: 'tool_result' }, index: j });
      }
    }
  }

  // Track which tool_result indices have been consumed (paired with a tool_use)
  const consumedResultIndices = new Set<number>();

  // First pass: identify which results pair with which tool_use
  for (let j = 0; j < blocks.length; j++) {
    const b = blocks[j];
    if (b.type === 'tool_use') {
      const tu = b as ToolUseBlock;
      const match = resultMap.get(tu.id);
      if (match) {
        consumedResultIndices.add(match.index);
      }
    }
  }

  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    const globalIdx = startIdx + i;

    if (block.type === 'text') {
      results.push({ html: renderTextBlock(block as ContentBlock & { type: 'text' }, globalIdx), consumed: 1 });
      i++;
    } else if (block.type === 'tool_use') {
      const tu = block as ToolUseBlock;
      const match = resultMap.get(tu.id);

      if (match) {
        // Check if result is the immediate next block (consecutive pair)
        if (match.index === i + 1) {
          results.push({
            html: renderToolPair(block as ContentBlock & { type: 'tool_use' }, match.block),
            consumed: 2,
          });
          i += 2;
        } else {
          // Non-consecutive: render paired but consume only the tool_use (result consumed separately)
          results.push({
            html: renderToolPair(block as ContentBlock & { type: 'tool_use' }, match.block),
            consumed: 1,
          });
          i++;
        }
      } else {
        // Orphan tool_use (result not yet available)
        results.push({
          html: renderToolPair(block as ContentBlock & { type: 'tool_use' }, undefined),
          consumed: 1,
        });
        i++;
      }
    } else if (block.type === 'tool_result') {
      if (consumedResultIndices.has(i)) {
        // Already paired with a tool_use — skip rendering standalone
        results.push({ html: '', consumed: 1 });
      } else {
        // Orphan result (tool_use was in hidden blocks) — render standalone
        const cls = (block as ToolResultBlock).isError ? 'tool-result-error' : 'tool-result-ok';
        const orphanContent = (block as ToolResultBlock).content;
        results.push({
          html: `<details class="block block-result ${cls}">
            <summary class="result-header">
              <span class="result-icon">${(block as ToolResultBlock).isError ? '✗' : '✓'}</span>
              <span class="result-label">${(block as ToolResultBlock).isError ? 'Error' : 'Result'}</span>
            </summary>
            <div class="result-body">${renderExpandableResult('', {}, orphanContent, (block as ToolResultBlock).isError)}</div>
          </details>`,
          consumed: 1,
        });
      }
      i++;
    } else {
      i++;
    }
  }

  return results;
}

// ── Conversation message rendering (server-side) ──────────────────

const CONV_TEXT_COLLAPSE_LINES = 20;

/** Render a conversation tool block (same style as agent tool pairs) */
function renderConvTodoList(tb: ConvToolBlock): string {
  const todos = tb.input['todos'] as Array<Record<string, unknown>> | undefined;
  if (!todos || !Array.isArray(todos)) return '';
  const resultIcon = tb.result !== undefined ? (tb.isError ? '✗' : '✓') : '⋯';
  const resultCls = tb.result !== undefined ? (tb.isError ? 'tool-result-error' : 'tool-result-ok') : 'tool-result-pending';
  const inProgressItem = todos.find(t => t['status'] === 'in_progress');
  const activeLabel = inProgressItem ? esc(String((inProgressItem['activeForm'] ?? inProgressItem['content']) || '')) : '';
  const headerLabel = activeLabel || 'Tasks';
  const items = todos.map(t => {
    const status = String(t['status'] || '');
    const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '◉' : '○';
    const cls = status === 'completed' ? 'todo-done' : status === 'in_progress' ? 'todo-active' : 'todo-pending';
    return `<div class="todo-item ${cls}"><span class="todo-icon">${icon}</span><span class="todo-text">${esc(String(t['content'] || ''))}</span></div>`;
  }).join('');
  return `<div class="block block-todo conv-tool-pair ${resultCls}">
    <div class="todo-header"><span class="tool-pair-result-icon">${resultIcon}</span><span class="todo-header-label">${headerLabel}</span></div>
    <div class="todo-items">${items}</div>
  </div>`;
}

type DiffOp = { op: 'eq' | 'del' | 'ins'; line: string };

/** Myers-style LCS diff — returns per-line operations */
function lineDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const M = oldLines.length, N = newLines.length;
  // LCS table (only need two rows)
  const dp: number[][] = Array.from({ length: M + 1 }, () => new Array(N + 1).fill(0));
  for (let i = M - 1; i >= 0; i--)
    for (let j = N - 1; j >= 0; j--)
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < M || j < N) {
    if (i < M && j < N && oldLines[i] === newLines[j]) {
      ops.push({ op: 'eq', line: oldLines[i++] }); j++;
    } else if (j < N && (i >= M || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ op: 'ins', line: newLines[j++] });
    } else {
      ops.push({ op: 'del', line: oldLines[i++] });
    }
  }
  return ops;
}

function renderEditDiff(input: Record<string, unknown>): string {
  const oldStr = (input['old_string'] as string) ?? '';
  const newStr = (input['new_string'] as string) ?? '';
  if (!oldStr && !newStr) return '';

  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // Skip diff for very large inputs to avoid O(M*N) LCS blowup
  const MAX_DIFF_LINES = 200;
  if (oldLines.length + newLines.length > MAX_DIFF_LINES) {
    // Fallback: just show a "too large to diff" note with line counts
    return `<div class="tool-pair-diff"><div class="tool-pair-section-label">Changes</div>` +
      `<div class="diff-block"><div class="diff-truncated">${oldLines.length} lines → ${newLines.length} lines (diff skipped, too large)</div></div></div>`;
  }

  const ops = lineDiff(oldLines, newLines);
  const CONTEXT = 3; // unchanged lines to show around changes
  const MAX_RENDERED = 120; // hard cap on rendered lines

  // Identify which 'eq' ops are within CONTEXT lines of a change
  const visible = new Set<number>();
  const changeIdxs: number[] = [];
  ops.forEach((op, i) => { if (op.op !== 'eq') changeIdxs.push(i); });
  for (const ci of changeIdxs)
    for (let k = Math.max(0, ci - CONTEXT); k <= Math.min(ops.length - 1, ci + CONTEXT); k++)
      visible.add(k);

  let rows = '';
  let rendered = 0;
  let skipped = 0;
  for (let i = 0; i <= ops.length; i++) {
    if (i === ops.length || (!visible.has(i) && ops[i].op === 'eq')) {
      if (i < ops.length) { skipped++; continue; }
    }
    if (skipped > 0) {
      rows += `<div class="diff-line diff-ctx-skip">  ···  ${skipped} unchanged line${skipped !== 1 ? 's' : ''}</div>`;
      skipped = 0;
    }
    if (i === ops.length) break;
    if (rendered >= MAX_RENDERED) { rows += `<div class="diff-truncated">…more lines not shown</div>`; break; }
    const { op, line } = ops[i];
    if (op === 'eq') {
      rows += `<div class="diff-line diff-ctx"><span class="diff-sign"> </span>${esc(line)}</div>`;
    } else if (op === 'del') {
      rows += `<div class="diff-line diff-del"><span class="diff-sign">-</span>${esc(line)}</div>`;
    } else {
      rows += `<div class="diff-line diff-add"><span class="diff-sign">+</span>${esc(line)}</div>`;
    }
    rendered++;
  }

  return `<div class="tool-pair-diff"><div class="tool-pair-section-label">Changes</div><div class="diff-block">${rows}</div></div>`;
}

function renderConvTool(tb: ConvToolBlock, msgTimestamp?: string): string {
  // TodoWrite gets special flat rendering
  if (tb.name === 'TodoWrite') {
    return renderConvTodoList(tb);
  }

  const resultIsBackground = (tb.result ?? '').startsWith('Command running in background with ID:');
  return renderToolBlockHtml({
    name: tb.name,
    input: tb.input,
    result: tb.result,
    isError: tb.isError,
    backgroundCommand: tb.backgroundCommand,
    msgTimestamp,
    resultIsBackground,
    isConvView: true,
  });
}

const TOOL_GROUP_THRESHOLD = 3; // Consecutive same-tool calls ≥ this get collapsed

/** Render N consecutive same-tool calls as a single collapsible group */
function renderConvToolGroup(run: ConvToolBlock[], msgTimestamp?: string): string {
  const n = run.length;
  const name = run[0].name;
  const icon = effectiveToolIcon(name, run[0].input);

  // Aggregate status
  const hasError = run.some(t => t.isError);
  const hasPending = run.some(t => t.result === undefined && !(t.input['run_in_background'] === true));
  const aggCls = hasError ? 'tool-result-error' : (hasPending ? 'tool-result-pending' : 'tool-result-ok');
  const aggIcon = hasError ? '✗' : (hasPending ? '⋯' : '✓');

  // Group summary text: "8 files" / "5 commands" / "N calls"
  const noun = (name === 'Read' || name === 'Glob' || name === 'Grep') ? 'files'
    : (name === 'Bash') ? 'commands'
    : (name === 'Edit' || name === 'Write') ? 'edits'
    : 'calls';
  const groupPreview = `${n} ${noun}`;

  // Compact item list inside the group — one line per tool
  const items = run.map(tb => {
    const itHasResult = tb.result !== undefined;
    const itPending = !itHasResult && !(tb.input['run_in_background'] === true);
    const itCls = tb.isError ? 'tool-result-error' : (itPending ? 'tool-result-pending' : 'tool-result-ok');
    const itIcon = tb.isError ? '✗' : (itPending ? '⋯' : '✓');
    const itPreview = esc(compactToolPreview(tb.name, tb.input));
    return `<div class="conv-tool-group-item ${itCls}">
      <span class="conv-tool-group-item-icon">${itIcon}</span>
      <span class="conv-tool-group-item-preview">${itPreview}</span>
    </div>`;
  }).join('');

  return `<details class="conv-tool-group ${aggCls}">
    <summary class="conv-tool-group-header">
      <span class="tool-pair-icon">${icon}</span>
      <span class="tool-pair-name">${esc(name)}</span>
      <span class="tool-pair-preview">${groupPreview}</span>
      <span class="tool-pair-result-icon">${aggIcon}</span>
    </summary>
    <div class="conv-tool-group-body">${items}</div>
  </details>`;
}

/** Render tool blocks, collapsing consecutive same-name runs of ≥ TOOL_GROUP_THRESHOLD */
function groupAndRenderConvTools(toolBlocks: ConvToolBlock[], msgTimestamp?: string): string {
  let html = '';
  let i = 0;
  while (i < toolBlocks.length) {
    const name = toolBlocks[i].name;
    // TodoWrite has special rendering — never group it
    if (name === 'TodoWrite') { html += renderConvTool(toolBlocks[i], msgTimestamp); i++; continue; }
    let j = i + 1;
    while (j < toolBlocks.length && toolBlocks[j].name === name && name !== 'TodoWrite') j++;
    const run = toolBlocks.slice(i, j);
    if (run.length >= TOOL_GROUP_THRESHOLD) {
      html += renderConvToolGroup(run, msgTimestamp);
    } else {
      for (const tb of run) html += renderConvTool(tb, msgTimestamp);
    }
    i = j;
  }
  return html;
}

/** Classify a user message for special rendering */
interface TaskNotifData {
  taskId: string;
  status: string;
  summary: string;
  afterTag: string;
  commandName: string;
  exitCode: string;
  outputFile: string;
  fullCommand?: string;
}

interface ClassifiedMessage {
  type: 'normal' | 'system' | 'command' | 'interrupted' | 'stdout' | 'compaction' | 'task-notification' | 'context-summary';
  cleanText: string;
  meta?: string;
  taskNotif?: TaskNotifData;
}

function classifyUserMessage(text: string, bgCommandMap?: Map<string, string>): ClassifiedMessage {
  const trimmed = text.trim();

  if (/^\[Request interrupted by user/.test(trimmed)) {
    return { type: 'interrupted', cleanText: trimmed };
  }

  // Task notification XML: <task-notification>...<summary>...</summary></task-notification>
  const taskNotifMatch = trimmed.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (taskNotifMatch) {
    const inner = taskNotifMatch[1];
    const summary = inner.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? '';
    const status = inner.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() ?? '';
    const taskId = inner.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]?.trim() ?? '';
    const outputFile = inner.match(/<output-file>([\s\S]*?)<\/output-file>/)?.[1]?.trim() ?? '';
    const afterTag = trimmed.replace(/<task-notification>[\s\S]*?<\/task-notification>/, '').trim();

    // Extract command name and exit code from summary: 'Background command "NAME" completed (exit code N)'
    const cmdMatch = summary.match(/[Bb]ackground command "([^"]+)"/);
    const commandName = cmdMatch?.[1] ?? '';
    const exitMatch = summary.match(/exit code (\d+)/);
    const exitCode = exitMatch?.[1] ?? '';

    const fullCommand = (taskId && bgCommandMap) ? (bgCommandMap.get(taskId) ?? '') : '';
    const display = summary || `Task ${taskId} ${status}`;
    const fullText = afterTag ? display + '\n' + afterTag : display;
    return {
      type: 'task-notification', cleanText: fullText, meta: status || 'notification',
      taskNotif: { taskId, status, summary, afterTag, commandName, exitCode, outputFile, fullCommand },
    };
  }

  // Context summary from continued session (long, should be collapsed)
  if (/^This session is being continued from a previous conversation/i.test(trimmed)) {
    return { type: 'context-summary', cleanText: trimmed, meta: 'Context summary' };
  }

  // Context compaction/summarization markers
  if (/context.*compress|conversation.*compact|messages.*summar|prior messages.*compress/i.test(trimmed) && trimmed.length < 500) {
    return { type: 'compaction', cleanText: 'Context compacted', meta: 'System' };
  }

  // System reminders about summarization
  if (trimmed.startsWith('<system-reminder>') && /summar|compact|context/i.test(trimmed)) {
    return { type: 'compaction', cleanText: 'Context summarized', meta: 'System' };
  }

  const stdoutMatch = trimmed.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdoutMatch) {
    return { type: 'stdout', cleanText: stdoutMatch[1].trim(), meta: 'Command output' };
  }

  if (trimmed.includes('<local-command-caveat>')) {
    // Strip the caveat tag — it may prefix actual user text (queued messages)
    const stripped = trimmed.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim();
    if (!stripped) return { type: 'system', cleanText: '', meta: 'System caveat' };
    // Re-classify the remaining text
    return classifyUserMessage(stripped, bgCommandMap);
  }

  const cmdMatch = trimmed.match(/<command-name>(.*?)<\/command-name>/);
  if (cmdMatch) {
    return { type: 'command', cleanText: cmdMatch[1], meta: 'Slash command' };
  }

  const ideMatch = trimmed.match(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>\s*([\s\S]*)/);
  if (ideMatch) {
    const remaining = ideMatch[1].trim();
    if (!remaining) return { type: 'system', cleanText: '', meta: 'IDE context' };
    return { type: 'normal', cleanText: remaining };
  }

  return { type: 'normal', cleanText: text };
}

/** Pre-render a conversation message to HTML */
export function renderConvMessageHtml(msg: ConversationMessage, prevRole = '', bgCommandMap?: Map<string, string>): string {
  const isUser = msg.role === 'user';
  const isCompact = msg.isCompact === true;
  const isContinuation = !isCompact && msg.role === prevRole;
  const timeHtml = msg.timestamp ? `<span class="conv-time">${esc(formatTime(msg.timestamp))}</span>` : '';
  const timeTitle = msg.timestamp ? ` title="${esc(formatTime(msg.timestamp))}"` : '';

  // Classify user messages for special handling
  if (isUser && !isCompact) {
    const classified = classifyUserMessage(msg.text, bgCommandMap);

    if (classified.type === 'system' && !classified.cleanText) {
      return ''; // Skip system caveats entirely
    }

    if (classified.type === 'interrupted') {
      return `<div class="conv-msg interrupted"><div class="conv-role">System${timeHtml}</div><div class="conv-text">${esc(classified.cleanText)}</div></div>`;
    }

    if (classified.type === 'command') {
      return `<div class="conv-msg command-msg"><div class="conv-role">Command${timeHtml}</div><div class="conv-text"><span class="conv-command-badge">${esc(classified.cleanText)}</span></div></div>`;
    }

    if (classified.type === 'stdout') {
      return `<div class="conv-msg stdout-msg"><div class="conv-role">${esc(classified.meta || 'Output')}${timeHtml}</div><pre class="conv-text">${esc(classified.cleanText)}</pre></div>`;
    }

    if (classified.type === 'compaction') {
      return `<div class="conv-msg compaction-msg"><div class="conv-role">System${timeHtml}</div><div class="conv-text"><span class="conv-compaction-badge">⊘ ${esc(classified.cleanText)}</span></div></div>`;
    }

    if (classified.type === 'context-summary') {
      const summaryText = formatMarkdown(esc(classified.cleanText));
      return `<details class="conv-msg context-summary-msg"><summary class="conv-role">⊘ Context summary from previous session${timeHtml}</summary><div class="conv-text">${summaryText}</div></details>`;
    }

    if (classified.type === 'task-notification') {
      const tn = classified.taskNotif!;
      const statusIcon = tn.status === 'completed' ? '✓' : tn.status === 'failed' ? '✗' : '⟳';
      const statusCls = tn.status === 'completed' ? 'notif-ok' : tn.status === 'failed' ? 'notif-err' : 'notif-pending';
      const title = tn.commandName || 'Background command';
      const shortId = tn.taskId ? tn.taskId.slice(0, 8) : '';
      const idBadge = shortId ? `<span class="notif-task-id">${esc(shortId)}</span>` : '';
      const statusBadge = `<span class="notif-status-badge ${statusCls}">${statusIcon} ${esc(tn.status || 'running')}</span>`;
      const exitBadge = tn.exitCode ? `<span class="notif-exit-code">exit ${esc(tn.exitCode)}</span>` : '';
      const loadBtn = tn.outputFile
        ? `<button class="notif-load-btn" onclick="event.stopPropagation();loadTaskOutput(this,'${escAttr(tn.outputFile)}')" title="Load output from file">Load result</button>`
        : '';
      const MAX_CMD_LEN = 120;
      const cmdText = tn.fullCommand
        ? (tn.fullCommand.length > MAX_CMD_LEN ? tn.fullCommand.slice(0, MAX_CMD_LEN) + '…' : tn.fullCommand)
        : '';
      const cmdLine = cmdText ? `<div class="notif-command"><code>${esc(cmdText)}</code></div>` : '';
      return `<div class="conv-msg task-notification-msg ${statusCls}">`
        + `<div class="notif-header"><span class="notif-title">${esc(title)}</span>${idBadge}${statusBadge}${exitBadge}${timeHtml}</div>`
        + cmdLine
        + `<div class="notif-actions">${loadBtn}</div>`
        + `</div>`;
    }

    // Normal with cleaned text
    if (classified.type === 'normal' && classified.cleanText !== msg.text) {
      msg = { ...msg, text: classified.cleanText };
    }
  }

  const roleLabel = isCompact ? 'Compact' : (isUser ? 'User' : 'Assistant');
  const compactBadge = isCompact ? '<span class="conv-compact-badge">compacted</span>' : '';
  const modelHtml = msg.model ? `<span class="conv-model">${esc(msg.model)}</span>` : '';

  // Render text with full markdown
  const textRendered = formatMarkdown(esc(msg.text));

  // Check if text should be collapsible (trim trailing whitespace to avoid phantom "Show more")
  const lineCount = msg.text.trimEnd().split('\n').length;
  const textHtml = lineCount > CONV_TEXT_COLLAPSE_LINES + 2
    ? `<div class="conv-text collapsible" data-max-lines="${CONV_TEXT_COLLAPSE_LINES}" data-total-lines="${lineCount}"><div class="text-content" style="-webkit-line-clamp:${CONV_TEXT_COLLAPSE_LINES};display:-webkit-box;-webkit-box-orient:vertical">${textRendered}</div><div class="collapse-bar" onclick="expandMore(this)"><span class="collapse-label">Show more</span></div></div>`
    : `<div class="conv-text">${textRendered}</div>`;

  // Render thinking blocks (extended thinking)
  // Claude Code redacts thinking content in JSONL — only the block count is available.
  let thinkingHtml = '';
  if (!isUser && (msg.thinkingCount ?? 0) > 0) {
    if (msg.thinking && msg.thinking.length > 0) {
      // Content available (future-proofing)
      const thinkingContent = msg.thinking.map(t => `<pre class="thinking-content">${esc(t)}</pre>`).join('');
      const words = msg.thinking.join(' ').split(/\s+/).length;
      thinkingHtml = `<details class="conv-thinking"><summary class="conv-thinking-label"><span class="thinking-icon">⟳</span> Thinking <span class="thinking-word-count">${words} words</span></summary>${thinkingContent}</details>`;
    } else {
      // Content redacted — show indicator only
      thinkingHtml = `<div class="conv-thinking-indicator"><span class="thinking-icon">⟳</span> Extended thinking</div>`;
    }
  }

  // Render tool blocks with full detail
  let toolsHtml = '';
  if (msg.toolBlocks && msg.toolBlocks.length > 0) {
    toolsHtml = `<div class="conv-tools-detail">${groupAndRenderConvTools(msg.toolBlocks, msg.timestamp)}</div>`;
  }

  // Token counter footer for assistant messages
  // Only show on the final message of a turn (output_tokens > 0).
  // Streaming/parallel partial chunks have output_tokens === 0 and would show duplicate counts.
  let tokenHtml = '';
  if (!isUser && msg.tokenUsage && msg.tokenUsage.output > 0) {
    const u = msg.tokenUsage;
    const fmtK = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
    const parts: string[] = [];
    if (u.input > 0) parts.push(`${fmtK(u.input)} new`);
    if (u.cacheRead > 0) parts.push(`<span class="token-cache-read" title="Cache read">${fmtK(u.cacheRead)} cached</span>`);
    if (u.cacheCreate > 0) parts.push(`<span class="token-cache-write" title="Cache write (new cache)">${fmtK(u.cacheCreate)} saved</span>`);
    parts.push(`${fmtK(u.output)} out`);
    tokenHtml = `<div class="conv-token-footer">${parts.join(' <span style="opacity:0.4">·</span> ')}</div>`;
  }

  const msgCls = isCompact ? 'user compact' : (isUser ? 'user' : 'assistant');
  const contCls = isContinuation ? ' continuation' : '';
  const headerHtml = isContinuation
    ? '' // No role header for continuation messages — timestamp on hover via title attr
    : `<div class="conv-role">${roleLabel}${compactBadge}${modelHtml}${timeHtml}</div>`;
  return `<div class="conv-msg ${msgCls}${contCls}"${timeTitle}>${headerHtml}${thinkingHtml}${textHtml}${toolsHtml}${tokenHtml}</div>`;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

/** Serialize conversation messages to pre-rendered HTML strings */
export function serializeConversation(messages: ConversationMessage[]): string[] {
  // Build a map from backgroundCommand commandId → full command string
  // so task-notification messages can display the actual command that was run.
  const bgCommandMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.toolBlocks) {
      for (const tb of msg.toolBlocks) {
        if (tb.backgroundCommand?.commandId && typeof tb.input.command === 'string') {
          bgCommandMap.set(tb.backgroundCommand.commandId, tb.input.command);
        }
      }
    }
  }

  let prevRole = '';
  return messages.map((m, i) => {
    let html = renderConvMessageHtml(m, prevRole, bgCommandMap);
    // Inject data-midx onto the outermost element for scroll-to-message
    if (html) html = html.replace(/^(<\w+\s)/, `$1data-midx="${i}" `);
    // Only update prevRole for normal user/assistant messages — special types
    // (task-notification, compaction, context-summary, etc.) should not break grouping
    if (html && !isSpecialMessageHtml(html)) prevRole = m.role;
    return html;
  });
}

function isSpecialMessageHtml(html: string): boolean {
  return html.includes('task-notification-msg')
    || html.includes('compaction-msg')
    || html.includes('context-summary-msg')
    || html.includes('interrupted')
    || html.includes('command-msg')
    || html.includes('stdout-msg');
}

// Per-task render cache to avoid re-rendering unchanged blocks
interface TaskRenderCache {
  blockCount: number;
  visibleLimit: number;
  blocksHtml: string;
  searchText: string;
}
const taskRenderCache = new Map<string, TaskRenderCache>();

/** Clear the render cache (used in tests) */
export function clearTaskRenderCache(): void {
  taskRenderCache.clear();
}

const DEFAULT_VISIBLE_BLOCKS = 50;
const LOAD_MORE_INCREMENT = 50;

// Per-task expanded block limits (grows when user clicks "Load more")
const expandedLimits = new Map<string, number>();

export function expandBlockLimit(agentId: string): void {
  const current = expandedLimits.get(agentId) ?? DEFAULT_VISIBLE_BLOCKS;
  expandedLimits.set(agentId, current + LOAD_MORE_INCREMENT);
}

/** Serialize a task to a JSON-safe data object for the webview */
export function serializeTask(task: AgentTask, descOverride?: string, sessionLabel?: string): SerializedTask {
  const blocks = task.contentBlocks;
  const limit = expandedLimits.get(task.agentId) ?? DEFAULT_VISIBLE_BLOCKS;
  const visibleStart = Math.max(0, blocks.length - limit);
  const hiddenCount = visibleStart;

  // Check render cache — reuse blocksHtml and searchText if blocks and limit unchanged
  const cached = taskRenderCache.get(task.agentId);
  let blocksHtml: string;
  let searchText: string;

  if (cached && cached.blockCount === blocks.length && cached.visibleLimit === limit) {
    blocksHtml = cached.blocksHtml;
    searchText = cached.searchText;
  } else {
    // Build searchable text from all blocks
    const searchParts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text') searchParts.push(b.text.slice(0, 500));
      else if (b.type === 'tool_use') searchParts.push(b.name + ' ' + formatToolInput(b.name, b.input).slice(0, 200));
      else if (b.type === 'tool_result' && b.isError) searchParts.push(b.content.slice(0, 300));
      if (searchParts.join('').length > 3000) break;
    }
    searchText = searchParts.join(' ').slice(0, 3000);

    // Render blocks with tool_use + tool_result grouping
    const visibleBlocks = blocks.slice(visibleStart);
    const grouped = renderBlockGroup(visibleBlocks, visibleStart);
    let blockIdx = visibleStart;
    blocksHtml = grouped
      .map(g => {
        const idx = blockIdx;
        blockIdx += g.consumed;
        const pendingWrap = g.html.includes('data-pending="1"') ? ' data-pending="1"' : '';
        return `<div class="block-wrapper" data-block-idx="${idx}" data-block-count="${g.consumed}"${pendingWrap}>${g.html}</div>`;
      })
      .join('');

    taskRenderCache.set(task.agentId, { blockCount: blocks.length, visibleLimit: limit, blocksHtml, searchText });
  }

  return {
    agentId: task.agentId,
    sessionId: task.sessionId,
    status: task.status,
    description: descOverride || task.description || task.agentId.slice(0, 12),
    prompt: task.prompt || undefined,
    model: task.model ? task.model.replace('claude-', '') : undefined,
    startedAt: task.startedAt,
    lastActivity: task.lastActivity,
    sessionLabel,
    hiddenCount,
    blockCount: blocks.length,
    blocksHtml,
    searchText,
    tokenUsage: task.tokenUsage,
    lastActivitySummary: task.status === 'running' ? getAgentLastActivity(task) : undefined,
    activeState: task.activeState,
  };
}

export function renderSessionChips(panel: Pick<PanelInfo, 'sessions' | 'conversationSessionId'>): string {
  const sessionCount = panel.sessions.length;
  if (sessionCount <= 1) return '';
  const convSessionId = panel.conversationSessionId ?? panel.sessions[0]?.id;
  const chipLabel = (s: SessionInfo) => {
    const name = s.displayName;
    const label = name.length <= 20 ? name : s.id.slice(0, 10);
    return s.agentCount ? `${label} · ${s.agentCount}` : label;
  };
  return `<div class="session-chips">
      ${panel.sessions.map(s => {
        const isActive = s.id === convSessionId;
        return `<button class="session-chip${isActive ? ' active' : ''}" data-session-id="${s.id}" onclick="vscode.postMessage({command:&#39;switchConversation&#39;,sessionId:&#39;${s.id}&#39;})" title="${esc(s.displayName)}">${esc(chipLabel(s))}</button>`;
      }).join('')}
    </div>`;
}

export function renderToolbar(panel: PanelInfo): string {
  const wsLabel = shortenPath(panel.workspace) ?? 'auto';
  const sessionLabels = panel.sessions.length > 0
    ? panel.sessions.map(s => s.displayName).join(', ')
    : 'auto (latest)';
  const sessionCount = panel.sessions.length;

  return `<div class="toolbar">
    <div class="toolbar-row">
      <button class="toolbar-btn workspace-btn" onclick="vscode.postMessage({command:'selectWorkspace'})" title="Change workspace">
        ${FOLDER_ICON}
        <span class="toolbar-label">${esc(wsLabel)}</span>
      </button>
      ${panel.isOverride ? '<button class="toolbar-reset" onclick="vscode.postMessage({command:&apos;clearOverrides&apos;})" title="Reset to auto">×</button>' : ''}
    </div>
    <div class="toolbar-row">
      <button class="toolbar-btn session-btn" onclick="vscode.postMessage({command:'selectSession'})" title="Select sessions">
        <span class="toolbar-label">${esc(sessionLabels)}</span>
        ${sessionCount > 1 ? `<span class="toolbar-badge">${sessionCount}</span>` : ''}
      </button>
      ${panel.sessions.length > 0 ? `<button class="toolbar-copy-sessions" onclick="vscode.postMessage({command:&#39;copyToClipboard&#39;,text:&#39;${panel.sessions.map(s => s.id).join('\\n').replace(/'/g, '&#39;')}&#39;})" title="Copy session IDs">${COPY_ICON}</button>` : ''}
    </div>
    <div id="sessionChipsContainer">${renderSessionChips(panel)}</div>
  </div>`;
}
