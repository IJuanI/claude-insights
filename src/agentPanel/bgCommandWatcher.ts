import * as fs from 'fs';
import { ConversationMessage } from '../agentParser';
import type { WebviewPoster, PanelLogger } from './types';

/**
 * Manages background command output file watching — tracks bg commands
 * from conversation tool blocks, watches their output files, and streams
 * updates to the webview.
 */
export class BgCommandWatcher {
  private _bgCommandWatchers = new Map<string, fs.FSWatcher>();
  private _bgCommandPolls = new Map<string, ReturnType<typeof setInterval>>();
  private _bgCommandLastSize = new Map<string, number>();
  private _bgCommandComplete = new Set<string>();
  private _bgCommandPaths = new Map<string, string>();

  constructor(
    private readonly _poster: WebviewPoster,
    private readonly _logger: PanelLogger,
    private readonly _onRefresh: () => void,
  ) {}

  get completeSet(): ReadonlySet<string> {
    return this._bgCommandComplete;
  }

  getCompleteSerialized(): string[] {
    return [...this._bgCommandComplete];
  }

  markComplete(commandId: string) {
    this._bgCommandComplete.add(commandId);
  }

  watchConversationBgCommands(messages: ConversationMessage[]) {
    // First pass: detect completed bg commands from task-notification messages
    const completedRe = /<task-notification>[\s\S]*?<task-id>(\w+)<\/task-id>[\s\S]*?<status>completed<\/status>[\s\S]*?<\/task-notification>/g;
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      let m: RegExpExecArray | null;
      while ((m = completedRe.exec(msg.text)) !== null) {
        this._bgCommandComplete.add(m[1]);
      }
    }

