import * as fs from 'node:fs';
import * as path from 'node:path';
import { CTX_OPEN, CTX_CLOSE, modelChoices, ModelChoice, SpeedMode, speedServiceTier, speedLabel, supportsSpeed, isSpeedMode, billingKind, PermissionSuggestionView, ToWebview } from '../shared';
import { CodexRpc, RpcMessage, RpcId } from './rpc';
import { QUESTION_REPLY_PREFIX, toolView, quotaEvents } from './events';

const USER_DECISION_INSTRUCTIONS = '当任务需要用户选择、确认业务事实、付款或其他明确决定时，使用 AskUserQuestion 向用户提问并等待其答案。不要替用户选择选项，也不要在提出问题后自行继续依赖该答案的步骤。用户未提交答案时必须持续等待，不得因为等待时间较长而结束本轮或给出最终答复。';
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
}
export interface PermissionRequest {
  requestId: string; toolUseId?: string; toolName: string; displayName?: string;
  input: Record<string, unknown>; description?: string; suggestions: PermissionSuggestionView[];
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
export class CodexProcess {
  private readonly rpc: CodexRpc;
  private sessionId?: string;
  private activeModel = "";
  private models: ModelChoice[] = [];
  private turnId?: string;
  private busy = false;
  private exited = false;
  private disposed = false;
  private startingTurn?: Promise<void>;
  private beganAt = 0;
  private compacting = false;
  private readonly pending = new Map<string, { id: RpcId; method: string; params: any }>();
  private pausedQuestion?: { request: PermissionRequest; turnId?: string; ready: boolean; timer?: NodeJS.Timeout };
  private readonly streamed = new Set<string>();
  private activeBlock?: string;
  private readonly tools = new Map<string, any>();
  constructor(private readonly opts: CodexProcessOptions, private readonly hooks: CodexProcessHooks) {
    this.rpc = new CodexRpc(opts.codexPath, opts.cwd, opts.env);
    this.rpc.on('notification', (m: RpcMessage) => { try { this.notification(m); } catch (e) { this.error(e); } });
    this.rpc.on('request', (m: RpcMessage) => { void this.request(m).catch(e => { try { this.rpc.reject(m.id!, String(e)); } catch {} this.error(e); }); });
    this.rpc.on('close', (code: number | null) => { clearTimeout(this.pausedQuestion?.timer); this.exited = true; this.busy = false; this.hooks.onClose(code); });
  }
  get modelForNextTurn() { return this.opts.model || this.activeModel; }
  get currentSessionId() { return this.sessionId; }
  get isBusy() { return this.busy; }
  get isExited() { return this.exited; }
  private emit(e: ToWebview) { if (!this.disposed) this.hooks.emit(e); }
  private error(e: unknown) { this.emit({ kind: 'error', message: String(e instanceof Error ? e.message : e) }); }
  async start(): Promise<void> {
    try {
      await this.rpc.start();
      const account = await this.rpc.request('account/read', {});
      if (!account.account && account.requiresOpenaiAuth) throw new Error('请先执行“Codex: 登录账号”，或在终端运行 codex login。');
      this.emit({ kind: 'speed_context', billing: billingKind(account.account?.type) });
      const p = permissions(this.opts.permissionMode, this.opts.addDirs ?? [this.opts.cwd]);
      const params = { serviceTier: speedServiceTier(this.opts.speedMode ?? 'default'), cwd: this.opts.cwd, model: this.opts.model || null, approvalPolicy: p.approvalPolicy, approvalsReviewer: 'user', sandbox: p.sandbox, developerInstructions: [USER_DECISION_INSTRUCTIONS, this.opts.appendSystemPrompt].filter(Boolean).join('\n\n'), dynamicTools: [ASK_USER_QUESTION_TOOL] };
      const result = await this.rpc.request(this.opts.resumeSessionId ? 'thread/resume' : 'thread/start', this.opts.resumeSessionId ? { ...params, threadId: this.opts.resumeSessionId } : params);
      this.activeModel = result.model ?? this.opts.model ?? "";
      this.sessionId = result.thread.id;
      this.hooks.onSessionId(this.sessionId!, !!this.opts.resumeSessionId);
      this.emit({ kind: 'session', sessionId: this.sessionId!, cwd: this.opts.cwd, model: result.model ?? '', tools: [], resumed: !!this.opts.resumeSessionId, permissionMode: this.opts.permissionMode });
      await this.restoreQuestion(result.thread);
      try {
        const catalog = await this.rpc.request('model/list', {});
        this.models = modelChoices(catalog.data);
        this.emit({ kind: 'models', models: this.models });
      } catch (e) { this.error(e); }
    } catch (e) { this.exited = true; this.rpc.dispose(); throw e; }
  }
  private saveQuestion(): void {
    const paused = this.pausedQuestion;
    if (!this.opts.questionStateDir || !this.sessionId || !paused?.ready) return;
    fs.mkdirSync(this.opts.questionStateDir, { recursive: true, mode: 0o700 });
    const file = questionStateFile(this.opts.questionStateDir, this.sessionId);
    const data = { version: 1, sessionId: this.sessionId, turnId: paused.turnId, beganAt: this.beganAt, request: paused.request };
    fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
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
    catch { this.clearSavedQuestion(); this.emit({ kind: 'notice', message: '保存的提问已损坏，请重新发送消息。' }); return; }
    const questions = saved?.request?.input?.questions;
    if (saved?.version !== 1 || saved.sessionId !== this.sessionId || typeof saved.turnId !== 'string' ||
        saved.request?.toolName !== 'AskUserQuestion' || typeof saved.request.requestId !== 'string' ||
        !Array.isArray(questions) || !questions.length || questions.some((q: any) => !q || typeof q.question !== 'string')) {
      this.clearSavedQuestion(); return;
    }
    // 只恢复仍停在同一轮的问题，防止用户在其他窗口续聊后复活旧问题。
    if (!Array.isArray(thread.turns) || !thread.turns.length) thread = (await this.rpc.request('thread/read', { threadId: this.sessionId, includeTurns: true })).thread;
    const last = thread.turns?.at(-1);
    if (!last || last.id !== saved.turnId || !['interrupted', 'completed'].includes(last.status)) { this.clearSavedQuestion(); return; }
    const request: PermissionRequest = saved.request;
    this.pausedQuestion = { request, turnId: saved.turnId, ready: true };
    this.pending.set(request.requestId, { id: request.requestId, method: 'item/tool/call', params: { arguments: request.input } });
    this.busy = true; this.beganAt = typeof saved.beganAt === 'number' ? saved.beganAt : Date.now();
    this.emit({ kind: 'busy', busy: true });
    this.hooks.onPermission(request);
  }
  sendUserMessage(text: string, context?: string, images?: { mediaType: string; data: string }[]): boolean {
    if (!this.sessionId || this.exited || this.busy) return false;
    this.busy = true; this.beganAt = Date.now(); this.streamed.clear(); this.activeBlock = undefined; this.tools.clear();
    this.emit({ kind: 'busy', busy: true });
    const model = this.opts.model || this.activeModel;
    const speed = this.opts.speedMode ?? 'default';
    const unsupportedSpeed = !supportsSpeed(this.models.find(m => m.id === model), speed);
    const input: any[] = [];
    const prompt = context ? `${text}\n\n${CTX_OPEN}\n${context}\n${CTX_CLOSE}` : text;
    if (prompt) input.push({ type: 'text', text: prompt, text_elements: [] });
    for (const image of images ?? []) input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
    const p = permissions(this.opts.permissionMode, this.opts.addDirs ?? [this.opts.cwd]);
    this.startingTurn = (unsupportedSpeed
      ? Promise.reject(new Error(`无法确认当前账号的模型「${model}」支持${speedLabel(speed)}模式。请改用普通模式、选择提供该档位的模型，或更新 Codex CLI 后重试。`))
      : this.rpc.request('turn/start', { threadId: this.sessionId, input, serviceTier: speedServiceTier(this.opts.speedMode ?? 'default'), model: this.opts.model || null, effort: this.opts.effort || null, approvalPolicy: p.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: p.sandboxPolicy }))
      .then(r => { this.activeModel = model; this.emit({ kind: "speed_context", model }); return r; })
      .then(r => { if (this.busy && !this.pausedQuestion?.ready) this.turnId = r.turn.id; }).catch(e => { this.error(e); this.finish(true); }).finally(() => { this.startingTurn = undefined; });
    return true;
  }
  compact(): void {
    if (!this.sessionId || this.busy) return;
    this.busy = true; this.compacting = true; this.beganAt = Date.now(); this.emit({ kind: 'busy', busy: true }); this.emit({ kind: 'compacting' });
    void this.rpc.request('thread/compact/start', { threadId: this.sessionId }).catch(e => { this.error(e); this.finish(true); });
  }
  private block(id: string, type: 'text' | 'thinking') {
    if (this.activeBlock !== id) { this.activeBlock = id; this.emit({ kind: 'block_start', blockType: type }); }
  }
  private notification(m: RpcMessage): void {
    const p = m.params ?? {};
    if (p.threadId && this.sessionId && p.threadId !== this.sessionId) return;
    // 用户问题不交给后台工具等待：先中断模型，保留本地问题，收到答案才开启续轮。
    // 等待中忽略旧轮次的尾部事件；真正停止由 turn/completed 确认，而非隐藏 UI。
    if (this.pausedQuestion) {
      const paused = this.pausedQuestion;
      if (m.method === 'turn/completed' && (!paused.turnId || p.turn.id === paused.turnId)) {
        if (p.turn.status === 'failed') { this.error(p.turn.error?.message ?? '暂停提问失败'); this.finish(true); return; }
        if (!paused.ready) {
          clearTimeout(paused.timer); paused.ready = true; this.turnId = undefined;
          try { this.saveQuestion(); }
          catch (e) { this.error(`保存等待中的问题失败：${String(e)}`); this.finish(true); return; }
          this.hooks.onPermission(paused.request);
        }
      }
      return;
    }
    if (m.method === 'turn/started') { this.turnId = p.turn.id; return; }
    if (m.method === 'turn/completed') { if (p.turn.error) this.error(p.turn.error.message); this.finish(p.turn.status === 'failed'); return; }
    if (m.method === 'item/agentMessage/delta' || m.method === 'item/plan/delta') {
      this.block(p.itemId, 'text'); this.streamed.add(p.itemId); this.emit({ kind: 'text_delta', text: p.delta }); return;
    }
    if (m.method === 'item/reasoning/summaryTextDelta' || m.method === 'item/reasoning/textDelta') {
      this.block(p.itemId, 'thinking'); this.streamed.add(p.itemId); this.emit({ kind: 'thinking_delta', text: p.delta }); return;
    }
    if (m.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage; if (u?.modelContextWindow) this.emit({ kind: 'context', used: u.last?.totalTokens ?? 0, total: u.modelContextWindow });
      this.emit({ kind: 'tokens', output: u?.last?.outputTokens ?? 0 }); return;
    }
    if (m.method === 'account/rateLimits/updated') { for (const event of quotaEvents(p.rateLimits)) this.emit(event); return; }
    if (m.method === 'turn/plan/updated') {
      this.emit({ kind: 'tool_input', toolId: 'plan', name: 'TodoWrite', input: { todos: (p.plan ?? []).map((x: any) => ({ content: x.step, status: x.status, activeForm: x.step })) } }); return;
    }
    if (m.method === 'error') { if (p.willRetry) this.emit({kind:'status',label:'Codex 正在重试请求…'}); else this.error(p.error?.message ?? p.message ?? 'Codex 请求失败'); return; }
    if (m.method === 'serverRequest/resolved') {
      const key = String(p.requestId); if (!this.pending.delete(key)) return; this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'deny', auto: true }); return;
    }
    if (m.method !== 'item/started' && m.method !== 'item/completed') return;
    const item = p.item; if (!item) return;
    const done = m.method === 'item/completed';
    if (['agentMessage', 'plan', 'reasoning'].includes(item.type)) {
      if (done && !this.streamed.has(item.id)) {
        const thinking = item.type === 'reasoning'; this.block(item.id, thinking ? 'thinking' : 'text');
        this.emit(thinking ? { kind: 'thinking_delta', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') } : { kind: 'text_delta', text: item.text ?? '' });
      }
      return;
    }
    if (item.type === 'contextCompaction') { if (done) { this.emit({ kind: 'compacted', trigger: 'manual', preTokens: 0, postTokens: 0 }); if (this.compacting) this.finish(false); } return; }
    if (item.type === 'userMessage' || item.type === 'hookPrompt') return;
    this.tools.set(item.id, item);
    if (item.type === 'dynamicToolCall' && item.tool === 'AskUserQuestion') return;
    const view = toolView(item);
    if (!done) { this.activeBlock = undefined; this.emit({ kind: 'tool_input', toolId: item.id, name: view.name, input: view.input }); }
    else this.emit({ kind: 'tool_result', toolUseId: item.id, content: view.result, isError: view.isError });
  }
  private async request(m: RpcMessage): Promise<void> {
    const p = m.params ?? {}, key = String(m.id);
    if (p.threadId && p.threadId !== this.sessionId) { this.rpc.reject(m.id!, '会话不匹配'); return; }
    if (this.pausedQuestion) { this.rpc.reject(m.id!, '正在暂停等待用户回答'); return; }
    const method = m.method!;
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'item/tool/call', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'].includes(method)) { this.rpc.reject(m.id!); return; }
    if (method === 'item/tool/call' && p.tool !== 'AskUserQuestion') { this.rpc.reject(m.id!, '未知工具'); return; }
    this.pending.set(key, { id: m.id!, method, params: p });
    const question = method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput' || method === 'item/tool/call';
    const name = question ? 'AskUserQuestion' : method.includes('commandExecution') ? 'Bash' : method.includes('fileChange') ? 'Edit' : '权限请求';
    const item = this.tools.get(p.itemId);
    const rawQuestions = method === 'item/tool/call' ? p.arguments?.questions : p.questions;
    const input = question ? { questions: (Array.isArray(rawQuestions) ? rawQuestions : []).map((q: any) => ({ ...q, multiSelect: false })) } : item ? toolView(item).input : { command: p.command, ...p };
    if (!question) await this.hooks.onPreTool?.(name, input);
    const request: PermissionRequest = { requestId: key, toolUseId: p.itemId, toolName: name, input, description: p.reason ?? 'Codex 请求授权', suggestions: method.includes('commandExecution') || method.includes('fileChange') ? [{ id: 'session', label: '本会话允许' }] : [] };
    if (!question) { this.hooks.onPermission(request); return; }
    const paused: NonNullable<CodexProcess['pausedQuestion']> = { request, turnId: p.turnId ?? this.turnId, ready: false };
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
      await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: paused.turnId });
    } catch (e) {
      // 未能确认暂停时关闭连接，不能放任模型继续，也不展示可用的问题卡片。
      if (this.pausedQuestion === paused && !paused.ready) {
        this.error(`暂停等待用户失败：${String(e)}`); this.finish(true); this.rpc.dispose();
      }
    }
  }
  respondPermission(key: string, decision: { behavior: 'allow' | 'deny'; suggestionId?: string; message?: string }): void {
    const p = this.pending.get(key); if (!p) return;
    const allow = decision.behavior === 'allow';
    if (p.method === 'item/tool/requestUserInput' || p.method === 'tool/requestUserInput' || p.method === 'item/tool/call') { if (!allow) void this.interrupt().catch(e => this.error(e)); return; }
    const result = p.method === 'item/permissions/requestApproval' ? { permissions: allow ? p.params.permissions : {}, scope: 'turn' }
      : p.method === 'mcpServer/elicitation/request' ? { action: allow ? 'accept' : 'decline', content: null }
      : { decision: allow ? (decision.suggestionId === 'session' ? 'acceptForSession' : 'accept') : 'decline' };
    this.rpc.respond(p.id, result); this.pending.delete(key); this.emit({ kind: 'permission_resolved', requestId: key, behavior: decision.behavior });
  }
  answerQuestion(key: string, answers: Record<string, string | string[]>): boolean {
    if (this.exited || this.disposed || !this.busy) return false;
    const p = this.pending.get(key);
    if (!p || !['item/tool/call', 'item/tool/requestUserInput', 'tool/requestUserInput'].includes(p.method)) return false;
    const mapped: Record<string, { answers: string[] }> = {};
    const questions = p.method === 'item/tool/call' ? p.params.arguments?.questions : p.params.questions;
    if (!Array.isArray(questions) || !questions.length) return false;
    for (const [index, q] of questions.entries()) {
      const a = answers[q.id] ?? answers[q.question] ?? answers[String(index)] ?? [];
      const values = Array.isArray(a) ? a : [a];
      if (!values.length || values.some(value => typeof value !== 'string' || !value.trim())) return false;
      mapped[q.id || q.question || String(index)] = { answers: values };
    }
    const paused = this.pausedQuestion;
    if (!paused?.ready || paused.request.requestId !== key) return false;
    const reply = questions.map((q, index) => ({ question: q.question, ...(q.isSecret ? { isSecret: true } : {}), answers: mapped[q.id || q.question || String(index)].answers }));
    // 原工具请求随中断失效。用真实用户消息恢复同一会话，绝不向旧 RPC 伪造成功。
    this.clearSavedQuestion();
    this.pausedQuestion = undefined;
    this.pending.clear();
    this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'allow' });
    this.busy = false;
    return this.sendUserMessage(`${QUESTION_REPLY_PREFIX}${JSON.stringify(reply)}`);
  }
  async interrupt(): Promise<void> {
    if (this.pausedQuestion?.ready) { this.finish(false); return; }
    clearTimeout(this.pausedQuestion?.timer); this.pausedQuestion = undefined;
    await this.startingTurn;
    if (this.turnId && this.busy) await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId });
    else if (this.compacting) { this.dispose(); }
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
    try { this.clearSavedQuestion(); } catch (e) { this.error(`清理已结束的提问失败：${String(e)}`); }
    clearTimeout(this.pausedQuestion?.timer);
    this.busy = false; this.compacting = false; this.turnId = undefined; this.pausedQuestion = undefined;
    for (const key of this.pending.keys()) this.emit({ kind: 'permission_resolved', requestId: key, behavior: 'deny', auto: true });
    this.pending.clear(); this.emit({ kind: 'busy', busy: false });
    this.emit({ kind: 'result', isError, durationMs: Date.now() - this.beganAt, numTurns: 1 });
  }
  dispose() { clearTimeout(this.pausedQuestion?.timer); this.disposed = true; this.exited = true; this.rpc.dispose(); }
  async disposeAndWait() { clearTimeout(this.pausedQuestion?.timer); this.disposed = true; this.exited = true; await this.rpc.disposeAndWait(); }
}
