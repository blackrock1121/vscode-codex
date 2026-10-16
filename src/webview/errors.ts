/** 页面错误可能带有正文/URL；仅上报固定操作名和标准错误类型。 */
export function webviewErrorCategory(error: unknown): string {
  const name = (error as { name?: unknown })?.name;
  return typeof name === 'string' && ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'AbortError'].includes(name) ? name : 'Error';
}
export function installWebviewErrors(send: (message: string) => void): (operation: string, error?: unknown) => void {
  const reported = new Map<string, number>();
  const report = (operation: string, error?: unknown) => {
    const message = `${operation}: ${webviewErrorCategory(error)}`, now = Date.now();
    if (now - (reported.get(message) ?? -Infinity) < 60000) return;
    if (reported.size >= 64) reported.delete(reported.keys().next().value!);
    reported.set(message, now);
    try { send(message); } catch { /* 最终桥接已关闭，不能递归上报 */ }
  };
  window.addEventListener('error', event => report(
    /^ResizeObserver loop (?:completed with undelivered notifications\.|limit exceeded)$/.test(event.message) ? 'ResizeObserver loop completed with undelivered notifications.' : 'webview.runtime', event.error));
  window.addEventListener('unhandledrejection', event => report('webview.unhandledrejection', event.reason));
  return report;
}
