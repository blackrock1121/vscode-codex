import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RpcMessage } from './rpc';
import type { TransportDiagnostic } from './telemetry';

export type PerformanceRow = Record<string, unknown>;
export interface PerformanceContext { traceId: string; startedAt: number; startedWallMs: number; queueMs?: number }
export function performanceContext(queueMs?: number): PerformanceContext {
  return { traceId: randomUUID(), startedAt: performance.now(), startedWallMs: Date.now(),
    queueMs: typeof queueMs === 'number' && Number.isFinite(queueMs) && queueMs >= 0 ? Math.round(Math.min(queueMs, 604800000)) : undefined };
}
export function diagnosticId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w.:-]{1,160}$/.test(value) ? value : undefined;
}
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 只输出分类，不记录命令、参数、输出、错误正文或路径。分类是线索，不是根因断言。 */
export function failureCategory(value: unknown, exitCode?: number | null): string {
  const text = typeof value === 'string' ? value.slice(0, 32768) : '';
  if (/command not found|not recognized as an internal|executable file not found/i.test(text) || exitCode === 127) return 'command_not_found';
  if (/ModuleNotFoundError|MODULE_NOT_FOUND|Cannot find module|No module named|missing dependency/i.test(text)) return 'missing_dependency';
  if (/exec format error|no matching manifest|wrong architecture|incompatible architecture/i.test(text)) return 'architecture_mismatch';
  if (/permission denied|operation not permitted|EACCES|EPERM/i.test(text) || exitCode === 126) return 'permission';
  if (/timed?\s*out|ETIMEDOUT|请求超时/i.test(text) || exitCode === 124) return 'timeout';
  if (/429|rate.?limit|too many requests/i.test(text)) return 'rate_limit';
  if (/ENOTFOUND|EAI_AGAIN|could not resolve|name resolution/i.test(text)) return 'dns';
  if (/ECONNRESET|ECONNREFUSED|connection reset|connection refused|502 Bad Gateway|503 Service/i.test(text)) return 'network_or_service';
  if (/401 Unauthorized|403 Forbidden|authentication failed|unauthorized/i.test(text)) return 'authentication';
  if (/syntax error|SyntaxError|unexpected token|unterminated/i.test(text)) return 'syntax';
  if (/error TS\d+|compilation failed|build failed|test.*failed|FAIL\s/i.test(text)) return 'build_or_test';
  if (/No such file or directory|ENOENT/i.test(text)) return 'missing_file';
  return exitCode ? 'nonzero_exit' : 'unknown';
}

type Kind = 'bash' | 'tool' | 'agent' | 'agent_wait' | 'compaction' | 'reasoning' | 'message' | 'approval' | 'question' | 'child_validation' | 'pretool';
interface Span {
  key: string; spanId: number; kind: Kind; threadId?: string; turnId?: string; itemId?: string;
  start: number; lastOutput?: number; firstOutputMs?: number; outputBytes: number; outputEvents: number;
  tool?: string; fingerprint?: string; program?: string; repeated?: number; parentThreadId?: string;
}
interface Run {
  context: PerformanceContext; threadId?: string; turnId?: string; threads: Set<string>; turns: Set<string>;
  rootEndedAt?: number; endedWallMs?: number; lastAt: number; lastEventAt: number; sequence: number;
  spans: Map<string, Span>; ended: Set<string>; fingerprints: Map<string, number>;
  phases: Record<string, number>; kinds: Record<string, { count: number; failed: number; totalMs: number; maxMs: number }>;
  toolCount: number; failures: number; retries: number; repeated: number; maxTools: number; maxAgents: number;
  parallelToolMs: number; parallelAgentMs: number; incomplete: number; dropped: number;
  firstEventMs?: number; firstTextMs?: number; firstReasoningMs?: number; firstToolMs?: number;
  maxEventLoopDelayMs: number; lastHeartbeatAt: number; cpu: NodeJS.CpuUsage;
}
const TOOLS = new Set<Kind>(['bash', 'tool']);
const PROGRAMS = new Set(['bash', 'sh', 'zsh', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'python', 'python3',
  'pip', 'pip3', 'uv', 'go', 'cargo', 'rustc', 'make', 'cmake', 'docker', 'git', 'gh', 'rg', 'grep', 'curl', 'wget',
  'ssh', 'scp', 'rsync', 'brew', 'sed', 'awk', 'cat', 'ls', 'find', 'sleep', 'timeout', 'tsc', 'pytest']);

