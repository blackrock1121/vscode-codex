import * as fs from "node:fs";
import * as path from "node:path";

const LOG_NAME = /^codex-chat-\d{4}-\d{2}-\d{2}\.log$/;

export function logDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 保留今天和之前六个本地日历日的插件日志，不触碰目录中的其它文件。 */
export function pruneLogs(dir: string, now = new Date()): void {
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const cutoff = `codex-chat-${logDay(oldest)}.log`;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!LOG_NAME.test(name) || name >= cutoff) continue;
      try {
        const full = path.join(dir, name);
        if (fs.lstatSync(full).isFile()) fs.unlinkSync(full);
      } catch { /* 单个文件无法清理，不影响日志和插件 */ }
    }
  } catch { /* 日志目录不可读时不影响插件 */ }
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

  constructor(private readonly dir: string) {
    this.prune();
  }

  prune(now = new Date()): void {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { return; }
    pruneLogs(this.dir, now);
  }

  write(line: string, now = new Date()): void {
    if (this.closed) return;
    try {
      const day = logDay(now);
      const hh = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      const row = `[${hh}] ${line.slice(0, 32768)}${line.length > 32768 ? " [truncated]" : ""}\n`;
      const bytes = Buffer.byteLength(row);
      if (this.pendingBytes + bytes > 1024 * 1024) { this.dropped++; return; }
      const rows = this.pending.get(day) ?? []; rows.push(row); this.pending.set(day, rows);
      this.pendingBytes += bytes; this.latestDate = now;
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 200); this.timer.unref(); }
    } catch { /* 写日志失败不影响插件功能 */ }
  }

  /** 有界队列 + 串行异步批量落盘，流式事件不再逐条阻塞扩展宿主。 */
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.flushing) { await this.flushing; if (this.pending.size) await this.flush(); return; }
    if (!this.pending.size) return;
    const batches = this.pending; this.pending = new Map(); this.pendingBytes = 0;
    const date = this.latestDate, dropped = this.dropped; this.dropped = 0;
    this.flushing = (async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        for (const [day, rows] of batches) await fs.promises.appendFile(path.join(this.dir, `codex-chat-${day}.log`), rows.join(''), 'utf8');
        if (dropped) await fs.promises.appendFile(path.join(this.dir, `codex-chat-${logDay(date)}.log`), `[logging] droppedLines=${dropped} reason=buffer_or_write_limit\n`, 'utf8');
        // 先完成跨天批次再清理，避免把过期批次重新创建出来。
        if (this.prunedDay !== logDay(date)) { this.prune(date); this.prunedDay = logDay(date); }
      } catch { this.dropped += [...batches.values()].reduce((n, rows) => n + rows.length, 0) + dropped; }
    })();
    try { await this.flushing; } finally { this.flushing = undefined; }
  }
  async dispose(): Promise<void> { this.closed = true; await this.flush(); }
}
