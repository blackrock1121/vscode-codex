import { randomUUID } from 'node:crypto';
import * as fs from "node:fs";
import * as path from "node:path";

const LOG_NAME = /^codex-chat-\d{4}-\d{2}-\d{2}\.log$/;

export function logDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 保留今天和之前六个本地日历日的插件日志，不触碰目录中的其它文件。 */
export async function pruneLogs(dir: string, now = new Date(), failure: (error: unknown) => void = () => {}): Promise<void> {
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const cutoff = `codex-chat-${logDay(oldest)}.log`;
  try {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (!LOG_NAME.test(name) || name >= cutoff || !entry.isFile()) continue;
      try {
        await fs.promises.unlink(path.join(dir, name));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure(error); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure(error); }
}

export interface LogIdentity { pluginVersion: string; windowId: string; hostId: string }
export interface LogFlushState {
  status: 'completed' | 'incomplete' | 'timeout'; pendingBytes: number; pendingLines: number;
  pendingWriters: number; failedWriters: number; droppedLines: number;
}

/** 预算只限制扫描前的等待；不能把超时或仍未写入的批次当作刷新成功。 */
export async function flushLogWriters(writers: DailyLogWriter[], budgetMs = 1500): Promise<LogFlushState> {
  let timer: NodeJS.Timeout | undefined, timedOut = false;
  try {
    await Promise.race([Promise.all(writers.map(async writer => {
      await writer.flush();
      if (!writer.healthSnapshot().failed) await writer.flush(); // 包含恢复健康记录。
    })), new Promise<void>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, budgetMs); })]);
  } finally { clearTimeout(timer); }
  const states = writers.map(writer => writer.healthSnapshot());
  const sum = (key: 'pendingBytes' | 'pendingLines' | 'droppedLines') => states.reduce((n, state) => n + state[key], 0);
  const pendingWriters = states.filter(state => state.pendingBytes || state.flushing || state.droppedLines).length;
  const failedWriters = states.filter(state => state.failed).length;
  return { status: timedOut ? 'timeout' : pendingWriters || failedWriters ? 'incomplete' : 'completed',
    pendingWriters, failedWriters, pendingBytes: sum('pendingBytes'), pendingLines: sum('pendingLines'), droppedLines: sum('droppedLines') };
}

export class DailyLogWriter {
  private pending = new Map<string, string[]>();
  private pendingBytes = 0;
  private dropped = 0;
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private closed = false;
  private latestDate = new Date();
  private prunedDay = "";
  private pruning?: Promise<void>;
  private readonly operationId = randomUUID();
  private writeFailures = 0;
  private inFlightBytes = 0;
  private inFlightLines = 0;
  private inFlightDropped = 0;
  private healthFailures = new Set<string>();
  private readonly identityPrefix: string;

  constructor(private readonly dir: string, identity?: LogIdentity, private readonly onBatch?: (text: string) => void,
    private readonly onHealth: (text: string) => void = text => console.warn(text)) {
    const safe = (value: string) => /^[\w.-]{1,160}$/.test(value) ? value : 'unknown';
    this.identityPrefix = identity ? `[pluginVersion=${safe(identity.pluginVersion)} windowId=${safe(identity.windowId)} hostId=${safe(identity.hostId)}] ` : '';
  }
  healthSnapshot() {
    return { pendingBytes: this.pendingBytes + this.inFlightBytes,
      pendingLines: [...this.pending.values()].reduce((n, rows) => n + rows.length, 0) + this.inFlightLines,
      flushing: !!this.flushing, failed: this.writeFailures > 0, droppedLines: this.dropped + this.inFlightDropped };
  }
  private health(operation: string, error?: unknown): void {
    if (error && this.healthFailures.has(operation)) return;
    if (!error && !this.healthFailures.has(operation)) return;
    if (error) this.healthFailures.add(operation); else this.healthFailures.delete(operation);
    const code = (error as NodeJS.ErrnoException)?.code;
    const line = `[logging] ${JSON.stringify({ atMs: Date.now(), operationId: this.operationId, operation, stage: error ? 'failed' : 'recovered',
      errorCode: typeof code === 'string' && /^E[A-Z0-9_]{1,32}$/.test(code) ? code : undefined })}`;
    // 不经过队列；磁盘不可写时也能在扩展宿主/输出通道看到故障，不递归写同一日志。
    try { this.onHealth(line); } catch { /* 最终反馈通道也可能已经关闭 */ }
    if (!this.closed) this.write(line);
  }

