import * as vscode from 'vscode';
import * as os from 'os';

export interface LogEntry {
  timestamp: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  source: string;
  category: string;
  message: string;
  data?: any;
}

export interface HealthCheckResult {
  name: string;
  status: 'ok' | 'warn' | 'critical';
  message: string;
  timestamp: string;
}

export interface DiagnosticExport {
  meta: {
    extensionVersion: string;
    vscodeVersion: string;
    os: string;
    uptime: number;
    timestamp: string;
    nodeVersion: string;
  };
  config: Record<string, unknown>;
  state: any;
  healthChecks: HealthCheckResult[];
  errors: LogEntry[];
  log: LogEntry[];
  fileSystem: any;
}

const RING_BUFFER_SIZE = 2000;
const EXPORT_LOG_LIMIT = 500;

export class DiagnosticLog {
  private buffer: LogEntry[] = [];
  private head = 0;
  private count = 0;
  private readonly startTime = Date.now();

  readonly onEntry: vscode.Event<LogEntry>;
  private readonly emitter = new vscode.EventEmitter<LogEntry>();

  private stateProvider: (() => any) | undefined;
  private fileSystemProvider: (() => any) | undefined;

  constructor(private readonly outputChannel: vscode.OutputChannel) {
    this.buffer = new Array(RING_BUFFER_SIZE);
    this.onEntry = this.emitter.event;
  }

  log(
    level: LogEntry['level'],
    source: string,
    category: string,
    message: string,
    data?: any,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      category,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % RING_BUFFER_SIZE;
    if (this.count < RING_BUFFER_SIZE) {
      this.count++;
    }

    const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    this.outputChannel.appendLine(
      `[${entry.timestamp}] [${level.toUpperCase().padEnd(5)}] [${source}/${category}] ${message}${dataStr}`,
    );

    this.emitter.fire(entry);
  }

  trace(source: string, category: string, message: string, data?: any): void {
    this.log('trace', source, category, message, data);
  }

  debug(source: string, category: string, message: string, data?: any): void {
    this.log('debug', source, category, message, data);
  }

  info(source: string, category: string, message: string, data?: any): void {
    this.log('info', source, category, message, data);
  }

  warn(source: string, category: string, message: string, data?: any): void {
    this.log('warn', source, category, message, data);
  }

  error(source: string, category: string, message: string, data?: any): void {
    this.log('error', source, category, message, data);
  }

  getEntries(filter?: {
    level?: LogEntry['level'];
    source?: string;
    category?: string;
    since?: string;
  }): LogEntry[] {
    const ordered = this.orderedEntries();
    if (!filter) return ordered;

    return ordered.filter((e) => {
      if (filter.level && e.level !== filter.level) return false;
      if (filter.source && e.source !== filter.source) return false;
      if (filter.category && e.category !== filter.category) return false;
      if (filter.since && e.timestamp <= filter.since) return false;
      return true;
    });
  }

  getEntriesSince(timestamp: string): LogEntry[] {
    return this.getEntries({ since: timestamp });
  }

  clear(): void {
    this.buffer = new Array(RING_BUFFER_SIZE);
    this.head = 0;
    this.count = 0;
  }

  setStateProvider(fn: () => any): void {
    this.stateProvider = fn;
  }

  setFileSystemProvider(fn: () => any): void {
    this.fileSystemProvider = fn;
  }

  exportAll(): DiagnosticExport {
    const config = vscode.workspace.getConfiguration('claudeCodeInsights');
    const configObj: Record<string, unknown> = {};
    for (const key of Object.keys(config)) {
      if (typeof config[key] !== 'function' && key !== 'has' && key !== 'get' && key !== 'update' && key !== 'inspect') {
        configObj[key] = config.get(key);
      }
    }

    const all = this.orderedEntries();
    const errors = all.filter((e) => e.level === 'error');
    const log = all.slice(-EXPORT_LOG_LIMIT);

    return {
      meta: {
        extensionVersion: vscode.extensions.getExtension('claude-code-insights')?.packageJSON?.version ?? 'unknown',
        vscodeVersion: vscode.version,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
      },
      config: configObj,
      state: this.stateProvider?.() ?? null,
      healthChecks: [],
      errors,
      log,
      fileSystem: this.fileSystemProvider?.() ?? null,
    };
  }

