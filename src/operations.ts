import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { failureCategory } from './codex/performanceTrace';
import { DiagnosticHealth } from './diagnosticHealth';

type Fields = Record<string, string | number | boolean | null | undefined>;
const context = new AsyncLocalStorage<string>();
let sink: ((line: string) => void) | undefined;
const health = new DiagnosticHealth('operation.sink');
// 同一个异常跨操作边界传播时保留故障标识；不修改冻结异常，也不把异常正文写盘。
const failures = new WeakMap<object, string>();
export function setOperationLogSink(write?: (line: string) => void): void { sink = write; }
export function errorFields(error: unknown): Fields {
  const e = error as (NodeJS.ErrnoException & { rpcCode?: number; processRunId?: string; failureId?: string; requestId?: number; errorOrigin?: string }) | undefined;
  const safeCode = (value: unknown) => typeof value === 'string' && /^(?:E[A-Z0-9_]{1,32}|ERR_[A-Z_]{1,48}|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/.test(value) ? value : undefined;
  const code = safeCode(e?.code);
  // Node/代理库可能把网络原因包装在 cause 中。只提取有界链上的白名单代码。
  let causeCode: string | undefined, cause = (e as Error | undefined)?.cause;
  for (let depth = 0; cause && typeof cause === 'object' && depth < 4; depth++) {
    causeCode = safeCode((cause as NodeJS.ErrnoException).code);
    if (causeCode) break;
    cause = (cause as Error).cause;
  }
  const message = typeof e?.message === 'string' ? e.message.slice(0, 32768) : '';
  const httpStatusCode = Number(message.match(/\b(?:HTTP(?:\/[\d.]+)?|status(?:_code| code)?)[ :="']+([45]\d{2})\b/i)?.[1]) || undefined;
  const transportReason = /Proxy connection ended before receiving CONNECT response/i.test(message) ? 'proxy_connect_closed' :
    /opening handshake has timed out/i.test(message) ? 'handshake_timeout' :
    /CERT_|SELF_SIGNED|UNABLE_TO_(?:VERIFY|GET_ISSUER)|ERR_TLS/.test(code ?? causeCode ?? '') ? 'tls_certificate' : undefined;
  const id = (value: unknown) => typeof value === 'string' && /^[a-f\d-]{36}$/i.test(value) ? value : undefined;
  return { processRunId: id(e?.processRunId), failureId: id(e?.failureId) ?? (e && typeof e === 'object' ? failures.get(e) : undefined), requestId: Number.isSafeInteger(e?.requestId) ? e!.requestId : undefined,
    errorOrigin: ['client', 'transport', 'backend', 'timeout'].includes(e?.errorOrigin ?? '') ? e!.errorOrigin : undefined,
    errorCode: code, causeCode, httpStatusCode, transportReason, rpcCode: Number.isInteger(e?.rpcCode) ? e!.rpcCode : undefined, errorType: ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError', 'Error'].includes(e?.name ?? '') ? e!.name : undefined, failureCategory: code === 'ENOSPC' ? 'disk_full' : code === 'EIO' ? 'disk_io' : code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' ? 'connection_closed' :
    e?.name === 'AbortError' ? 'cancelled' : e?.name === 'SyntaxError' ? 'invalid_data' : transportReason === 'handshake_timeout' ? 'timeout' :
      transportReason ? 'network_or_service' : failureCategory(`${code ?? causeCode ?? ''} ${message}`) };
}
/** 仅传入固定操作名、枚举、计数和关联 ID；绝不接收错误正文、路径、请求或工具输出。 */
export function operationLog(operation: string, stage: string, fields: Fields = {}): void {
  try {
    if (!sink) return;
    health.recovered(sink);
    sink(`[operation] ${JSON.stringify({ atMs: Date.now(), operation, operationId: context.getStore() ?? randomUUID(), stage, ...fields })}`);
  } catch (error) { health.failed(error); }
}
export function operationFailure(operation: string, error: unknown, fields: Fields = {}): void {
  if (error && typeof error === 'object' && !errorFields(error).failureId) failures.set(error, randomUUID());
  const details = errorFields(error);
  operationLog(operation, details.failureCategory === 'cancelled' ? 'cancelled' : 'failed', { ...details, ...fields });
}
export function expectedFileError(error: unknown, codes = ['ENOENT']): boolean {
  return codes.includes(String((error as NodeJS.ErrnoException)?.code));
}
export async function observeOperation<T>(operation: string, work: () => PromiseLike<T> | T, fields: Fields = {}): Promise<T> {
  const parentOperationId = context.getStore(), operationId = randomUUID(), started = performance.now();
  return context.run(operationId, async () => {
    operationLog(operation, 'start', { ...fields, parentOperationId });
    try {
      const result = await work();
      operationLog(operation, 'completed', { ...fields, durationMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      operationFailure(operation, error, { ...fields, durationMs: Math.round(performance.now() - started) });
      throw error;
    }
  });
}
