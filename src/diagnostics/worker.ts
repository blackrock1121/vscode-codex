import { parentPort, workerData } from 'node:worker_threads';
import { scanPluginLogs } from './scan';

void (async () => {
  try {
    const result = await scanPluginLogs(workerData.logDir, message => parentPort!.postMessage({ type: 'progress', message }));
    parentPort!.postMessage({ type: 'progress', message: '正在整理全局诊断证据…' });
    parentPort!.postMessage({ type: 'result', result });
  } catch { parentPort!.postMessage({ type: 'error', message: '诊断未完成：全局日志读取或分析失败，请重试并检查日志目录权限。' }); }
})();
