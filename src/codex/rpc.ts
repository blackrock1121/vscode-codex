import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type RpcId = string | number;
export interface RpcMessage { id?: RpcId; method?: string; params?: any; result?: any; error?: { code: number; message: string }; }

/** 只传输 JSONL，不记录提示词、凭据或完整 RPC 内容。 */
export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<RpcId, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private starting?: Promise<void>;
  private closed = false;
  constructor(private readonly executable: string, private readonly cwd: string, private readonly env?: NodeJS.ProcessEnv) { super(); }
  get isClosed(): boolean { return this.closed; }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'));
    return this.starting ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    const child = spawn(resolveCodex(this.executable), ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: 'pipe', windowsHide: true,
    });
    this.child = child;
    child.on('error', e => this.fail(e));
    child.stdin.on('error', e => this.fail(e));
    child.stderr.on('data', () => { /* CLI stderr 可能含配置和路径，不写入聊天日志。 */ });
    child.once('close', code => { this.fail(new Error(`Codex 进程已退出 (${code ?? 'signal'})`)); this.emit('close', code); });
    createInterface({ input: child.stdout }).on('line', line => {
      let msg: RpcMessage;
      try { msg = JSON.parse(line); } catch { this.fail(new Error(`Codex 返回了无效协议数据（stdout 行长度 ${Buffer.byteLength(line)} 字节）`)); return; }
      if (msg.method) {
        this.emit(msg.id === undefined ? 'notification' : 'request', msg);
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`)); else p.resolve(msg.result);
      }
    });
    await this.request('initialize', { clientInfo: { name: 'vscode_codex_copilot', title: 'Codex Copilot', version: '0.1.0' }, capabilities: { experimentalApi: true } });
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
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
    // 协议损坏时子进程可能仍存活；释放它，避免后续请求复用失效连接。
    this.child?.kill();
  }
  dispose(): void {
    this.fail(new Error('Codex 连接已关闭'));
    const child = this.child;
    if (!child) return;
    child.stdin.end(); child.kill();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    timer.unref(); child.once('close', () => clearTimeout(timer));
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
