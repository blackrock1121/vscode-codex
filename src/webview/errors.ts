/** 页面错误可能带有正文/URL；仅上报固定操作名和标准错误类型。 */
export function webviewErrorCategory(error: unknown): string {
  const name = (error as { name?: unknown })?.name;
  return typeof name === 'string' && ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'AbortError'].includes(name) ? name : 'Error';
}
export function imageErrorOperation(element: Element): string {
  const src = element.getAttribute('src') ?? '';
  const type = element.hasAttribute('data-local-src') || /^file:/i.test(src) ? 'local' :
    /^https?:/i.test(src) ? 'remote' : /^data:/i.test(src) ? 'inline' : src ? 'resource' : undefined;
  return `webview.image.load${type ? '.' + type : ''}`;
}
export function installWebviewErrors(send: (message: string) => void): (operation: string, error?: unknown) => void {
  const reported = new Map<string, number>();
  const pending = new Map<string, number>();
  let unavailable = false;
  const flush = () => {
    for (const [message] of pending) {
      try { send(message); }
      catch {
        if (!unavailable) { unavailable = true; console.warn('[webview] error_report_unavailable'); }
        return;
      }
      pending.delete(message);
      if (reported.size >= 64) reported.delete(reported.keys().next().value!);
      reported.set(message, Date.now());
    }
    if (unavailable) { unavailable = false; console.warn('[webview] error_report_recovered'); }
  };
  const report = (operation: string, error?: unknown) => {
    if (!/^[a-z][a-zA-Z0-9.]{0,95}$/.test(operation) && operation !== 'ResizeObserver loop completed with undelivered notifications.') operation = 'webview.runtime';
    const message = `${operation}: ${webviewErrorCategory(error)}`, now = Date.now();
    if (now - (reported.get(message) ?? -Infinity) < 60000) return;
    if (pending.size >= 64 && !pending.has(message)) pending.delete(pending.keys().next().value!);
    pending.set(message, now);
    flush();
  };
  // 宿主下一次来信说明通道重新活动；不盲目重放用户操作，只补发脱敏错误摘要。
  window.addEventListener('message', flush);
  window.addEventListener('error', event => report(
    (event.target as Element | null)?.tagName === 'IMG' ? imageErrorOperation(event.target as Element) :
    /^ResizeObserver loop (?:completed with undelivered notifications\.|limit exceeded)$/.test(event.message) ? 'ResizeObserver loop completed with undelivered notifications.' : 'webview.runtime', event.error), true);
  window.addEventListener('unhandledrejection', event => report('webview.unhandledrejection', event.reason));
  return report;
}