  async prune(now = new Date()): Promise<void> {
    if (this.pruning) return this.pruning;
    this.pruning = (async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        let failed = false;
        await pruneLogs(this.dir, now, error => { failed = true; this.health('prune', error); });
        if (!failed) this.health('prune');
      } catch (error) { this.health('prune', error); }
    })();
    try { await this.pruning; } finally { this.pruning = undefined; }
  }

  write(line: string, now = new Date()): void {
    if (this.closed) return;
    try {
      const day = logDay(now);
      const hh = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      const row = `[${hh}] ${this.identityPrefix}${line.slice(0, 32768)}${line.length > 32768 ? " [truncated]" : ""}\n`;
      const bytes = Buffer.byteLength(row);
      if (this.pendingBytes + bytes > 1024 * 1024) { this.dropped++; return; }
      const rows = this.pending.get(day) ?? []; rows.push(row); this.pending.set(day, rows);
      this.pendingBytes += bytes; this.latestDate = now;
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 200); this.timer.unref(); }
    } catch (error) { try { this.onHealth('[logging] enqueue_failed'); } catch { /* 不递归 */ } }
  }

  /** 有界队列 + 串行异步批量落盘，流式事件不再逐条阻塞扩展宿主。 */
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.flushing) {
      await this.flushing;
      // 失败批次由有界退避或下次显式刷新重试；并发等待者不能绕开退避递归刷盘。
      if (!this.writeFailures && (this.pending.size || this.dropped)) await this.flush();
      return;
    }
    if (!this.pending.size && !this.dropped) return;
    const batches = this.pending; this.inFlightBytes = this.pendingBytes; this.pending = new Map(); this.pendingBytes = 0;
    this.inFlightLines = [...batches.values()].reduce((n, rows) => n + rows.length, 0);
    const date = this.latestDate, dropped = this.dropped; this.inFlightDropped = dropped; this.dropped = 0;
    this.flushing = (async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        for (const [day, rows] of batches) {
          const text = rows.join('');
          await fs.promises.appendFile(path.join(this.dir, `codex-chat-${day}.log`), text, 'utf8');
          this.inFlightBytes -= Buffer.byteLength(text); this.inFlightLines -= rows.length;
          batches.delete(day); // 部分成功后重试不能把已落盘的日期重放。
          try { this.onBatch?.(text); this.health('output'); } catch (error) { this.health('output', error); }
        }
        // 丢弃汇总也必须有时间；否则带时间窗的诊断会把它排入 unknownTimeLines，
        // 从而在明明丢失日志时仍显示 droppedLines=0。保留旧格式兼容历史读取器。
        if (dropped) await fs.promises.appendFile(path.join(this.dir, `codex-chat-${logDay(date)}.log`), `[${new Date().toISOString()}] ${this.identityPrefix}[logging] droppedLines=${dropped} reason=buffer_or_write_limit\n`, 'utf8');
        this.writeFailures = 0; this.health('write');
        // 先完成跨天批次再清理，避免把过期批次重新创建出来。
        if (this.prunedDay !== logDay(date)) { await this.prune(date); this.prunedDay = logDay(date); }
      } catch (error) {
        // 保留未落盘批次并保持先后顺序；总内存仍有界，不等待下次业务日志才恢复。
        this.dropped += dropped;
        const newer = this.pending; this.pending = new Map(); this.pendingBytes = 0;
        for (const source of [batches, newer]) for (const [day, rows] of source) for (const row of rows) {
          const bytes = Buffer.byteLength(row);
          if (this.pendingBytes + bytes > 1024 * 1024) { this.dropped++; continue; }
          const list = this.pending.get(day) ?? []; list.push(row); this.pending.set(day, list); this.pendingBytes += bytes;
        }
        this.health('write', error);
        if (++this.writeFailures <= 3 && !this.closed && !this.timer) {
          this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000 * this.writeFailures); this.timer.unref();
        }
      }
    })();
    try { await this.flushing; } finally { this.flushing = undefined; this.inFlightBytes = 0; this.inFlightLines = 0; this.inFlightDropped = 0; }
  }
  async dispose(): Promise<void> { this.closed = true; await this.flush(); }
}
