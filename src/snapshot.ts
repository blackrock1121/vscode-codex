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
  private readonly excluded: RegExp[];
  constructor(private readonly roots: string[], private readonly maxFiles = 20000, excludePatterns: string[] = []) {
    this.excluded = excludePatterns.flatMap(pattern => {
      const normalized = pattern.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      const full = globRegex(normalized);
      const subtree = normalized.endsWith('/**') ? globRegex(normalized.slice(0, -3)) : undefined;
      return [full, subtree].filter((re): re is RegExp => !!re);
    });
  }
  private skip(file: string, reason: SnapshotSkipReason): void {
    this.skipped.add(file);
    this.skipReasons.set(file, reason);
  }
  private isExcluded(root: string, file: string): boolean {
    const relative = path.relative(root, file).split(path.sep).join('/');
    return this.excluded.some(re => re.test(relative));
  }
  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.next', '.codex', '.idea']);
    const visit = async (dir: string) => {
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { this.skip(dir, 'unreadable'); this.completeScan = false; return; }
      for (const e of entries) {
        if (out.length >= this.maxFiles) { this.skip(dir, 'limit'); this.completeScan = false; return; }
        const full = path.join(dir, e.name);
        if (this.isExcluded(root, full)) continue;
        if (e.isSymbolicLink()) { this.skip(full, 'symlink'); continue; }
        if (e.isDirectory()) { if (!excluded.has(e.name)) await visit(full); }
        else if (e.isFile()) out.push(full);
      }
    };
    await visit(root); return out;
  }
  private async read(file: string): Promise<{ text?: string; reason?: SnapshotSkipReason }> {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) return { reason: 'large' };
      const data = await fs.readFile(file);
      if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) return { reason: 'binary' };
      return { text: data.toString('utf8') };
    } catch { return { reason: 'unreadable' }; }
  }
  async capture(): Promise<void> {
    for (const root of this.roots) for (const file of await this.walk(root)) {
      const { text, reason } = await this.read(file);
      if (text === undefined) { this.skip(file, reason ?? 'unreadable'); continue; }
      const size = Buffer.byteLength(text);
      if (this.bytes + size > 64 * 1024 * 1024) { this.skip(file, 'limit'); continue; }
      this.files.set(file, text); this.bytes += size;
    }
  }
  async changed(): Promise<Map<string, string | null>> {
    const changes = new Map<string, string | null>();
    for (const [file, original] of this.files) {
      const current = (await this.read(file)).text;
      if (current !== original) changes.set(file, original);
    }
    for (const root of this.roots) for (const file of await this.walk(root)) {
      if (this.completeScan && !this.files.has(file) && !this.skipped.has(file) && (await this.read(file)).text !== undefined) changes.set(file, null);
    }
    return changes;
  }
}
