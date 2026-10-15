import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { failureCategory } from './performanceTrace';

/** CLI 的 OTLP 只送到本机；原始属性可能含工具输出，必须先过白名单再交给日志。 */
export type TransportDiagnostic = Record<string, string | number | boolean | null>;
const EVENTS = new Set(['codex.api_request', 'codex.sse_event', 'codex.websocket_request',
  'codex.websocket_event', 'codex.websocket_connect', 'codex.retry', 'codex.responses_api_timing',
  'codex.tool_result', 'codex.tool_decision']);
const IDS = ['conversation.id', 'thread_id', 'turn.id', 'turn_id', 'response.id', 'response_id',
  'request_id', 'auth.request_id', 'model', 'service_tier', 'model_reasoning_effort', 'app.version',
  'tool', 'tool_name', 'tool.name', 'call_id', 'tool_call_id', 'parent_thread_id'];
const NUMBERS = ['duration_ms', 'attempt', 'http.response.status_code', 'status_code', 'ttft_ms',
  'input_token_count', 'output_token_count', 'cached_token_count', 'cache_write_token_count', 'reasoning_token_count',
  'responses_duration_excl_engine_and_client_tool_time_ms', 'engine_service_total_ms',
  'engine_iapi_ttft_total_ms', 'engine_service_ttft_total_ms',
  'engine_iapi_tbt_across_engine_calls_ms', 'engine_service_tbt_across_engine_calls_ms'];
const METRICS = new Set(['api_request.duration_ms', 'websocket.request.duration_ms',
  'responses_api_overhead.duration_ms', 'responses_api_inference_time.duration_ms',
  'responses_api_engine_iapi_ttft.duration_ms', 'responses_api_engine_service_ttft.duration_ms',
  'responses_api_engine_iapi_tbt.duration_ms', 'responses_api_engine_service_tbt.duration_ms',
  'tool.call.duration_ms', 'mcp.call.duration_ms', 'hooks.run.duration_ms', 'turn.e2e_duration_ms',
  'turn.ttft.duration_ms', 'turn.ttfm.duration_ms', 'mcp.tools.list.duration_ms']);
const MAX_BYTES = 2 * 1024 * 1024;
function list(v: unknown): any[] { return Array.isArray(v) ? v : []; }
function scalar(v: any): unknown { return v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue; }
function attrs(v: unknown): Record<string, unknown> {
  return Object.fromEntries(list(v).filter(x => typeof x?.key === 'string').map(x => [x.key, scalar(x.value)]));
}
function number(v: unknown): number | undefined {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+(?:\.\d+)?$/.test(v))) return;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function timestamp(v: unknown): number | null {
  const n = number(v); return n !== undefined && n > 0 && n / 1e6 < 8.64e15 ? Math.floor(n / 1e6) : null;
}
function identifier(v: unknown): string | undefined {
  return typeof v === 'string' && /^[\w.:-]{1,160}$/.test(v) ? v : undefined;
}
function fields(a: Record<string, unknown>): TransportDiagnostic {
  const out: TransportDiagnostic = {};
  for (const key of IDS) { const v = identifier(a[key]); if (v !== undefined) out[key] = v; }
  for (const key of NUMBERS) { const v = number(a[key]); if (v !== undefined) out[key] = v; }
  if (typeof a.success === 'boolean') out.success = a.success;
  else if (a.success === 'true' || a.success === 'false') out.success = a.success === 'true';
  // 错误正文不写盘；只保留是否存在，具体类别由 app-server 的结构化错误补充。
  if (typeof a['error.message'] === 'string') out.hasError = a['error.message'].length > 0;
  if (typeof a['auth.connection_reused'] === 'boolean') out.connectionReused = a['auth.connection_reused'];
  for (const key of ['decision', 'source']) {
    const allowed = ['approved', 'denied', 'accept', 'decline', 'abort', 'user', 'config', 'configuration', 'automatic', 'session'];
    if (typeof a[key] === 'string' && allowed.includes(a[key])) out[key] = a[key];
  }
  if (Number.isInteger(a.exit_code)) out.exitCode = a.exit_code as number;
  if (out.success === false) out.failureCategory = failureCategory(a['error.message'] ?? a.output, out.exitCode as number | undefined);
  // 只保存已知 API 路由，不保存主机、查询参数或任意 URL。
  if (typeof a.endpoint === 'string') {
    const endpoint = a.endpoint.match(/(?:^|\/)(responses(?:\/compact)?|models)(?:\?|$)/)?.[1];
    if (endpoint) out.endpoint = `/${endpoint}`;
  }
  return out;
}