/** 所有时长用单调时钟。并行累计时长与互斥墙钟分开，缺少事件的时间明确归为未观测。 */
export class PerformanceTrace {
  private run?: Run;
  private readonly recent: Pick<Run, 'context' | 'threadId' | 'turnId' | 'threads' | 'turns' | 'endedWallMs'>[] = [];
  private readonly salt = randomUUID();
  private timer?: NodeJS.Timeout;
  private readonly arrivals = new WeakMap<RpcMessage, number>();
  constructor(private readonly emit: (row: PerformanceRow) => void,
    private readonly now = () => performance.now(), private readonly wall = () => Date.now(),
    private readonly transport = (): PerformanceRow => ({})) {}
  get currentTraceId(): string | undefined { return this.run?.context.traceId; }
  private write(event: string, extra: PerformanceRow = {}): void {
    const r = this.run;
    try { this.emit({ schema: 1, event, atMs: this.wall(), traceId: r?.context.traceId ?? null,
      threadId: r?.threadId ?? null, turnId: r?.turnId ?? null, ...extra }); } catch { /* 诊断不影响执行 */ }
  }
  begin(threadId: string | undefined, settings: PerformanceRow, context?: PerformanceContext): void {
    if (this.run) this.finish('superseded');
    const at = this.now();
    const c = context ?? { traceId: randomUUID(), startedAt: at, startedWallMs: this.wall() };
    this.run = { context: c, threadId, threads: new Set(threadId ? [threadId] : []), turns: new Set(),
      lastAt: at, lastEventAt: at, sequence: 0, spans: new Map(), ended: new Set(), fingerprints: new Map(),
      phases: { preparation: Math.max(0, at - c.startedAt) }, kinds: {}, toolCount: 0, failures: 0, retries: 0,
      repeated: 0, maxTools: 0, maxAgents: 0, parallelToolMs: 0, parallelAgentMs: 0, incomplete: 0, dropped: 0,
      maxEventLoopDelayMs: 0, lastHeartbeatAt: at, cpu: process.cpuUsage() };
    this.write('turn_start', { startedAtMs: c.startedWallMs, queueMs: c.queueMs ?? 0, ...settings,
      timingScope: 'client_observed', serverQueueMs: null, networkTransitMs: null });
    this.timer = setInterval(() => this.heartbeat(), 30000); this.timer.unref();
  }
  received(message: RpcMessage): void { this.arrivals.set(message, this.now()); }
  private counts() {
    const counts: Partial<Record<Kind, number>> = {};
    for (const span of this.run?.spans.values() ?? []) counts[span.kind] = (counts[span.kind] ?? 0) + 1;
    return counts;
  }
  private settle(): void {
    const r = this.run; if (!r) return;
    const at = this.now(), delta = Math.max(0, at - r.lastAt); r.lastAt = at;
    const n = this.counts(), tools = (n.tool ?? 0) + (n.bash ?? 0), agents = n.agent ?? 0;
    const phase = n.question || n.approval ? 'user_wait' : n.compaction ? 'compaction' : tools ? 'tools' :
      n.pretool || n.child_validation ? 'local_preparation' : n.reasoning || n.message ? 'model_visible' :
      r.rootEndedAt !== undefined && agents ? 'child_tail' : n.agent_wait ? 'agent_wait' : 'unobserved';
    r.phases[phase] = (r.phases[phase] ?? 0) + delta;
    if (tools > 1) r.parallelToolMs += delta;
    if (agents > 1) r.parallelAgentMs += delta;
    r.maxTools = Math.max(r.maxTools, tools); r.maxAgents = Math.max(r.maxAgents, agents);
  }
  start(key: string, kind: Kind, fields: Partial<Span> = {}): void {
    const r = this.run; if (!r || r.spans.has(key) || r.ended.has(key)) return;
    if (r.spans.size >= 2048) { r.dropped++; return; }
    this.settle();
    const span: Span = { key, kind, spanId: ++r.sequence, start: this.now(), outputBytes: 0, outputEvents: 0, ...fields };
    r.spans.set(key, span);
    if (span.threadId) r.threads.add(span.threadId);
    if (span.turnId) r.turns.add(span.turnId);
    if (TOOLS.has(kind)) {
      r.toolCount++; r.firstToolMs ??= Math.round(this.now() - r.context.startedAt);
      if (span.fingerprint) {
        span.repeated = r.fingerprints.get(span.fingerprint) ?? 0;
        if (span.repeated) r.repeated++;
        if (r.fingerprints.size < 1024) r.fingerprints.set(span.fingerprint, span.repeated + 1);
      }
    }
    this.settle();
    this.write('span_start', this.fields(span));
  }
  private fields(s: Span): PerformanceRow {
    return { spanId: s.spanId, kind: s.kind, threadId: s.threadId ?? this.run?.threadId ?? null,
      turnId: s.turnId ?? this.run?.turnId ?? null, itemId: s.itemId ?? null, tool: s.tool ?? null,
      commandFingerprint: s.fingerprint ?? null, program: s.program ?? null, repeated: s.repeated ?? 0,
      parentThreadId: s.parentThreadId ?? null };
  }
  end(key: string, outcome = 'completed', fields: PerformanceRow = {}): void {
    const r = this.run, span = r?.spans.get(key); if (!r || !span) return;
    this.settle(); r.spans.delete(key); r.ended.add(key);
    if (r.ended.size > 4096) r.ended.delete(r.ended.values().next().value!);
    const durationMs = Math.max(0, this.now() - span.start);
    const k = r.kinds[span.kind] ??= { count: 0, failed: 0, totalMs: 0, maxMs: 0 };
    k.count++; k.totalMs += durationMs; k.maxMs = Math.max(k.maxMs, durationMs);
    if (outcome === 'failed') { k.failed++; if (TOOLS.has(span.kind)) r.failures++; }
    if (outcome === 'incomplete') r.incomplete++;
    this.write('span_end', { ...this.fields(span), durationMs: Math.round(durationMs), outcome,
      firstOutputMs: span.firstOutputMs ?? null, outputBytes: span.outputBytes, outputEvents: span.outputEvents,
      outputIdleMs: Math.round(this.now() - (span.lastOutput ?? span.start)), ...fields });
  }
  registerChild(threadId: string, parentThreadId?: string): void {
    if (!this.run) return;
    this.run.threads.add(threadId);
    this.start(`agent:${threadId}`, 'agent', { threadId, parentThreadId });
  }
  private itemKey(threadId: string | undefined, turnId: string | undefined, itemId: string) {
    return JSON.stringify([threadId, turnId, itemId]);
  }
  observe(message: RpcMessage, child = false, parentThreadId?: string): void {
    const r = this.run; if (!r) return;
    const p = message.params ?? {}, method = message.method ?? '';
    const threadId = diagnosticId(p.threadId) ?? r.threadId;
    const turnId = diagnosticId(p.turnId ?? p.turn?.id) ?? (!child ? r.turnId : undefined);
    const at = this.now(); r.lastEventAt = at;
    if (turnId) { r.turns.add(turnId); if (!child) r.turnId = turnId; }
    if (child && threadId && method !== 'turn/completed' && method !== 'thread/closed') this.registerChild(threadId, parentThreadId);
    if (method === 'turn/started') {
      // resumed 子线程的新轮次使用相同 agent ID，单独记录每轮，不能复活旧已结束轮次。
      if (child && threadId) { r.ended.delete(`agent:${threadId}`); this.registerChild(threadId, parentThreadId); }
      this.write('agent_turn_start', { threadId, turnId, parentThreadId: parentThreadId ?? null, role: child ? 'child' : 'root',
        startupMs: child ? Math.round(at - (r.spans.get(`agent:${threadId}`)?.start ?? at)) : null,
        routingDelayMs: Math.round(at - (this.arrivals.get(message) ?? at)) });
      return;
    }
    if (method === 'turn/completed' || method === 'thread/closed') {
      const outcome = p.turn?.status === 'failed' ? 'failed' : p.turn?.status === 'interrupted' ? 'interrupted' : 'completed';
      for (const [key, span] of r.spans) if (span.threadId === threadId && span.kind !== 'question' && span.kind !== 'approval' && span.kind !== 'agent') this.end(key, 'incomplete');
      if (child) this.end(`agent:${threadId}`, outcome);
      else { this.settle(); r.rootEndedAt = at; }
      this.write('agent_turn_end', { threadId, turnId, role: child ? 'child' : 'root', outcome });
      return;
    }
    if (method === 'error') {
      if (p.willRetry) r.retries++;
      this.write('retry', { threadId, turnId, willRetry: p.willRetry === true,
        category: failureCategory(p.error?.message ?? p.message) }); return;
    }
    const item = p.item;
    const itemId = diagnosticId(item?.id ?? p.itemId);
    if (method.includes('Delta') || method.endsWith('/delta') || method.endsWith('TextDelta') || method.endsWith('/textDelta')) {
      if (!child && typeof p.delta === 'string' && p.delta.length) {
        r.firstEventMs ??= Math.round(at - r.context.startedAt);
        if (method.includes('agentMessage')) r.firstTextMs ??= Math.round(at - r.context.startedAt);
        if (method.includes('reasoning')) r.firstReasoningMs ??= Math.round(at - r.context.startedAt);
      }
      const span = itemId ? r.spans.get(this.itemKey(threadId, turnId, itemId)) : undefined;
      if (span && typeof p.delta === 'string' && p.delta.length) {
        span.firstOutputMs ??= Math.round(at - span.start); span.lastOutput = at;
        span.outputBytes += Buffer.byteLength(p.delta); span.outputEvents++;
      }
      return;
    }
    if (!item || !itemId || !['item/started', 'item/completed'].includes(method) || ['userMessage', 'hookPrompt', 'subAgentActivity'].includes(item.type)) return;
    r.firstEventMs ??= Math.round(at - r.context.startedAt);
    const key = this.itemKey(threadId, turnId, itemId);
    const tool = diagnosticId(item.tool) ?? diagnosticId(item.type) ?? 'unknown';
    const kind: Kind = item.type === 'commandExecution' ? 'bash' : item.type === 'collabAgentToolCall' && /^(wait|waitAgent|wait_agent)$/.test(tool) ? 'agent_wait' : item.type === 'contextCompaction' ? 'compaction' :
      item.type === 'reasoning' ? 'reasoning' : ['agentMessage', 'plan'].includes(item.type) ? 'message' : 'tool';
    if (method === 'item/started') {
      const command = typeof item.command === 'string' ? item.command :
        typeof item.arguments?.cmd === 'string' ? item.arguments.cmd : typeof item.arguments?.command === 'string' ? item.arguments.command : undefined;
      const program = command?.trim().split(/\s/, 1)[0]?.split('/').at(-1);
      this.start(key, kind, { threadId, turnId, itemId, tool,
        fingerprint: command && command.length <= 65536 ? createHmac('sha256', this.salt).update(command).digest('hex').slice(0, 20) : undefined,
        program: command ? program && PROGRAMS.has(program) ? program : 'other' : undefined });
      return;
    }
    const exitCode = Number.isInteger(item.exitCode) ? item.exitCode : null;
    const output = item.aggregatedOutput ?? item.error?.message ?? item.result?.error?.message ??
      (Array.isArray(item.contentItems) ? item.contentItems.find((x: any) => typeof x?.text === 'string')?.text : undefined) ??
      (Array.isArray(item.result?.content) ? item.result.content.find((x: any) => typeof x?.text === 'string')?.text : undefined);
    const noMatch = exitCode === 1 && /^(rg|grep)\s/.test(item.command ?? '') && !/[|;&\n]/.test(item.command ?? '') && !output;
    const failed = !noMatch && (item.status === 'failed' || item.success === false || item.isError === true || item.result?.isError === true || !!item.error || (exitCode !== null && exitCode !== 0));
    if (!r.spans.has(key)) {
      if (!r.ended.has(key)) {
        r.incomplete++; r.ended.add(key);
        if (r.ended.size > 4096) r.ended.delete(r.ended.values().next().value!);
        this.write('span_unmatched_end', { kind, threadId, turnId, itemId, tool, durationMs: null,
          serverDurationMs: numeric(item.durationMs) ?? null, outcome: failed ? 'failed' : 'unknown', incomplete: true });
      }
      return;
    }
    this.end(key, failed ? 'failed' : item.status === 'declined' ? 'declined' : 'completed', {
      exitCode, serverDurationMs: numeric(item.durationMs) ?? null, expectedNoMatch: noMatch,
      resultBytes: typeof output === 'string' ? Buffer.byteLength(output) : null,
      receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(diagnosticId).filter(Boolean).slice(0, 32) : undefined,
      failureCategory: failed ? failureCategory(output, exitCode) : null,
      routingDelayMs: Math.round(at - (this.arrivals.get(message) ?? at)) });
  }
  approval(id: string, question: boolean, threadId?: string, turnId?: string, itemId?: string): void {
    this.start(`approval:${id}`, question ? 'question' : 'approval', { threadId, turnId, itemId });
  }
  resolved(id: string, outcome: string): void { this.end(`approval:${id}`, outcome); }
  associate(row: TransportDiagnostic): string | null {
    if (row.type === 'metric') return null;
    const threadId = row['conversation.id'] ?? row.thread_id ?? row.threadId;
    const turnId = row['turn.id'] ?? row.turn_id ?? row.turnId;
    const time = typeof row.sourceTimeMs === 'number' ? row.sourceTimeMs : undefined;
    const candidates = [...this.recent, ...(this.run ? [this.run] : [])].filter(r =>
      (!threadId || r.threads.has(String(threadId))) && (turnId ? r.turns.has(String(turnId)) :
        !!threadId && time !== undefined && time >= r.context.startedWallMs && time <= (r.endedWallMs ?? this.wall())));
    return candidates.length === 1 ? candidates[0].context.traceId : null;
  }
  heartbeat(): void {
    const r = this.run; if (!r) return;
    const at = this.now(); r.maxEventLoopDelayMs = Math.max(r.maxEventLoopDelayMs, Math.max(0, at - r.lastHeartbeatAt - 30000));
    r.lastHeartbeatAt = at; this.settle();
    const cpu = process.cpuUsage(r.cpu); r.cpu = process.cpuUsage();
    this.write('heartbeat', { elapsedMs: Math.round(at - r.context.startedAt), idleMs: Math.round(at - r.lastEventAt),
      active: [...r.spans.values()].slice(0, 16).map(s => ({ ...this.fields(s), elapsedMs: Math.round(at - s.start),
        outputIdleMs: Math.round(at - (s.lastOutput ?? s.start)), outputBytes: s.outputBytes })),
      activeCount: r.spans.size, rssBytes: process.memoryUsage().rss, extensionHostCpuMs: Math.round((cpu.user + cpu.system) / 1000),
      maxEventLoopDelayMs: Math.round(r.maxEventLoopDelayMs), processScope: 'extension_host_shared', ...this.transport() });
  }
  finish(outcome: string): void {
    const r = this.run; if (!r) return;
    this.settle();
    for (const key of [...r.spans.keys()]) this.end(key, 'incomplete');
    clearInterval(this.timer); this.timer = undefined;
    r.endedWallMs = this.wall();
    this.write('turn_summary', { outcome, elapsedMs: Math.round(this.now() - r.context.startedAt), queueMs: r.context.queueMs ?? 0,
      phasesMs: Object.fromEntries(Object.entries(r.phases).map(([k, v]) => [k, Math.round(v)])),
      toolCount: r.toolCount, failures: r.failures, retries: r.retries, repeatedCommands: r.repeated,
      maxParallelTools: r.maxTools, parallelToolMs: Math.round(r.parallelToolMs), maxParallelAgents: r.maxAgents,
      parallelAgentMs: Math.round(r.parallelAgentMs), childTailMs: r.rootEndedAt === undefined ? 0 : Math.round(this.now() - r.rootEndedAt),
      firstEventMs: r.firstEventMs ?? null, firstTextMs: r.firstTextMs ?? null, firstReasoningMs: r.firstReasoningMs ?? null,
      firstToolMs: r.firstToolMs ?? null, incompleteSpans: r.incomplete, droppedSpans: r.dropped,
      kinds: Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, { ...v, totalMs: Math.round(v.totalMs), maxMs: Math.round(v.maxMs) }])),
      note: 'phases_exclusive_kinds_overlap_model_visible_is_not_server_inference', maxEventLoopDelayMs: Math.round(r.maxEventLoopDelayMs), ...this.transport() });
    this.recent.push({ context: r.context, threadId: r.threadId, turnId: r.turnId, threads: r.threads, turns: r.turns, endedWallMs: r.endedWallMs });
    if (this.recent.length > 64) this.recent.shift();
    this.run = undefined;
  }
}
