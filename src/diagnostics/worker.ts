import { errorFields } from '../operations';
import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { scanPluginLogs } from './scan';

void (async () => {
  try {
    const result = await scanPluginLogs(workerData.logDir, message => parentPort!.postMessage({ type: 'progress', message }), workerData.request);
    parentPort!.postMessage({ type: 'progress', message: '正在整理全局诊断证据…' });
    parentPort!.postMessage({ type: 'result', result });
  } catch (error) {
    parentPort!.postMessage({ type: 'error', fields: { ...errorFields(error), failureId: randomUUID() } });
  }
})();