export function transportDiagnostics(payload: any): TransportDiagnostic[] {
  const out: TransportDiagnostic[] = [];
  for (const resource of list(payload?.resourceLogs)) {
    const common = attrs(resource?.resource?.attributes);
    for (const scope of list(resource?.scopeLogs)) for (const record of list(scope?.logRecords)) {
      const a = { ...common, ...attrs(record?.attributes) };
      const event = a['event.name'] ?? record?.eventName;
      if (typeof event !== 'string' || !EVENTS.has(event)) continue;
      const kind = identifier(a['event.kind'] ?? a.kind);
      // 每个 token 的 delta 不写日志；保留开始、结束、压缩与错误事件及汇总用量。
      if ((event === 'codex.sse_event' || event === 'codex.websocket_event') && kind?.includes('delta') &&
          !a['error.message'] && a.success !== false && a.success !== 'false') continue;
      const eventTime = typeof a['event.timestamp'] === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(a['event.timestamp']) ? Date.parse(a['event.timestamp']) : NaN;
      const sourceTime = timestamp(record?.timeUnixNano);
      const row: TransportDiagnostic = { type: 'event', event,
        sourceTimeMs: Number.isFinite(eventTime) ? eventTime : sourceTime,
        sourceTimeBasis: Number.isFinite(eventTime) ? 'event.timestamp' : sourceTime === null ? 'unavailable' : 'timeUnixNano',
        observedTimeMs: timestamp(record?.observedTimeUnixNano), ...fields(a) };
      for (const key of ['traceId', 'spanId']) {
        if (typeof record?.[key] === 'string' && /^(?:[a-f0-9]{16}|[a-f0-9]{32})$/i.test(record[key]) && /[1-9a-f]/i.test(record[key]))
          row[key] = record[key];
      }
      if (kind) row.eventKind = kind;
      // 部分 CLI 把后端 timing 放在一个 JSON 字符串中，仍逐字段筛选。
      if (typeof a.timing_metrics === 'string' && a.timing_metrics.length < 8192) {
        try {
          const timing = JSON.parse(a.timing_metrics);
          for (const key of NUMBERS.filter(x => x.includes('engine_'))) {
            const v = number(timing?.[key]); if (v !== undefined) row[key] = v;
          }
        } catch { /* 未提供结构化 timing */ }
      }
      out.push(row);
    }
  }
  for (const resource of list(payload?.resourceMetrics)) {
    const common = attrs(resource?.resource?.attributes);
    for (const scope of list(resource?.scopeMetrics)) for (const metric of list(scope?.metrics)) {
      const name = typeof metric?.name === 'string' ? metric.name.replace(/^codex\./, '') : '';
      if (!METRICS.has(name)) continue;
      for (const point of list(metric?.histogram?.dataPoints)) {
        const row: TransportDiagnostic = { type: 'metric', metric: name, scope: 'process_aggregate',
          sourceTimeMs: timestamp(point?.timeUnixNano), startTimeMs: timestamp(point?.startTimeUnixNano),
          ...fields({ ...common, ...attrs(point?.attributes) }) };
        for (const key of ['count', 'sum', 'min', 'max']) { const v = number(point?.[key]); if (v !== undefined) row[key] = v; }
        const temporality = number(metric?.histogram?.aggregationTemporality);
        if (temporality !== undefined) row.aggregationTemporality = temporality;
        out.push(row);
      }
    }
  }
  return out;
}

export class LocalTelemetry {
  private readonly route = `/${randomUUID()}`;
  private readonly server: http.Server;
  private constructor(private readonly receive: (row: TransportDiagnostic) => void) {
    this.server = http.createServer((req, res) => {
      // 不提供 CORS，不接受任意路径，也不对外网监听。
      if (req.method !== 'POST' || ![`${this.route}/v1/logs`, `${this.route}/v1/metrics`].includes(req.url ?? '')) {
        res.writeHead(404).end(); req.resume(); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      req.on('error', () => {});
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_BYTES) return;
        try {
          let body = Buffer.concat(chunks);
          if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body, { maxOutputLength: MAX_BYTES });
          else if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
            res.writeHead(415).end(); return;
          }
          const rows = transportDiagnostics(JSON.parse(body.toString('utf8')));
          for (const row of rows) { try { this.receive(row); } catch { /* 日志失败不能影响对话 */ } }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        } catch { res.writeHead(400).end(); }
      });
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.maxConnections = 8;
  }
  static async start(receive: (row: TransportDiagnostic) => void): Promise<LocalTelemetry> {
    const local = new LocalTelemetry(receive);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { local.close(); reject(new Error('telemetry_listen_timeout')); }, 1000);
      local.server.once('error', () => { clearTimeout(timer); local.close(); reject(new Error('telemetry_listen_failed')); });
      local.server.listen(0, '127.0.0.1', () => { clearTimeout(timer); local.server.unref(); resolve(); });
    });
    return local;
  }
  endpoint(kind: 'logs' | 'metrics'): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('telemetry_not_listening');
    return `http://127.0.0.1:${address.port}${this.route}/v1/${kind}`;
  }
  args(): string[] {
    const exporter = (kind: 'logs' | 'metrics') => `{ otlp-http = { endpoint = "${this.endpoint(kind)}", protocol = "json" } }`;
    return ['-c', `otel.exporter=${exporter('logs')}`, '-c', `otel.metrics_exporter=${exporter('metrics')}`,
      '-c', 'otel.log_user_prompt=false'];
  }
  close(): void { this.server.close(); this.server.closeAllConnections(); }
}
