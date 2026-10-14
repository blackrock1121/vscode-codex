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
  private day = "";

  constructor(private readonly dir: string) {
    this.prune();
  }

  prune(now = new Date()): void {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { return; }
    pruneLogs(this.dir, now);
  }

  write(line: string, now = new Date()): void {
    try {
      const day = logDay(now);
      if (day !== this.day) {
        this.prune(now);
        this.day = day;
      }
      const hh = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      fs.appendFileSync(path.join(this.dir, `codex-chat-${day}.log`), `[${hh}] ${line}\n`, "utf8");
    } catch { /* 写日志失败不影响插件功能 */ }
  }
}
