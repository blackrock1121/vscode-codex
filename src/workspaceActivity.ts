import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { operationFailure, operationLog } from './operations';

interface Activity {
  id: string;
  roots: string[];
  started: number;
  ended?: number;
  pid: number;
}

const now = () => performance.timeOrigin + performance.now();
const contains = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const overlaps = (a: string[], b: string[]) => a.some(left => b.some(right => contains(left, right) || contains(right, left)));

/** 只保存执行区间与路径，不保存对话或文件正文。独立于会话，删除/派生会话也不能抹掉并行证据。 */
export class WorkspaceActivity {
  private static readonly verificationFailures = new Map<string, string>();
  private constructor(private readonly dir: string, private readonly record: Activity) {}
  get id(): string { return this.record.id; }

  static begin(storageDir: string, roots: string[]): WorkspaceActivity {
    const dir = path.join(storageDir, 'workspace-activity');
    fs.mkdirSync(dir, { recursive: true });
    // 宿主异常退出的区间保守延长到本次启动；之后的新任务不会永远被旧活动阻塞。
    for (const record of this.read(dir)) {
      if (record.ended !== undefined) continue;
      try { process.kill(record.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        new WorkspaceActivity(dir, record).finish();
      }
    }
    const activity = new WorkspaceActivity(dir, {
      id: randomUUID(), roots: roots.map(root => fs.realpathSync(root)), started: now(), pid: process.pid,
    });
    activity.save();
    return activity;
  }

  finish(fallbackPaths: string[] = []): void {
    if (this.record.ended !== undefined) return;
    if (!this.record.roots.length) this.record.roots = [...new Set(fallbackPaths.map(file => path.dirname(file)))];
    this.record.ended = now();
    try { this.save(); }
    catch (error) { this.record.ended = undefined; throw error; }
  }

  private save(): void {
    const file = path.join(this.dir, this.id + '.json'), temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.record), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  private static read(dir: string): Activity[] {
    return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Activity;
      if (typeof record.id !== 'string' || !Array.isArray(record.roots) || !record.roots.every(root => typeof root === 'string') ||
        !Number.isFinite(record.started) || !Number.isInteger(record.pid) || record.pid <= 0 ||
        (record.ended !== undefined && (!Number.isFinite(record.ended) || record.ended < record.started)))
        throw new Error('工作区活动记录损坏');
      return record;
    });
  }

  static blockReason(storageDir: string, ids: string[], files: string[]): string | undefined {
    try {
      files = files.map(file => {
        let parent = path.dirname(file), suffix = path.basename(file);
        while (!fs.existsSync(parent) && path.dirname(parent) !== parent) {
          suffix = path.join(path.basename(parent), suffix); parent = path.dirname(parent);
        }
        return path.join(fs.realpathSync(parent), suffix);
      });
      const records = this.read(path.join(storageDir, 'workspace-activity'));
      const previousFailureId = this.verificationFailures.get(storageDir);
      if (previousFailureId) {
        operationLog('workspace.activity.verify', 'recovered', { previousFailureId });
        this.verificationFailures.delete(storageDir);
      }
      const selected = ids.map(id => records.find(record => record.id === id));
      if (selected.some(record => !record || record.ended === undefined)) return '文件快照的执行区间未完整记录';
      for (const record of records) {
        if (record.ended === undefined && files.some(file => record.roots.some(root => contains(root, file))))
          return '同一工作区还有会话正在执行，请先停止或等待结束';
        if (selected.some(own => own && own.id !== record.id && overlaps(own.roots, record.roots) &&
          own.started < (record.ended ?? Infinity) && record.started < own.ended!))
          return '采集文件快照期间有其他会话同时使用该工作区，无法区分各会话的改动；已阻止回滚以保留其他会话的成果';
      }
    } catch (error) {
      // 返回安全拒绝仍须保留磁盘/数据原因；列表刷新不重复记同一故障。
      if (!this.verificationFailures.has(storageDir)) {
        if (this.verificationFailures.size >= 128) this.verificationFailures.delete(this.verificationFailures.keys().next().value!);
        const failureId = randomUUID();
        this.verificationFailures.set(storageDir, failureId);
        operationFailure('workspace.activity.verify', error, { failureId });
      }
      return '无法验证工作区的并行活动记录，已阻止文件回滚';
    }
    return undefined;
  }
}
