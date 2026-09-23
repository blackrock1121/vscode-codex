import { CodexRpc } from './rpc';
import { timeline, userView } from './events';
import { SessionSummary, TimelineItem } from '../shared';

/** Codex 的 preview 是首条消息正文，直接作为标签名会把整段提问塞进标题栏。 */
export function previewTitle(preview: string): string {
  const firstLine = String(preview || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  const clause = firstLine.split(/[，,。！？!?；;]/, 1)[0].trim();
  const title = clause.length >= 6 ? clause : firstLine;
  const chars = Array.from(title);
  return chars.length > 22 ? chars.slice(0, 22).join('') + '…' : title || '新对话';
}

/** 历史只通过官方接口访问，不修改 Codex 的 SQLite/JSONL。同步方法仅访问已加载缓存。 */
export class SessionStore {
  private rpc?: CodexRpc;
  private connecting?: Promise<CodexRpc>;
  private threads = new Map<string, any>();
  private hydrating = new Map<string, Promise<void>>();
  private pending = new Map<string, { title: string; updatedAt: number }>();
  private listing?: Promise<void>;
  constructor(private readonly cwd: string, private readonly executable: () => string) {}
  async connection(): Promise<CodexRpc> {
    if (this.rpc?.isClosed) { this.rpc = undefined; this.connecting = undefined; }
    if (this.connecting) return this.connecting;
    const rpc = new CodexRpc(this.executable(), this.cwd);
    this.rpc = rpc;
    rpc.on('request', m => { try { rpc.reject(m.id, '管理连接不执行工具'); } catch {} });
    rpc.on('close', () => { if (this.rpc === rpc) { this.rpc = undefined; this.connecting = undefined; } });
    this.connecting = rpc.start().then(() => rpc).catch(e => {
      rpc.dispose();
      if (this.rpc === rpc) { this.rpc = undefined; this.connecting = undefined; }
      throw e;
    });
    return this.connecting;
  }
  /** 只用于无副作用的读取；连接在请求期间断开时重建并重试一次。 */
  async read<T = any>(method: string, params: unknown = {}): Promise<T> {
    const rpc = await this.connection();
    try { return await rpc.request<T>(method, params); }
    catch (error) {
      if (!rpc.isClosed) throw error;
      return (await this.connection()).request<T>(method, params);
    }
  }
  async refresh(): Promise<void> {
    if (this.listing) return this.listing;
    this.listing = this.refreshInner().finally(() => { this.listing = undefined; }); return this.listing;
  }
  private async refreshInner(): Promise<void> {
    let cursor: string | null = null;
    const found = new Map<string, any>();
    do {
      const r: any = await this.read('thread/list', { cwd: this.cwd, limit: 100, cursor, sortKey: 'updated_at', modelProviders: [] });
      for (const t of r.data) {
        found.set(t.id, { ...t, turns: this.threads.get(t.id)?.turns ?? t.turns });
        if (t.preview?.trim() || t.name?.trim()) this.pending.delete(t.id);
      }
      cursor = r.nextCursor;
    } while (cursor);
    // Forked threads can be absent from thread/list briefly after creation.
    for (const [id, thread] of this.threads) if (this.pending.has(id) && !found.has(id)) found.set(id, thread);
    this.threads = found;
  }
  async hydrate(id: string): Promise<void> {
    const active = this.hydrating.get(id);
    if (active) return active;
    const work = (async () => this.hydrateWith(await this.connection(), id))();
    this.hydrating.set(id, work);
    try { await work; }
    finally { if (this.hydrating.get(id) === work) this.hydrating.delete(id); }
  }
  private async hydrateWith(rpc: CodexRpc, id: string): Promise<void> {
    const r = await rpc.request('thread/read', { threadId: id, includeTurns: true });
    const thread = r.thread;
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
    const entries = new Map<string, SessionSummary>([...this.threads.values()].map(t => [t.id, { id: t.id, title: t.name?.trim() || previewTitle(t.preview), updatedAt: t.updatedAt * 1000, messageCount: t.turns?.length ?? 0 }]));
    for (const [id, p] of this.pending) {
      const existing = entries.get(id);
      entries.set(id, { id, title: existing?.title && existing.title !== '新对话' ? existing.title : p.title, updatedAt: Math.max(existing?.updatedAt ?? 0, p.updatedAt), messageCount: existing?.messageCount ?? 0 });
    }
    return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  notePending(id: string, text: string): void {
    this.pending.set(id, { title: previewTitle(text), updatedAt: Date.now() });
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
    await (await this.connection()).request('thread/archive', { threadId: id }); this.threads.delete(id); this.pending.delete(id);
  }
  async delete(id: string): Promise<boolean> {
    const rpc = await this.connection();
    await rpc.request('thread/archive', { threadId: id });
    await rpc.request('thread/delete', { threadId: id }); this.threads.delete(id); this.pending.delete(id); return true;
  }
  async fork(id: string, lastTurnId: string): Promise<string> {
    // thread/fork grants its app-server process the new thread's writer lock.
    // A long-lived management RPC would block the chat process from resuming it.
    const rpc = new CodexRpc(this.executable(), this.cwd);
    try {
      await rpc.start();
      const r = await rpc.request('thread/fork', { threadId: id, lastTurnId, cwd: this.cwd });
      this.threads.set(r.thread.id, r.thread);
      await this.hydrateWith(rpc, r.thread.id);
      this.notePending(r.thread.id, this.threads.get(id)?.preview || '派生会话');
      return r.thread.id;
    } finally {
      await rpc.disposeAndWait();
    }
  }
  dispose() { this.rpc?.dispose(); }
}
