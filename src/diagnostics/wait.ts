/** 取消只结束本次等待，不关闭其它功能复用的管理连接；迟到结果不会重新推进诊断。 */
export function diagnosticWait<T>(work: () => PromiseLike<T>, signal?: AbortSignal, timeoutMs = 10000,
  timeoutMessage = '诊断准备超时，请重试；本地检查结果已保留'): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error('诊断已中断'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error('诊断已中断'));
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('诊断已中断');
      return work();
    }).then(value => finish(undefined, value), error => finish(error));
  });
}
