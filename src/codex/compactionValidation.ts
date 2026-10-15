import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexRpc, RpcMessage } from './rpc';
import { CompactionRelay } from './compactionRelay';
import { ValidationResult, VALIDATION_TOTAL } from './compactionPolicy';

const facts = {
  port: '4317', timeout: '4700', branch: 'feature/orbit', commit: 'f83a902', architecture: 'amd64',
  logPattern: 'logs/session-*.jsonl', job: 'job-P73', checksum: 'SUM-9182', version: '0.8.17', timezone: 'Asia/Shanghai',
  retryLimit: '2', testCount: '57', rolloutPhase: 'paused', minSamples: '9', owner: '乔宁', artifact: 'release/orbit.vsix',
};
const decisions = { deployAllowed: false, fastWhenNormal: false, continueWhenSyncFails: false,
  tailMustRemain: true, toolPairMaySplit: false, claimLatencyDecomposed: false };
export { VALIDATION_TOTAL } from './compactionPolicy';
export function validationFixture(): any[] {
  const message = (text: string, role = 'user') => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
  const rows: any[] = [message('这是合成的 Orbit 任务记录。保留最新事实、约束、未完成工作及被否决方案。旧方案端口 3000，超时 1000，版本 0.8.10，测试数 41，部署曾计划自动执行。')];
  const entries = Object.entries(facts);
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    rows.push(message(`最新已确认字段 ${key} = ${value}。如早先记录不同，以本次为准。`));
    rows.push(message(`第 ${i + 1} 项已完成检查。` + '历史诊断：缓存命中、路径检查和重复输出均已归档，无待处理故障。'.repeat(45), 'assistant'));
  }
  rows.splice(15, 0, message('新的明确约束：没有部署授权，不得部署。普通会话不得为压缩开启快速档位。设置同步失败必须取消压缩。最近新增轮次必须保留；不能把工具调用和结果拆在摘要切点两侧。客户端耗时不足以拆出模型推理、网络和排队耗时。'));
  rows.push(message('当前工作：等待足够样本和部署批准，部署仍暂停。不要把早期设想、工具日志或“已检查”误当成发布授权。'));
  return rows;
}
export const validationQuestions = '仅根据压缩后的 Orbit 任务记录输出 JSON，不调用工具，不推断缺失事实。facts 中逐一给出最新字段 port、timeout、branch、commit、architecture、logPattern、job、checksum、version、timezone、retryLimit、testCount、rolloutPhase、minSamples、owner、artifact，值均为字符串；未知填 UNKNOWN。decisions 中回答布尔值：deployAllowed 当前是否获准部署；fastWhenNormal 普通会话是否可以为压缩开启快速；continueWhenSyncFails 设置同步失败能否继续压缩；tailMustRemain 新增最近轮次是否必须保留；toolPairMaySplit 工具调用和结果能否拆开；claimLatencyDecomposed 是否已经能够精确拆分网络、排队、推理耗时。';
export const validationSchema = { type: 'object', additionalProperties: false, required: ['facts', 'decisions'], properties: {
  facts: { type: 'object', additionalProperties: false, required: Object.keys(facts), properties: Object.fromEntries(Object.keys(facts).map(k => [k, { type: 'string' }])) },
  decisions: { type: 'object', additionalProperties: false, required: Object.keys(decisions), properties: Object.fromEntries(Object.keys(decisions).map(k => [k, { type: 'boolean' }])) },
} };
export function scoreValidation(answer: any): number {
  return Object.entries(facts).filter(([k, v]) => answer?.facts?.[k] === v).length +
    Object.entries(decisions).filter(([k, v]) => answer?.decisions?.[k] === v).length;
}

/** 仅用于隔离评测：跨重试共用限额，不让 CLI 重连绕开预算。普通用户请求不会经过此函数。 */
export class ValidationBudget {
  generations = 0; frames = 0; bytes = 0; outputTokenBudget = 0;
  constructor(private readonly exceeded: () => void) {}
  constrain = (raw: Buffer): Buffer => {
    const body = JSON.parse(raw.toString());
    this.frames++;
    const generation = body.generate !== false;
    // 原生 v2 压缩要求至少 20000；这是允许的上限，不代表每次实际消耗。
    const outputLimit = body.input?.at(-1)?.type === 'compaction_trigger' ? 20000 : 2048;
    if (generation) { this.generations++; this.outputTokenBudget += outputLimit; }
    // 同时禁止原生工具和动态工具；明确普通档位，避免独立评测继承高价档位。
    body.tools = []; body.tool_choice = 'none'; body.service_tier = 'default';
    body.max_output_tokens = outputLimit;
    const encoded = Buffer.from(JSON.stringify(body));
    this.bytes += encoded.length;
    if (this.frames > 12 || this.generations > 4 || this.outputTokenBudget > 44096 || this.bytes > 768 * 1024 || encoded.length > 192 * 1024) {
      this.exceeded(); throw Error('评测限额已到');
    }
    return encoded;
  };
}

