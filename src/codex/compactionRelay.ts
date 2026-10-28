import { operationFailure, operationLog } from '../operations';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import { getProxyForUrl } from 'proxy-from-env';
import * as path from 'node:path';
import { CompactionArchive, InputSavings, optimizeCompactionInput, ResponseHistory } from './compactionInput';

interface RelayOptions {
  processRunId?: string;
  /** 上游握手预算；不限制已连接的生成流。 */
  handshakeTimeoutMs?: number;
  constrain?: (raw: Buffer) => Buffer;
  archiveDirectory?: string;
  /** 内部适配测试可延长预算；生产调用省略，使用 250ms。 */
  inputPreparationMs?: number;
  onOptimized?: (threadId: string, savings: InputSavings) => void;
}

const MAX_PAYLOAD = 128 * 1024 * 1024;
const MAX_REWRITE = 32 * 1024 * 1024;
import { CompactionSelector } from './compactionPolicy';
export interface CompactionRoute {
  stage: 'request' | 'response' | 'transport_end';
  routeId?: string;
  connectionId?: string;
  failureId?: string;
  threadId?: string;
  fromModel: string;
  fromEffort?: string;
  outcome?: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  reason?: string;
  httpStatusCode?: number;
  toModel: string;
  effort: string;
  serviceTier: string | null;
  transport: 'http' | 'websocket';
  servedModel?: string;
}

/** 只接管已知的官方提供方；自定义网关、身份路由及未知账号保持原配置。 */
export function compactionUpstream(config: any, account: any): string | undefined {
  if (!config || (config.model_provider && config.model_provider !== 'openai') || config.openai_base_url) return;
  if (config.chatgpt_base_url && (typeof config.chatgpt_base_url !== 'string' ||
    config.chatgpt_base_url.replace(/\/$/, '') !== 'https://chatgpt.com/backend-api')) return;
  if (account?.type === 'chatgpt') return 'https://chatgpt.com/backend-api/codex';
  if (account?.type === 'apiKey') return 'https://api.openai.com/v1';
}

/** 仅替换原生压缩请求的模型/推理；历史、工具、阈值、收费档位逐项保留。 */
export function routeCompaction(raw: Buffer, legacy: boolean, select: CompactionSelector):
  { body: Buffer; route?: Omit<CompactionRoute, 'threadId' | 'transport' | 'stage'> } {
  if (raw.length > MAX_REWRITE) return { body: raw };
  let body: any;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { body: raw }; }
  if (!body || typeof body !== 'object' || typeof body.model !== 'string') return { body: raw };
  if (body.generate === false || body.stream_id != null || body.conversation != null || body.context_management != null) return { body: raw };
  const triggered = Array.isArray(body.input) && body.input.at(-1)?.type === 'compaction_trigger';
  if (!legacy && !triggered) return { body: raw };
  // 只优化已评测的原生 v2。旧 /responses/compact 保留原样，避免误用不同模型协议。
  if (legacy || (body.type !== undefined && body.type !== 'response.create')) return { body: raw };
  const tier = body.service_tier ?? null;
  if (tier !== null && !['default', 'priority', 'fast', 'ultrafast', 'flex', 'auto'].includes(tier)) return { body: raw };
  const selection = select(body.model, tier);
  if (!selection) return { body: raw };
  const fromModel = body.model, fromEffort = typeof body.reasoning?.effort === 'string' && /^[a-z]{1,16}$/.test(body.reasoning.effort) ? body.reasoning.effort : undefined;
  body.model = selection.model;
  body.reasoning = { ...(body.reasoning ?? {}), effort: selection.effort };
  return { body: Buffer.from(JSON.stringify(body)), route: {
    fromModel, ...(fromEffort ? { fromEffort } : {}), toModel: selection.model, effort: selection.effort, serviceTier: tier,
  } };
}

function forwardedHeaders(headers: http.IncomingHttpHeaders, websocket: boolean): http.OutgoingHttpHeaders {
  const skip = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
  for (const name of String(headers.connection ?? '').split(',')) skip.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !skip.has(key) &&
    (!websocket || !key.startsWith('sec-websocket-'))));
}
function bytes(data: RawData): Buffer { return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data); }

