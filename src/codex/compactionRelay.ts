import * as http from 'node:http';
import * as https from 'node:https';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import { getProxyForUrl } from 'proxy-from-env';
import * as path from 'node:path';
import { CompactionArchive, InputSavings, optimizeCompactionInput, ResponseHistory } from './compactionInput';

interface RelayOptions { archiveDirectory?: string; onOptimized?: (threadId: string, savings: InputSavings) => void; }

const MAX_PAYLOAD = 128 * 1024 * 1024;
const MAX_REWRITE = 32 * 1024 * 1024;
const COMPACTION_MODEL = 'gpt-6.1-sol';
export interface CompactionRoute {
  stage: 'request' | 'response';
  threadId?: string;
  fromModel: string;
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
export function routeCompaction(raw: Buffer, legacy: boolean, canRoute: (tier: string | null) => boolean):
  { body: Buffer; route?: Omit<CompactionRoute, 'threadId' | 'transport' | 'stage'> } {
  if (raw.length > MAX_REWRITE) return { body: raw };
  let body: any;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { body: raw }; }
  if (!body || typeof body !== 'object' || body.model !== 'gpt-6-astra') return { body: raw };
  const triggered = Array.isArray(body.input) && body.input.at(-1)?.type === 'compaction_trigger';
  if (!legacy && !triggered) return { body: raw };
  // 只优化已评测的原生 v2。旧 /responses/compact 保留原样，避免误用不同模型协议。
  if (legacy || (body.type !== undefined && body.type !== 'response.create')) return { body: raw };
  const tier = body.service_tier ?? null;
  if (tier !== null && !['default', 'priority', 'fast', 'ultrafast', 'flex', 'auto'].includes(tier)) return { body: raw };
  if (!canRoute(tier)) return { body: raw };
  body.model = COMPACTION_MODEL;
  body.reasoning = { ...(body.reasoning ?? {}), effort: 'xhigh' };
  return { body: Buffer.from(JSON.stringify(body)), route: {
    fromModel: 'gpt-6-astra', toModel: COMPACTION_MODEL, effort: 'xhigh', serviceTier: tier,
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
  private readonly server = http.createServer((req, res) => { void this.http(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(502); res.end();
  }); });
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private readonly sockets = new Set<WebSocket>();
  private readonly requests = new Set<http.ClientRequest>();
  private readonly prefix = '/' + randomBytes(32).toString('hex');
  private agent?: http.Agent;
  private closed = false;
  private constructor(private readonly upstream: string, private readonly canRoute: (tier: string | null) => boolean,
    private readonly onRoute: (route: CompactionRoute) => void, private readonly options: RelayOptions) {
    const target = new URL(upstream);
    if (!(target.protocol === 'https:' && ['chatgpt.com', 'api.openai.com'].includes(target.hostname)) &&
      !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw new Error('不支持的压缩转发目标');
    if (target.username || target.password || target.search || target.hash) throw new Error('无效的压缩转发目标');
    this.server.on('upgrade', (req, socket, head) => {
      const target = this.target(req);
      if (!target || this.closed) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, client => this.websocket(req, target, client));
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }
  static async start(upstream: string, canRoute: (tier: string | null) => boolean,
    onRoute: (route: CompactionRoute) => void, options: RelayOptions = {}): Promise<CompactionRelay> {
    const relay = new CompactionRelay(upstream.replace(/\/$/, ''), canRoute, onRoute, options);
    try {
      const proxy = getProxyForUrl(upstream);
      if (proxy) {
        if (!/^https?:\/\//i.test(proxy)) throw new Error('当前网络代理不支持压缩优化');
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        relay.agent = new HttpsProxyAgent(proxy);
      }
      await new Promise<void>((resolve, reject) => {
        relay.server.once('error', reject);
        relay.server.listen(0, '127.0.0.1', () => { relay.server.off('error', reject); resolve(); });
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
    try { this.onRoute(route); } catch { /* 诊断失败不能中断模型请求 */ }
  }
  private async rewrite(raw: Buffer, req: http.IncomingMessage, target: URL, transport: CompactionRoute['transport'], history?: ResponseHistory): Promise<{ body: Buffer; route?: CompactionRoute }> {
    if (!target.pathname.endsWith('/responses') || req.headers['content-encoding']) return { body: raw };
    const result = routeCompaction(raw, false, this.canRoute);
    const id = req.headers['thread-id'] ?? req.headers['session-id'];
    const threadId = typeof id === 'string' && /^[\w-]{1,100}$/.test(id) ? id : undefined;
    if (result.route && this.options.archiveDirectory && threadId && raw.length <= MAX_REWRITE) {
      try {
        const body = JSON.parse(result.body.toString());
        if (body.generate !== false && body.input?.at(-1)?.type === 'compaction_trigger') {
          const input = history ? history.resolve(body) : !body.previous_response_id ? body.input : undefined;
          if (input) {
            const optimized = await optimizeCompactionInput(input, new CompactionArchive(path.join(this.options.archiveDirectory, threadId)));
            if (optimized.savings.optimizedBytes < optimized.savings.originalBytes) {
              body.input = optimized.input;
              // 改写的是完整历史，不能再沿用包含未精简前缀的服务端响应引用。
              delete body.previous_response_id;
              result.body = Buffer.from(JSON.stringify(body));
              try { this.options.onOptimized?.(threadId, optimized.savings); } catch { /* 诊断不可影响请求 */ }
            }
          }
        }
      } catch { /* 历史不完整、未知协议或归档失败时沿用原生输入 */ }
    }
    if (result.route) {
      const route: CompactionRoute = { ...result.route, threadId, transport, stage: 'request' };
      this.report(route);
      return { body: result.body, route };
    }
    return { body: result.body };
  }
  private websocket(req: http.IncomingMessage, target: URL, client: WebSocket): void {
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = typeof req.headers['sec-websocket-protocol'] === 'string' ?
      req.headers['sec-websocket-protocol'].split(',').map(x => x.trim()) : [];
    const upstream = new WebSocket(target, protocols, { headers: forwardedHeaders(req.headers, true),
      agent: this.agent, maxPayload: MAX_PAYLOAD, handshakeTimeout: 20_000,
      perMessageDeflate: { concurrencyLimit: 2, zlibDeflateOptions: { level: 3 } } });
    this.sockets.add(client); this.sockets.add(upstream);
    let queued: { body: Buffer; binary: boolean }[] = [], queuedBytes = 0;
    const history = new ResponseHistory();
    let writes = Promise.resolve(), pendingBytes = 0;
    const responses: (CompactionRoute | undefined)[] = [];
    client.on('message', (data, binary) => {
      const original = bytes(data); pendingBytes += original.length; client.pause();
      if (pendingBytes > MAX_PAYLOAD) { client.close(1009); upstream.terminate(); return; }
      writes = writes.then(async () => {
        if (this.closed || client.readyState !== WebSocket.OPEN) return;
        const routed = binary ? { body: original } : await this.rewrite(original, req, target, 'websocket', history);
        if (this.closed || client.readyState !== WebSocket.OPEN) return;
        const body = routed.body;
        if (!binary) {
          try {
            const request = JSON.parse(body.toString()); history.request(request);
            if (request.type === 'response.create') responses.push(routed.route);
          } catch { /* 原样转发非 JSON 帧 */ }
        }
        if (upstream.readyState === WebSocket.CONNECTING) {
          queuedBytes += body.length;
          if (queuedBytes > MAX_PAYLOAD) { client.close(1009); upstream.terminate(); return; }
          queued.push({ body, binary });
        } else if (upstream.readyState === WebSocket.OPEN) {
          await new Promise<void>((resolve, reject) => upstream.send(body, { binary }, error => error ? reject(error) : resolve()));
        }
      }).catch(() => { client.terminate(); upstream.terminate(); }).finally(() => {
        pendingBytes -= original.length;
        if (pendingBytes === 0 && client.readyState === WebSocket.OPEN) client.resume();
      });
    });
    upstream.on('open', () => {
      if (client.readyState !== WebSocket.OPEN) { upstream.close(); return; }
      for (const { body, binary } of queued) upstream.send(body, { binary });
      queued = []; queuedBytes = 0;
    });
    upstream.on('message', (data, binary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (!binary) {
        try {
          const event = JSON.parse(bytes(data).toString());
          history.event(event);
          if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
            const route = responses.shift();
            const model = event.response?.model;
            if (route && typeof model === 'string' && /^[\w.-]{1,100}$/.test(model))
              this.report({ ...route, stage: 'response', servedModel: model });
          }
        } catch { /* 上游原文只转发，不写日志 */ }
      }
      upstream.pause(); client.send(data, { binary }, error => { if (error) upstream.terminate(); else upstream.resume(); });
    });
    const closePeer = (peer: WebSocket, code: number, reason: Buffer) => {
      if (peer.readyState === WebSocket.CONNECTING || code === 1006) peer.terminate();
      else if (peer.readyState === WebSocket.OPEN) peer.close(code === 1005 ? 1000 : code, reason);
    };
    client.on('close', (code, reason) => { this.sockets.delete(client); queued = []; history.clear(); closePeer(upstream, code, reason); });
    upstream.on('close', (code, reason) => { this.sockets.delete(upstream); queued = []; history.clear(); closePeer(client, code, reason); });
    client.on('error', () => upstream.terminate());
    upstream.on('error', () => client.terminate());
  }
  private async http(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = this.target(req);
    if (!target || this.closed) { res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_PAYLOAD) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    const original = Buffer.concat(chunks);
    const body = req.method === 'POST' ? (await this.rewrite(original, req, target, 'http')).body : original;
    if (this.closed || res.destroyed || req.aborted) { res.destroy(); return; }
    const headers = forwardedHeaders(req.headers, false);
    if (body.length || req.headers['content-length']) headers['content-length'] = body.length;
    const upstream = (target.protocol === 'https:' ? https : http).request(target, {
      method: req.method, headers, agent: this.agent,
    }, response => {
      res.writeHead(response.statusCode ?? 502, forwardedHeaders(response.headers, false));
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    this.requests.add(upstream);
    upstream.on('close', () => this.requests.delete(upstream));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
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
