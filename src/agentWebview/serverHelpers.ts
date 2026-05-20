import { ContentBlock, ToolResultBlock, ConvToolBlock, BackgroundCommand } from '../agentParser';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


export function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function shortenPath(p?: string): string | undefined {
  if (!p) return undefined;
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

export function timeAgo(ts: string): string {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return (input['command'] as string) ?? JSON.stringify(input, null, 2);
    case 'Read':
      return (input['file_path'] as string) ?? JSON.stringify(input, null, 2);
    case 'Write':
    case 'Edit':
      return (input['file_path'] as string) ?? JSON.stringify(input, null, 2);
    case 'Grep':
      return `${input['pattern'] ?? ''} ${input['path'] ?? ''}`.trim() || JSON.stringify(input, null, 2);
    case 'Glob':
      return `${input['pattern'] ?? ''} ${input['path'] ?? ''}`.trim() || JSON.stringify(input, null, 2);
    case 'Agent':
      return (input['description'] as string) ?? (input['prompt'] as string)?.slice(0, 200) ?? JSON.stringify(input, null, 2);
    case 'WebSearch':
      return (input['query'] as string) ?? JSON.stringify(input, null, 2);
    case 'WebFetch':
      return (input['url'] as string) ?? JSON.stringify(input, null, 2);
    case 'TodoWrite': {
      const todos = input['todos'] as Array<Record<string, unknown>> | undefined;
      if (todos && Array.isArray(todos)) {
        return todos.map(t => {
          const status = t['status'] as string || '?';
          const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '◉' : '○';
          const content = (t['content'] as string) || '';
          return icon + ' ' + content;
        }).join('\n');
      }
      return JSON.stringify(input, null, 2);
    }
    default: {
      // For unknown tools, try common field names before falling back to JSON
      const desc = (input['description'] as string) ?? (input['query'] as string) ?? (input['prompt'] as string);
      if (desc) return desc;
      return JSON.stringify(input, null, 2);
    }
  }
}

