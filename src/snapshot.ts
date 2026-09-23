import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type SnapshotSkipReason = 'large' | 'binary' | 'limit' | 'symlink' | 'unreadable';

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
  private bytes = 0;
  private completeScan = true;
  private readonly excluded: Map<string, RegExp[]>;
  private readonly readConcurrency = 16;
  constructor(private readonly roots: string[], private readonly maxFiles = 20000, excludePatterns: string[] | Map<string, string[]> = []) {
    const compile = (patterns: string[]) => patterns.flatMap(pattern => {
      const normalized = pattern.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      const full = globRegex(normalized);
      const subtree = normalized.endsWith('/**') ? globRegex(normalized.slice(0, -3)) : undefined;
      return [full, subtree].filter((re): re is RegExp => !!re);
    });
    this.excluded = new Map(roots.map(root => [root, compile(excludePatterns instanceof Map ? excludePatterns.get(root) ?? [] : excludePatterns)]));
  }
  private skip(file: string, reason: SnapshotSkipReason): void {
    this.skipped.add(file);
    this.skipReasons.set(file, reason);
  }
  private isExcluded(root: string, file: string): boolean {
    const relative = path.relative(root, file).split(path.sep).join('/');
    return (this.excluded.get(root) ?? []).some(re => re.test(relative));
  }
  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.next', '.codex', '.idea']);
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
            if (out.length >= this.maxFiles) { this.skip(dir, 'limit'); this.completeScan = false; return out; }
            const full = path.join(dir, e.name);
            if (this.isExcluded(root, full)) continue;
            if (e.isSymbolicLink()) { this.skip(full, 'symlink'); continue; }
            if (e.isDirectory()) { if (!excluded.has(e.name)) next.push(full); }
            else if (e.isFile()) out.push(full);
          }
        }
      }
      dirs = next;
    }
    return out;
  }
  private async read(file: string): Promise<{ text?: string; reason?: SnapshotSkipReason }> {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) return { reason: 'large' };
      const data = await fs.readFile(file);
      if (data.includes(0)) return { reason: 'binary' };
      try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }; }
      catch { return { reason: 'binary' }; }
    } catch { return { reason: 'unreadable' }; }
  }
  /** Overlap disk reads while bounding transient buffers and preserving file order. */
  private async readBatch(files: string[], visit: (file: string, result: { text?: string; reason?: SnapshotSkipReason }) => void): Promise<void> {
    for (let i = 0; i < files.length; i += this.readConcurrency) {
      const batch = files.slice(i, i + this.readConcurrency);
      const results = await Promise.all(batch.map(file => this.read(file)));
      batch.forEach((file, index) => visit(file, results[index]));
    }
  }
  async capture(): Promise<void> {
    for (const root of this.roots) await this.readBatch(await this.walk(root), (file, { text, reason }) => {
      if (text === undefined) { this.skip(file, reason ?? 'unreadable'); return; }
      const size = Buffer.byteLength(text);
      if (this.bytes + size > 64 * 1024 * 1024) { this.skip(file, 'limit'); return; }
      this.files.set(file, text); this.bytes += size;
    });
  }
  async changed(): Promise<Map<string, string | null>> {
    const changes = new Map<string, string | null>();
    const existingReady = this.readBatch([...this.files.keys()], (file, { text: current }) => {
      const original = this.files.get(file)!;
      if (current !== original) changes.set(file, original);
    });
    const scansReady = Promise.all(this.roots.map(root => this.walk(root)));
    const [, scans] = await Promise.all([existingReady, scansReady]);
    // An incomplete scan cannot distinguish a newly created file from an
    // original file that the baseline missed because of the file cap.
    if (!this.completeScan) return changes;
    for (const files of scans) {
      const newFiles = files.filter(file => !this.files.has(file) && !this.skipped.has(file));
      await this.readBatch(newFiles, (file, { text }) => {
        if (text !== undefined) changes.set(file, null);
      });
    }
    return changes;
  }
}
