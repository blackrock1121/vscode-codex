import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { failureCategory } from './codex/performanceTrace';

type Fields = Record<string, string | number | boolean | null | undefined>;
const context = new AsyncLocalStorage<string>();
let sink: ((line: string) => void) | undefined;
export function setOperationLogSink(write?: (line: string) => void): void { sink = write; }
export function errorFields(error: unknown): Fields {
  const e = error as NodeJS.ErrnoException | undefined;
  const code = typeof e?.code === 'string' && /^(?:E[A-Z0-9_]{1,32}|ERR_[A-Z_]{1,48})$/.test(e.code) ? e.code : undefined;
  return { errorCode: code, errorType: ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError', 'Error'].includes(e?.name ?? '') ? e!.name : undefined, failureCategory: code === 'ENOSPC' ? 'disk_full' : code === 'EIO' ? 'disk_io' :
    e?.name === 'AbortError' ? 'cancelled' : e?.name === 'SyntaxError' ? 'invalid_data' : failureCategory(`${code ?? ''} ${e?.message ?? ''}`) };
}
/** 仅传入固定操作名、枚举、计数和关联 ID；绝不接收错误正文、路径、请求或工具输出。 */
export function operationLog(operation: string, stage: string, fields: Fields = {}): void {
  try { sink?.(`[operation] ${JSON.stringify({ atMs: Date.now(), operation, operationId: context.getStore() ?? randomUUID(), stage, ...fields })}`); }
  catch { /* 最终日志出口故障不能递归调用自己；DailyLogWriter 提供独立健康反馈。 */ }
}
export function operationFailure(operation: string, error: unknown, fields: Fields = {}): void {
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