  private orderedEntries(): LogEntry[] {
    if (this.count < RING_BUFFER_SIZE) {
      return this.buffer.slice(0, this.count);
    }
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head),
    ];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export class HealthChecker {
  private results = new Map<string, HealthCheckResult>();
  private intervalHandle: NodeJS.Timeout | undefined;
  private stateProvider: (() => any) | undefined;

  private lastInitDataSent: number | undefined;
  private lastPongReceived: number | undefined;
  private lastPingSent: number | undefined;
  private expectedTaskCount: number | undefined;
  private registeredTaskCount: number | undefined;
  private watcherEvents = new Map<string, number>();
  private watcherCreated = new Map<string, number>();
  private hasActiveWatchers = false;

  constructor(private readonly log: DiagnosticLog) {}

  setStateProvider(fn: () => any): void {
    this.stateProvider = fn;
  }

  recordEvent(name: string): void {
    const now = Date.now();

    if (name === 'initDataSent') {
      this.lastInitDataSent = now;
      this.hasActiveWatchers = true;
    } else if (name === 'pongReceived') {
      this.lastPongReceived = now;
    } else if (name === 'pingSent') {
      this.lastPingSent = now;
    } else if (name.startsWith('watcherFired:')) {
      const path = name.slice('watcherFired:'.length);
      this.watcherEvents.set(path, now);
    } else if (name.startsWith('watcherCreated:')) {
      const path = name.slice('watcherCreated:'.length);
      this.watcherCreated.set(path, now);
      this.watcherEvents.set(path, now);
    } else if (name.startsWith('taskCount:')) {
      const parts = name.slice('taskCount:'.length).split('/');
      this.registeredTaskCount = parseInt(parts[0], 10);
      if (parts[1] !== undefined) {
        this.expectedTaskCount = parseInt(parts[1], 10);
      }
    } else if (name === 'watchersStopped') {
      this.hasActiveWatchers = false;
    }
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => this.runChecks(), 10_000);
    this.log.info('health', 'lifecycle', 'HealthChecker started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.log.info('health', 'lifecycle', 'HealthChecker stopped');
  }

  getResults(): HealthCheckResult[] {
    return Array.from(this.results.values());
  }

  private runChecks(): void {
    this.checkMessageFlow();
    this.checkWebviewResponsive();
    this.checkTaskCountSync();
    this.checkFileWatcherLiveness();

    const criticals = this.getResults().filter((r) => r.status === 'critical').length;
    const warns = this.getResults().filter((r) => r.status === 'warn').length;
    if (criticals > 0 || warns > 0) {
      this.log.warn('health', 'health', `Health check: ${criticals} critical, ${warns} warn`);
    }
  }

  private record(name: string, status: HealthCheckResult['status'], message: string): void {
    const result: HealthCheckResult = {
      name,
      status,
      message,
      timestamp: new Date().toISOString(),
    };
    this.results.set(name, result);
  }

  private checkMessageFlow(): void {
    if (!this.hasActiveWatchers || this.lastInitDataSent === undefined) {
      this.record('messageFlow', 'ok', 'No active watchers');
      return;
    }
    const age = (Date.now() - this.lastInitDataSent) / 1000;
    if (age > 15) {
      this.record('messageFlow', 'warn', `Last _sendInitData was ${Math.round(age)}s ago`);
    } else {
      this.record('messageFlow', 'ok', `Last _sendInitData was ${Math.round(age)}s ago`);
    }
  }

  private checkWebviewResponsive(): void {
    if (this.lastPingSent === undefined) {
      this.record('webviewResponsive', 'ok', 'No ping sent yet');
      return;
    }
    const sinceLastPong =
      this.lastPongReceived === undefined
        ? Date.now() - this.lastPingSent
        : Date.now() - this.lastPongReceived;
    const age = sinceLastPong / 1000;

    if (age > 30) {
      this.record('webviewResponsive', 'critical', `No pong for ${Math.round(age)}s`);
    } else if (age > 10) {
      this.record('webviewResponsive', 'warn', `No pong for ${Math.round(age)}s`);
    } else {
      this.record('webviewResponsive', 'ok', `Last pong ${Math.round(age)}s ago`);
    }
  }

  private checkTaskCountSync(): void {
    if (this.registeredTaskCount === undefined || this.expectedTaskCount === undefined) {
      this.record('taskCountSync', 'ok', 'Task counts not yet reported');
      return;
    }
    if (this.registeredTaskCount !== this.expectedTaskCount) {
      this.record(
        'taskCountSync',
        'warn',
        `Task count mismatch: registered=${this.registeredTaskCount}, expected=${this.expectedTaskCount}`,
      );
    } else {
      this.record('taskCountSync', 'ok', `Task count matches: ${this.registeredTaskCount}`);
    }
  }

  private checkFileWatcherLiveness(): void {
    if (this.watcherCreated.size === 0) {
      this.record('fileWatcherLiveness', 'ok', 'No watchers registered');
      return;
    }
    const now = Date.now();
    const stale: string[] = [];

    for (const [path, created] of this.watcherCreated) {
      const lastFired = this.watcherEvents.get(path) ?? created;
      const age = (now - lastFired) / 1000;
      if (age > 120) {
        stale.push(`${path} (${Math.round(age)}s)`);
      }
    }

    if (stale.length > 0) {
      this.record('fileWatcherLiveness', 'warn', `Stale watchers: ${stale.join(', ')}`);
    } else {
      this.record('fileWatcherLiveness', 'ok', `All ${this.watcherCreated.size} watcher(s) active`);
    }
  }

  dispose(): void {
    this.stop();
  }
}

export function createDiagnosticLog(outputChannel: vscode.OutputChannel): DiagnosticLog {
  return new DiagnosticLog(outputChannel);
}
