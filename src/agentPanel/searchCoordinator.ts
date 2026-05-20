import * as path from 'path';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { pathToProjectKey } from '../agentParser';
import { renderConvMessageHtml } from '../agentWebview';
import type { WebviewPoster, PanelLogger } from './types';

/**
 * Manages the Worker thread for cross-session search, including caching,
 * incremental result streaming, and lifecycle management.
 */
export class SearchCoordinator {
  private _searchSeq = 0;
  private _searchWorker?: Worker;
  private _searchResults: unknown[] = [];
  private _searchFlushed = 0;
  private _searchT0 = 0;

  // Search result cache — keyed by "query|scope|case|word", invalidated on file changes
  private _searchCache = new Map<string, { results: unknown[]; ts: number }>();
  private _searchCacheGeneration = 0; // bumped on file changes to invalidate all entries

  private _lastSearchQuery = '';
  private _lastSearchCacheKey = '';

  constructor(
    private readonly _poster: WebviewPoster,
    private readonly _logger: PanelLogger,
    private readonly _getEffectiveWorkspacePath: () => string | undefined,
    private readonly _getCurrentSessionIds: () => ReadonlySet<string>,
    private readonly _getDisplayNameCache: () => Map<string, string>,
  ) {}

  private _searchCacheKey(query: string, scope: string, matchCase: boolean, matchWholeWord: boolean): string {
    return `${query}|${scope}|${matchCase ? '1' : '0'}|${matchWholeWord ? '1' : '0'}`;
  }

  /** Call when session files change to invalidate search cache */
  invalidateSearchCache() {
    this._searchCacheGeneration++;
    this._searchCache.clear();
  }

  private _ensureSearchWorker(): Worker {
    if (this._searchWorker) return this._searchWorker;

    const worker = new Worker(path.join(__dirname, 'searchWorker.js'));
    this._searchWorker = worker;

    const postMsg = (msg: Record<string, unknown>) => {
      this._poster.postToAll(msg);
    };

    worker.on('message', (msg: { type: string; seq?: number; data?: unknown; message?: string }) => {
      // Ignore messages from stale searches
      if (msg.seq !== undefined && msg.seq !== this._searchSeq) return;

      if (msg.type === 'result') {
        const data = msg.data as Record<string, unknown>;
        if (data.richText) {
          const richMsg: import('../agentParser').ConversationMessage = {
            role: ((data.role as string) || 'user') as 'user' | 'assistant',
            text: data.richText as string,
            timestamp: data.timestamp as string | undefined,
            model: data.model as string | undefined,
          };
          data.richHtml = renderConvMessageHtml(richMsg);
        }
        this._searchResults.push(data);
      } else if (msg.type === 'flush') {
        // Send only new results since last flush (incremental)
        const newResults = this._searchResults.slice(this._searchFlushed);
        this._searchFlushed = this._searchResults.length;
        if (newResults.length > 0) {
          postMsg({ command: 'searchResults', results: newResults, query: this._lastSearchQuery, streaming: true, incremental: true });
        }
      } else if (msg.type === 'done') {
        this._logger.log(`search: "${this._lastSearchQuery}" found ${this._searchResults.length} results in ${Date.now() - this._searchT0}ms`);
        // Cache results (keep max 10 entries, evict oldest)
        if (this._lastSearchCacheKey) {
          if (this._searchCache.size >= 10) {
            const oldest = this._searchCache.keys().next().value;
            if (oldest !== undefined) this._searchCache.delete(oldest);
          }
          this._searchCache.set(this._lastSearchCacheKey, { results: [...this._searchResults], ts: Date.now() });
        }
        // Final: send any remaining unflushed results
        const remaining = this._searchResults.slice(this._searchFlushed);
        if (remaining.length > 0) {
          postMsg({ command: 'searchResults', results: remaining, query: this._lastSearchQuery, streaming: false, incremental: true });
        } else {
          postMsg({ command: 'searchResults', results: [], query: this._lastSearchQuery, streaming: false, incremental: true });
        }
      } else if (msg.type === 'error') {
        this._logger.log(`search worker error: ${msg.message}`);
        const remaining = this._searchResults.slice(this._searchFlushed);
        postMsg({ command: 'searchResults', results: remaining, query: this._lastSearchQuery, streaming: false, incremental: true });
      }
    });

    worker.on('error', (err) => {
      this._logger.log(`search worker crashed: ${err}`);
      this._searchWorker = undefined;
      postMsg({ command: 'searchResults', results: this._searchResults, query: this._lastSearchQuery, streaming: false });
    });

    worker.on('exit', () => {
      this._searchWorker = undefined;
    });

    return worker;
  }

  handleSearch(query: string, scope: string, matchCase = false, matchWholeWord = false) {
    if (!query || query.length < 2) return;

    const postMsg = (msg: Record<string, unknown>) => {
      this._poster.postToAll(msg);
    };

    // Check cache first
    const cacheKey = this._searchCacheKey(query, scope, matchCase, matchWholeWord);
    const cached = this._searchCache.get(cacheKey);
    if (cached) {
      this._logger.log(`search: cache hit for "${query}" (${cached.results.length} results)`);
      ++this._searchSeq; // still bump seq to cancel any in-flight search
      postMsg({ command: 'searchStatus', status: 'searching', query });
      postMsg({ command: 'searchResults', results: cached.results, query, streaming: false, incremental: false });
      return;
    }

    const seq = ++this._searchSeq;
    this._lastSearchQuery = query;
    this._lastSearchCacheKey = cacheKey;
    this._searchResults = [];
    this._searchFlushed = 0;
    this._searchT0 = Date.now();

    postMsg({ command: 'searchStatus', status: 'searching', query });

    const currentWorkspace = this._getEffectiveWorkspacePath();
    const currentKey = currentWorkspace ? pathToProjectKey(currentWorkspace) : null;
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');

    const displayNameCache: Record<string, string> = {};
    for (const [k, v] of this._getDisplayNameCache()) displayNameCache[k] = v;

    try {
      const worker = this._ensureSearchWorker();
      worker.postMessage({
        seq,
        query,
        scope,
        claudeDir,
        currentKey,
        currentSessionIds: [...this._getCurrentSessionIds()],
        displayNameCache,
        maxResults: 200,
        matchCase,
        matchWholeWord,
      });
    } catch (e) {
      this._logger.log(`search: failed to start search: ${e}`);
      postMsg({ command: 'searchResults', results: [], query, streaming: false });
    }
  }

  terminate() {
    if (this._searchWorker) {
      this._searchWorker.terminate();
      this._searchWorker = undefined;
    }
  }
}
