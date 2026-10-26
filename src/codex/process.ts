import { errorFields, operationFailure, operationLog } from '../operations';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { CTX_OPEN, CTX_CLOSE, modelChoices, ModelChoice, SpeedMode, speedServiceTier, speedLabel, supportsSpeed, isSpeedMode, billingKind, PermissionSuggestionView, ToWebview, QuestionAnswerModes } from '../shared';
import { CodexRpc, RpcMessage, RpcId } from './rpc';
import { QUESTION_REPLY_PREFIX, asyncQuestions, normalizeQuestions, toolView, quotaEvents, questionAnswerMetadata } from './events';
import { AnswerImage, QuestionImages, QUESTION_IMAGE_ANSWER, validateQuestionImages } from '../questionImages';
import { TransportDiagnostic } from './telemetry';
import { PerformanceTrace, PerformanceContext } from './performanceTrace';
import { ChildThreadRegistry, childToolId } from './childThreads';
import { executionConfig, executionInstructions } from './executionPolicy';
import { CompactionRelay, CompactionRoute, compactionUpstream } from './compactionRelay';
import { CompactionPolicy, CompactionValidationStore, modelRank } from './compactionPolicy';
import { validateCompactionModel } from './compactionValidation';
export { ChildThreadRegistry, childToolId } from './childThreads';

const USER_DECISION_INSTRUCTIONS = '当任务需要用户选择、确认业务事实、付款或其他明确决定时，必须调用 AskUserQuestion 向用户提问；恢复的旧会话若没有此工具，调用原生 request_user_input_async 或 request_user_input，客户端同样会展示问题卡片并暂停等待答案。不要只在普通消息里列出问题或选项。等待由客户端处理，禁止调用 sleep、执行休眠命令或轮询来等待用户。不要替用户选择选项，也不要在提出问题后自行继续依赖该答案的步骤。用户未提交答案时不得因为等待时间较长而继续任务或给出最终答复。';
const ASK_USER_QUESTION_TOOL = {
  type: 'function', name: 'AskUserQuestion',
  description: '向用户展示一个或多个可选问题，并等待用户提交答案。需要用户选择或确认时必须调用此工具。',
  inputSchema: {
    type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', properties: {
        id: { type: 'string' }, question: { type: 'string' }, header: { type: 'string' },
        isOther: { type: 'boolean' }, isSecret: { type: 'boolean' }, options: { type: 'array', items: { type: 'object', properties: {
          label: { type: 'string' }, description: { type: 'string' },
        }, required: ['label'] } },
      }, required: ['question', 'options'],
    } } }, required: ['questions'],
  },
};

