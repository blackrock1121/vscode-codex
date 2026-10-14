import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { LocalTelemetry, TransportDiagnostic } from './telemetry';

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
  private pending = new Map<RpcId, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private starting?: Promise<void>;
  private closed = false;
  private closeReason?: Error;
  private killTimer?: NodeJS.Timeout;
  private telemetry?: LocalTelemetry;
  private readonly processRunId = randomUUID();
  private receivedMessages = 0;
  private receivedBytes = 0;
  private lastReceivedAt?: number;
  constructor(private readonly executable: string, private readonly cwd: string, private readonly env?: NodeJS.ProcessEnv,
    private readonly diagnostics = false) { super(); }
  transportSnapshot() {
    return { processRunId: this.processRunId, localReceivedMessages: this.receivedMessages,
      localReceivedBytes: this.receivedBytes, localLastMessageAgeMs: this.lastReceivedAt === undefined ? null :
        Math.round(performance.now() - this.lastReceivedAt), localPendingRequests: this.pending.size };
  }
  private diagnostic(row: TransportDiagnostic) {
    this.emit('diagnostic', { ...row, processRunId: this.processRunId, receivedAtMs: Date.now() });
  }
  get isClosed(): boolean { return this.closed; }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'));
    return this.starting ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    if (this.diagnostics) {
      try {
        this.telemetry = await LocalTelemetry.start(row => this.diagnostic(row));
        this.diagnostic({ type: 'telemetry_status', status: 'local_collector_ready',
          serverQueueMs: null, networkTransitMs: null, note: 'backend_timings_only_when_reported' });
      } catch { this.diagnostic({ type: 'telemetry_status', status: 'unavailable' }); }
    }
    if (this.closed) { this.telemetry?.close(); throw new Error('Codex 连接已关闭'); }
    const child = spawn(resolveCodex(this.executable), ['app-server', '--listen', 'stdio://', ...(this.telemetry?.args() ?? [])], {
      cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: 'pipe', windowsHide: true,
    });
    this.child = child;
    child.on('error', e => this.fail(e));
    child.stdin.on('error', e => this.fail(e));
    child.stdout.on('error', e => this.fail(e));
    child.stderr.on('data', () => { /* CLI stderr 可能含配置和路径，不写入聊天日志。 */ });
    child.once('close', code => {
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
      let msg: RpcMessage;
      try { msg = JSON.parse(line); } catch { this.fail(new Error(`Codex 返回了无效协议数据（stdout 行长度 ${Buffer.byteLength(line)} 字节）`)); return; }
      if (!isRpcMessage(msg)) { this.fail(new Error(`Codex 返回了无效协议消息结构（stdout 行长度 ${Buffer.byteLength(line)} 字节）`)); return; }
      this.receivedMessages++; this.lastReceivedAt = performance.now();
      if (msg.method) {
        this.emit(msg.id === undefined ? 'notification' : 'request', msg);
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`)); else p.resolve(msg.result);
      }
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
  }
  request<T = any>(method: string, params: unknown = {}, timeout = 60_000): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new Error('Codex 尚未连接'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  reject(id: RpcId, message = '客户端不支持此请求'): void { this.write({ id, error: { code: -32601, message } }); }
  private write(msg: RpcMessage): void {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Codex 连接已断开');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = e;
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
    this.fail(new Error('Codex 连接已关闭'));
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
