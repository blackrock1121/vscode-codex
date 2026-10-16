import { observeOperation, operationLog } from '../operations';
import { CodexRpc } from './rpc';
import { timeline, userView, parseQuestionReply, normalizeQuestions } from './events';
import { SessionSummary, TimelineItem } from '../shared';
import { QuestionImages, QUESTION_IMAGE_ANSWER } from '../questionImages';

export interface ForkPreparation {
  ready: Promise<CodexRpc>;
  dispose(): Promise<void>;
}

/** 仅缩短编辑器标签，不改会话名称；为原生关闭按钮留出空间。 */
export function sessionTabTitle(title?: string): string {
  const text = title?.replace(/\s+/g, ' ').trim() || 'Codex Copilot';
  const parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment);
  const width = (s: string) => /^[\x20-\x7e]+$/.test(s) ? s.length : 2;
  if (parts.reduce((n, s) => n + width(s), 0) <= 24) return text;
  let result = '', used = 0;
  for (const part of parts) {
    if (used + width(part) > 22) break;
    result += part;
    used += width(part);
  }
  return result.trimEnd() + '…';
}

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
  private deletedIds = new Set<string>();
  private listing?: Promise<void>;
  private forkIds = new Set<string>();
  private preparations = new Set<ForkPreparation>();
  private metadata = new Map<string, { expiresAt: number; result: Promise<any> }>();
  private metadataRevision = 0;
  private disposed = false;
  constructor(private readonly cwd: string, private readonly executable: () => string) {}
  private resetClosedConnection(): void {
    if (!this.rpc?.isClosed) return;
    this.invalidateMetadata(); this.rpc = undefined; this.connecting = undefined;
  }
  async connection(): Promise<CodexRpc> {
    if (this.disposed) throw new Error('Codex 管理连接已关闭');
    this.resetClosedConnection();
    if (this.connecting) return this.connecting;
    const rpc = new CodexRpc(this.executable(), this.cwd);
    this.rpc = rpc;
    rpc.on('request', m => { try { rpc.reject(m.id, '管理连接不执行工具'); } catch {} });
    rpc.on('notification', m => {
      if (this.rpc === rpc && m.method === 'account/updated') this.invalidateMetadata();
    });
    rpc.on('close', () => { if (this.rpc === rpc) { this.invalidateMetadata(); this.rpc = undefined; this.connecting = undefined; } });
    this.connecting = rpc.start().then(() => rpc).catch(e => {
      rpc.dispose();
      if (this.rpc === rpc) { this.rpc = undefined; this.connecting = undefined; }
      throw e;
    });
    return this.connecting;
  }
  private invalidateMetadata(): void {
    this.metadataRevision++;
    this.metadata.clear();
  }
  /** 仅缓存界面元数据；鉴权、快速档位校验及用量读取仍使用各自的实时请求。 */
  private readMetadata<T>(key: string, read: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Codex 管理连接已关闭'));
    this.resetClosedConnection();
    const cached = this.metadata.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const revision = this.metadataRevision;
    const entry = { expiresAt: Infinity, result: Promise.resolve(undefined) as Promise<any> };
    entry.result = read().then(result => {
      // 登录切换或断线时，旧连接迟到的结果不能进入新账号的界面缓存。
      if (revision !== this.metadataRevision) {
        if (this.metadata.get(key) === entry) this.metadata.delete(key);
        return this.readMetadata(key, read);
      }
      entry.expiresAt = Date.now() + 30_000;
      return result;
    }).catch(error => {
      if (this.metadata.get(key) === entry) this.metadata.delete(key);
      throw error;
    });
    this.metadata.set(key, entry);
    return entry.result;
  }
  readAccountInfo(): Promise<any> {
    return this.readMetadata('account', () => this.read('account/read', { refreshToken: false }));
  }
  readModelCatalog(): Promise<{ data: any[] }> {
    return this.readMetadata('models', async () => {
      const data: any[] = [], seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: { data: any[]; nextCursor?: string | null } = await this.read('model/list', { cursor });
        data.push(...page.data);
        cursor = page.nextCursor ?? null;
        if (cursor && seen.has(cursor)) throw new Error('模型列表分页游标重复，已停止读取，请重试。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return { data };
    });
  }
  /** 只用于无副作用的读取；连接在请求期间断开时重建并重试一次。 */
  read<T = any>(method: string, params: unknown = {}): Promise<T> {
    return observeOperation('session.read', () => this.readInner<T>(method, params), { method });
  }
  private async readInner<T>(method: string, params: unknown): Promise<T> {
    const rpc = await this.connection();
    try { return await rpc.request<T>(method, params); }
    catch (error) {
      if (!rpc.isClosed) throw error;
      operationLog('session.read', 'retry', { method });
      const result = await (await this.connection()).request<T>(method, params);
      operationLog('session.read', 'recovered', { method });
      return result;
    }
  }
  async refresh(): Promise<void> {
    if (this.listing) return this.listing;
    this.listing = this.refreshInner().finally(() => { this.listing = undefined; }); return this.listing;
  }
  private async refreshInner(): Promise<void> {
    let cursor: string | null = null;
    const found = new Map<string, any>();
    const seen = new Set<string>();
    do {
      const r: any = await this.read('thread/list', { cwd: this.cwd, limit: 100, cursor, sortKey: 'updated_at', modelProviders: [] });
      for (const t of r.data) {
        if (this.deletedIds.has(t.id)) continue;
        found.set(t.id, t);
        if (t.preview?.trim() || t.name?.trim()) this.pending.delete(t.id);
      }
      cursor = r.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('会话列表分页游标重复，已停止读取，请重试。');
      if (cursor) seen.add(cursor);
    } while (cursor);
    // 所有分页完成后再合并缓存，避免覆盖分页期间刚读取的完整历史。
    for (const [id, thread] of found) {
      if (this.deletedIds.has(id)) found.delete(id);
      else found.set(id, { ...thread, turns: this.threads.get(id)?.turns ?? thread.turns });
    }
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
    // 分页会话的 includeTurns:true 也可能返回完整正文，随后分页又传一遍。
    // 先看历史协议；只有传统会话才走完整 thread/read。
    let r = await rpc.request('thread/read', { threadId: id, includeTurns: false });
    if (r.thread?.id !== id) throw new Error('Codex 返回了不同的会话 ID，已中止读取，避免覆盖其他会话。');
    if (r.thread.historyMode !== 'paginated') r = await rpc.request('thread/read', { threadId: id, includeTurns: true });
    if (r.thread?.id !== id) throw new Error('Codex 返回了不同的会话 ID，已中止读取，避免覆盖其他会话。');
    await this.hydrateThread(rpc, r.thread);
  }
  /** 发送前只需还原点轮数，实时读取轻量索引，不改完整历史缓存。 */
  async readTurnCount(id: string): Promise<number> {
    const rpc = await this.connection();
    try { return await this.readTurnCountWith(rpc, id); }
    catch (error) {
      // 仅断线重试一次，并从第一页重新计数，不能拼接两个连接的半份结果。
      if (rpc.isClosed) return this.readTurnCountWith(await this.connection(), id);
      const message = error instanceof Error ? error.message : '';
      if (!/\(-32601\)$/.test(message) && !/unknown variant [`'"]notLoaded[`'"]|unknown field [`'"]itemsView[`'"]/.test(message)) throw error;
      await this.hydrate(id);
      return this.countLines(id);
    }
  }
  private async readTurnCountWith(rpc: CodexRpc, id: string): Promise<number> {
    let cursor: string | null = null;
    const cursors = new Set<string>(), turns = new Set<string>();
    do {
      const page: any = await rpc.request('thread/turns/list', { threadId: id, cursor, limit: 100, sortDirection: 'asc', itemsView: 'notLoaded' });
      if (!Array.isArray(page?.data) || (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)))
        throw new Error('会话历史分页数据无效，已取消发送。');
      for (const turn of page.data) {
        if (typeof turn?.id !== 'string' || !turn.id || turns.has(turn.id)) throw new Error('会话历史轮次无效或重复，已取消发送。');
        turns.add(turn.id);
      }
      cursor = page.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new Error('会话历史分页游标重复，已取消发送。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return turns.size;
  }
  private async hydrateThread(rpc: CodexRpc, thread: any): Promise<void> {
    const id = thread.id;
    if (thread.historyMode === 'paginated' || !Array.isArray(thread.turns)) {
      let cursor: string | null = null; const turns: any[] = [];
      const seen = new Set<string>();
      do {
        const page: any = await rpc.request('thread/turns/list', { threadId: id, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
        turns.push(...page.data); cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('会话历史分页游标重复，已停止读取，请重试。');
        if (cursor) seen.add(cursor);
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
  questionBeforeAnswer(id: string, count: number): { input: Record<string, unknown>; initialAnswers: Record<string, string | string[]>; initialImages?: QuestionImages } | undefined {
    const turns = this.threads.get(id)?.turns;
    if (!Number.isInteger(count) || count < 1 || !turns?.[count] || !['completed', 'interrupted'].includes(turns[count - 1]?.status)) return;
    const answer = this.firstUserTurnAfter(id, count);
    const reply = parseQuestionReply(answer?.text ?? '');
    if (!reply) return;
    const source = timeline([turns[count - 1]]).reverse().find(item => {
      if (item.type !== 'tool' || item.name !== 'AskUserQuestion') return false;
      const qs = normalizeQuestions(item.input?.questions);
      return qs?.length === reply.length && qs.every((q, i) => q.question === reply[i].question);
    });
    const original = source?.type === 'tool' ? normalizeQuestions(source.input?.questions) : undefined;
    const questions = original ?? reply.map((r, i) => ({ id: String(i), question: r.question, isSecret: r.isSecret, options: [] }));
    const initialAnswers: Record<string, string | string[]> = {};
    const initialImages: QuestionImages = {};
    let offset = 0;
    questions.forEach((q, i) => {
      const imageCount = reply[i].imageCount ?? 0;
      const pictures = answer?.images.slice(offset, offset + imageCount) ?? [];
      offset += imageCount;
      if (q.isSecret || reply[i].isSecret) q.isSecret = true;
      else {
        initialAnswers[q.id] = imageCount && reply[i].answers.length === 1 && reply[i].answers[0] === QUESTION_IMAGE_ANSWER ? '' : reply[i].answers.join('、');
        if (pictures.length) initialImages[q.id] = pictures;
      }
    });
    return { input: { questions }, initialAnswers, ...(Object.keys(initialImages).length ? { initialImages } : {}) };
  }
  /** 仅识别末尾确实已中断、且连用户消息都未落盘的空轮次。 */
  isEmptyInterruptedTail(id: string, count: number): boolean {
    const turns = this.threads.get(id)?.turns;
    if (!Array.isArray(turns) || !Number.isInteger(count) || count < 0 || turns.length !== count + 1) return false;
    const turn = turns[count];
    return turn.status === 'interrupted' && Array.isArray(turn.items) && turn.items.length === 0;
  }
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
    // thread/delete 支持活跃及已归档会话。先归档会让删除失败的会话消失，
    // 还会在缺少 rollout 时提前失败，阻止 delete 清理残留元数据。
    await rpc.request('thread/delete', { threadId: id });
    this.deletedIds.add(id); this.threads.delete(id); this.pending.delete(id); return true;
  }
  /** 只重排用户选中的会话，先删派生历史，再删被引用的原会话。 */
  deletionOrder(ids: string[]): string[] {
    const selected = new Set(ids), children = new Map<string, string[]>();
    for (const id of selected) {
      const thread = this.threads.get(id);
      for (const parent of new Set([thread?.forkedFromId, thread?.parentThreadId])) {
        if (!selected.has(parent)) continue;
        const list = children.get(parent) ?? [];
        list.push(id); children.set(parent, list);
      }
    }
    const seen = new Set<string>(), ordered: string[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const child of children.get(id) ?? []) visit(child);
      ordered.push(id);
    };
    for (const id of selected) visit(id);
    return ordered;
  }
  prepareFork(): ForkPreparation {
    const rpc = new CodexRpc(this.executable(), this.cwd);
    let closing: Promise<void> | undefined;
    const preparation: ForkPreparation = {
      ready: rpc.start().then(() => rpc),
      dispose: () => closing ??= rpc.disposeAndWait().finally(() => this.preparations.delete(preparation)),
    };
    // 初始化与原会话校验并行，错误仍由 fork 的 await 报告，避免提前拒绝未被捕获。
    void preparation.ready.catch(() => {});
    this.preparations.add(preparation);
    return preparation;
  }
  async fork(id: string, lastTurnId: string, preparation = this.prepareFork()): Promise<string> {
    // thread/fork grants its app-server process the new thread's writer lock.
    // A long-lived management RPC would block the chat process from resuming it.
    try {
      const rpc = await preparation.ready;
      const r = await rpc.request('thread/fork', { threadId: id, lastTurnId, cwd: this.cwd });
      const newId = r.thread?.id;
      if (typeof newId !== 'string' || !/^[\w-]{1,128}$/.test(newId) || newId === id ||
          this.threads.has(newId) || this.pending.has(newId) || this.forkIds.has(newId))
        throw new Error('Codex 返回了无效或重复的派生会话 ID，已中止，未覆盖或删除原会话。');
      this.forkIds.add(newId);
      const thread = r.thread;
      // legacy fork 响应已含完整历史时直接复用；分页、缺少内容或边界不符则完整读取。
      if (['legacy', 'full', undefined].includes(thread.historyMode) && Array.isArray(thread.turns) &&
          thread.turns.length && thread.turns.at(-1).id === lastTurnId && thread.turns.every((turn: any) => Array.isArray(turn.items)))
        this.threads.set(newId, thread);
      else if (thread.historyMode === 'paginated') await this.hydrateThread(rpc, thread);
      else await this.hydrateWith(rpc, newId);
      this.notePending(newId, this.threads.get(id)?.preview || '派生会话');
      return newId;
    } finally {
      await preparation.dispose();
    }
  }
  dispose() { this.disposed = true; this.invalidateMetadata(); this.rpc?.dispose(); for (const preparation of this.preparations) void preparation.dispose(); }
}
