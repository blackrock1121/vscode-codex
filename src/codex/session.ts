import { CodexRpc } from './rpc';
import { timeline, userView } from './events';
import { SessionSummary, TimelineItem } from '../shared';

/** 历史只通过官方接口访问，不修改 Codex 的 SQLite/JSONL。同步方法仅访问已加载缓存。 */
export class SessionStore {
  private rpc?: CodexRpc;
  private connecting?: Promise<CodexRpc>;
  private threads = new Map<string, any>();
  private listing?: Promise<void>;
  constructor(private readonly cwd: string, private readonly executable: () => string) {}
  async connection(): Promise<CodexRpc> {
    if (this.connecting) return this.connecting;
    const rpc = new CodexRpc(this.executable(), this.cwd);
    this.rpc = rpc;
    rpc.on('request', m => { try { rpc.reject(m.id, '管理连接不执行工具'); } catch {} });
    rpc.on('close', () => { if (this.rpc === rpc) { this.rpc = undefined; this.connecting = undefined; } });
    this.connecting = rpc.start().then(() => rpc).catch(e => { rpc.dispose(); this.connecting = undefined; throw e; });
    return this.connecting;
  }
  async refresh(): Promise<void> {
    if (this.listing) return this.listing;
    this.listing = this.refreshInner().finally(() => { this.listing = undefined; }); return this.listing;
  }
  private async refreshInner(): Promise<void> {
    const rpc = await this.connection(); let cursor: string | null = null;
    const found = new Map<string, any>();
    do {
      const r: any = await rpc.request('thread/list', { cwd: this.cwd, limit: 100, cursor, sortKey: 'updated_at', modelProviders: [] });
      for (const t of r.data) found.set(t.id, { ...t, turns: this.threads.get(t.id)?.turns ?? t.turns });
      cursor = r.nextCursor;
    } while (cursor);
    this.threads = found;
  }
  async hydrate(id: string): Promise<void> {
    const rpc = await this.connection();
    const r = await rpc.request('thread/read', { threadId: id });
    let thread = r.thread;
    if (thread.historyMode !== 'paginated') thread = (await rpc.request('thread/read', { threadId: id, includeTurns: true })).thread;
    if (thread.historyMode === 'paginated' || !thread.turns?.length) {
      let cursor: string | null = null; const turns: any[] = [];
      do {
        const page: any = await rpc.request('thread/turns/list', { threadId: id, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
        turns.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
      thread.turns = turns;
    }
    this.threads.set(id, thread);
  }
  list(): SessionSummary[] {
    return [...this.threads.values()].map(t => ({ id: t.id, title: t.name || t.preview || '新对话', updatedAt: t.updatedAt * 1000, messageCount: t.turns?.length ?? 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  load(id: string): TimelineItem[] { return timeline(this.threads.get(id)?.turns ?? []); }
  findFile(id: string): string | undefined { const t = this.threads.get(id); return t ? (t.path || id) : undefined; }
  countLines(id: string): number { return this.threads.get(id)?.turns?.length ?? 0; }
  userTurnLines(id: string): { text: string; hasImages: boolean; line: number }[] {
    return (this.threads.get(id)?.turns ?? []).flatMap((t: any, index: number) => {
      const user = t.items?.find((i: any) => i.type === 'userMessage'); if (!user) return [];
      const v = userView(user.content ?? []); return [{ text: v.text, hasImages: !!v.images?.length, line: index + 1 }];
    });
  }
  rewindLeafFor(id: string, count: number): string | undefined { return this.threads.get(id)?.turns?.[count - 1]?.id; }
  firstUserTurnAfter(id: string, count: number): { text: string; images: { mediaType: string; data: string }[] } | undefined {
    const item = this.threads.get(id)?.turns?.[count]?.items?.find((i: any) => i.type === 'userMessage');
    if (!item) return undefined;
    const v = userView(item.content ?? []);
    return { text: v.text, images: (v.images ?? []).flatMap(uri => { const m = /^data:([^;]+);base64,(.+)$/.exec(uri); return m ? [{ mediaType: m[1], data: m[2] }] : []; }) };
  }
  async setCustomTitle(id: string, title: string): Promise<boolean> {
    await (await this.connection()).request('thread/name/set', { threadId: id, name: title || '新对话' });
    if (this.threads.has(id)) this.threads.get(id).name = title; return true;
  }
  async archive(id: string): Promise<void> {
    await (await this.connection()).request('thread/archive', { threadId: id }); this.threads.delete(id);
  }
  async delete(id: string): Promise<boolean> {
    const rpc = await this.connection();
    await rpc.request('thread/archive', { threadId: id });
    await rpc.request('thread/delete', { threadId: id }); this.threads.delete(id); return true;
  }
  async fork(id: string, lastTurnId: string): Promise<string> {
    const r = await (await this.connection()).request('thread/fork', { threadId: id, lastTurnId, cwd: this.cwd });
    this.threads.set(r.thread.id, r.thread); await this.hydrate(r.thread.id); return r.thread.id;
  }
  dispose() { this.rpc?.dispose(); }
}
