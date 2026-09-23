import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 在 turn/start 前读取基线，避免依赖可能晚于工具执行的通知。 */
export class WorkspaceSnapshot {
  readonly files = new Map<string, string>();
  readonly skipped = new Set<string>();
  private bytes = 0;
  private completeScan = true;
  constructor(private readonly roots: string[], private readonly maxFiles = 20000) {}
  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.next', '.codex', '.idea']);
    const visit = async (dir: string) => {
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { this.skipped.add(dir); this.completeScan = false; return; }
      for (const e of entries) {
        if (out.length >= this.maxFiles) { this.skipped.add(dir); this.completeScan = false; return; }
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) { this.skipped.add(full); continue; }
        if (e.isDirectory()) { if (!excluded.has(e.name)) await visit(full); }
        else if (e.isFile()) out.push(full);
      }
    };
    await visit(root); return out;
  }
  private async read(file: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) return undefined;
      const data = await fs.readFile(file);
      if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) return undefined;
      return data.toString('utf8');
    } catch { return undefined; }
  }
  async capture(): Promise<void> {
    for (const root of this.roots) for (const file of await this.walk(root)) {
      const text = await this.read(file);
      if (text === undefined || this.bytes + Buffer.byteLength(text) > 64 * 1024 * 1024) { this.skipped.add(file); continue; }
      this.files.set(file, text); this.bytes += Buffer.byteLength(text);
    }
  }
  async changed(): Promise<Map<string, string | null>> {
    const changes = new Map<string, string | null>();
    for (const [file, original] of this.files) {
      const current = await this.read(file);
      if (current !== original) changes.set(file, original);
    }
    for (const root of this.roots) for (const file of await this.walk(root)) {
      if (this.completeScan && !this.files.has(file) && !this.skipped.has(file) && await this.read(file) !== undefined) changes.set(file, null);
    }
    return changes;
  }
}