export function formatMarkdown(text: string): string {
  // Extract code blocks first to protect them from other transformations
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="codeblock">${code}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Inline code (protect from other transforms)
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${idx}\x00`;
  });

  result = result.replace(/^---$/gm, '<hr class="md-hr">');
  result = result.replace(/^#{4}\s+(.+)$/gm, '<div class="md-h4">$1</div>');
  result = result.replace(/^#{3}\s+(.+)$/gm, '<div class="md-h3">$1</div>');
  result = result.replace(/^#{2}\s+(.+)$/gm, '<div class="md-h2">$1</div>');
  result = result.replace(/^#{1}\s+(.+)$/gm, '<div class="md-h1">$1</div>');
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  result = result.replace(/^[-*]\s+(.+)$/gm, '<div class="md-li">\u2022 $1</div>');
  result = result.replace(/^(\d+)\.\s+(.+)$/gm, (_m, num, content) => {
    return `<div class="md-li"><span class="md-ol-num">${num}.</span> ${content}</div>`;
  });
  result = result.replace(/((?:^\|.+\|$(?:\n|$))+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length === 0) return tableBlock;
    // Parse all data rows (skip separator rows)
    const dataRows: string[][] = [];
    for (const row of rows) {
      if (/^\|[\s\-:|\u2014]+$/.test(row)) continue;
      dataRows.push(row.split('|').filter(Boolean).map((c: string) => c.trim()));
    }
    if (dataRows.length === 0) return tableBlock;
    const colCount = dataRows[0].length;
    // Compute max char width per column to set proportional grid columns
    const colMaxLen = new Array(colCount).fill(0);
    for (const cells of dataRows) {
      for (let c = 0; c < colCount && c < cells.length; c++) {
        colMaxLen[c] = Math.max(colMaxLen[c], cells[c].length);
      }
    }
    // Use minmax with proportional fr units based on content width
    const gridCols = colMaxLen.map(len => `minmax(60px, ${Math.max(len, 4)}fr)`).join(' ');
    let html = `<div class="md-table" style="grid-template-columns: ${gridCols}">`;
    let isFirst = true;
    for (const cells of dataRows) {
      const cls = isFirst ? 'md-th' : 'md-td';
      html += '<div class="md-table-row' + (isFirst ? ' md-header-row' : '') + '">' +
        cells.map((c: string) => `<span class="${cls}">${c}</span>`).join('') + '</div>';
      isFirst = false;
    }
    html += '</div>';
    return html;
  });

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" title="$2">$1</a>');

  result = result.replace(/\n/g, '<br>');
  result = result.replace(/<br>\s*(<(?:pre|div|hr))/g, '$1');
  result = result.replace(/(<\/(?:pre|div)>)\s*<br>/g, '$1');

  // Restore inline codes and code blocks
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

  return result;
}

export const COLLAPSE_LINE_THRESHOLD = 10;

/** Tool icon based on tool name — monochrome text/SVG only for consistency */
export function toolIcon(name: string): string {
  switch (name) {
    case 'Bash': return '›_';
    case 'Read': return '⊞';
    case 'Write': case 'Edit': return '✏';
    case 'Grep': return '⊕';
    case 'Glob': return '⊟';
    case 'Agent': return '⊛';
    case 'WebSearch': return '⊙';
    case 'WebFetch': return '⊙';
    case 'TodoWrite': return '☑';
    default: return '⚙';
  }
}

/** Check if a Bash command is a find/fd command */
export function isFindCommand(input: Record<string, unknown>): boolean {
  const cmd = (input['command'] as string) ?? '';
  return /^\s*(find|fd)\s/.test(cmd);
}

/** Get the effective icon for a tool (with subtype detection) */
export function effectiveToolIcon(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && isFindCommand(input)) return '⊕';
  return toolIcon(name);
}

/** Compact preview of a tool input (up to 2 lines for Bash) */
export function compactToolPreview(name: string, input: Record<string, unknown>): string {
  const raw = formatToolInput(name, input);
  if (name === 'Bash') {
    // Allow up to 2 lines for bash commands
    const lines = raw.split('\n').filter(l => l.trim()).slice(0, 2);
    const preview = lines.join('\n');
    return preview.length > 240 ? preview.slice(0, 237) + '...' : preview;
  }
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
}

/** Short line count for success results (displayed inline with icon) */
export function compactResultLineCount(content: string): string {
  if (!content) return '';
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length <= 1) return '';
  return `${lines.length} lines`;
}

/** Compact preview of a tool result — errors show 2 lines, success shows line count only */
export function compactResultPreview(content: string, isError: boolean): string {
  if (!content) return isError ? 'Error (empty)' : '✓';
  const lines = content.split('\n').filter(l => l.trim());
  if (isError) {
    // Show up to 2 lines of error content
    const preview = lines.slice(0, 2).map(l => l.trim()).join('\n');
    const suffix = lines.length > 2 ? ` (+${lines.length - 2} lines)` : '';
    const truncated = preview.length > 200 ? preview.slice(0, 197) + '...' : preview;
    return truncated + suffix;
  }
  // Success: just show line count, no content preview
  if (lines.length === 0) return '✓';
  if (lines.length === 1) return `✓ ${lines.length} line`;
  return `✓ ${lines.length} lines`;
}

/** Format tool result for display — strips line number prefixes from Read output */
export function formatResultForDisplay(name: string, content: string): string {
  if (name === 'Read') {
    // Strip the "     N→" line number prefix that cat -n format produces
    return content.replace(/^\s*\d+→/gm, '');
  }
  return content;
}

/** Detect language from file path extension */
export function detectLang(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
    sh: 'sh', bash: 'sh', zsh: 'sh',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', xml: 'html', svg: 'html',
    sql: 'sql', md: 'md',
  };
  return ext ? map[ext] : undefined;
}

/** Replace regex matches only in text segments outside existing <span> tags */
export function replaceOutsideSpans(html: string, re: RegExp, replacement: string): string {
  // Split on span tags — match opening through closing, non-greedy on tag name
  const result: string[] = [];
  let cursor = 0;
  // Find each <span ...>...</span> and skip it
  const spanRe = /<span\b[^>]*>.*?<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = spanRe.exec(html)) !== null) {
    // Process text before this span
    if (m.index > cursor) {
      result.push(html.slice(cursor, m.index).replace(re, replacement));
    }
    result.push(m[0]); // Keep span as-is
    cursor = m.index + m[0].length;
  }
  // Process remaining text
  if (cursor < html.length) {
    result.push(html.slice(cursor).replace(re, replacement));
  }
  return result.join('');
}

/** Apply simple syntax highlighting to code — returns HTML with span classes */
export function highlightCode(code: string, lang: string): string {
  // First escape HTML
  let html = esc(code);

  // Comments (single-line)
  if (['ts', 'js', 'go', 'rs', 'java', 'css'].includes(lang)) {
    html = html.replace(/(\/\/.*?)(?=<br>|$)/gm, '<span class="hl-comment">$1</span>');
    // Block comments
    html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="hl-comment">$1</span>');
  } else if (['py', 'rb', 'sh', 'yaml'].includes(lang)) {
    html = html.replace(/(#.*?)(?=<br>|$)/gm, '<span class="hl-comment">$1</span>');
  } else if (lang === 'sql') {
    html = html.replace(/(--.*?)(?=<br>|$)/gm, '<span class="hl-comment">$1</span>');
  } else if (lang === 'html') {
    html = html.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="hl-comment">$1</span>');
  }

  // Strings (double and single quoted — simple, no nesting)
  html = html.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '<span class="hl-string">$1</span>');
  html = html.replace(/(&#39;(?:[^&]|&(?!#39;))*?&#39;)/g, '<span class="hl-string">$1</span>');
  // Backtick strings for JS/TS
  if (['ts', 'js'].includes(lang)) {
    html = html.replace(/(`[^`]*?`)/g, '<span class="hl-string">$1</span>');
  }

  // Numbers
  html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="hl-number">$1</span>');

  // Keywords by language
  let keywords: string[] = [];
  if (['ts', 'js'].includes(lang)) {
    keywords = ['import', 'export', 'from', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw', 'typeof', 'instanceof', 'interface', 'type', 'enum', 'implements', 'abstract', 'private', 'protected', 'public', 'readonly', 'static', 'default', 'switch', 'case', 'break', 'continue'];
  } else if (lang === 'py') {
    keywords = ['import', 'from', 'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'raise', 'with', 'as', 'pass', 'yield', 'lambda', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'self', 'async', 'await'];
  } else if (lang === 'go') {
    keywords = ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'struct', 'interface', 'type', 'var', 'const', 'map', 'chan', 'go', 'defer', 'select', 'nil', 'true', 'false'];
  } else if (lang === 'sql') {
    keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'NOT', 'NULL', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DISTINCT', 'UNION', 'EXISTS', 'IN', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];
  } else if (lang === 'sh') {
    keywords = ['if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly', 'set', 'unset', 'shift', 'true', 'false'];
  }

  if (keywords.length) {
    // SQL: case-insensitive
    const flags = lang === 'sql' ? 'gi' : 'g';
    const kwRe = new RegExp(`\\b(${keywords.join('|')})\\b`, flags);
    html = replaceOutsideSpans(html, kwRe, '<span class="hl-keyword">$1</span>');
  }

  // Decorators for TS/Py
  if (['ts', 'js', 'py'].includes(lang)) {
    html = replaceOutsideSpans(html, /@(\w+)/g, '<span class="hl-decorator">@$1</span>');
  }

  // HTML/XML tags
  if (lang === 'html') {
    html = replaceOutsideSpans(html, /(&lt;\/?)([\w-]+)/g, '$1<span class="hl-tag">$2</span>');
  }

  return html;
}

