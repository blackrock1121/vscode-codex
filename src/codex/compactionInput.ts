import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_TRACKED_BYTES = 32 * 1024 * 1024;
const MIN_OUTPUT_CHARS = 12_000;
const KEEP_OUTPUTS = 8;
const KEEP_USER_TURNS = 2;
const EXCERPT_CHARS = 6_000;
export interface InputSavings { originalBytes: number; optimizedBytes: number; archivedOutputs: number; duplicateOutputs: number; protectedFrom: number; }
const outputItem = (x: any) => x?.type === 'function_call_output' || x?.type === 'custom_tool_call_output';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** 原文按内容寻址写入本机；保存失败时调用方必须保留原输出。 */
export class CompactionArchive {
  private storedBytes?: number;
  constructor(private readonly directory: string, private readonly maxBytes = 64 * 1024 * 1024) {}
  async save(text: string): Promise<string> {
    const digest = hash(text), file = path.join(this.directory, digest + '.txt');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      if (hash(await fs.readFile(file, 'utf8')) !== digest) throw new Error('压缩归档内容校验失败');
      return file;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (this.storedBytes === undefined) {
      const files = (await fs.readdir(this.directory, { withFileTypes: true })).filter(x => x.isFile() && /^[a-f0-9]{64}\.txt$/.test(x.name));
      this.storedBytes = (await Promise.all(files.map(x => fs.stat(path.join(this.directory, x.name))))).reduce((n, x) => n + x.size, 0);
    }
    const bytes = Buffer.byteLength(text);
    if (this.storedBytes + bytes > this.maxBytes) throw new Error('本会话压缩归档空间已达到上限');
    try { await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }); this.storedBytes += bytes; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (hash(await fs.readFile(file, 'utf8')) !== digest) throw new Error('压缩归档内容校验失败');
    }
    return file;
  }
}

/** 只精简较旧的工具结果；最近两个用户轮次、最近八个结果和所有消息/工具调用原样保留。 */
export async function optimizeCompactionInput(input: any[], archive: CompactionArchive): Promise<{ input: any[]; savings: InputSavings }> {
  const serialized = JSON.stringify(input), originalBytes = Buffer.byteLength(serialized);
  const users = input.flatMap((item, i) => item?.type === 'message' && item.role === 'user' ? [i] : []);
  const outputs = input.flatMap((item, i) => outputItem(item) ? [i] : []);
  const protectedFrom = Math.min(users.at(-KEEP_USER_TURNS) ?? 0, outputs.at(-KEEP_OUTPUTS) ?? 0);
  const savings: InputSavings = { originalBytes, optimizedBytes: originalBytes, archivedOutputs: 0, duplicateOutputs: 0, protectedFrom };
  if (originalBytes < 64_000 || originalBytes > MAX_TRACKED_BYTES || protectedFrom === 0) return { input, savings };
  const result = [...input];
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
      const original = parts[part]; if (original.length < MIN_OUTPUT_CHARS) continue;
      const digest = hash(original), canonical = latest.get(digest);
      if (i >= protectedFrom) { if (!canonical) latest.set(digest, { item: i, part }); continue; }
      try {
        const file = await archive.save(original);
        const later = canonical === undefined ? undefined : input[canonical.item];
        const reference = later && typeof later.call_id === 'string' && /^[\w.-]{1,160}$/.test(later.call_id) ? later.call_id : undefined;
        const text = reference
          ? `[旧工具输出与后面的调用 ${reference} 第 ${canonical!.part + 1} 段完全相同；原文 ${original.length} 字符，已完整保存到 ${file}]`
          : `[旧工具输出已精简；原文 ${original.length} 字符，完整内容保存在 ${file}。以下是原文摘录；路径及事实仍须按原工具结果理解。]\n${excerpt(original)}`;
        if (text.length >= original.length * 0.8) continue;
        const output = typeof item.output === 'string' ? text :
          (result[i].output as any[]).map((x, index) => index === part ? { ...x, text } : x);
        result[i] = { ...item, output };
        if (reference) savings.duplicateOutputs++; else { savings.archivedOutputs++; latest.set(digest, { item: i, part }); }
      } catch { /* 不丢弃无法归档的结果 */ }
    }
  }
  savings.optimizedBytes = Buffer.byteLength(JSON.stringify(result));
  return { input: result, savings };
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
  private readonly pending: { input?: any[]; output: any[]; bytes: number }[] = [];
  resolve(body: any): any[] | undefined {
    if (!Array.isArray(body?.input)) return;
    if (!body.previous_response_id) return body.input;
    const prefix = this.completed.get(body.previous_response_id);
    if (prefix) return [...prefix, ...body.input];
  }
  request(body: any): void {
    if (body?.type === 'response.create') {
      const input = this.resolve(body), bytes = input ? Buffer.byteLength(JSON.stringify(input)) : 0;
      this.pending.push({ input: bytes <= MAX_TRACKED_BYTES ? input : undefined, output: [], bytes });
    }
    if (this.pending.length > 16) this.clear();
  }
  event(event: any): void {
    const current = this.pending[0]; if (!current) return;
    if (event?.type === 'response.output_item.done' && event.item && current.input) {
      current.bytes += Buffer.byteLength(JSON.stringify(event.item));
      if (current.bytes > MAX_TRACKED_BYTES) { current.input = undefined; current.output = []; }
      else current.output.push(event.item);
    }
    if (event?.type === 'response.completed') {
      this.pending.shift();
      const response = event.response;
      // 部分服务端 completed 不再重复 output；存在更完整的最终列表时优先采用。
      const output = Array.isArray(response?.output) && response.output.length >= current.output.length ? response.output :
        current.output.length ? current.output : undefined;
      if (current.input && typeof response?.id === 'string' && Array.isArray(output)) {
        const items = [...current.input, ...output];
        if (Buffer.byteLength(JSON.stringify(items)) <= MAX_TRACKED_BYTES) {
          this.completed.set(response.id, items);
          while (this.completed.size > 2) this.completed.delete(this.completed.keys().next().value!);
        }
      }
    } else if (event?.type === 'error' || event?.type === 'response.failed' || event?.type === 'response.incomplete') this.pending.shift();
  }
  clear(): void { this.pending.length = 0; this.completed.clear(); }
}
