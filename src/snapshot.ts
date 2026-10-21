import { operationFailure, operationLog } from './operations';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

export type SnapshotSkipReason = 'large' | 'binary' | 'limit' | 'symlink' | 'unreadable';
const SYSTEM_METADATA_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const runFile = promisify(execFile);
interface SnapshotRead { text?: string; reason?: SnapshotSkipReason; missing?: boolean }

/** 匹配工作区相对路径：* 仅匹配一段，** 可跨目录。 */
function globRegex(pattern: string): RegExp | undefined {
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return undefined;
  let source = '^';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
      else { source += '.*'; i++; }
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(source + '$');
}

/** 在 turn/start 前读取基线，避免依赖可能晚于工具执行的通知。 */
export class WorkspaceSnapshot {
  readonly files = new Map<string, string>();
  readonly skipped = new Set<string>();
  readonly skipReasons = new Map<string, SnapshotSkipReason>();
  readonly unrestorableChanges = new Set<string>();
  private skippedBaseline = new Map<string, string | undefined>();
  private bytes = 0;
  private completeScan = true;
  private changedDuringRead = 0;
  private readonly roots: string[];
  private readonly excluded: Map<string, RegExp[]>;
  private readonly readConcurrency = 16;
  constructor(roots: string[], private readonly maxFiles = 20000, excludePatterns: string[] | Map<string, string[]> = [], private readonly excludePaths: ReadonlySet<string> = new Set()) {
    this.roots = [...new Set(roots.map(root => path.resolve(root)))];
    const compile = (patterns: string[]) => patterns.flatMap(pattern => {
      const normalized = pattern.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      const full = globRegex(normalized);
      const subtree = normalized.endsWith('/**') ? globRegex(normalized.slice(0, -3)) : undefined;
      return [full, subtree].filter((re): re is RegExp => !!re);
    });
    this.excluded = new Map(roots.map(root => [path.resolve(root), compile(excludePatterns instanceof Map ? excludePatterns.get(root) ?? [] : excludePatterns)]));
  }
  private skip(file: string, reason: SnapshotSkipReason): void {
    this.skipped.add(file);
    this.skipReasons.set(file, reason);
  }
  private isExcluded(root: string, file: string): boolean {
    if (this.excludePaths.has(file)) return true;
    const relative = path.relative(root, file).split(path.sep).join('/');
    return (this.excluded.get(root) ?? []).some(re => re.test(relative));
  }
  /** Git 只提供候选清单；备份仍读取当前磁盘内容，保留未提交及未跟踪的源码。 */
  private async gitInventory(root: string): Promise<{ files: Set<string>; paths: Set<string> } | undefined> {
    let dir = root;
    for (;;) {
      try { await fs.lstat(path.join(dir, '.git')); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          operationFailure('snapshot.inventory', error); return undefined;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    try {
      const { stdout } = await runFile('git', ['-c', 'core.fsmonitor=false', 'ls-files',
        '--cached', '--others', '--exclude-standard', '--deduplicate', '-z', '--', '.'], {
        cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      });
      const files = new Set<string>(), paths = new Set<string>();
      for (const relative of stdout.split('\0')) {
        if (!relative) continue;
        const file = path.resolve(root, relative), checked = path.relative(root, file);
        if (checked === '..' || checked.startsWith('..' + path.sep) || path.isAbsolute(checked)) continue;
        files.add(file);
        for (let current = file; current !== root; current = path.dirname(current)) paths.add(current);
      }
      return { files, paths };
    } catch (error) {
      // Git 不可用、仓库损坏或清单超限时使用原有目录扫描，不悄悄丢弃备份范围。
      operationFailure('snapshot.inventory', error);
      return undefined;
    }
  }
  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.next', '.codex', '.idea']);
    const inventory = await this.gitInventory(root);
    // Git 将子模块列为目录，继续按原规则扫描其内容；不跟随符号链接。
    const submodules: string[] = [];
    let dirs = [root];
    while (dirs.length) {
      const next: string[] = [];
      for (let i = 0; i < dirs.length; i += this.readConcurrency) {
        const batch = dirs.slice(i, i + this.readConcurrency);
        const listed = await Promise.all(batch.map(dir => fs.readdir(dir, { withFileTypes: true }).catch(() => undefined)));
        for (let j = 0; j < batch.length; j++) {
          const dir = batch[j], entries = listed[j];
          if (!entries) { this.skip(dir, 'unreadable'); this.completeScan = false; continue; }
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (this.isExcluded(root, full)) continue;
            if (inventory && !inventory.paths.has(full) && !submodules.some(sub => full.startsWith(sub + path.sep))) continue;
            if (e.isSymbolicLink()) { this.skip(full, 'symlink'); continue; }
            if (e.isDirectory()) {
              if (!excluded.has(e.name)) {
                if (inventory?.files.has(full)) submodules.push(full);
                next.push(full);
              }
            }
            else if (e.isFile() && !SYSTEM_METADATA_FILES.has(e.name)) {
              if (out.length >= this.maxFiles) { this.skip(full, 'limit'); this.completeScan = false; return out; }
              out.push(full);
            }
          }
        }
      }
      dirs = next;
    }
    return out;
  }
  private async read(file: string): Promise<SnapshotRead> {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) return { reason: 'symlink' };
      if (!stat.isFile()) return { reason: 'unreadable' };
      if (stat.size > MAX_FILE_BYTES) return { reason: 'large' };
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) return { reason: 'unreadable' };
        const same = (a: typeof stat, b: typeof stat) => a.dev === b.dev && a.ino === b.ino &&
          a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
        if (!same(stat, opened)) { this.changedDuringRead++; return { reason: 'unreadable' }; }
        if (opened.size > MAX_FILE_BYTES) return { reason: 'large' };
        const chunks: Buffer[] = [];
        let size = 0;
        while (size <= MAX_FILE_BYTES) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > MAX_FILE_BYTES) return { reason: 'large' };
          const chunk = buffer.subarray(0, bytesRead);
          if (chunk.includes(0)) return { reason: 'binary' };
          chunks.push(chunk);
        }
        // 已打开文件在读取期间消失/被替换，属于不稳定读取，不能当作可安全还原的删除。
        const current = await fs.lstat(file).catch(() => undefined);
        if (!current || !same(opened, await handle.stat()) || !same(opened, current)) {
          this.changedDuringRead++; return { reason: 'unreadable' };
        }
        try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size)) }; }
        catch { return { reason: 'binary' }; }
      } finally { await handle.close(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true };
      return { reason: code === 'ELOOP' ? 'symlink' : 'unreadable' };
    }
  }
  private async fingerprint(file: string): Promise<string | undefined> {
    try {
      const s = await fs.lstat(file, { bigint: true });
      return [s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(":");
    } catch { return undefined; }
  }
  private async fingerprints(files: string[]): Promise<Map<string, string | undefined>> {
    const result = new Map<string, string | undefined>();
    for (let i = 0; i < files.length; i += this.readConcurrency) {
      const batch = files.slice(i, i + this.readConcurrency);
      const values = await Promise.all(batch.map(file => this.fingerprint(file)));
      batch.forEach((file, index) => result.set(file, values[index]));
    }
    return result;
  }
  /** Overlap disk reads while bounding transient buffers and preserving file order. */
  private async readBatch(files: string[], visit: (file: string, result: SnapshotRead) => void): Promise<void> {
    for (let i = 0; i < files.length; i += this.readConcurrency) {
      const batch = files.slice(i, i + this.readConcurrency);
      const results = await Promise.all(batch.map(file => this.read(file)));
      batch.forEach((file, index) => visit(file, results[index]));
    }
  }
  async capture(): Promise<void> {
    const operationId = randomUUID(), started = Date.now();
    operationLog('snapshot.capture', 'start', { operationId, roots: this.roots.length });
    for (const root of this.roots) {
      const files = (await this.walk(root)).filter(file => !this.files.has(file) && !this.skipped.has(file));
      await this.readBatch(files, (file, { text, reason, missing }) => {
        if (missing) return;
        if (text === undefined) { this.skip(file, reason ?? 'unreadable'); return; }
        const size = Buffer.byteLength(text);
        if (this.bytes + size > 64 * 1024 * 1024) { this.skip(file, 'limit'); return; }
        this.files.set(file, text); this.bytes += size;
      });
    }
    this.skippedBaseline = await this.fingerprints([...this.skipped]);
    const unreadable = [...this.skipReasons.values()].filter(reason => reason === 'unreadable').length;
    operationLog('snapshot.capture', !this.roots.length ? 'skipped' : unreadable ? this.files.size ? 'partial' : 'unavailable' : 'completed',
      { operationId, reason: !this.roots.length ? 'no_workspace' : undefined, files: this.files.size, skipped: this.skipped.size,
        unreadable, changedDuringRead: this.changedDuringRead, completeScan: this.completeScan, durationMs: Date.now() - started });
  }
  async changed(): Promise<Map<string, string | null>> {
    const changes = new Map<string, string | null>();
    const existingReady = this.readBatch([...this.files.keys()], (file, { text: current, reason }) => {
      if (reason === 'unreadable' || reason === 'symlink') { this.unrestorableChanges.add(file); return; }
      const original = this.files.get(file)!;
      if (current !== original) changes.set(file, original);
    });
    const scansReady = Promise.all(this.roots.map(root => this.walk(root)));
    const [, scans] = await Promise.all([existingReady, scansReady]);
    for (const [file, current] of await this.fingerprints([...this.skipped])) {
      const before = this.skippedBaseline.get(file);
      if (!before || before !== current) this.unrestorableChanges.add(file);
    }
    // An incomplete scan cannot distinguish a newly created file from an
    // original file that the baseline missed because of the file cap.
    if (!this.completeScan) {
      for (const root of this.roots) this.unrestorableChanges.add(root);
      return changes;
    }
    for (const files of scans) {
      const newFiles = files.filter(file => !this.files.has(file) && !this.skipped.has(file));
      // 完整基线里不存在的新文件，无论文本还是二进制，回滚都应删除。
      for (const file of newFiles) changes.set(file, null);
    }
    return changes;
  }
}