    // Second pass: watch bg commands that aren't already complete
    // If the output file's parent directory doesn't exist (e.g., /tmp cleaned on reboot),
    // mark as complete immediately. Otherwise, start a watcher.
    for (const msg of messages) {
      if (!msg.toolBlocks) continue;
      for (const tb of msg.toolBlocks) {
        if (tb.backgroundCommand) {
          const { commandId, outputPath } = tb.backgroundCommand;
          this._bgCommandPaths.set(commandId, outputPath); // always store path for flush
          if (this._bgCommandComplete.has(commandId)) continue;
          // Always delegate to watchBgCommand — it handles missing dirs with retries
          // and marks complete only after 10s if the file never appears (e.g. /tmp cleaned)
          this.watchBgCommand(commandId, outputPath);
        }
      }
    }
  }

  watchBgCommand(commandId: string, outputPath: string) {
    if (this._bgCommandWatchers.has(commandId)) return;
    this._bgCommandPaths.set(commandId, outputPath);
    if (!fs.existsSync(outputPath)) {
      // File may not exist yet — retry up to 10 times (every 1s)
      let retries = 0;
      const retryTimer = setInterval(() => {
        retries++;
        if (fs.existsSync(outputPath)) {
          clearInterval(retryTimer);
          this.watchBgCommand(commandId, outputPath);
        } else if (retries >= 10) {
          clearInterval(retryTimer);
          this._logger.log(`[BgCmd] Output file never appeared, marking complete: ${outputPath}`);
          this._bgCommandComplete.add(commandId);
          this._onRefresh();
        }
      }, 1000);
      return;
    }

    let debounce: ReturnType<typeof setTimeout> | null = null;
    let staleCount = 0;

    const sendOutput = () => {
      try {
        const stat = fs.statSync(outputPath);
        const prevSize = this._bgCommandLastSize.get(commandId) ?? 0;

        // Check if task was marked complete by conversation (task-notification)
        const isComplete = this._bgCommandComplete.has(commandId);

        if (stat.size === prevSize) {
          staleCount++;
          // Auto-complete if: explicitly marked done, OR file hasn't changed for 5+ min
          const fileStaleSec = (Date.now() - stat.mtimeMs) / 1000;
          if (isComplete || fileStaleSec > 300) {
            this._postBgOutput(commandId, this._readBgTail(outputPath), true);
            this._stopBgWatch(commandId);
          }
          return;
        }

        staleCount = 0;
        this._bgCommandLastSize.set(commandId, stat.size);
        const content = this._readBgTail(outputPath);
        this._postBgOutput(commandId, content, isComplete);
        if (isComplete) this._stopBgWatch(commandId);
      } catch {
        this._stopBgWatch(commandId);
      }
    };

    try {
      const watcher = fs.watch(outputPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(sendOutput, 500);
      });
      this._bgCommandWatchers.set(commandId, watcher);

      // Poll every 10s as stale-file recovery fallback (fs.watch covers normal updates)
      const poll = setInterval(() => {
        if (!this._bgCommandWatchers.has(commandId)) {
          clearInterval(poll);
          return;
        }
        sendOutput();
      }, 10000);
      this._bgCommandPolls.set(commandId, poll);

      // Initial read
      sendOutput();
      this._logger.log(`[BgCmd] Watching ${commandId}: ${outputPath}`);
    } catch (e) {
      this._logger.log(`[BgCmd] Failed to watch ${outputPath}: ${e}`);
    }
  }

  readBgTail(outputPath: string): string {
    return this._readBgTail(outputPath);
  }

  private _readBgTail(outputPath: string): string {
    try {
      const MAX_TAIL = 32768;
      const stat = fs.statSync(outputPath);
      const fd = fs.openSync(outputPath, 'r');
      const offset = Math.max(0, stat.size - MAX_TAIL);
      const buf = Buffer.alloc(Math.min(MAX_TAIL, stat.size));
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const text = buf.toString('utf-8');
      const raw = offset > 0 ? '... (truncated)\n' + text : text;

      // Detect JSONL agent session file by scanning the first valid JSON line
      // (can't just check raw[0] — tailed files start with "... (truncated)\n")
      const isAgentJsonl = raw.split('\n').slice(0, 5).some(line => {
        const t = line.trim();
        return t.startsWith('{"parentUuid":') || t.startsWith('{"type":"') || t.startsWith('{"uuid":');
      });
      if (isAgentJsonl) {
        return this._parseAgentJsonl(raw);
      }
      return raw;
    } catch {
      return '';
    }
  }

  private _parseAgentJsonl(text: string): string {
    const lines = text.split('\n').filter(Boolean);
    let prompt = '';
    // Collect all non-duplicate assistant text blocks in order
    const textBlocks: string[] = [];
    const seenBlocks = new Set<string>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && !prompt) {
          const content = entry.message?.content;
          if (typeof content === 'string') prompt = content;
          else if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === 'text' && b.text) { prompt = b.text; break; }
            }
          }
        } else if (entry.type === 'assistant') {
          const content = entry.message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === 'text' && b.text?.trim()) {
                const t = b.text.trim();
                if (!seenBlocks.has(t)) {
                  seenBlocks.add(t);
                  textBlocks.push(t);
                }
              }
            }
          }
        }
      } catch {}
    }

    const parts: string[] = [];
    if (prompt) {
      const p = prompt.trim();
      parts.push('Prompt:\n' + p.slice(0, 400) + (p.length > 400 ? '…' : ''));
    }
    if (textBlocks.length > 0) {
      // Show last block as primary result; if there were multiple, note the count
      const last = textBlocks[textBlocks.length - 1];
      const prefix = textBlocks.length > 1 ? `Result (step ${textBlocks.length}):\n` : 'Result:\n';
      parts.push(prefix + last.slice(0, 1200) + (last.length > 1200 ? '…' : ''));
    } else {
      parts.push('(agent running — no text output yet)');
    }
    return parts.join('\n\n---\n\n');
  }

  private _postBgOutput(commandId: string, output: string, isComplete: boolean) {
    if (isComplete) this._bgCommandComplete.add(commandId);
    const msg = { command: 'bgCommandOutput', commandId, output, isComplete };
    this._poster.postToAll(msg);
  }

  private _stopBgWatch(commandId: string) {
    const watcher = this._bgCommandWatchers.get(commandId);
    if (watcher) {
      watcher.close();
      this._bgCommandWatchers.delete(commandId);
    }
    const poll = this._bgCommandPolls.get(commandId);
    if (poll) {
      clearInterval(poll);
      this._bgCommandPolls.delete(commandId);
    }
    this._bgCommandLastSize.delete(commandId);
  }

  /** Re-send current content for all active bg watchers after a DOM rebuild. */
  flushBgOutputs() {
    for (const [commandId, ] of this._bgCommandWatchers) {
      const outputPath = this._bgCommandPaths.get(commandId);
      if (!outputPath) continue;
      const content = this._readBgTail(outputPath);
      const isComplete = this._bgCommandComplete.has(commandId);
      this._postBgOutput(commandId, content, isComplete);
    }
    // Also send completed commands that have output (watcher already stopped)
    for (const commandId of this._bgCommandComplete) {
      if (this._bgCommandWatchers.has(commandId)) continue; // already handled above
      const outputPath = this._bgCommandPaths.get(commandId);
      if (!outputPath) continue;
      const content = this._readBgTail(outputPath);
      if (content) this._postBgOutput(commandId, content, true);
    }
  }

  resetWatchers() {
    for (const [id] of this._bgCommandWatchers) this._stopBgWatch(id);
    this._bgCommandComplete.clear();
    this._bgCommandPaths.clear();
  }

  dispose() {
    for (const [id] of this._bgCommandWatchers) this._stopBgWatch(id);
  }
}
