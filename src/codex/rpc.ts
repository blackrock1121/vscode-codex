import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { LocalTelemetry, TransportDiagnostic } from './telemetry';
import { diagnosticId, failureCategory } from './performanceTrace';
import { redactDiagnosticText } from '../diagnostics/redact';
import { errorFields, operationFailure, operationLog } from '../operations';

export type RpcId = string | number;
export interface RpcMessage { id?: RpcId; method?: string; params?: any; result?: any; error?: { code: number; message: string }; }

function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const msg = value as RpcMessage;
  const hasId = Object.hasOwn(msg, 'id');
  if (hasId && typeof msg.id !== 'string' && (typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id))) return false;
  const hasResult = Object.hasOwn(msg, 'result');
  const hasError = Object.hasOwn(msg, 'error');
  if (Object.hasOwn(msg, 'method')) return typeof msg.method === 'string' && msg.method.length > 0 && !hasResult && !hasError;
  if (!hasId || hasResult === hasError) return false;
  return !hasError || (!!msg.error && typeof msg.error === 'object' && !Array.isArray(msg.error)
    && Number.isInteger(msg.error.code) && typeof msg.error.message === 'string');
}

/** 只传输 JSONL，不记录提示词、凭据或完整 RPC 内容。 */
export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<RpcId, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string; startedAt: number }>();
  private starting?: Promise<void>;
  private closed = false;
  private closeReason?: Error;
  private killTimer?: NodeJS.Timeout;
  private telemetry?: LocalTelemetry;
  private readonly processRunId = randomUUID();
  private receivedMessages = 0;
  private receivedBytes = 0;
  private lastReceivedAt?: number;
  private maxDecodeMs = 0;
  private maxHandlerMs = 0;
  private writeBackpressureCount = 0;
  constructor(private readonly executable: string, private readonly cwd: string, private readonly env?: NodeJS.ProcessEnv,
    private readonly diagnostics = false) { super(); }
  transportSnapshot() {
    return { processRunId: this.processRunId, localReceivedMessages: this.receivedMessages,
      localReceivedBytes: this.receivedBytes, localLastMessageAgeMs: this.lastReceivedAt === undefined ? null :
        Math.round(performance.now() - this.lastReceivedAt), localPendingRequests: this.pending.size,
      oldestPendingRequest: [...this.pending.entries()].slice(0, 1).map(([requestId, p]) => ({ requestId, method: p.method, elapsedMs: Math.round(performance.now() - p.startedAt) }))[0] ?? null,
      connectionState: this.closed ? 'closed' : this.child ? 'connected' : 'starting',
      maxDecodeMs: Math.round(this.maxDecodeMs), maxHandlerMs: Math.round(this.maxHandlerMs),
      writeBackpressureCount: this.writeBackpressureCount, stdinBufferedBytes: this.child?.stdin.writableLength ?? 0 };
  }
  private diagnostic(row: TransportDiagnostic) {
    try { this.emit('diagnostic', { ...row, processRunId: this.processRunId, receivedAtMs: Date.now() }); }
    catch (error) { operationFailure('rpc.diagnostic.receiver', error, { operationId: this.processRunId }); }
  }
  get isClosed(): boolean { return this.closed; }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'));
    return this.starting ??= this.initialize().catch(error => {
      this.fail(error); this.telemetry?.close(); this.telemetry = undefined;
      throw error;
    });
  }
  private async initialize(): Promise<void> {
    operationLog('rpc.process', 'start', { operationId: this.processRunId });
    if (this.diagnostics) {
      try {
        this.telemetry = await LocalTelemetry.start(row => this.diagnostic(row));
        this.diagnostic({ type: 'telemetry_status', status: 'local_collector_ready',
          serverQueueMs: null, networkTransitMs: null, note: 'backend_timings_only_when_reported' });
      } catch (error) { operationFailure('rpc.telemetry.start', error, { operationId: this.processRunId }); this.diagnostic({ type: 'telemetry_status', status: 'unavailable' }); }
    }
    if (this.closed) { this.telemetry?.close(); throw new Error('Codex 连接已关闭'); }
    const child = spawn(resolveCodex(this.executable), ['app-server', '--listen', 'stdio://', ...(this.telemetry?.args() ?? [])], {
      cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: 'pipe', windowsHide: true,
    });
    this.child = child;
    child.on('error', e => this.fail(e));
    child.stdin.on('error', e => this.fail(e));
    child.stdout.on('error', e => this.fail(e));
    // 只留有界、脱敏后的错误/警告线索；普通输出和整份 stderr 不落盘。
    let stderrTail = '', stderrWindow = Date.now(), stderrCount = 0;
    const stderrLine = (line: string) => {
      if (!this.diagnostics || !/\b(?:error|warn|panic|fatal|exception)\b|失败|异常|报错/i.test(line)) return;
      if (Date.now() - stderrWindow >= 60000) { stderrWindow = Date.now(); stderrCount = 0; }
      if (++stderrCount > 30) { if (stderrCount === 31) this.diagnostic({ type: 'runtime_error', source: 'cli_stderr', severity: 'warning', event: 'stderr_limit', message: 'CLI 错误/警告摘要达到每分钟 30 条上限，后续重复摘要省略', sourceTimeMs: Date.now() }); return; }
      this.diagnostic({ type: 'runtime_error', source: 'cli_stderr', severity: /\b(?:error|panic|fatal|exception)\b/i.test(line) ? 'error' : 'warning',
        failureCategory: failureCategory(line), message: redactDiagnosticText(line), sourceTimeMs: Date.now() });
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const parts = chunk.split('\n');
      for (let i = 0; i < parts.length; i++) {
        stderrTail = (stderrTail + parts[i]).slice(0, 8192);
        if (i < parts.length - 1) { stderrLine(stderrTail); stderrTail = ''; }
      }
    });
    child.stderr.on('end', () => { if (stderrTail) stderrLine(stderrTail); stderrTail = ''; });
    child.once('close', (code, signal) => {
      operationLog('rpc.process', 'end', { operationId: this.processRunId, exitCode: code, signal });
      this.telemetry?.close(); this.telemetry = undefined;
      this.fail(new Error(`Codex 进程已退出 (${code ?? 'signal'})`));
      clearTimeout(this.killTimer);
      this.emit('close', code, this.closeReason);
    });
    // JSONL 只以 LF 分帧。Node 24 的 readline 还会拆分 U+2028/U+2029，
    // 但这两个字符可以合法出现在 JSON 字符串中，拆开会破坏历史和工具输出。
    // setEncoding 保留跨数据块的 UTF-8 字符；片段在完整一行到达时才合并。
    let fragments: string[] = [];
    const receiveLine = (line: string) => {
      if (this.closed) return;
      const decodingAt = performance.now();
      let msg: RpcMessage;
      try { msg = JSON.parse(line); } catch { this.fail(new Error(`Codex 返回了无效协议数据（stdout 行长度 ${Buffer.byteLength(line)} 字节）`)); return; }
      if (!isRpcMessage(msg)) { this.fail(new Error(`Codex 返回了无效协议消息结构（stdout 行长度 ${Buffer.byteLength(line)} 字节）`)); return; }
      const handlingAt = performance.now(); this.maxDecodeMs = Math.max(this.maxDecodeMs, handlingAt - decodingAt);
      this.receivedMessages++; this.lastReceivedAt = performance.now();
      if (msg.method) {
        try { this.emit(msg.id === undefined ? 'notification' : 'request', msg); }
        catch (error) { operationFailure('rpc.handler', error, { operationId: this.processRunId }); this.fail(new Error('Codex 事件处理失败')); }
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(`${msg.error.message} (${msg.error.code})`), { rpcCode: msg.error.code })); else p.resolve(msg.result);
      }
      this.maxHandlerMs = Math.max(this.maxHandlerMs, performance.now() - handlingAt);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.closed) return;
      this.receivedBytes += Buffer.byteLength(chunk);
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf('\n', start)) !== -1) {
        fragments.push(chunk.slice(start, end));
        const line = fragments.join('');
        fragments = [];
        receiveLine(line);
        if (this.closed) return;
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    });
    child.stdout.on('end', () => {
      if (fragments.length) receiveLine(fragments.join(''));
      fragments = [];
      this.fail(new Error('Codex 输出通道已关闭'));
    });
    const initialized = await this.request('initialize', { clientInfo: { name: 'vscode_codex_copilot', title: 'Codex Copilot', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    if (this.diagnostics) this.diagnostic({ type: 'cli_info', version:
      typeof initialized?.userAgent === 'string' ? initialized.userAgent.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null : null });
    this.write({ method: 'initialized' });
    operationLog('rpc.process', 'ready', { operationId: this.processRunId });
  }
  request<T = any>(method: string, params: unknown = {}, timeout = 60_000): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new Error('Codex 尚未连接'));
    const id = ++this.sequence;
    const startedAt = performance.now(), sourceTimeMs = Date.now();
    const p = params as { threadId?: unknown; turnId?: unknown } | null;
    const fields = { type: 'rpc', method, requestId: id, sourceTimeMs,
      threadId: diagnosticId(p?.threadId) ?? null, turnId: diagnosticId(p?.turnId) ?? null };
    if (this.diagnostics) this.diagnostic({ ...fields, stage: 'start', pendingRequests: this.pending.size });
    const request = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method, startedAt });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
    return request.then(value => {
      if (this.diagnostics) this.diagnostic({ ...fields, stage: 'end', outcome: 'completed', durationMs: Math.round(performance.now() - startedAt) });
      return value;
    }, error => {
      if (this.diagnostics) this.diagnostic({ ...fields, stage: 'end', outcome: this.closeReason?.name === 'AbortError' ? 'cancelled' : 'failed', durationMs: Math.round(performance.now() - startedAt),
        ...errorFields(error) });
      throw error;
    });
  }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  reject(id: RpcId, message = '客户端不支持此请求'): void { this.write({ id, error: { code: -32601, message } }); }
  private write(msg: RpcMessage): void {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Codex 连接已断开');
    if (!this.child.stdin.write(JSON.stringify(msg) + '\n')) this.writeBackpressureCount++;
  }
  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = e;
    if (e.name === 'AbortError') operationLog('rpc.process', 'cancelled', { operationId: this.processRunId });
    else operationFailure('rpc.process', e, { operationId: this.processRunId });
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
    // 协议损坏时子进程可能仍存活；释放它，避免后续请求复用失效连接。
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      this.killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
      this.killTimer.unref();
    }
  }
  dispose(): void {
    this.fail(Object.assign(new Error('Codex 连接已关闭'), { name: 'AbortError' }));
    const child = this.child;
    if (!child) return;
    child.stdin.end();
  }
  async disposeAndWait(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) { this.dispose(); return; }
    await new Promise<void>(resolve => { child.once('close', () => resolve()); this.dispose(); });
  }
}

export function resolveCodex(configured: string): string {
  if (configured && configured !== 'codex') return configured;
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
  for (const dir of dirs) {
    const file = path.join(dir, binary);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* 下一个位置 */ }
  }
  const nvm = path.join(os.homedir(), '.nvm/versions/node');
  try {
    for (const version of fs.readdirSync(nvm).sort().reverse()) {
      const file = path.join(nvm, version, 'bin', binary);
      if (fs.existsSync(file)) return file;
    }
  } catch { /* 可选安装目录 */ }
  return configured || 'codex';
}