/** Format result HTML — syntax highlight for Read, tree view for Glob, grouped for Grep */
export function formatResultHtml(toolName: string, input: Record<string, unknown>, content: string, isError: boolean): string {
  if (isError) return esc(content);
  if (toolName === 'Glob') return formatGlobResult(content);
  if (toolName === 'Grep') return formatGrepResult(content, input);
  if (toolName === 'Read') {
    const filePath = (input['file_path'] as string) ?? '';
    const lang = detectLang(filePath);
    if (lang) return highlightCode(content, lang);
  }
  return esc(content);
}

/** Format Glob results as a tree view with relative paths */
export function formatGlobResult(content: string): string {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return esc(content);

  // Find common prefix (directory)
  const parts = lines.map(l => l.split('/'));
  let commonLen = 0;
  if (parts.length > 1) {
    outer: for (let i = 0; i < parts[0].length - 1; i++) {
      const seg = parts[0][i];
      for (let j = 1; j < parts.length; j++) {
        if (i >= parts[j].length - 1 || parts[j][i] !== seg) break outer;
      }
      commonLen = i + 1;
    }
  }

  const prefix = commonLen > 0 ? parts[0].slice(0, commonLen).join('/') + '/' : '';
  const relativePaths = lines.map(l => commonLen > 0 ? l.slice(prefix.length) : l);

  // Group by first directory segment for tree structure
  let html = '';
  if (prefix) {
    html += `<span class="hl-comment">${esc(shortenPath(prefix) ?? prefix)}</span>\n`;
  }

  // Simple tree: indent based on depth, show file name differently from dirs
  const seen = new Set<string>();
  for (const rel of relativePaths) {
    const segs = rel.split('/');
    // Show intermediate directory prefixes with tree markers
    let dirPath = '';
    for (let i = 0; i < segs.length - 1; i++) {
      dirPath += segs[i] + '/';
      if (!seen.has(dirPath)) {
        seen.add(dirPath);
        html += `${'  '.repeat(i)}<span class="hl-keyword">${esc(segs[i])}/</span>\n`;
      }
    }
    // File name
    const fileName = segs[segs.length - 1];
    const indent = '  '.repeat(segs.length - 1);
    html += `${indent}${esc(fileName)}\n`;
  }

  return html;
}