export interface CodexProcessOptions {
  codexPath: string; cwd: string; model?: string; effort?: string; speedMode?: SpeedMode; permissionMode: string;
  questionStateDir?: string; resumeSessionId?: string; addDirs?: string[]; appendSystemPrompt?: string; env?: NodeJS.ProcessEnv;
  transportDiagnostics?: boolean;
  compactionMode?: 'balanced' | 'session';
  compactionModel?: string; compactionAutoValidate?: boolean; compactionStateDir?: string;
  executionMode?: 'parallel' | 'tools' | 'standard';
}
export interface PermissionRequest {
  requestId: string; toolUseId?: string; toolName: string; displayName?: string;
  agentLabel?: string;
  input: Record<string, unknown>; description?: string; suggestions: PermissionSuggestionView[];
  initialAnswers?: Record<string, string | string[]>;
  initialAnswerModes?: QuestionAnswerModes;
  initialImages?: QuestionImages;
}
export interface CodexProcessHooks {
  emit: (event: ToWebview) => void; onPermission: (request: PermissionRequest) => void;
  onSessionId: (id: string, resumed: boolean) => void; onClose: (code: number | null) => void;
  onPreTool?: (name: string, input: Record<string, unknown>) => Promise<void>;
}
export function permissions(mode: string, roots: string[]) {
  if (mode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
  if (mode === 'acceptEdits') return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
  if (mode === 'plan') return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
  if (mode !== 'default') throw new Error(`不支持的权限模式：${mode}`);
  return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
}
export function questionStateFile(dir: string, sessionId: string): string {
  return path.join(dir, `question-${encodeURIComponent(sessionId)}.json`);
}
export function deleteQuestionState(dir: string, sessionId: string): void {
  fs.rmSync(questionStateFile(dir, sessionId), { force: true });
}
export function saveQuestionState(dir: string, sessionId: string, turnId: string, request: PermissionRequest, beganAt = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = questionStateFile(dir, sessionId);
  fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, sessionId, turnId, beganAt, request }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function safeCompactionError(error: any): { errorCategory: string; httpStatusCode: number | null } {
  const info = error?.codexErrorInfo;
  const names = ['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
    'flexUnavailable', 'serverOverloaded', 'internalServerError', 'unauthorized', 'badRequest', 'other',
    'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'];
  const category = typeof info === 'string' && names.includes(info) ? info :
    info && typeof info === 'object' ? names.find(k => Object.hasOwn(info, k)) : undefined;
  const code = category && typeof info === 'object' ? info[category]?.httpStatusCode : undefined;
  return { errorCategory: category ?? 'unknown', httpStatusCode: Number.isInteger(code) && code >= 100 && code <= 599 ? code : null };
}
export function shouldUseCompactionRelay(platform: NodeJS.Platform, compactionMode: CodexProcessOptions['compactionMode'], processEnv: NodeJS.ProcessEnv, childEnv?: NodeJS.ProcessEnv): boolean {
  if (platform === 'win32' || compactionMode === 'session') return false;
  const env = { ...processEnv, ...childEnv };
  // 不覆盖环境指定的网关，也不让子进程专属代理设置在转发时丢失。
  return !env.OPENAI_BASE_URL && !Object.entries(childEnv ?? {}).some(([key, value]) =>
    /^(https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir|node_extra_ca_certs)$/i.test(key) && value !== processEnv[key]);
}
export class CodexProcess {
  private readonly rpc: CodexRpc;
  private readonly latency: PerformanceTrace;
  private sessionId?: string;
  private activeModel = "";
  private activeEffort?: string;
  private compactionRestore?: { operationId?: string; model: string; effort: string; pending: boolean; isError: boolean };
  private compactionRelay?: CompactionRelay;
  private readonly compactionRoutes = new Map<string, { traceId?: string; compactionId?: number }>();
  private compactionPreparation?: Promise<{ settings: any; identity: any } | undefined>;
  private autoCompactionsWithoutProgress = 0;
  private readonly compactionStore: CompactionValidationStore;
  private readonly compactionPolicy: CompactionPolicy;
  private compactionUpstreamUrl?: string;
  private validationTimer?: NodeJS.Timeout;
  private validationAbort?: AbortController;
  private hasWorked = false;
  private lastDispatched?: { model: string; effort: string; speedMode: SpeedMode };
  private models: ModelChoice[] = [];
  private modelsReady: Promise<void> = Promise.resolve();
  private modelsLoaded = false;
  private preparing?: Promise<void>;
  private starting?: Promise<void>;
  private dispatchSequence = 0;
  private readonly remoteInstance = randomUUID();
  private waitingForCatalog = false;
  private turnId?: string;
  private readonly endedTurns = new Set<string>();
  private busy = false;
  private exited = false;
  private disposed = false;
  private startingTurn?: Promise<void>;
  private beganAt = 0;
  private compacting = false;
  private contextUsage?: { used: number; total: number };
  private compactionSequence = 0;
  private compactionTrace?: {
    id: number; performanceTraceId?: string; trigger: 'manual' | 'auto'; startedAt: number; serverStartedAt?: number;
    startedWallMs: number; endedWallMs?: number; threadId?: string; turnId?: string; itemId?: string;
    requestAcceptedMs?: number; firstUsageMs?: number; lastTickAt: number; maxTimerDelayMs: number;
    speedMode: SpeedMode; effort: string; usage?: Record<string, number>;
    preTokens?: number; contextWindow?: number; latestTokens?: number; usageUpdates: number;
    retries: number; errors: number; model: string; modelSource: 'active_thread' | 'manual_override' | 'transport_override';
  };
  private readonly recentCompactions: NonNullable<CodexProcess['compactionTrace']>[] = [];
  private compactionTimer?: NodeJS.Timeout;
  private stopTimer?: NodeJS.Timeout;
  private stopSettled?: () => void;
  private readonly pending = new Map<string, { id: RpcId; method: string; params: any }>();
  private pausedQuestion?: { request: PermissionRequest; turnId?: string; ready: boolean; timer?: NodeJS.Timeout };
  private readonly streamed = new Set<string>();
  private activeBlock?: string;
  private readonly tools = new Map<string, any>();
  private readonly children = new ChildThreadRegistry();
  private readonly childChecks = new Map<string, Promise<boolean>>();
  private readonly childNotificationQueue = new Map<string, RpcMessage[]>();
  private readonly rejectedChildren = new Set<string>();
  private readonly childQuestions = new Map<string, any[]>();
  private readonly childInterrupts = new Map<string, Promise<void>>();
  private rootCompletion?: { isError: boolean };
  private stoppingTree = false;
  private lastActivityAt = 0;
  constructor(private readonly opts: CodexProcessOptions, private readonly hooks: CodexProcessHooks) {
    this.compactionStore = new CompactionValidationStore(opts.compactionStateDir);
    this.compactionPolicy = new CompactionPolicy(this.compactionStore, opts.compactionModel?.trim() || 'auto');
    this.latency = new PerformanceTrace(row => this.emit({ kind: 'diag', message: `[perf] ${JSON.stringify(row)}` }),
      undefined, undefined, () => this.rpc.transportSnapshot());
    this.rpc = new CodexRpc(opts.codexPath, opts.cwd, opts.env, opts.transportDiagnostics !== false);
    this.rpc.on('diagnostic', (row: TransportDiagnostic) => {
      row = this.latency.annotateTransport(row);
      // OTLP 会批量延迟到达：按源时间及线程关联，不能归到当前正在运行的轮次。
      const source = typeof row.sourceTimeMs === 'number' ? row.sourceTimeMs : undefined;
      const thread = row['conversation.id'] ?? row.thread_id;
      const trace = row.type === 'event' && source !== undefined && thread ?
        [...this.recentCompactions, ...(this.compactionTrace ? [this.compactionTrace] : [])].find(t =>
          thread === t.threadId && source >= t.startedWallMs && source <= (t.endedWallMs ?? Date.now())) : undefined;
      this.emit({ kind: 'diag', message: `[transport] ${JSON.stringify({ ...row, backendTraceId: row.traceId ?? null, traceId: this.latency.associate(row), compactionId: trace?.id ?? null })}` });
    });
    this.rpc.on('notification', (m: RpcMessage) => { try { this.notification(m); } catch (e) { this.handlerFailed('process.notification', e); } });
    this.rpc.on('request', (m: RpcMessage) => { void this.request(m).catch(e => this.handlerFailed('process.request', e)); });
    this.rpc.on('close', (code: number | null, reason: Error) => {
      this.cancelCompactionRestore();
      this.cancelCompactionValidation();
      this.latency.finish('connection_closed');
      this.compactionRelay?.close(); this.compactionRelay = undefined;
      this.endCompactionTrace('connection_closed');
      clearTimeout(this.stopTimer); clearTimeout(this.pausedQuestion?.timer);
      this.stopSettled?.(); this.stopSettled = undefined;
      this.clearChildState();
      if (this.busy && !this.disposed) this.error(reason);
      this.exited = true; this.busy = false; this.hooks.onClose(code);
    });
  }
  get modelForNextTurn() { return this.opts.model || this.activeModel; }
  get currentSessionId() { return this.sessionId; }
  get currentTurnId() {
    // 等待 turn/start 或根轮次结束但子任务仍运行时也能停止；跨进程/新轮次的旧操作不会命中。
    return this.busy ? this.turnId ?? this.pausedQuestion?.turnId ?? `${this.remoteInstance}-${this.dispatchSequence}-${this.compactionSequence}` : undefined;
  }
  get isBusy() { return this.busy; }
  get isExited() { return this.exited; }
  private emit(e: ToWebview) {
    if (!this.compactionTrace && (e.kind === 'text_delta' || e.kind === 'tool_result')) this.autoCompactionsWithoutProgress = 0;
    if (e.kind === 'permission_resolved') this.latency.resolved(e.requestId, e.auto ? 'cancelled' : e.behavior);
    if (!this.disposed) this.hooks.emit(e);
  }
  private showPermission(request: PermissionRequest): void {
    const p = this.pending.get(request.requestId)?.params;
    this.latency.approval(request.requestId, request.toolName === 'AskUserQuestion', p?.threadId ?? this.sessionId,
      p?.turnId ?? this.pausedQuestion?.turnId ?? this.turnId, p?.itemId ?? p?.callId ?? request.toolUseId);
    this.hooks.onPermission(request);
  }
  private async preTool(key: string, name: string, input: Record<string, unknown>, p: any): Promise<void> {
    this.latency.start(`pretool:${key}`, 'pretool', { threadId: p.threadId ?? this.sessionId, turnId: p.turnId, itemId: p.itemId });
    try { await this.hooks.onPreTool?.(name, input); }
    catch (error) { this.latency.end(`pretool:${key}`, 'failed', errorFields(error)); throw error; }
    finally { this.latency.end(`pretool:${key}`); }
  }
  private error(e: unknown) { this.emit({ kind: 'error', message: String(e instanceof Error ? e.message : e) }); }
  private handlerFailed(operation: string, error: unknown): void {
    // 委派到 error() 只会通知页面，无法落盘，也不会释放内部 busy/pending。
    // 状态处理异常后不能继续复用半更新的进程；不重放用户工具或生成请求。
    operationFailure(operation, error, { processRunId: this.rpc.runId, traceId: this.latency.currentTraceId });
    this.latency.finish('failed');
    this.endCompactionTrace('failed');
    this.exited = true; this.busy = false;
    try { this.error(error); }
    catch (deliveryError) { operationFailure('process.error.delivery', deliveryError, { processRunId: this.rpc.runId }); }
    finally { this.rpc.dispose(); }
  }
  private async timedRequest(method: string, params: unknown = {}): Promise<any> {
    const at = Date.now();
    try { return await this.rpc.request(method, params); }
    finally { this.emit({ kind: 'diag', message: `[rpc] ${method} ${Date.now() - at}ms` }); }
  }
  private async loadModels(): Promise<void> {
    try {
      const models: ModelChoice[] = [], seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const catalog = await this.timedRequest('model/list', { cursor });
        models.push(...modelChoices(catalog.data));
        cursor = catalog.nextCursor ?? null;
        if (cursor && seen.has(cursor)) throw new Error('模型列表分页游标重复');
        if (cursor) seen.add(cursor);
      } while (cursor);
      this.models = models;
      this.emit({ kind: 'models', models });
    } catch (e) {
      operationFailure('models.load', e);
      if (!this.exited) this.emit({ kind: 'notice', message: `模型列表读取失败，普通模式仍可使用：${String(e)}` });
    } finally { this.modelsLoaded = true; this.scheduleCompactionValidation(); }
  }
  /** 仅准备连接与模型目录；不创建会话、不发起模型生成。 */
  prepare(): Promise<void> {
    return this.preparing ??= (async () => {
      await this.rpc.start();
      this.prefetchCompactionSettings();
      this.modelsReady = this.loadModels();
    })();
  }
  start(): Promise<void> {
    return this.starting ??= this.startSession();
  }
  private async readAccount(): Promise<void> {
    try {
      const account = await this.timedRequest('account/read', { refreshToken: false });
      this.emit({ kind: 'speed_context', billing: billingKind(account.account?.type),
        planType: account.account?.type === 'chatgpt' ? account.account.planType : undefined });
    } catch (error) {
      operationFailure('account.background.read', error);
      // 账号读取只补充套餐显示；实际请求的鉴权交由 Codex，不能阻塞发送。
      if (!this.exited) this.emit({ kind: 'diag', message: '[account] 后台账号信息读取失败，不阻塞会话' });
    }
  }
  private async startSession(): Promise<void> {
    try {
      await this.prepare();
      await this.prepareCompactionRelay();
      const p = permissions(this.opts.permissionMode, this.opts.addDirs ?? [this.opts.cwd]);
      const mode = this.opts.executionMode ?? 'parallel';
      const params = { serviceTier: speedServiceTier(this.opts.speedMode ?? 'default'), cwd: this.opts.cwd, model: this.opts.model || null, approvalPolicy: p.approvalPolicy, approvalsReviewer: 'user', sandbox: p.sandbox, config: { ...executionConfig(mode), ...(this.compactionRelay ? { openai_base_url: this.compactionRelay.baseUrl } : {}) }, developerInstructions: [USER_DECISION_INSTRUCTIONS, executionInstructions(mode), this.opts.appendSystemPrompt].filter(Boolean).join('\n\n') };
      // resume 不支持 dynamicTools；旧会话沿用持久化工具，原生异步提问另行接入同一暂停流程。
      const result = await this.timedRequest(this.opts.resumeSessionId ? 'thread/resume' : 'thread/start', this.opts.resumeSessionId ? { ...params, threadId: this.opts.resumeSessionId } : { ...params, dynamicTools: [ASK_USER_QUESTION_TOOL] });
      if (this.opts.resumeSessionId && result.thread?.id !== this.opts.resumeSessionId)
        throw new Error('Codex 恢复了不同的会话 ID，已中止连接，避免串到其他会话。');
      this.activeModel = result.model ?? this.opts.model ?? "";
      this.activeEffort = result.reasoningEffort ?? undefined;
      this.sessionId = result.thread.id;
      this.children.setRoot(result.thread);
      this.hooks.onSessionId(this.sessionId!, !!this.opts.resumeSessionId);
      this.emit({ kind: 'session', sessionId: this.sessionId!, cwd: this.opts.cwd, model: result.model ?? '', tools: [], resumed: !!this.opts.resumeSessionId, permissionMode: this.opts.permissionMode });
      await this.restoreQuestion(result.thread);
      void this.readAccount();
    } catch (e) { this.compactionRelay?.close(); this.compactionRelay = undefined; this.exited = true; this.rpc.dispose(); throw e; }
  }
  private canPrepareCompactionRelay(): boolean {
    return shouldUseCompactionRelay(process.platform, this.opts.compactionMode, process.env, this.opts.env);
  }
  private prefetchCompactionSettings(): void {
    if (!this.canPrepareCompactionRelay() || this.compactionPreparation || this.exited || this.disposed) return;
    // 200ms 是启动等待可选优化的预算，不是本机 RPC 的执行超时。
    // 预热时并行读取并保留真实结果，避免繁忙宿主上的迟到响应被永久丢弃。
    this.compactionPreparation = Promise.all([
      this.rpc.request('config/read', { includeLayers: false }),
      this.rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }),
    ]).then(([settings, identity]) => ({ settings, identity })).catch(error => { operationFailure('compaction.settings', error); return undefined; });
  }
  private async prepareCompactionRelay(): Promise<void> {
    if (!this.canPrepareCompactionRelay() || this.exited || this.disposed) return;
    this.prefetchCompactionSettings();
    let timer: NodeJS.Timeout | undefined;
    try {
      const budgetExpired = Symbol('startup_budget_expired');
      const prepared = await Promise.race([this.compactionPreparation!, new Promise<typeof budgetExpired>(resolve => {
        timer = setTimeout(() => resolve(budgetExpired), 200);
      })]);
      if (this.exited || this.disposed) return;
      if (!prepared || prepared === budgetExpired) {
        this.emit({ kind: 'diag', message: `[compaction_route] ${JSON.stringify({ stage: 'fallback',
          processRunId: this.rpc.runId, reason: prepared === budgetExpired ? 'startup_budget_expired' : 'settings_unavailable', scope: 'native' })}` });
        return;
      }
      const { settings, identity } = prepared;
      if (!compactionUpstream(settings?.config, { type: 'chatgpt' })) return;
      // 只读本机鉴权模式，不请求令牌。account/read 可能联网发现工作区，继续留在聊天启动后的后台。
      const upstream = compactionUpstream(settings.config, { type: identity.authMethod === 'apikey' ? 'apiKey' : identity.authMethod });
      if (!upstream || this.exited || this.disposed) return;
      const relay = await CompactionRelay.start(upstream, (source, tier) => this.selectCompaction(source, tier), route => this.compactionRouted(route), {
        archiveDirectory: path.join(os.homedir(), '.codex-chat', 'compaction-archive'),
        onOptimized: (threadId, savings) => this.emit({ kind: 'diag', message: `[compaction_input] ${JSON.stringify({ threadId, ...savings })}` }),
      });
      if (this.exited || this.disposed) { relay.close(); return; }
      this.compactionRelay = relay; this.compactionUpstreamUrl = upstream;
      this.emit({ kind: 'diag', message: `[compaction_route] ${JSON.stringify({ stage: 'ready', scope: 'manual_and_auto', processRunId: this.rpc.runId })}` });
    } catch (error) {
      operationLog('compaction.relay.prepare', 'fallback', { ...errorFields(error), scope: 'native' });
      this.emit({ kind: 'notice', message: '自动压缩优化连接未启用，当前连接继续使用 CLI 原生压缩。' });
    } finally { clearTimeout(timer); }
  }
  private compactionRouted(route: CompactionRoute): void {
    if (route.stage === 'request' && route.routeId) {
      if (this.compactionRoutes.size >= 64) this.compactionRoutes.delete(this.compactionRoutes.keys().next().value!);
      this.compactionRoutes.set(route.routeId, { traceId: route.threadId === this.sessionId ? this.latency.currentTraceId : undefined,
        compactionId: route.threadId === this.compactionTrace?.threadId ? this.compactionTrace?.id : undefined });
    }
    const correlation = route.routeId ? this.compactionRoutes.get(route.routeId) : undefined;
    // 迟到的响应属于发起它的轮次；没有关联时保持未知，不能借用当前轮次。
    this.emit({ kind: 'diag', message: `[compaction_route] ${JSON.stringify({ ...route, atMs: Date.now(), processRunId: this.rpc.runId,
      traceId: correlation?.traceId ?? null, compactionId: correlation?.compactionId ?? null,
      configurationScope: 'request_only', sessionConfigurationChanged: false })}` });
    if (route.stage !== 'request' && route.routeId) this.compactionRoutes.delete(route.routeId);
    const trace = this.compactionTrace;
    if (route.stage === 'request' && trace && route.threadId === trace.threadId) {
      trace.model = route.toModel; trace.effort = route.effort; trace.modelSource = 'transport_override';
      this.logCompactionTrace('model_routed', trace);
      this.emit({ kind: 'status', label: `正在使用 ${route.toModel} 压缩上下文…` });
    }
  }
  private selectCompaction(source: string, tier: string | null) {
    return this.opts.compactionMode === 'session' ? undefined : this.compactionPolicy.select(source, tier, this.models);
  }
  private cancelCompactionValidation(): void {
    clearTimeout(this.validationTimer); this.validationTimer = undefined;
    this.validationAbort?.abort(); this.validationAbort = undefined;
  }
  private scheduleCompactionValidation(): void {
    if (this.opts.compactionMode === 'session' || this.opts.compactionAutoValidate === false || !this.opts.compactionStateDir ||
      !this.hasWorked || this.busy || this.exited || this.disposed || !this.compactionRelay || !this.compactionUpstreamUrl || this.validationAbort || this.validationTimer) return;
    this.validationTimer = setTimeout(() => { this.validationTimer = undefined; void this.runCompactionValidation(); }, 15_000);
    this.validationTimer.unref();
  }
  private async runCompactionValidation(): Promise<void> {
    if (this.busy || this.exited || this.disposed || this.validationAbort || !this.compactionUpstreamUrl ||
      this.opts.compactionMode === 'session' || this.opts.compactionAutoValidate === false) return;
    const source = this.modelForNextTurn;
    const candidate = this.compactionPolicy.pending(source, this.models);
    if (!candidate) return;
    const baseline = new CompactionPolicy(this.compactionStore).select(source, null, this.models)?.model ?? source;
    const reader = this.models.find(m => m.id === baseline && m.efforts.includes('medium'));
    if (!reader || !this.models.find(m => m.id === baseline)?.efforts.includes('xhigh') || !this.compactionStore.claim(candidate.id)) return;
    const controller = this.validationAbort = new AbortController();
    this.emit({ kind: 'notice', message: `发现新的压缩候选 ${candidate.id}，正在用合成样本做一次限额验证；当前会话继续沿用已验证策略。` });
    try {
      const result = await validateCompactionModel({ codexPath: this.opts.codexPath, env: this.opts.env, upstream: this.compactionUpstreamUrl,
        candidate: candidate.id, baseline, reader: reader.id, signal: controller.signal });
      this.compactionStore.complete(candidate.id, result);
      this.emit({ kind: 'diag', message: `[compaction_validation] ${JSON.stringify({ model: candidate.id, ...result })}` });
      this.emit({ kind: 'notice', message: result.passed ? `${candidate.id} 已通过压缩验证，后续符合层级和档位要求的压缩可自动使用。` :
        `${candidate.id} 未通过本次质量或耗时检查，继续沿用已验证的压缩策略。` });
    } catch (error) {
      if (controller.signal.aborted) operationLog('compaction.validation', 'cancelled');
      else operationFailure('compaction.validation', error);
      this.compactionStore.complete(candidate.id);
      if (!controller.signal.aborted) this.emit({ kind: 'notice', message: `${candidate.id} 的压缩验证未完成，保留当前策略，不自动重复评测。` });
    } finally { if (this.validationAbort === controller) this.validationAbort = undefined; }
  }
  private saveQuestion(): void {
    const paused = this.pausedQuestion;
    if (!this.opts.questionStateDir || !this.sessionId || !paused?.ready) return;
    if (!paused.turnId) throw new Error('问题缺少暂停轮次');
    saveQuestionState(this.opts.questionStateDir, this.sessionId, paused.turnId, paused.request, this.beganAt);
  }
  private clearSavedQuestion(): void {
    if (this.opts.questionStateDir && this.sessionId) deleteQuestionState(this.opts.questionStateDir, this.sessionId);
  }
  private async restoreQuestion(thread: any): Promise<void> {
    if (!this.opts.questionStateDir || !this.opts.resumeSessionId || !this.sessionId) return;
    const file = questionStateFile(this.opts.questionStateDir, this.sessionId);
    if (!fs.existsSync(file)) return;
    let saved: any;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { operationFailure('question.restore', error); this.clearSavedQuestion(); this.emit({ kind: 'notice', message: '保存的提问已损坏，请重新发送消息。' }); return; }
    const questions = normalizeQuestions(saved?.request?.input?.questions);
    if (saved?.version !== 1 || saved.sessionId !== this.sessionId || typeof saved.turnId !== 'string' ||
        saved.request?.toolName !== 'AskUserQuestion' || typeof saved.request.requestId !== 'string' ||
        !questions) {
      this.clearSavedQuestion(); return;
    }
    // 只恢复仍停在同一轮的问题，防止用户在其他窗口续聊后复活旧问题。
    if (!Array.isArray(thread.turns) || !thread.turns.length) thread = (await this.rpc.request('thread/read', { threadId: this.sessionId, includeTurns: true })).thread;
    const last = thread.turns?.at(-1);
    if (!last || last.id !== saved.turnId || !['interrupted', 'completed'].includes(last.status)) { this.clearSavedQuestion(); return; }
    const request: PermissionRequest = saved.request;
    request.input = { ...request.input, questions };
    this.pausedQuestion = { request, turnId: saved.turnId, ready: true };
    this.pending.set(request.requestId, { id: request.requestId, method: 'item/tool/call', params: { arguments: request.input } });
    this.busy = true; this.beganAt = typeof saved.beganAt === 'number' ? saved.beganAt : Date.now();
    this.emit({ kind: 'busy', busy: true });
    this.showPermission(request);
  }
  sendUserMessage(text: string, context?: string, images?: { mediaType: string; data: string }[], traceContext?: PerformanceContext, sendId?: string): boolean {
    if (!this.sessionId || this.exited || this.busy) return false;
    this.autoCompactionsWithoutProgress = 0;
    this.hasWorked = true; clearTimeout(this.validationTimer); this.validationTimer = undefined;
    if (this.opts.transportDiagnostics !== false) this.latency.begin(this.sessionId, { model: this.modelForNextTurn, effort: this.opts.effort || 'default', speedMode: this.opts.speedMode ?? 'default', trigger: 'message' }, traceContext);
    this.busy = true; this.beganAt = Date.now(); this.streamed.clear(); this.activeBlock = undefined; this.tools.clear();
    this.rootCompletion = undefined; this.stoppingTree = false; this.lastActivityAt = 0;
    this.emit({ kind: 'busy', busy: true });
    const model = this.opts.model || this.activeModel;
    const speed = this.opts.speedMode ?? 'default';
    const sequence = ++this.dispatchSequence;
    const input: any[] = [];
    const prompt = context ? `${text}\n\n${CTX_OPEN}\n${context}\n${CTX_CLOSE}` : text;
    if (prompt) input.push({ type: 'text', text: prompt, text_elements: [] });
    for (const image of images ?? []) input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
    const p = permissions(this.opts.permissionMode, this.opts.addDirs ?? [this.opts.cwd]);
    // 固定本轮参数，等待目录期间的模式切换只影响下一轮。
    const params = { threadId: this.sessionId, input, serviceTier: speedServiceTier(speed), model: this.opts.model || null, effort: this.opts.effort || null, approvalPolicy: p.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: p.sandboxPolicy };
    this.waitingForCatalog = speed !== 'default' && !this.modelsLoaded;
    if (this.waitingForCatalog) { this.latency.start('model_catalog', 'pretool'); this.emit({ kind: 'status', label: '正在确认模型速度档位…' }); }
    const dispatch = async () => {
      if (speed !== 'default') await this.modelsReady;
      this.latency.end('model_catalog');
      if (sequence !== this.dispatchSequence || !this.busy || this.exited) return;
      this.waitingForCatalog = false;
      if (!supportsSpeed(this.models.find(m => m.id === model), speed))
        throw new Error(`无法确认当前账号的模型「${model}」支持${speedLabel(speed)}模式。请改用普通模式、选择提供该档位的模型，或更新 Codex CLI 后重试。`);
      this.emit({ kind: 'diag', message: `[dispatch] model=${model} speed=${speed} effort=${params.effort ?? 'default'} 目录等待${Date.now() - this.beganAt}ms` });
      this.lastDispatched = { model, speedMode: speed, effort: params.effort ?? 'default' };
      operationLog('turn.configuration', 'dispatched', { traceId: this.latency.currentTraceId, model, effort: params.effort ?? 'default', serviceTier: params.serviceTier, permissionMode: this.opts.permissionMode });
      // busy:true 会保留已有阶段；必须在实际发送时结束“创建/连接会话”提示。
      // 不在异步回执中更新，避免覆盖先到达的思考、工具或完成状态。
      this.emit({ kind: 'status', label: '等待 Codex 响应…' });
      return this.timedRequest('turn/start', params);
    };
    this.startingTurn = dispatch().then(r => {
      if (!r || sequence !== this.dispatchSequence) return;
      if (sendId) this.emit({ kind: 'send_accepted', sendId, turnId: r.turn.id });
      this.activeModel = model; this.activeEffort = params.effort ?? this.activeEffort;
      this.emit({ kind: "speed_context", model });
      if (this.busy && !this.pausedQuestion?.ready) this.turnId = r.turn.id;
    }).catch(e => {
      if (sequence === this.dispatchSequence && !this.exited) { this.error(e); this.finish(true); }
    }).finally(() => {
      if (sequence === this.dispatchSequence) { this.startingTurn = undefined; this.waitingForCatalog = false; }
    });
    return true;
  }
  compact(): void {
    if (!this.sessionId || this.busy || this.exited) return;
    this.hasWorked = true; clearTimeout(this.validationTimer); this.validationTimer = undefined;
    if (this.opts.transportDiagnostics !== false) this.latency.begin(this.sessionId, { model: this.modelForNextTurn, effort: this.opts.effort || 'default', speedMode: this.opts.speedMode ?? 'default', trigger: 'manual_compaction' });
    const trace = this.beginCompactionTrace('manual');
    // 模型/推理也在点击压缩时冻结，避免刚切到 Luna 却仍按上一轮 Astra 压缩。
    const selectedSettings = { ...(this.opts.model ? { model: trace.model } : {}), ...(this.opts.effort ? { effort: trace.effort } : {}) };
    this.busy = true; this.compacting = true; this.beganAt = Date.now(); this.emit({ kind: 'busy', busy: true }); this.emit({ kind: 'compacting' });
    let settingsSynced = false;
    const dispatch = async () => {
      let override: { model: string; effort: string } | undefined;
      if (!this.compactionRelay && this.opts.compactionMode !== 'session' && (modelRank(trace.model) ?? 0) > 2) {
        await this.modelsReady;
        if (this.compactionTrace !== trace || this.exited || this.stopTimer) return;
        const candidate = this.selectCompaction(trace.model, speedServiceTier(trace.speedMode));
        const restoreEffort = trace.effort === 'default' ? this.activeEffort : trace.effort;
        // 只使用实测过的组合；无法确认账号能力或原推理设置时沿用会话模型。
        if (candidate && restoreEffort) {
          this.compactionRestore = { model: trace.model, effort: restoreEffort, pending: false, isError: false };
          override = candidate;
          trace.model = candidate.model; trace.effort = candidate.effort; trace.modelSource = 'manual_override';
          this.logCompactionTrace('model_selected', trace);
          this.emit({ kind: 'status', label: `正在使用 ${candidate.model} 压缩上下文…` });
        } else {
          this.emit({ kind: 'notice', message: '无法确认压缩模型所需配置，继续使用当前会话模型压缩。' });
        }
      }
      // 速度切换平时在下一次 turn/start 才传给 CLI；直接压缩也必须应用本会话的选择。
      // 普通档位显式传 default，不能省略后沿用上一轮的 priority。
      await this.rpc.request('thread/settings/update', {
        threadId: trace.threadId, serviceTier: speedServiceTier(trace.speedMode), ...selectedSettings, ...override,
      });
      if (this.compactionTrace !== trace || this.exited || this.stopTimer) return;
      settingsSynced = true;
      this.logCompactionTrace('settings_synced', trace);
      await this.rpc.request('thread/compact/start', { threadId: trace.threadId });
      // RPC 响应只表示请求已受理，可能晚于完成通知，必须关联原来的压缩记录。
      trace.requestAcceptedMs = Math.round(performance.now() - trace.startedAt);
      this.logCompactionTrace('request_accepted', trace);
    };
    void dispatch().catch(e => {
      const stage = settingsSynced ? 'request_failed' : 'settings_sync_failed';
      this.logCompactionTrace(stage, trace, { timeout: /请求超时/.test(String(e)) });
      if (this.compactionTrace !== trace) return;
      this.endCompactionTrace(stage);
      this.error(settingsSynced ? e : new Error(`无法同步会话速度配置，本次压缩未启动。请确认 Codex CLI 已更新后重试：${e instanceof Error ? e.message : String(e)}`));
      this.finish(true);
    });
  }
  private beginCompactionTrace(trigger: 'manual' | 'auto'): NonNullable<CodexProcess['compactionTrace']> {
    if (this.compactionTrace) return this.compactionTrace;
    const trace = this.compactionTrace = {
      id: ++this.compactionSequence, performanceTraceId: this.latency.currentTraceId, trigger, startedAt: performance.now(),
      startedWallMs: Date.now(), threadId: this.sessionId, turnId: trigger === 'auto' ? this.turnId : undefined,
      lastTickAt: performance.now(), maxTimerDelayMs: 0,
      // 手动压缩使用本次选择；自动压缩属于正在执行的轮次，不能被下轮设置覆盖。
      speedMode: trigger === 'manual' ? this.opts.speedMode ?? 'default' :
        this.lastDispatched?.speedMode ?? this.opts.speedMode ?? 'default',
      effort: (trigger === 'manual' ? this.opts.effort : undefined) || this.lastDispatched?.effort || this.opts.effort || 'default',
      preTokens: this.contextUsage?.used, contextWindow: this.contextUsage?.total,
      usageUpdates: 0, retries: 0, errors: 0,
      model: (trigger === 'manual' ? this.opts.model : undefined) || this.lastDispatched?.model || this.activeModel, modelSource: 'active_thread' as const,
    };
    this.logCompactionTrace('start', trace);
    this.compactionTimer = setInterval(() => {
      const now = performance.now();
      trace.maxTimerDelayMs = Math.max(trace.maxTimerDelayMs, Math.round(Math.max(0, now - trace.lastTickAt - 30_000)));
      trace.lastTickAt = now;
      this.logCompactionTrace('waiting', trace);
    }, 30_000);
    this.compactionTimer.unref();
    return trace;
  }
  private logCompactionTrace(stage: string, trace: NonNullable<CodexProcess['compactionTrace']>, extra = {}) {
    const now = performance.now();
    this.emit({ kind: 'diag', message: `[compaction] ${JSON.stringify({
      traceId: trace.performanceTraceId ?? null, id: trace.id, trigger: trace.trigger, stage, model: trace.model, modelSource: trace.modelSource,
      threadId: trace.threadId ?? null, turnId: trace.turnId ?? null, itemId: trace.itemId ?? null,
      startedAt: new Date(trace.startedWallMs).toISOString(), speedMode: trace.speedMode, effort: trace.effort,
      elapsedMs: Math.round(now - trace.startedAt),
      requestAcceptedMs: trace.requestAcceptedMs ?? null, firstUsageMs: trace.firstUsageMs ?? null,
      serverElapsedMs: trace.serverStartedAt === undefined ? null : Math.round(now - trace.serverStartedAt),
      timingScope: 'client_observed_notifications', serverQueueMs: null, networkTransitMs: null, inferenceMs: null,
      maxTimerDelayMs: trace.maxTimerDelayMs, ...this.rpc.transportSnapshot(),
      preTokens: trace.preTokens ?? null, contextWindow: trace.contextWindow ?? null,
      // 仅记录收到的用量快照；通知可能延后，不冒充压缩后精确用量。
      latestTokens: trace.latestTokens ?? null, latestUsage: trace.usage ?? null, usageUpdates: trace.usageUpdates,
      retries: trace.retries, errors: trace.errors, ...extra,
    })}` });
  }
  private endCompactionTrace(outcome: string) {
    clearInterval(this.compactionTimer); this.compactionTimer = undefined;
    const trace = this.compactionTrace;
    this.compactionTrace = undefined;
    if (trace) {
      trace.endedWallMs = Date.now();
      this.recentCompactions.push(trace);
      if (this.recentCompactions.length > 16) this.recentCompactions.shift();
      this.logCompactionTrace('end', trace, { outcome });
    }
  }
  private block(id: string, type: 'text' | 'thinking') {
    if (this.activeBlock !== id) { this.activeBlock = id; this.emit({ kind: 'block_start', blockType: type, itemId: id }); }
  }
  private rememberEndedTurn(id?: string): void {
    if (!id) return;
    this.endedTurns.add(id);
    if (this.endedTurns.size > 128) this.endedTurns.delete(this.endedTurns.values().next().value!);
  }
  private stopInvalidQuestion(): void {
    this.emit({ kind: 'notice', message: '提问格式无效，正在停止本轮，请重新发送消息。' });
    void this.interrupt().catch(e => { this.rpc.dispose(); this.error(e); });
  }
  private activity(label: string): void {
    const now = Date.now();
    if (now - this.lastActivityAt < 1000) return;
    this.lastActivityAt = now;
    this.emit({ kind: 'activity', label });
  }
  private clearChildState(): void {
    this.children.clear(); this.childChecks.clear(); this.childNotificationQueue.clear();
    this.rejectedChildren.clear(); this.childQuestions.clear(); this.childInterrupts.clear();
  }
  /** 未知线程只能经后端元数据确认父子关系；多条同时到达的审批共用一次核验。 */
  private ensureChild(threadId: string): Promise<boolean> {
    if (this.children.has(threadId)) return Promise.resolve(true);
    if (!this.sessionId || this.exited || this.disposed || this.rejectedChildren.has(threadId)) return Promise.resolve(false);
    const existing = this.childChecks.get(threadId);
    if (existing) return existing;
    if (this.childChecks.size >= 32) return Promise.resolve(false);
    const root = this.sessionId;
    this.latency.start(`validate:${threadId}`, 'child_validation', { threadId: root, itemId: threadId });
    const checking = (async () => {
      try {
        const chain: any[] = [], seen = new Set<string>();
        let current = threadId;
        // 独立迭代核验父链，避免同时核验 A/B 时互相等待 Promise 形成环。
        while (current !== root && !this.children.has(current)) {
          if (seen.has(current) || seen.size >= 16) return false;
          seen.add(current);
          const thread = (await this.rpc.request('thread/read', { threadId: current, includeTurns: false }, 10000)).thread;
          if (this.exited || this.disposed || this.sessionId !== root || thread?.id !== current ||
              typeof thread.parentThreadId !== 'string' || !thread.parentThreadId) return false;
          chain.push(thread); current = thread.parentThreadId;
        }
        for (const thread of chain.reverse()) {
          if (!this.children.register(thread)) return false;
          if (thread.status?.type === 'active') this.latency.registerChild(thread.id, thread.parentThreadId);
        }
        return this.children.has(threadId);
      } catch (error) { this.latency.end(`validate:${threadId}`, 'failed', errorFields(error)); return false; }
      finally { this.latency.end(`validate:${threadId}`); this.childChecks.delete(threadId); }
    })();
    this.childChecks.set(threadId, checking);
    return checking;
  }
  private routeChildNotification(m: RpcMessage): void {
    const threadId = m.params?.threadId;
    if (typeof threadId !== 'string') return;
    if (this.children.has(threadId)) { this.childNotification(m); return; }
    // 未确认归属时不保存正文/输出 delta；只暂存有界的生命周期消息。
    if (!['turn/started', 'turn/completed', 'thread/closed', 'item/started', 'item/completed', 'serverRequest/resolved'].includes(m.method!)) return;
    const queued = this.childNotificationQueue.get(threadId);
    if (queued) { if (queued.length >= 64) queued.shift(); queued.push(m); return; }
    if (this.childNotificationQueue.size >= 32 || this.rejectedChildren.has(threadId)) return;
    this.childNotificationQueue.set(threadId, [m]);
    void this.ensureChild(threadId).then(accepted => {
      const messages = this.childNotificationQueue.get(threadId) ?? [];
      this.childNotificationQueue.delete(threadId);
      if (accepted && !this.disposed && !this.exited) {
        for (const message of messages) this.childNotification(message);
      } else {
        this.rejectedChildren.add(threadId);
        if (this.rejectedChildren.size > 128) this.rejectedChildren.delete(this.rejectedChildren.values().next().value!);
      }
      this.finishTreeIfReady();
    }).catch(e => this.emit({ kind: 'error', message: String(e), keepBusy: true }));
  }
  private finishTreeIfReady(): void {
    if (!this.rootCompletion || this.children.activeTurns().length || this.childChecks.size ||
        this.childNotificationQueue.size || this.childInterrupts.size) return;
    const { isError } = this.rootCompletion;
    this.rootCompletion = undefined;
    this.finish(isError);
  }
  private discoverChildren(item: any): void {
    const ids = item?.type === 'collabAgentToolCall' ? item.receiverThreadIds :
      item?.type === 'subAgentActivity' ? [item.agentThreadId] : [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 32)) {
      if (typeof id !== 'string' || id === this.sessionId) continue;
      void this.ensureChild(id).then(accepted => {
        if (accepted && this.stoppingTree) return this.interruptChild(id);
      }).finally(() => this.finishTreeIfReady()).catch(e => this.emit({ kind: 'error', message: String(e), keepBusy: true }));
    }
  }
  private clearChildRequests(threadId: string, turnId?: string): void {
    for (const [key, request] of this.pending) {
      if (request.params.threadId !== threadId || (turnId && request.params.turnId !== turnId)) continue;
      this.pending.delete(key); this.childQuestions.delete(key);
      this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'deny', auto: true });
    }
  }
  private interruptChild(threadId: string): Promise<void> {
    const existing = this.childInterrupts.get(threadId);
    if (existing) return existing;
    const child = this.children.get(threadId);
    if (!child?.active) return Promise.resolve();
    const turnId = child.turnId;
    const stopping = (async () => {
      try {
        await this.rpc.request('turn/interrupt', { threadId, turnId: turnId ?? '' }, 10000);
        // 非空 turn 的回执由后端在 TurnAborted 后发送；空 turn 是启动取消。
        if (turnId || !this.children.get(threadId)?.turnId) {
          this.children.completed(threadId, turnId);
          this.clearChildRequests(threadId, turnId);
        }
      } catch (e) {
        if (this.children.get(threadId)?.active && !this.exited && !this.disposed) {
          this.error(`未能确认${child.label}停止，已关闭连接：${String(e)}`);
          this.exited = true; this.rpc.dispose(); this.clearChildState(); this.finish(true);
        }
      } finally {
        this.childInterrupts.delete(threadId);
        // 启动取消回执与首个 turn/started 交叉时，继续取消新出现的真实轮次。
        if (this.stoppingTree && this.children.get(threadId)?.active) void this.interruptChild(threadId);
        this.finishTreeIfReady();
      }
    })();
    this.childInterrupts.set(threadId, stopping);
    return stopping;
  }
  private childNotification(m: RpcMessage): void {
    const p = m.params ?? {}, threadId = p.threadId;
    const child = this.children.get(threadId);
    if (!child || this.exited || this.disposed) return;
    if (this.children.isCurrent(threadId, p.turnId ?? p.turn?.id)) this.latency.observe(m, true, child.parentThreadId);
    const turnId = p.turnId ?? p.turn?.id;
    if (m.method === 'thread/closed') {
      this.children.completed(threadId); this.clearChildRequests(threadId);
      this.finishTreeIfReady(); return;
    }
    if (m.method === 'turn/started') {
      if (this.children.started(threadId, turnId)) {
        this.activity(`${child.label}正在执行…`);
        if (this.stoppingTree) void this.interruptChild(threadId);
      }
      return;
    }
    if (m.method === 'turn/completed') {
      if (this.children.completed(threadId, turnId)) {
        this.clearChildRequests(threadId, turnId);
        this.activity(`${child.label}${p.turn?.status === 'failed' ? '执行失败' : p.turn?.status === 'interrupted' ? '已停止' : '已完成'}`);
        this.finishTreeIfReady();
      }
      return;
    }
    if (!this.children.isCurrent(threadId, turnId)) return;
    if (m.method === 'serverRequest/resolved') {
      const key = String(p.requestId), pending = this.pending.get(key);
      if (pending?.params.threadId === threadId) {
        this.pending.delete(key); this.childQuestions.delete(key);
        this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'deny', auto: true });
      }
      return;
    }
    if (m.method === 'item/commandExecution/outputDelta' || m.method === 'item/fileChange/outputDelta') {
      if (typeof p.delta === 'string' && p.delta.length) this.activity(`${child.label}的工具仍在输出…`); return;
    }
    if (m.method === 'item/agentMessage/delta' || m.method?.startsWith('item/reasoning/')) {
      this.activity(`${child.label}正在处理…`); return;
    }
    if (m.method === 'error') {
      if (p.willRetry) this.emit({ kind: 'diag', message: '[agent] 子任务正在重试' });
      else this.emit({ kind: 'error', message: `${child.label}：${p.error?.message ?? p.message ?? '执行失败'}`, keepBusy: true });
      return;
    }
    if (m.method !== 'item/started' && m.method !== 'item/completed') return;
    const item = p.item; if (!item) return;
    this.discoverChildren(item);
    const done = m.method === 'item/completed';
    this.children.started(threadId, turnId);
    if (this.stoppingTree) { void this.interruptChild(threadId); return; }
    if (done && item.type === 'agentMessage' && item.delivery === 'async' && item.questions?.length) {
      // V2 子线程可禁止直接 turn/start。通知没有待答 RPC，不能把答案错误地续到根线程。
      this.emit({ kind: 'error', message: `${child.label}发起了暂不支持直接恢复的异步提问，正在停止该子任务。请让主任务重新提出问题后继续。`, keepBusy: true });
      void this.interruptChild(threadId); return;
    }
    if (['agentMessage', 'reasoning', 'plan', 'userMessage', 'hookPrompt', 'contextCompaction', 'subAgentActivity'].includes(item.type)) {
      this.activity(`${child.label}正在处理…`); return;
    }
    const id = childToolId(threadId, item.id);
    if (!done) this.tools.set(id, item); else this.tools.delete(id);
    if (item.type === 'dynamicToolCall' && item.tool === 'AskUserQuestion') return;
    const view = toolView(item);
    if (!done) this.emit({ kind: 'tool_input', toolId: id, name: view.name, input: view.input, agentLabel: child.label });
    else this.emit({ kind: 'tool_result', toolUseId: id, content: view.result, isError: view.isError });
  }
  private notification(m: RpcMessage): void {
    this.latency.received(m);
    const p = m.params ?? {};
    if (m.method === 'thread/started' && this.sessionId && p.thread?.id !== this.sessionId) {
      if (this.children.register(p.thread, true)) {
        this.latency.registerChild(p.thread.id, p.thread.parentThreadId);
        if (this.stoppingTree) void this.interruptChild(p.thread.id);
      }
      return;
    }
    if (p.threadId && this.sessionId && p.threadId !== this.sessionId) { this.routeChildNotification(m); return; }
    const eventTurnId = p.turnId ?? p.turn?.id;
    if (eventTurnId && this.endedTurns.has(eventTurnId)) return;
    this.latency.observe(m);
    // 账号通知不属于被暂停的轮次；等待期间仍需更新额度。
    if (m.method === 'account/rateLimits/updated') { for (const event of quotaEvents(p.rateLimits)) this.emit(event); return; }
    // 用户问题不交给后台工具等待：先中断模型，保留本地问题，收到答案才开启续轮。
    // 等待中忽略旧轮次的尾部事件；真正停止由 turn/completed 确认，而非隐藏 UI。
    if (this.pausedQuestion) {
      const paused = this.pausedQuestion;
      if (m.method === 'turn/completed' && (!paused.turnId || p.turn.id === paused.turnId)) {
        if (p.turn.status === 'failed') { this.error(p.turn.error?.message ?? '暂停提问失败'); this.finish(true); return; }
        if (!paused.ready) {
          this.rememberEndedTurn(p.turn.id);
          clearTimeout(paused.timer); paused.ready = true; this.turnId = undefined;
          try { this.saveQuestion(); }
          catch (e) { this.error(`保存等待中的问题失败：${String(e)}`); this.finish(true); return; }
          this.showPermission(paused.request);
        }
      }
      return;
    }
    if (m.method === 'turn/started') { this.turnId = p.turn.id; return; }
    if (m.method === 'turn/completed') {
      this.endCompactionTrace(p.turn.status === 'failed' ? 'failed' : p.turn.status === 'interrupted' ? 'interrupted' : 'turn_ended_without_compaction_completed');
      this.rememberEndedTurn(p.turn.id); if (p.turn.error) this.emit({ kind: 'error', message: p.turn.error.message, keepBusy: true });
      this.turnId = undefined; this.rootCompletion = { isError: p.turn.status === 'failed' }; this.finishTreeIfReady(); return;
    }
    if (m.method === 'item/commandExecution/outputDelta' || m.method === 'item/fileChange/outputDelta') {
      if (typeof p.delta === 'string' && p.delta.length) this.activity('工具仍在输出…'); return;
    }
    if (m.method === 'item/agentMessage/delta' || m.method === 'item/plan/delta') {
      this.block(p.itemId, 'text'); this.streamed.add(p.itemId); this.emit({ kind: 'text_delta', text: p.delta }); return;
    }
    if (m.method === 'item/reasoning/summaryTextDelta' || m.method === 'item/reasoning/textDelta') {
      this.block(p.itemId, 'thinking'); this.streamed.add(p.itemId); this.emit({ kind: 'thinking_delta', text: p.delta }); return;
    }
    if (m.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage;
      if (typeof u?.last?.totalTokens === 'number') {
        this.contextUsage = { used: u.last.totalTokens, total: u.modelContextWindow };
        if (this.compactionTrace) {
          this.compactionTrace.latestTokens = u.last.totalTokens;
          this.compactionTrace.usageUpdates++;
          this.compactionTrace.firstUsageMs ??= Math.round(performance.now() - this.compactionTrace.startedAt);
          this.compactionTrace.usage = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens',
            'reasoningOutputTokens', 'totalTokens'].filter(k => Number.isSafeInteger(u.last[k]) && u.last[k] >= 0)
            .map(k => [k, u.last[k]]));
          this.logCompactionTrace('usage_updated', this.compactionTrace);
        }
      }
      if (u?.modelContextWindow) this.emit({ kind: 'context', used: u.last?.totalTokens ?? 0, total: u.modelContextWindow });
      this.emit({ kind: 'tokens', output: u?.last?.outputTokens ?? 0 }); return;
    }
    if (m.method === 'turn/plan/updated') {
      this.emit({ kind: 'tool_input', toolId: 'plan', name: 'TodoWrite', input: { todos: (p.plan ?? []).map((x: any) => ({ content: x.step, status: x.status, activeForm: x.step })) } });
      // 计划已更新；步骤自身的 in_progress 继续表示任务进度。
      this.emit({ kind: 'tool_result', toolUseId: 'plan', content: '', isError: false });
      return;
    }
    if (m.method === 'error') {
      if (this.compactionTrace) {
        if (p.willRetry) this.compactionTrace.retries++; else this.compactionTrace.errors++;
        this.logCompactionTrace(p.willRetry ? 'retry' : 'error', this.compactionTrace, safeCompactionError(p.error));
      }
      if (p.willRetry) this.emit({kind:'status',label:'Codex 正在重试请求…'});
      else this.emit({ kind: 'error', message: p.error?.message ?? p.message ?? 'Codex 请求失败', keepBusy: true }); return;
    }
    if (m.method === 'serverRequest/resolved') {
      const key = String(p.requestId); if (!this.pending.delete(key)) return; this.childQuestions.delete(key);
      this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'deny', auto: true }); return;
    }
    if (m.method !== 'item/started' && m.method !== 'item/completed') return;
    const item = p.item; if (!item) return;
    this.discoverChildren(item);
    const done = m.method === 'item/completed';
    const questions = asyncQuestions(item);
    if (questions) {
      if (done && this.busy && !this.stopTimer) {
        const key = `async-question:${item.id}`;
        const input = { questions };
        // 这是通知，不存在待答 RPC。仅建立本地问题，回答时用真实用户消息续轮。
        this.pending.set(key, { id: key, method: 'item/tool/call', params: { arguments: input } });
        this.emit({ kind: 'diag', message: '[question] 原生异步提问转入 AskUserQuestion 暂停流程' });
        void this.pauseForQuestion({ requestId: key, toolUseId: item.id, toolName: 'AskUserQuestion', input, suggestions: [] }, p.turnId);
      }
      return;
    }
    if (done && item.type === 'agentMessage' && item.delivery === 'async' && item.questions != null &&
        (!Array.isArray(item.questions) || item.questions.length > 0)) {
      // 结构化问题损坏时不能退化成普通文字，让模型继续 sleep 等待。
      this.stopInvalidQuestion();
      return;
    }
    if (['agentMessage', 'plan', 'reasoning'].includes(item.type)) {
      if (!done) this.block(item.id, item.type === 'reasoning' ? 'thinking' : 'text');
      if (done && !this.streamed.has(item.id)) {
        const thinking = item.type === 'reasoning'; this.block(item.id, thinking ? 'thinking' : 'text');
        this.emit(thinking ? { kind: 'thinking_delta', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') } : { kind: 'text_delta', text: item.text ?? '' });
      }
      if (done && this.activeBlock === item.id) {
        // completed 中的正文是权威结果，不能只沿用可能缺块或被修正的 delta。
        if (this.streamed.has(item.id) && item.type !== 'reasoning' && typeof item.text === 'string') this.emit({kind: 'text_snap', text: item.text});
        this.activeBlock = undefined;
        this.emit({ kind: 'block_end' });
      }
      return;
    }
    if (item.type === 'contextCompaction') {
      if (!done) {
        if (!this.compacting && this.opts.compactionMode !== 'session' && this.autoCompactionsWithoutProgress >= 3) {
          this.emit({ kind: 'notice', message: '连续三次自动压缩后仍未产生新回复或工具结果，已停止本轮，避免反复等待和消耗额度。请减少本轮输入或开启新会话后继续。' });
          void this.interrupt().catch(e => { this.rpc.dispose(); this.error(e); });
          return;
        }
        const trace = this.beginCompactionTrace(this.compacting ? 'manual' : 'auto');
        trace.itemId = item.id;
        trace.turnId = p.turnId ?? this.turnId;
        if (trace.serverStartedAt === undefined) {
          trace.serverStartedAt = performance.now();
          this.logCompactionTrace('server_started', trace);
        }
        this.emit({ kind: 'compacting' });
      }
      else {
        if (this.compactionTrace?.trigger === 'auto') this.autoCompactionsWithoutProgress++;
        this.endCompactionTrace('completed');
        this.emit({ kind: 'compacted', trigger: this.compacting ? 'manual' : 'auto', preTokens: 0, postTokens: 0 });
        // 自动压缩只是轮次中的一个阶段，后面还要继续回复。
        // 换过压缩模型时须等待轮次真正结束，再恢复设置，不能提前放行下一条消息。
        if (this.compacting && !this.compactionRestore) this.finish(false);
      }
      return;
    }
    if (item.type === 'userMessage' || item.type === 'hookPrompt') return;
    this.tools.set(item.id, item);
    if (item.type === 'dynamicToolCall' && item.tool === 'AskUserQuestion') return;
    const view = toolView(item);
    if (!done) { this.activeBlock = undefined; this.emit({ kind: 'tool_input', toolId: item.id, name: view.name, input: view.input }); }
    else this.emit({ kind: 'tool_result', toolUseId: item.id, content: view.result, isError: view.isError });
  }
  private async request(m: RpcMessage): Promise<void> {
    const p = m.params ?? {}, key = String(m.id);
    if (p.threadId && p.threadId !== this.sessionId) {
      if (await this.ensureChild(p.threadId)) {
        if (this.stoppingTree) void this.interruptChild(p.threadId);
        await this.childRequest(m);
      }
      else this.rpc.reject(m.id!, '会话不匹配');
      this.finishTreeIfReady(); return;
    }
    if (p.turnId && this.endedTurns.has(p.turnId)) { this.rpc.reject(m.id!, '该轮次已经结束'); return; }
    if (this.pausedQuestion || this.stopTimer) { this.rpc.reject(m.id!, '正在停止或等待用户回答'); return; }
    const method = m.method!;
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'item/tool/call', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'].includes(method)) { this.rpc.reject(m.id!); return; }
    if (method === 'item/tool/call' && p.tool !== 'AskUserQuestion') { this.rpc.reject(m.id!, '未知工具'); return; }
    this.pending.set(key, { id: m.id!, method, params: p });
    const question = method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput' || method === 'item/tool/call';
    const name = question ? 'AskUserQuestion' : method.includes('commandExecution') ? 'Bash' : method.includes('fileChange') ? 'Edit' : '权限请求';
    // 动态工具协议使用 callId；原生审批/提问使用 itemId。
    const itemId = p.itemId ?? p.callId;
    const item = this.tools.get(itemId);
    const rawQuestions = method === 'item/tool/call' ? p.arguments?.questions : p.questions;
    const questions = question ? normalizeQuestions(rawQuestions) : undefined;
    if (question && !questions) { this.stopInvalidQuestion(); return; }
    const input = question ? { questions: questions! } : item ? toolView(item).input : { command: p.command, ...p };
    if (!question) await this.preTool(key, name, input, p);
    const request: PermissionRequest = { requestId: key, toolUseId: itemId, toolName: name, input, description: p.reason ?? 'Codex 请求授权', suggestions: method.includes('commandExecution') || method.includes('fileChange') ? [{ id: 'session', label: '本会话允许' }] : [] };
    if (!question) { this.showPermission(request); return; }
    await this.pauseForQuestion(request, p.turnId);
  }
  private async childRequest(m: RpcMessage): Promise<void> {
    const p = m.params ?? {}, key = String(m.id), method = m.method!;
    const child = this.children.get(p.threadId);
    if (!child || this.stoppingTree || this.stopTimer || this.exited || this.disposed ||
        !this.children.isCurrent(p.threadId, p.turnId)) { this.rpc.reject(m.id!, '子任务已停止或轮次已结束'); return; }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput',
      'item/tool/call', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'].includes(method) ||
        (method === 'item/tool/call' && p.tool !== 'AskUserQuestion')) { this.rpc.reject(m.id!); return; }
    const question = method === 'item/tool/call' || method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput';
    const questions = question ? normalizeQuestions(method === 'item/tool/call' ? p.arguments?.questions : p.questions) : undefined;
    if (question && !questions) {
      this.rpc.reject(m.id!, '子任务提问格式无效');
      this.children.started(p.threadId, p.turnId); await this.interruptChild(p.threadId); return;
    }
    // 非阻塞原生问题可能被服务端自动解决，不能冒充一直等待用户的阻塞问题。
    if (question && p.isBlocking === false) {
      this.rpc.reject(m.id!, '子任务必须使用阻塞提问，或请主任务向用户提问');
      this.children.started(p.threadId, p.turnId); await this.interruptChild(p.threadId);
      this.emit({ kind: 'error', message: `${child.label}的非阻塞提问已停止，请让主任务重新提问。`, keepBusy: true }); return;
    }
    this.children.started(p.threadId, p.turnId);
    const name = question ? 'AskUserQuestion' : method.includes('commandExecution') ? 'Bash' : method.includes('fileChange') ? 'Edit' : '权限请求';
    const toolId = childToolId(p.threadId, p.itemId ?? p.callId ?? key);
    const item = this.tools.get(toolId);
    const input = question ? { questions: questions! } : item ? toolView(item).input : { command: p.command, ...p };
    if (!question) await this.preTool(key, name, input, p);
    // onPreTool 可能异步读快照；期间停止/完成的请求不能在界面复活。
    if (this.exited || this.disposed || this.stoppingTree || !this.children.isCurrent(p.threadId, p.turnId)) {
      this.rpc.reject(m.id!, '子任务已停止'); return;
    }
    this.pending.set(key, { id: m.id!, method, params: p });
    if (questions) this.childQuestions.set(key, questions);
    this.showPermission({ requestId: key, toolUseId: toolId, toolName: name, displayName: `${child.label} · ${name}`, agentLabel: child.label,
      input, description: `${child.label}：${p.reason ?? (question ? '等待你的回答' : 'Codex 请求授权')}`,
      suggestions: method.includes('commandExecution') || method.includes('fileChange') ? [{ id: 'session', label: '本会话允许' }] : [] });
  }
  isChildQuestion(key: string): boolean { return this.childQuestions.has(key); }
  /** 子任务的阻塞问题由原 RPC 恢复，不创建根会话用户轮次/还原点。 */
  answerChildQuestion(key: string, answers: Record<string, string | string[]>, images: QuestionImages = {}, answerModes: QuestionAnswerModes = {}): boolean {
    const pending = this.pending.get(key), questions = this.childQuestions.get(key);
    if (!pending || !questions || this.exited || this.disposed || this.stoppingTree ||
        !this.children.isCurrent(pending.params.threadId, pending.params.turnId)) return false;
    validateQuestionImages(images);
    if (Object.values(images).some(value => Array.isArray(value) && value.length))
      throw new Error('子任务问题暂不支持图片答案，请填写文字；问题仍在等待。');
    const mapped: Record<string, { answers: string[] }> = {};
    for (const [index, question] of questions.entries()) {
      const raw = answers[question.id] ?? answers[question.question] ?? answers[String(index)];
      const values = Array.isArray(raw) ? [...raw] : [raw];
      if (!values.length || values.some(value => typeof value !== 'string' || !value.trim())) return false;
      mapped[question.id] = { answers: values as string[], ...(pending.method === 'item/tool/call' && answerModes[question.id]
        ? questionAnswerMetadata(question, answerModes[question.id]) : {}) };
    }
    const response = { answers: mapped };
    this.rpc.respond(pending.id, pending.method === 'item/tool/call' ? {
      contentItems: [{ type: 'inputText', text: JSON.stringify(response) }], success: true,
    } : response);
    this.pending.delete(key); this.childQuestions.delete(key);
    this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'allow' });
    return true;
  }
  private async pauseForQuestion(request: PermissionRequest, turnId?: string): Promise<void> {
    const paused: NonNullable<CodexProcess['pausedQuestion']> = { request, turnId: turnId ?? this.turnId, ready: false };
    this.pausedQuestion = paused;
    this.emit({ kind: 'status', label: '正在暂停，等待用户回答…' });
    paused.timer = setTimeout(() => {
      if (this.pausedQuestion !== paused || paused.ready) return;
      this.error('未能确认模型暂停，已关闭连接。请重新发送消息。'); this.finish(true); this.rpc.dispose();
    }, 10000);
    paused.timer.unref();
    try {
      await this.startingTurn;
      if (this.pausedQuestion !== paused) return;
      paused.turnId ??= this.turnId;
      if (!paused.turnId) throw new Error('无法确定待暂停的轮次');
      this.latency.expectQuestionPause(request.toolUseId, this.sessionId, paused.turnId);
      await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: paused.turnId });
    } catch (e) {
      // 未能确认暂停时关闭连接，不能放任模型继续，也不展示可用的问题卡片。
      if (this.pausedQuestion === paused && !paused.ready) {
        this.error(`暂停等待用户失败：${String(e)}`); this.finish(true); this.rpc.dispose();
      }
    }
  }
  respondPermission(key: string, decision: { behavior: 'allow' | 'deny'; suggestionId?: string; message?: string }): boolean {
    const p = this.pending.get(key); if (!p || this.exited || this.disposed) return false;
    const allow = decision.behavior === 'allow';
    if (p.method === 'item/tool/requestUserInput' || p.method === 'tool/requestUserInput' || p.method === 'item/tool/call') { if (!allow) void this.interrupt().catch(e => this.error(e)); return false; }
    const result = p.method === 'item/permissions/requestApproval' ? { permissions: allow ? p.params.permissions : {}, scope: 'turn' }
      : p.method === 'mcpServer/elicitation/request' ? { action: allow ? 'accept' : 'decline', content: null }
      : { decision: allow ? (decision.suggestionId === 'session' ? 'acceptForSession' : 'accept') : 'decline' };
    this.rpc.respond(p.id, result); this.pending.delete(key); this.emit({ kind: 'permission_resolved', requestId: key, behavior: decision.behavior });
    return true;
  }
  prepareQuestionAnswer(key: string, answers: Record<string, string | string[]>, images: QuestionImages = {}, answerModes: QuestionAnswerModes = {}): { text: string; turnId: string; images: AnswerImage[] } | undefined {
    if (this.exited || this.disposed || !this.busy) return;
    const p = this.pending.get(key);
    if (!p || !['item/tool/call', 'item/tool/requestUserInput', 'tool/requestUserInput'].includes(p.method)) return;
    const mapped: Record<string, { answers: string[] }> = {};
    const questions = this.pausedQuestion?.request.input.questions as any[] | undefined;
    if (!Array.isArray(questions) || !questions.length) return;
    validateQuestionImages(images);
    const keys = new Set(questions.map((q, index) => q.id || q.question || String(index)));
    if (Object.keys(images).some(id => !keys.has(id))) throw new Error('图片所属的问题已失效，请重新添加');
    for (const [index, q] of questions.entries()) {
      const pictures = images[q.id || q.question || String(index)] ?? [];
      if (q.isSecret && pictures.length) throw new Error('私密问题请使用文字回答，不支持图片附件');
      const a = answers[q.id] ?? answers[q.question] ?? answers[String(index)] ?? [];
      const values = Array.isArray(a) ? [...a] : [a];
      if (pictures.length && (!values.length || values.every(value => typeof value === 'string' && !value.trim()))) values.splice(0, values.length, QUESTION_IMAGE_ANSWER);
      if (!values.length || values.some(value => typeof value !== 'string' || !value.trim())) return;
      mapped[q.id || q.question || String(index)] = { answers: values };
    }
    const paused = this.pausedQuestion;
    if (!paused?.ready || !paused.turnId || paused.request.requestId !== key) return;
    const speed = this.opts.speedMode ?? 'default';
    if (speed !== 'default' && !this.modelsLoaded) throw new Error('模型列表仍在加载，请稍后重新提交答案。');
    if (!supportsSpeed(this.models.find(m => m.id === this.modelForNextTurn), speed))
      throw new Error(`当前模型无法使用${speedLabel(speed)}模式，请切换速度或模型后重新提交答案。`);
    const attached: AnswerImage[] = [];
    const reply = questions.map((q, index) => {
      const id = q.id || q.question || String(index), pictures = images[id] ?? [];
      const imageNumbers = pictures.map((_, i) => attached.length + i + 1);
      attached.push(...pictures);
      return { question: q.question, ...questionAnswerMetadata(q, answerModes[id]), answers: mapped[id].answers,
        ...(pictures.length ? { imageCount: pictures.length, imageNumbers } : {}) };
    });
    return { text: `${QUESTION_REPLY_PREFIX}${JSON.stringify(reply)}`, turnId: paused.turnId, images: attached };
  }
  answerQuestion(key: string, answers: Record<string, string | string[]>, images?: QuestionImages, answerModes?: QuestionAnswerModes): boolean {
    const answer = this.prepareQuestionAnswer(key, answers, images, answerModes);
    if (!answer) return false;
    // 原工具请求随中断失效。用真实用户消息恢复同一会话，绝不向旧 RPC 伪造成功。
    this.clearSavedQuestion();
    this.pausedQuestion = undefined;
    for (const [id, pending] of this.pending) if (!pending.params.threadId || pending.params.threadId === this.sessionId) this.pending.delete(id);
    this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'allow' });
    this.latency.finish('answered');
    this.busy = false;
    return this.sendUserMessage(answer.text, undefined, answer.images);
  }
  async interrupt(): Promise<void> {
    if (this.stoppingTree || (!this.busy && !this.children.activeTurns().length)) return;
    this.stoppingTree = true;
    if (this.compactionTrace) this.logCompactionTrace('interrupt_requested', this.compactionTrace);
    if (this.waitingForCatalog) {
      ++this.dispatchSequence; this.waitingForCatalog = false; this.startingTurn = undefined;
    }
    clearTimeout(this.pausedQuestion?.timer); this.pausedQuestion = undefined;
    const sequence = this.dispatchSequence;
    const timeout = new Promise<void>(resolve => {
      this.stopSettled = resolve;
      this.stopTimer = setTimeout(() => {
        this.cancelCompactionRestore();
        this.exited = true; this.rpc.dispose();
        this.clearChildState();
        this.error('未能确认本轮停止，已关闭连接。下一条消息会重新连接。'); this.finish(true);
        resolve();
      }, 10000);
      this.stopTimer.unref();
    });
    const stop = async () => {
      // turn/started 可能先于 turn/start 回执。已有真实轮次 ID 就立即中断，
      // 不能被迟到或缺失的发送回执挡住。超时后旧异步流程不得操作下一轮。
      if (!this.turnId) await this.startingTurn;
      if (this.exited || !this.stoppingTree || sequence !== this.dispatchSequence) return;
      const childStops = this.children.activeTurns().map(child => this.interruptChild(child.threadId));
      const rootStop = this.turnId && this.busy ? this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }) : undefined;
      if (!rootStop) this.rootCompletion ??= { isError: false };
      if (!rootStop && this.compacting) { this.dispose(); return; }
      await Promise.all([...childStops, rootStop]);
      if (!this.exited && sequence === this.dispatchSequence) this.finishTreeIfReady();
    };
    await Promise.race([stop(), timeout]);
  }
  async setPermissionMode(mode: string) { permissions(mode, []); this.opts.permissionMode = mode; }
  async setModel(model: string) { this.opts.model = model; this.emit({ kind: "speed_context", model: this.modelForNextTurn }); }
  async setEffort(effort: string) { this.opts.effort = effort; }
  async setSpeedMode(mode: SpeedMode) {
    if (!isSpeedMode(mode)) throw new Error("无效的速度模式");
    this.opts.speedMode = mode;
  }
  private finish(isError: boolean) {
    if (!this.busy) return;
    const restore = this.compactionRestore;
    if (restore) {
      restore.isError ||= isError;
      if (restore.pending) return;
      restore.pending = true;
      const operationId = restore.operationId = randomUUID();
      const serviceTier = speedServiceTier(this.opts.speedMode ?? 'default');
      this.latency.start('compaction_restore', 'pretool');
      operationLog('compaction.restore', 'start', { operationId, processRunId: this.rpc.runId, traceId: this.latency.currentTraceId,
        model: restore.model, effort: restore.effort, serviceTier });
      this.emit({ kind: 'status', label: '正在恢复会话模型设置…' });
      void this.rpc.request('thread/settings/update', {
        threadId: this.sessionId, model: restore.model, effort: restore.effort,
        serviceTier,
      }).then(() => {
        if (this.disposed || this.compactionRestore !== restore) return;
        this.latency.end('compaction_restore');
        operationLog('compaction.restore', 'completed', { operationId, processRunId: this.rpc.runId, traceId: this.latency.currentTraceId,
          model: restore.model, effort: restore.effort, serviceTier });
        this.compactionRestore = undefined;
        this.finish(restore.isError);
      }).catch(error => {
        if (this.disposed || this.compactionRestore !== restore) return;
        operationFailure('compaction.restore', error, { operationId, processRunId: this.rpc.runId, traceId: this.latency.currentTraceId,
          model: restore.model, effort: restore.effort, serviceTier });
        this.latency.end('compaction_restore', 'failed');
        this.compactionRestore = undefined;
        this.error('压缩后的会话设置恢复失败，已关闭连接；下一条消息会按会话配置重新连接。');
        this.exited = true; this.finish(true); this.rpc.dispose();
      });
      return;
    }
    this.latency.finish(isError ? 'failed' : this.stoppingTree ? 'interrupted' : 'completed');
    this.endCompactionTrace(isError ? 'failed' : 'turn_ended_without_compaction_completed');
    this.rememberEndedTurn(this.turnId);
    try { this.clearSavedQuestion(); } catch (e) { this.error(`清理已结束的提问失败：${String(e)}`); }
    clearTimeout(this.pausedQuestion?.timer);
    clearTimeout(this.stopTimer); this.stopTimer = undefined;
    this.stopSettled?.(); this.stopSettled = undefined;
    this.busy = false; this.compacting = false; this.turnId = undefined; this.pausedQuestion = undefined;
    this.rootCompletion = undefined; this.stoppingTree = false; this.childQuestions.clear();
    for (const key of this.pending.keys()) this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'deny', auto: true });
    this.pending.clear(); this.emit({ kind: 'busy', busy: false });
    this.emit({ kind: 'result', isError, durationMs: Date.now() - this.beganAt, numTurns: 1 });
    this.scheduleCompactionValidation();
  }
  private cancelCompactionRestore(): void {
    if (this.compactionRestore?.operationId) {
      operationLog('compaction.restore', 'cancelled', { operationId: this.compactionRestore.operationId, traceId: this.latency.currentTraceId });
      this.latency.end('compaction_restore', 'cancelled');
    }
    this.compactionRestore = undefined;
  }
  dispose() { this.cancelCompactionRestore(); this.cancelCompactionValidation(); this.latency.finish('disposed'); this.compactionRelay?.close(); this.compactionRelay = undefined; this.endCompactionTrace('disposed'); clearTimeout(this.stopTimer); this.stopSettled?.(); this.stopSettled = undefined; clearTimeout(this.pausedQuestion?.timer); this.disposed = true; this.exited = true; this.clearChildState(); this.rpc.dispose(); }
  async disposeAndWait() { this.cancelCompactionRestore(); this.cancelCompactionValidation(); this.latency.finish('disposed'); this.compactionRelay?.close(); this.compactionRelay = undefined; this.endCompactionTrace('disposed'); clearTimeout(this.stopTimer); this.stopSettled?.(); this.stopSettled = undefined; clearTimeout(this.pausedQuestion?.timer); this.disposed = true; this.exited = true; this.clearChildState(); await this.rpc.disposeAndWait(); }
}