/**
 * 每个 CLI 连接独占的回环转发器。凭据由 CLI 正常提供，仅转发到固定官方地址；
 * 不读凭据文件；精简的旧工具原文仅归档到本机，不写入诊断日志。
 * 不更改全局配置。WebSocket 与 SSE 均保留原传输方式。
 */
export class CompactionRelay {
  private readonly server = http.createServer((req, res) => { void this.http(req, res).catch(error => {
    if (!this.closed && !req.aborted && !res.destroyed) operationFailure('relay.http', error, { processRunId: this.options.processRunId });
    if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); }
  }); });
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private readonly sockets = new Set<WebSocket>();
  private readonly requests = new Set<http.ClientRequest>();
  private readonly prefix = '/' + randomBytes(32).toString('hex');
  private agent?: http.Agent;
  private closed = false;
  private ready = false;
  private constructor(private readonly upstream: string, private readonly select: CompactionSelector,
    private readonly onRoute: (route: CompactionRoute) => void, private readonly options: RelayOptions) {
    const target = new URL(upstream);
    if (!(target.protocol === 'https:' && ['chatgpt.com', 'api.openai.com'].includes(target.hostname)) &&
      !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw new Error('不支持的压缩转发目标');
    if (target.username || target.password || target.search || target.hash) throw new Error('无效的压缩转发目标');
    this.server.on('upgrade', (req, socket, head) => {
      const target = this.target(req);
      if (!target || this.closed) { socket.destroy(); return; }
      try { this.upgrade(req, socket, head, target); }
      catch (error) { operationFailure('relay.websocket.upgrade', error, { processRunId: this.options.processRunId }); socket.destroy(); }
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    // listen 成功后仍可能发生服务器错误，不能留下无监听的 error 事件。
    this.server.on('error', error => { if (this.ready && !this.closed) operationFailure('compaction.server', error); });
    this.wss.on('error', error => { if (!this.closed) operationFailure('compaction.websocket.server', error); });
  }
  static async start(upstream: string, select: CompactionSelector,
    onRoute: (route: CompactionRoute) => void, options: RelayOptions = {}): Promise<CompactionRelay> {
    const relay = new CompactionRelay(upstream.replace(/\/$/, ''), select, onRoute, options);
    try {
      const proxy = getProxyForUrl(upstream);
      if (proxy) {
        if (!/^https?:\/\//i.test(proxy)) throw new Error('当前网络代理不支持压缩优化');
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        relay.agent = new HttpsProxyAgent(proxy);
      }
      await new Promise<void>((resolve, reject) => {
        relay.server.once('error', reject);
        relay.server.listen(0, '127.0.0.1', () => { relay.server.off('error', reject); relay.ready = true; resolve(); });
      });
      return relay;
    } catch (e) { relay.close(); throw e; }
  }
  get baseUrl(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('压缩转发已关闭');
    return `http://127.0.0.1:${address.port}${this.prefix}`;
  }
  private target(req: http.IncomingMessage): URL | undefined {
    if (req.headers.origin || !req.url?.startsWith(this.prefix + '/')) return;
    try {
      const target = new URL(this.upstream + req.url.slice(this.prefix.length));
      if (target.href.startsWith(this.upstream + '/')) return target;
    } catch { /* 畸形 URL 不能影响扩展宿主 */ }
  }
  private report(route: CompactionRoute): void {
    try { this.onRoute(route); } catch (error) { operationFailure('compaction.observer', error); /* 诊断失败不能中断模型请求 */ }
  }
  private async rewrite(raw: Buffer, req: http.IncomingMessage, target: URL, transport: CompactionRoute['transport'], signal: AbortSignal, history?: ResponseHistory, connectionId?: string): Promise<{ body: Buffer; route?: CompactionRoute }> {
    if (!target.pathname.endsWith('/responses') || req.headers['content-encoding']) return { body: raw };
    const result = routeCompaction(raw, false, this.select);
    const id = req.headers['thread-id'] ?? req.headers['session-id'];
    const threadId = typeof id === 'string' && /^[\w-]{1,100}$/.test(id) ? id : undefined;
    if (result.route && this.options.archiveDirectory && threadId && raw.length <= MAX_REWRITE) {
      try {
        const body = JSON.parse(result.body.toString());
        if (body.generate !== false && body.input?.at(-1)?.type === 'compaction_trigger') {
          const input = (history ?? new ResponseHistory()).resolve(body);
          if (input) {
            const optimized = await optimizeCompactionInput(input, new CompactionArchive(path.join(this.options.archiveDirectory, threadId)),
              { signal, maxDurationMs: this.options.inputPreparationMs });
            if (optimized.savings.optimizedBytes < optimized.savings.originalBytes) {
              body.input = optimized.input;
              // 改写的是完整历史，不能再沿用包含未精简前缀的服务端响应引用。
              delete body.previous_response_id;
              result.body = Buffer.from(JSON.stringify(body));
              try { this.options.onOptimized?.(threadId, optimized.savings); } catch (error) { operationFailure('compaction.optimized.observer', error); }
            }
          }
        }
      } catch (error) { operationFailure('compaction.rewrite', error); /* 保留原生输入 */ }
    }
    if (this.options.constrain) result.body = this.options.constrain(result.body);
    if (result.route) {
      const route: CompactionRoute = { ...result.route, routeId: randomUUID(), connectionId, threadId, transport, stage: 'request' };
      this.report(route);
      return { body: result.body, route };
    }
    return { body: result.body };
  }
  /** 上游接受握手后才向 CLI 返回 101；403/502 保留原状态，避免伪成功后断流重试。 */
  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: URL): void {
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = typeof req.headers['sec-websocket-protocol'] === 'string' ?
      req.headers['sec-websocket-protocol'].split(',').map(x => x.trim()) : [];
    const upstream = new WebSocket(target, protocols, { headers: forwardedHeaders(req.headers, true),
      agent: this.agent, maxPayload: MAX_PAYLOAD, handshakeTimeout: this.options.handshakeTimeoutMs ?? 20_000,
      perMessageDeflate: { concurrencyLimit: 2, zlibDeflateOptions: { level: 3 } } });
    const connectionId = randomUUID(), started = Date.now();
    const fields = { operationId: connectionId, connectionId, processRunId: this.options.processRunId, transport: 'websocket', targetService: new URL(this.upstream).hostname };
    let settled = false;
    this.sockets.add(upstream);
    operationLog('relay.websocket.handshake', 'start', fields);
    const reject = (status: number, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (this.closed || socket.destroyed) {
        operationLog('relay.websocket.handshake', 'cancelled', { ...fields, durationMs: Date.now() - started });
        socket.destroy();
      }
      else {
        operationFailure('relay.websocket.handshake', error ?? new Error(`HTTP ${status}`), {
          ...fields, httpStatusCode: status, durationMs: Date.now() - started,
          responseSource: error ? 'relay' : 'upstream' });
        // 不转存错误页、认证头或网关正文。
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
      upstream.terminate();
    };
    const cancelled = () => {
      if (!settled) { settled = true; operationLog('relay.websocket.handshake', 'cancelled', { ...fields, durationMs: Date.now() - started }); upstream.terminate(); }
    };
    socket.once('close', cancelled);
    socket.once('error', cancelled);
    upstream.once('close', () => { this.sockets.delete(upstream); if (!settled) reject(502); });
    upstream.on('unexpected-response', (request, response) => {
      reject(response.statusCode ?? 502); response.destroy(); request.destroy();
    });
    // 保留该监听器以吸收 terminate 的迟到 error；已交接连接由 websocket 的边界负责。
    upstream.on('error', error => reject(502, error));
    upstream.once('open', () => {
      if (settled || this.closed || socket.destroyed) { cancelled(); upstream.terminate(); return; }
      settled = true;
      socket.off('close', cancelled); socket.off('error', cancelled);
      try {
        if (upstream.protocol) req.headers['sec-websocket-protocol'] = upstream.protocol;
        else delete req.headers['sec-websocket-protocol'];
        let upgraded = false;
        this.wss.handleUpgrade(req, socket, head, client => {
          upgraded = true;
          this.websocket(req, target, client, upstream, connectionId);
          operationLog('relay.websocket.handshake', 'completed', { ...fields, durationMs: Date.now() - started });
        });
        if (!upgraded) {
          operationLog('relay.websocket.handshake', 'cancelled', { ...fields, reason: 'invalid_client_handshake', durationMs: Date.now() - started });
          upstream.terminate();
        }
        // 非法下游握手被 ws 拒绝时同样释放已经连接的上游。
        socket.once('close', () => { if (upstream.readyState === WebSocket.OPEN) upstream.terminate(); });
      } catch (error) {
        operationFailure('relay.websocket.upgrade', error, fields); socket.destroy(); upstream.terminate();
      }
    });
  }
  private websocket(req: http.IncomingMessage, target: URL, client: WebSocket, upstream: WebSocket, connectionId: string): void {
    this.sockets.add(client); this.sockets.add(upstream);
    const history = new ResponseHistory();
    const controller = new AbortController();
    const fields = { connectionId, processRunId: this.options.processRunId };
    let writes = Promise.resolve(), pendingBytes = 0;
    const responses: (CompactionRoute | undefined)[] = [];
    const incomplete = (reason: string, outcome?: CompactionRoute['outcome'], failureId?: string) => {
      for (const route of responses.splice(0)) if (route) this.report({ ...route, stage: 'response',
        outcome: this.closed ? 'cancelled' : outcome ?? 'incomplete', reason, failureId });
    };
    let writeFailed = false;
    const failedWrite = (reason: string, error: unknown) => {
      if (writeFailed) return;
      writeFailed = true;
      const failureId = randomUUID();
      if (!this.closed) operationFailure('relay.websocket.write', error, { ...fields, reason, failureId });
      incomplete(reason, 'failed', this.closed ? undefined : failureId); controller.abort(); client.terminate(); upstream.terminate();
    };
    client.on('message', (data, binary) => {
      const original = bytes(data); pendingBytes += original.length; client.pause();
      if (pendingBytes > MAX_PAYLOAD) { client.close(1009); upstream.terminate(); return; }
      writes = writes.then(async () => {
        if (this.closed || client.readyState !== WebSocket.OPEN) return;
        const routed = binary ? { body: original } : await this.rewrite(original, req, target, 'websocket', controller.signal, history, connectionId);
        if (this.closed || client.readyState !== WebSocket.OPEN) {
          if (routed.route) this.report({ ...routed.route, stage: 'response', outcome: 'cancelled', reason: 'closed_before_send' });
          return;
        }
        const body = routed.body;
        if (!binary) {
          try {
            const request = JSON.parse(body.toString()); history.request(request);
            if (!history.isReliable) {
              incomplete('history_unavailable');
              if (routed.route) this.report({ ...routed.route, stage: 'response', outcome: 'incomplete', reason: 'history_unavailable' });
            }
            else if (request.type === 'response.create') responses.push(routed.route);
          } catch { history.clear(); incomplete('unrecognized_frame'); /* 无法识别的帧仅转发 */ }
        } else { history.clear(); incomplete('binary_frame'); }
        if (upstream.readyState === WebSocket.OPEN) {
          await new Promise<void>((resolve, reject) => upstream.send(body, { binary }, error => error ? reject(error) : resolve()));
        } else { incomplete('upstream_closed'); client.terminate(); }
      }).catch(error => failedWrite('upstream_send', error)).finally(() => {
        pendingBytes -= original.length;
        if (pendingBytes === 0 && client.readyState === WebSocket.OPEN) client.resume();
      });
    });
    upstream.on('message', (data, binary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (!binary) {
        try {
          const event = JSON.parse(bytes(data).toString());
          const terminal = ['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type);
          const route = terminal ? responses.shift() : undefined;
          history.event(event);
          if (!history.isReliable) incomplete('history_unavailable');
          if (route) {
            const model = event.response?.model;
            this.report({ ...route, stage: 'response', outcome: event.type === 'response.completed' ? 'completed' : event.type === 'response.incomplete' ? 'incomplete' : 'failed',
              servedModel: typeof model === 'string' && /^[\w.-]{1,100}$/.test(model) ? model : undefined });
          }
        } catch { history.clear(); incomplete('unrecognized_frame'); /* 上游原文只转发，不写日志 */ }
      } else { history.clear(); incomplete('binary_frame'); }
      upstream.pause();
      try { client.send(data, { binary }, error => { if (error) failedWrite('client_send', error); else if (!writeFailed) upstream.resume(); }); }
      catch (error) { failedWrite('client_send', error); }
    });
    const closePeer = (peer: WebSocket, code: number, reason: Buffer) => {
      if (peer.readyState === WebSocket.CONNECTING || code === 1006) peer.terminate();
      else if (peer.readyState === WebSocket.OPEN) peer.close(code === 1005 ? 1000 : code, reason);
    };
    client.on('close', (code, reason) => { incomplete('client_closed'); controller.abort(); this.sockets.delete(client); history.clear(); closePeer(upstream, code, reason); });
    upstream.on('close', (code, reason) => { incomplete('upstream_closed'); controller.abort(); this.sockets.delete(upstream); history.clear(); closePeer(client, code, reason); });
    client.on('error', error => { if (!this.closed && !controller.signal.aborted) operationFailure('relay.websocket.client', error, fields); controller.abort(); upstream.terminate(); });
    upstream.on('error', error => { if (!this.closed && !controller.signal.aborted) operationFailure('relay.websocket.upstream', error, fields); controller.abort(); client.terminate(); });
  }
  private async http(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = this.target(req);
    if (!target || this.closed) { res.writeHead(404); res.end(); return; }
    const controller = new AbortController();
    const requestId = randomUUID(), started = Date.now();
    const fields = { operationId: requestId, connectionId: requestId, processRunId: this.options.processRunId,
      transport: 'http', targetService: target.hostname };
    req.once('aborted', () => controller.abort());
    res.once('close', () => controller.abort());
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_PAYLOAD) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    const original = Buffer.concat(chunks);
    const routed = req.method === 'POST' ? await this.rewrite(original, req, target, 'http', controller.signal, undefined, requestId) : { body: original };
    const body = routed.body;
    let ended = false, httpStatusCode: number | undefined, firstResponseMs: number | undefined;
    operationLog('relay.http', 'start', { ...fields, routeId: routed.route?.routeId, requestKind: routed.route ? 'compaction' : 'passthrough' });
    // HTTP 只观察传输终态，不把 2xx/SSE 结束冒充压缩语义成功。
    const finish = (outcome: CompactionRoute['outcome'], reason: string, error?: unknown) => {
      if (ended) return;
      ended = true;
      const failureId = outcome === 'failed' ? randomUUID() : undefined;
      const details = { ...fields, routeId: routed.route?.routeId, requestKind: routed.route ? 'compaction' : 'passthrough',
        httpStatusCode, firstResponseMs, durationMs: Date.now() - started, reason, failureId };
      if (outcome === 'failed') operationFailure('relay.http', error ?? new Error(`HTTP ${httpStatusCode}`), details);
      else operationLog('relay.http', outcome === 'cancelled' ? 'cancelled' : outcome === 'incomplete' ? 'incomplete' : 'completed', details);
      if (routed.route) this.report({ ...routed.route, stage: 'transport_end', outcome, reason, httpStatusCode, failureId });
    };
    if (this.closed || res.destroyed || req.aborted) { finish('cancelled', 'closed_before_send'); res.destroy(); return; }
    res.once('close', () => finish('cancelled', this.closed ? 'relay_closed' : 'client_closed'));
    const headers = forwardedHeaders(req.headers, false);
    if (body.length || req.headers['content-length']) headers['content-length'] = body.length;
    const upstream = (target.protocol === 'https:' ? https : http).request(target, {
      method: req.method, headers, agent: this.agent,
    }, response => {
      httpStatusCode = response.statusCode;
      firstResponseMs = Date.now() - started;
      res.writeHead(response.statusCode ?? 502, forwardedHeaders(response.headers, false));
      response.on('end', () => finish(httpStatusCode && httpStatusCode >= 400 ? 'failed' : undefined, 'http_stream_ended'));
      response.on('error', error => { finish(controller.signal.aborted ? 'cancelled' : 'failed', 'response_error', error); res.destroy(); }); response.pipe(res);
    });
    this.requests.add(upstream);
    upstream.on('close', () => this.requests.delete(upstream));
    upstream.on('error', error => {
      finish(this.closed || controller.signal.aborted ? 'cancelled' : 'failed', 'upstream_error', error);
      // 已经转发部分 SSE 后必须中断响应，不能伪装成完整的 HTTP 200。
      if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); }
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.terminate(); this.sockets.clear();
    for (const request of this.requests) request.destroy(); this.requests.clear();
    this.wss.close(); this.server.closeAllConnections(); this.server.close(); this.agent?.destroy();
  }
}
