import { randomUUID } from 'node:crypto';
import { errorFields, operationFailure, operationLog } from './operations';

type Target = { postMessage(message: any): PromiseLike<boolean> };
const failures = new WeakMap<Target, string>();
/** 全部 Webview 发送共用失败边界，接收方关闭时不会产生未处理的 Promise rejection。 */
export async function postWebviewMessage(target: Target | undefined, message: unknown): Promise<boolean> {
  if (!target) return false;
  try {
    const delivered = await target.postMessage(message);
    if (delivered === false) {
      if (!failures.has(target)) { failures.set(target, randomUUID()); operationLog('webview.delivery', 'unavailable', { operationId: failures.get(target), failureId: failures.get(target) }); } return false;
    }
    if (failures.has(target)) { operationLog('webview.delivery', 'recovered', { operationId: failures.get(target), previousFailureId: failures.get(target) }); failures.delete(target); }
    return true;
  } catch (error) {
    if (!failures.has(target)) {
      const failureId = String(errorFields(error).failureId ?? randomUUID());
      failures.set(target, failureId);
      operationFailure('webview.delivery', error, { operationId: failureId, failureId });
    } return false;
  }
}