export async function validateCompactionModel(options: {
  codexPath: string; env?: NodeJS.ProcessEnv; upstream: string; candidate: string; baseline: string; reader: string; signal: AbortSignal; diagnostic?: (category: string) => void;
}): Promise<ValidationResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compaction-eval-'));
  const rpc = new CodexRpc(options.codexPath, dir, options.env, false);
  let relay: CompactionRelay | undefined, timer: NodeJS.Timeout | undefined;
  let current: { threadId: string; text: string; compacted: boolean; resolve(): void; reject(error: Error): void } | undefined;
  const stop = () => { current?.reject(Error('评测已停止')); rpc.dispose(); relay?.close(); };
  const budget = new ValidationBudget(stop);
  const notification = ({ method, params: p }: RpcMessage) => {
    if (!current || p?.threadId !== current.threadId) return;
    if (method === 'item/agentMessage/delta') current.text += p.delta;
    if (method === 'item/completed' && p.item?.type === 'agentMessage' && !current.text) current.text = p.item.text ?? '';
    if (method === 'item/completed' && p.item?.type === 'contextCompaction') current.compacted = true;
    if (method === 'turn/completed') p.turn.status === 'completed' ? current.resolve() : current.reject(Error('评测轮次失败'));
    if (method === 'error' && !p.willRetry) {
      options.diagnostic?.(String(p.error?.codexErrorInfo ?? 'unknown'));
      current.reject(Error('评测请求失败'));
    }
    if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall'].includes(p.item?.type)) stop();
  };
  rpc.on('notification', notification);
  rpc.on('close', () => current?.reject(Error('评测连接已关闭')));
  rpc.on('request', m => rpc.reject(m.id!, '隔离评测不使用工具'));
  options.signal.addEventListener('abort', stop, { once: true });
  const phase = async (threadId: string, dispatch: () => Promise<unknown>) => {
    if (options.signal.aborted) throw Error('评测已停止');
    let resolve!: () => void, reject!: (e: Error) => void;
    const done = new Promise<void>((r, j) => { resolve = r; reject = j; });
    // 先注册处理器，RPC 受理可能晚于完成通知。
    const state = current = { threadId, text: '', compacted: false, resolve, reject };
    await Promise.all([dispatch(), done]);
    current = undefined; return state;
  };
  try {
    if (options.signal.aborted) throw Error('评测已停止');
    timer = setTimeout(stop, 180_000);
    relay = await CompactionRelay.start(options.upstream, () => undefined, () => {}, { constrain: budget.constrain });
    await rpc.start();
    const results: { milliseconds: number; score: number }[] = [];
    for (const model of [options.baseline, options.candidate]) {
      const started = await rpc.request('thread/start', { ephemeral: true, model, allowProviderModelFallback: false,
        serviceTier: 'default', approvalPolicy: 'never', sandbox: 'read-only',
        config: { openai_base_url: relay.baseUrl, model_reasoning_effort: 'xhigh', 'features.multi_agent': false },
        developerInstructions: '仅执行合成上下文压缩质量测试。禁止使用任何工具。' });
      const threadId = started.thread.id;
      await rpc.request('thread/inject_items', { threadId, items: validationFixture() });
      const at = performance.now();
      const compacted = await phase(threadId, () => rpc.request('thread/compact/start', { threadId }));
      const milliseconds = Math.round(performance.now() - at);
      if (!compacted.compacted) throw Error('未完成原生压缩');
      const answer = await phase(threadId, () => rpc.request('turn/start', { threadId, model: options.reader, effort: 'medium',
        serviceTier: 'default', input: [{ type: 'text', text: validationQuestions, text_elements: [] }], environments: [], outputSchema: validationSchema }));
      let parsed: unknown; try { parsed = JSON.parse(answer.text); } catch { throw Error('评测答案格式无效'); }
      results.push({ milliseconds, score: scoreValidation(parsed) });
    }
    const [baseline, candidate] = results;
    return { passed: baseline.score === VALIDATION_TOTAL && candidate.score === VALIDATION_TOTAL && candidate.milliseconds <= baseline.milliseconds * 1.25,
      baselineModel: options.baseline, baselineMs: baseline.milliseconds, candidateMs: candidate.milliseconds,
      baselineScore: baseline.score, candidateScore: candidate.score, total: VALIDATION_TOTAL };
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', stop);
    current = undefined; relay?.close(); await rpc.disposeAndWait(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
