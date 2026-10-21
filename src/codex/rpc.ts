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
  private readonly createdAt = performance.now();
  private closePhase?: string;
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
  get runId(): string { return this.processRunId; }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(this.closeReason ?? new Error('Codex 连接已关闭'));
    return this.starting ??= this.initialize().catch(error => {
      this.fail(error, 'initialize'); this.telemetry?.close(); this.telemetry = undefined;
      throw this.closeReason ?? error;
    });
  }
  private async initialize(): Promise<void> {
    operationLog('rpc.process', 'start', { operationId: this.processRunId, processRunId: this.processRunId });
    if (this.diagnostics) {
      try {
        this.telemetry = await LocalTelemetry.start(row => this.diagnostic(row));
        this.diagnostic({ type: 'telemetry_status', status: 'local_collector_ready',
          serverQueueMs: null, networkTransitMs: null, note: 'backend_timings_only_when_reported' });
      } catch (error) { operationFailure('rpc.telemetry.start', error, { operationId: this.processRunId }); this.diagnostic({ type: 'telemetry_status', status: 'unavailable' }); }
    }
    if (this.closed) { this.telemetry?.close(); throw new Error('Codex 连接已关闭'); }
    const executable = resolveCodex(this.executable);
    const child = spawn(executable, ['app-server', '--listen', 'stdio://', ...(this.telemetry?.args() ?? [])], {
      cwd: this.cwd, env: codexSpawnEnvironment(executable, { ...process.env, ...this.env }), stdio: 'pipe', windowsHide: true,
    });
    this.child = child;
    child.on('error', e => this.fail(e, 'spawn'));
    child.stdin.on('error', e => this.fail(e, 'stdin'));
    child.stdout.on('error', e => this.fail(e, 'stdout'));
    child.stderr.on('error', e => this.fail(e, 'stderr'));
    // 只留有界、脱敏后的错误/警告线索；普通输出和整份 stderr 不落盘。
    let stderrTail = '', stderrWindow = Date.now(), stderrCount = 0;
    let startupFailure: Error | undefined;
    const stderrLine = (line: string) => {
      // 管理连接也需要启动原因；仅识别固定错误，不把 stderr 原文/凭据展示或落盘。
      if (/^env: (?:node: |[‘']node[’']: )No such file or directory\s*$/.test(line.trim()))
        startupFailure = Object.assign(new Error('无法启动 Codex：当前 VS Code 环境找不到 Node.js。请检查 Codex 安装目录中的 node 或 codexChat.codexPath。'), { code: 'ENOENT' });
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
      this.telemetry?.close(); this.telemetry = undefined;
      this.fail(new Error(`Codex 进程已退出 (${code ?? 'signal'})`), 'process_exit');
      operationLog('rpc.process', 'end', { ...errorFields(this.closeReason), operationId: this.processRunId,
        processRunId: this.processRunId, exitCode: code, signal, phase: this.closePhase,
        outcome: this.closeReason?.name === 'AbortError' ? 'cancelled' : 'failed', durationMs: Math.round(performance.now() - this.createdAt) });
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
      try { msg = JSON.parse(line); } catch { this.fail(new SyntaxError(`Codex 返回了无效协议数据（stdout 行长度 ${Buffer.byteLength(line)} 字节）`)); return; }
      if (!isRpcMessage(msg)) { this.fail(new SyntaxError(`Codex 返回了无效协议消息结构（stdout 行长度 ${Buffer.byteLength(line)} 字节）`)); return; }
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
      if (stderrTail) stderrLine(stderrTail);
      this.fail(startupFailure ?? new Error('Codex 输出通道已关闭'), startupFailure ? 'runtime_dependency' : 'stdout_end');
    });
    const initialized = await this.request('initialize', { clientInfo: { name: 'vscode_codex_copilot', title: 'Codex Copilot', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    if (this.diagnostics) this.diagnostic({ type: 'cli_info', version:
      typeof initialized?.userAgent === 'string' ? initialized.userAgent.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null : null });
    this.write({ method: 'initialized' });
    operationLog('rpc.process', 'ready', { operationId: this.processRunId, processRunId: this.processRunId, durationMs: Math.round(performance.now() - this.createdAt) });
  }
  request<T = any>(method: string, params: unknown = {}, timeout = 60_000): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(this.closeReason ?? new Error('Codex 尚未连接'));
    const id = ++this.sequence;
    const startedAt = performance.now(), sourceTimeMs = Date.now();
    const p = params as { threadId?: unknown; turnId?: unknown } | null;
    const fields = { type: 'rpc', method, requestId: id, sourceTimeMs,
      threadId: diagnosticId(p?.threadId) ?? null, turnId: diagnosticId(p?.turnId) ?? null };
    const record = (stage: string, extra: TransportDiagnostic = {}) => {
      if (this.diagnostics) this.diagnostic({ ...fields, stage, ...extra });
      else operationLog('rpc.request', stage, { processRunId: this.processRunId, requestId: id, method, ...extra });
    };
    record('start', { pendingRequests: this.pending.size });
    const request = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`Codex 请求超时：${method}`), { errorOrigin: 'timeout' })); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method, startedAt });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
    return request.then(value => {
      record('end', { outcome: 'completed', durationMs: Math.round(performance.now() - startedAt) });
      return value;
    }, error => {
      // 进程关闭错误由多个请求共享，复制关联字段，不能让并发请求互相覆盖编号。
      const failure = Object.assign(new Error(error.message), { name: error.name, code: error.code, rpcCode: error.rpcCode,
        processRunId: this.processRunId, requestId: id, failureId: error.failureId ?? randomUUID(),
        errorOrigin: error.errorOrigin ?? (Number.isInteger(error.rpcCode) ? 'backend' : 'transport') });
      record('end', { ...errorFields(failure), outcome: failure.name === 'AbortError' ? 'cancelled' : 'failed', durationMs: Math.round(performance.now() - startedAt) });
      throw failure;
    });
  }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  reject(id: RpcId, message = '客户端不支持此请求'): void { this.write({ id, error: { code: -32601, message } }); }
  private write(msg: RpcMessage): void {
    if (this.closed || !this.child) throw this.closeReason ?? new Error('Codex 连接已断开');
    // 参数序列化错误属于调用方；管道写入失败则立即废弃连接，不能等迟到的 close
    // 才让只读调用重建连接，也不能让其它挂起请求等满 60 秒。
    let line: string;
    try { line = JSON.stringify(msg) + '\n'; }
    catch (error) {
      throw Object.assign(new Error('Codex 请求无法序列化'), { name: error instanceof Error ? error.name : 'Error', errorOrigin: 'client' });
    }
    try {
      if (!this.child.stdin.writable) throw Object.assign(new Error('Codex 输入通道已关闭'), { code: 'ERR_STREAM_DESTROYED' });
      if (!this.child.stdin.write(line)) this.writeBackpressureCount++;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Codex 管道写入失败'), 'stdin');
      throw this.closeReason;
    }
  }
  private fail(e: Error, phase = 'protocol'): void {
    if (this.closed) return;
    this.closed = true;
    this.closePhase = phase;
    const cause = errorFields(e);
    this.closeReason = Object.assign(e, { processRunId: this.processRunId,
      failureId: cause.failureId ?? randomUUID(), errorOrigin: cause.errorOrigin ?? 'transport' });
    const fields = { operationId: this.processRunId, processRunId: this.processRunId, phase, pendingRequests: this.pending.size };
    if (e.name === 'AbortError') operationLog('rpc.process', 'cancelled', fields);
    else operationFailure('rpc.process', e, fields);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.closeReason); }
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
    this.fail(Object.assign(new Error('Codex 连接已关闭'), { name: 'AbortError' }), 'dispose');
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

/** npm 的 Codex 启动器使用 /usr/bin/env node；GUI 更新后可能没有加载 nvm 的 PATH。 */
export function codexSpawnEnvironment(executable: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(executable)) return env;
    fd = fs.openSync(executable, 'r');
    const header = Buffer.alloc(128), bytes = fs.readSync(fd, header, 0, header.length, 0);
    if (!/^#![^\r\n]*\benv(?:\s+-S)?\s+node(?:\s|$)/.test(header.toString('utf8', 0, bytes))) return env;
    const directory = path.dirname(executable);
    fs.accessSync(path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'), fs.constants.X_OK);
    if ((env.PATH ?? '').split(path.delimiter).includes(directory)) return env;
    return { ...env, PATH: [directory, env.PATH].filter(Boolean).join(path.delimiter) };
  } catch { return env; /* 可选探测失败仍交给 spawn 的统一错误处理，不替换用户选择的 CLI。 */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
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
