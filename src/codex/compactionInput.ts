import { errorFields, expectedFileError, operationFailure, operationLog } from '../operations';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_TRACKED_BYTES = 32 * 1024 * 1024;
const MIN_OUTPUT_CHARS = 12_000;
const KEEP_OUTPUTS = 8;
const KEEP_USER_TURNS = 2;
const EXCERPT_CHARS = 6_000;
const MIN_SAVED_BYTES = 16 * 1024;
const MIN_SAVED_RATIO = 0.1;
export interface InputSavings { originalBytes: number; optimizedBytes: number; archivedOutputs: number; duplicateOutputs: number; protectedFrom: number; }
const outputItem = (x: any) => x?.type === 'function_call_output' || x?.type === 'custom_tool_call_output';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** 原文按内容寻址写入本机；保存失败时调用方必须保留原输出。 */
export class CompactionArchive {
  private storedBytes?: number;
  constructor(private readonly directory: string, private readonly maxBytes = 64 * 1024 * 1024) {}
  async save(text: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const digest = hash(text), file = path.join(this.directory, digest + '.txt');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      if (hash(await fs.readFile(file, { encoding: 'utf8', signal })) !== digest) throw new Error('压缩归档内容校验失败');
      return file;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (this.storedBytes === undefined) {
      const files = (await fs.readdir(this.directory, { withFileTypes: true })).filter(x => x.isFile() && /^[a-f0-9]{64}\.txt$/.test(x.name));
      this.storedBytes = (await Promise.all(files.map(x => fs.stat(path.join(this.directory, x.name))))).reduce((n, x) => n + x.size, 0);
    }
    const bytes = Buffer.byteLength(text);
    if (this.storedBytes + bytes > this.maxBytes) throw new Error('本会话压缩归档空间已达到上限');
    signal?.throwIfAborted();
    // 完整写入后才发布到内容寻址路径，取消/磁盘错误不会留下半份可引用原文。
    const temporary = path.join(this.directory, `.${digest}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600, signal });
      signal?.throwIfAborted();
      try { await fs.link(temporary, file); this.storedBytes += bytes; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        if (hash(await fs.readFile(file, { encoding: 'utf8', signal })) !== digest) throw new Error('压缩归档内容校验失败');
      }
    } finally { await fs.rm(temporary, { force: true }).catch(error => { if (!expectedFileError(error)) operationFailure('compaction.archive.cleanup', error); }); }
    return file;
  }
}

/** 只精简较旧的工具结果；最近两个用户轮次、最近八个结果和所有消息/工具调用原样保留。 */
export async function optimizeCompactionInput(input: any[], archive: Pick<CompactionArchive, 'save'>,
  options: { signal?: AbortSignal; maxDurationMs?: number } = {}): Promise<{ input: any[]; savings: InputSavings }> {
  const serialized = JSON.stringify(input), originalBytes = Buffer.byteLength(serialized);
  const users = input.flatMap((item, i) => item?.type === 'message' && item.role === 'user' ? [i] : []);
  const outputs = input.flatMap((item, i) => outputItem(item) ? [i] : []);
  const protectedFrom = Math.min(users.at(-KEEP_USER_TURNS) ?? 0, outputs.at(-KEEP_OUTPUTS) ?? 0);
  const savings: InputSavings = { originalBytes, optimizedBytes: originalBytes, archivedOutputs: 0, duplicateOutputs: 0, protectedFrom };
  const unchanged = () => ({ input, savings: { ...savings } });
  if (originalBytes < 64_000 || originalBytes > MAX_TRACKED_BYTES || protectedFrom === 0 || options.signal?.aborted) return unchanged();
  const controller = new AbortController(), deadline = performance.now() + (options.maxDurationMs ?? 250);
  const abort = () => { operationLog('compaction.input', options.signal?.aborted ? 'cancelled' : 'fallback', { reason: 'preparation_budget' }); controller.abort(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, deadline - performance.now())); timer.unref();
  const cancelled = new Promise<ReturnType<typeof unchanged>>(resolve => controller.signal.addEventListener('abort', () => resolve(unchanged()), { once: true }));
  try { return await Promise.race([prepare(), cancelled]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }

  async function prepare(): Promise<ReturnType<typeof unchanged>> {
    const stopped = () => controller.signal.aborted || performance.now() >= deadline;
    const result = [...input];
    const changes: { item: number; part: number; original: string; digest: string; render: (file: string) => string }[] = [];
    let potentialSavings = 0;
    // 同文输出保留较新的位置。只处理纯文本片段，不动图片、多模态、未知结构或调用配对。
    const latest = new Map<string, { item: number; part: number }>();
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!outputItem(item)) continue;
      const parts: string[] | undefined = typeof item.output === 'string' ? [item.output] :
        Array.isArray(item.output) && item.output.every((x: any) =>
          ['input_text', 'output_text'].includes(x?.type) && typeof x.text === 'string') ? item.output.map((x: any) => x.text) : undefined;
      if (!parts) continue;
      for (let part = parts.length - 1; part >= 0; part--) {
        if (stopped()) return unchanged();
        const original = parts[part]; if (original.length < MIN_OUTPUT_CHARS) continue;
        const digest = hash(original), canonical = latest.get(digest);
        if (i >= protectedFrom) { if (!canonical) latest.set(digest, { item: i, part }); continue; }
        const later = canonical === undefined ? undefined : input[canonical.item];
        const reference = later && typeof later.call_id === 'string' && /^[\w.-]{1,160}$/.test(later.call_id) ? later.call_id : undefined;
        const selected = reference ? '' : excerpt(original);
        const render = (file: string) => reference
          ? `[旧工具输出与后面的调用 ${reference} 第 ${canonical!.part + 1} 段完全相同；原文 ${original.length} 字符，已完整保存到 ${file}]`
          : `[旧工具输出已精简；原文 ${original.length} 字符，完整内容保存在 ${file}。以下是原文摘录；路径及事实仍须按原工具结果理解。]\n${selected}`;
        if (render('').length >= original.length * 0.8) continue;
        potentialSavings += Buffer.byteLength(JSON.stringify(original)) - Buffer.byteLength(JSON.stringify(render('')));
        changes.push({ item: i, part, original, digest, render });
        if (!reference) latest.set(digest, { item: i, part });
      }
    }
    const worthwhile = (saved: number) => saved >= MIN_SAVED_BYTES && saved >= originalBytes * MIN_SAVED_RATIO;
    // 小收益不足以抵偿归档和可能的前缀缓存失效；先判断再读写磁盘。
    if (!worthwhile(potentialSavings) || stopped()) return unchanged();
    const archived = new Map<string, string | undefined>(), nextSavings = { ...savings };
    for (const change of changes) {
      if (stopped()) return unchanged();
      try {
        if (!archived.has(change.digest)) {
          try { archived.set(change.digest, await archive.save(change.original, controller.signal)); }
          catch (error) { if (!controller.signal.aborted) operationLog('compaction.archive', 'fallback', { ...errorFields(error), scope: 'original_input' }); archived.set(change.digest, undefined); }
        }
        if (stopped()) return unchanged();
        const file = archived.get(change.digest); if (!file) continue;
        const text = change.render(file), item = result[change.item];
        if (text.length >= change.original.length * 0.8) continue;
        const output = typeof item.output === 'string' ? text :
          item.output.map((x: any, i: number) => i === change.part ? { ...x, text } : x);
        result[change.item] = { ...item, output };
        if (text.startsWith('[旧工具输出与')) nextSavings.duplicateOutputs++; else nextSavings.archivedOutputs++;
      } catch (error) { operationLog('compaction.input', 'fallback', { ...errorFields(error), scope: 'original_input' }); /* 保留原文 */ }
    }
    nextSavings.optimizedBytes = Buffer.byteLength(JSON.stringify(result));
    return worthwhile(originalBytes - nextSavings.optimizedBytes) && !stopped() ? { input: result, savings: nextSavings } : unchanged();
  }
}

/** 原文头尾与状态/错误/计数等关键行。只摘录，不推断或重新生成事实。 */
function excerpt(text: string): string {
  const head = text.slice(0, 1600), tail = text.slice(-2400);
  const middle = text.slice(1600, -2400).split('\n');
  const selected: string[] = []; let remaining = EXCERPT_CHARS - head.length - tail.length;
  const important = /(?:error|fail|exception|warning|fatal|passed|tests?|success|version|commit|sha256|median|mean|duration|elapsed|秒|耗时|失败|错误|通过|版本|提交|警告|样本|均值|中位数)/i;
  for (const line of middle) {
    if (!important.test(line) || line.length > 600 || line.length + 1 > remaining) continue;
    selected.push(line); remaining -= line.length + 1;
  }
  return head + '\n[中间原文见归档；选取的状态行]\n' + selected.join('\n') + '\n[原文末尾]\n' + tail;
}

/** 还原 WebSocket 的 previous_response_id 增量；状态缺失时放弃优化，绝不猜测前缀。 */
export class ResponseHistory {
  private readonly completed = new Map<string, any[]>();
  private pending?: { input?: any[]; output: Map<number, any>; bytes: number; responseId?: string; complete: boolean };
  private disabled = false;
  private sizes = new WeakMap<object, number>();
  get isReliable(): boolean { return !this.disabled; }
  private size(items: any[]): number {
    let bytes = 2;
    for (const item of items) {
      const cached = item && typeof item === 'object' ? this.sizes.get(item) : undefined;
      const length = cached ?? Buffer.byteLength(JSON.stringify(item));
      if (item && typeof item === 'object' && cached === undefined) this.sizes.set(item, length);
      bytes += length + 1;
      if (bytes > MAX_TRACKED_BYTES) break;
    }
    return bytes;
  }
  resolve(body: any): any[] | undefined {
    if (!Array.isArray(body?.input)) return;
    // 这些协议的服务端上下文不等于 input + output，不能靠拼接重建。
    if (body.stream_id != null || body.conversation != null || body.context_management != null ||
      body.input.some((item: any) => item?.type === 'item_reference')) return;
    if (!body.previous_response_id) return body.input;
    if (this.disabled) return;
    const prefix = this.completed.get(body.previous_response_id);
    if (prefix) return [...prefix, ...body.input];
  }
  request(body: any): void {
    if (this.disabled) return;
    if (body?.type !== 'response.create' || this.pending || body.stream_id != null ||
      body.conversation != null || body.context_management != null) { this.clear(); return; }
    const input = this.resolve(body), bytes = input ? this.size(input) : 0;
    this.pending = { input: bytes <= MAX_TRACKED_BYTES ? input : undefined, output: new Map(), bytes, complete: true };
  }
  event(event: any): void {
    if (this.disabled) return;
    if (event?.stream_id != null || event?.type === 'error' || event?.type === 'response.failed' ||
      event?.type === 'response.incomplete') { this.clear(); return; }
    const current = this.pending;
    if (!current) {
      if (event?.type === 'response.created') this.clear(); // 例如服务端自动开始的 steering 后继响应。
      return;
    }
    const id = event?.response_id ?? event?.response?.id;
    if (typeof id === 'string') {
      if (current.responseId && current.responseId !== id) { this.clear(); return; }
      current.responseId = id;
    }
    if (event?.type === 'response.output_item.done' && event.item && current.input) {
      current.bytes += this.size([event.item]);
      const index = event.output_index;
      if (current.bytes > MAX_TRACKED_BYTES) { current.input = undefined; current.output.clear(); }
      else if (!Number.isSafeInteger(index) || index < 0 || index > 100_000 || current.output.has(index)) current.complete = false;
      else current.output.set(index, event.item);
    }
    if (event?.type === 'response.completed') {
      this.pending = undefined;
      const response = event.response;
      // 完整 final output 优先；部分服务端末尾不重复正文，按 output_index 恢复且不接受缺口。
      const streamed = [...current.output.entries()].sort((a, b) => a[0] - b[0]);
      const contiguous = current.complete && streamed.every(([index], i) => index === i);
      const output = Array.isArray(response?.output) && response.output.length > 0 ? response.output :
        streamed.length && contiguous ? streamed.map(([, item]) => item) :
          current.complete && !streamed.length && Array.isArray(response?.output) ? response.output : undefined;
      if (current.input && typeof response?.id === 'string' && Array.isArray(output) &&
        !output.some((item: any) => item?.type === 'compaction') &&
        !streamed.some(([, item]) => item?.type === 'compaction')) {
        const items = [...current.input, ...output];
        if (this.size(items) <= MAX_TRACKED_BYTES) {
          this.completed.set(response.id, items);
          while (this.completed.size > 2) this.completed.delete(this.completed.keys().next().value!);
        }
      }
    }
  }
  clear(): void { this.disabled = true; this.pending = undefined; this.completed.clear(); this.sizes = new WeakMap(); }
}