/** Format Grep results — highlight file paths and line numbers */
export function formatGrepResult(content: string, input: Record<string, unknown>): string {
  const lines = content.split('\n');
  const outputMode = (input['output_mode'] as string) ?? 'files_with_matches';

  if (outputMode === 'files_with_matches') {
    // File list — render like Glob tree view
    return formatGlobResult(content);
  }

  // Content mode: lines are typically "file:line:content" or just content
  const htmlLines: string[] = [];
  let lastFile = '';
  for (const line of lines) {
    if (!line.trim()) { htmlLines.push(''); continue; }
    // Match ripgrep output: file:linenum:content or file-linenum-content
    const match = line.match(/^(.+?)[:\-](\d+)[:\-](.*)$/);
    if (match) {
      const [, file, lineNum, code] = match;
      if (file !== lastFile) {
        // New file header
        htmlLines.push(`<span class="hl-comment">${esc(shortenPath(file) ?? file)}</span>`);
        lastFile = file;
      }
      htmlLines.push(`<span class="hl-number">${esc(lineNum)}</span>: ${esc(code)}`);
    } else {
      htmlLines.push(esc(line));
    }
  }
  return htmlLines.join('\n');
}

export const TRUNCATE_CHARS = 2000;
export const TRUNCATE_MAX_EMBED = 20000;
export let _expandId = 0;

/** Render a result with expandable truncation — shows first 2000 chars with a "Show more" button */
export function renderExpandableResult(toolName: string, input: Record<string, unknown>, content: string, isError: boolean): string {
  if (content.length <= TRUNCATE_CHARS) {
    return `<pre>${formatResultHtml(toolName, input, content, isError)}</pre>`;
  }

  const id = `exp-${_expandId++}`;
  const initial = content.slice(0, TRUNCATE_CHARS);
  const remaining = content.length - TRUNCATE_CHARS;

  // For content up to 20K, embed full highlighted HTML as base64 for client-side expansion
  // For larger content, just show what we have (the pre is scrollable)
  if (content.length <= TRUNCATE_MAX_EMBED) {
    const fullHtml = formatResultHtml(toolName, input, content, isError);
    const b64 = Buffer.from(fullHtml, 'utf-8').toString('base64');
    return `<pre id="${id}" data-shown="${TRUNCATE_CHARS}" data-full-len="${content.length}">${formatResultHtml(toolName, input, initial, isError)}</pre>` +
      `<button class="show-more-btn" data-target="${id}" data-full="${escAttr(b64)}"` +
      ` onclick="expandResult(this)">Show more (${formatCharCount(remaining)} remaining)</button>`;
  }

  // Large content: embed up to 10K and show approximate count
  return `<pre id="${id}">${formatResultHtml(toolName, input, content.slice(0, 10000), isError)}</pre>` +
    `<span class="show-more-btn" style="cursor:default;opacity:0.5">Showing first 10K of ${formatCharCount(content.length)}</span>`;
}

export function formatCharCount(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}K chars`;
}

export const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2zm2-2v2h2a2 2 0 0 1 2 2v2h2V2H6zM2 8v6h6V8H2z"/></svg>';

export const FOLDER_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 14h13a.5.5 0 0 0 .5-.5V4a.5.5 0 0 0-.5-.5H7.71a.5.5 0 0 1-.36-.15L5.86 1.85A.5.5 0 0 0 5.5 1.7H1.5a.5.5 0 0 0-.5.5v11.3a.5.5 0 0 0 .5.5z"/></svg>';
export const SEARCH_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>';
