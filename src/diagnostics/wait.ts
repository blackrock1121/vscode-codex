/** 取消只结束本次等待，不关闭其它功能复用的管理连接；迟到结果不会重新推进诊断。 */
export function diagnosticWait<T>(work: () => PromiseLike<T>, signal?: AbortSignal, timeoutMs = 10000,
  timeoutMessage = '诊断准备超时，请重试；本地检查结果已保留'): Promise<T> {
  const cancelled = () => Object.assign(new Error('诊断已中断'), { name: 'AbortError' });
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error); else resolve(value!);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(Object.assign(new Error(timeoutMessage), { code: 'ETIMEDOUT', errorOrigin: 'timeout' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw cancelled();
      return work();
    }).then(value => finish(undefined, value), error => finish(error));
  });
}
