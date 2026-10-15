import { parentPort, workerData } from 'node:worker_threads';
import { readPerformanceData, performanceReport } from '../diagnosticsReport';
import { analyzePerformance } from './analysis';

void (async () => {
  try {
    parentPort!.postMessage({ type: 'progress', message: '正在读取日志样本…' });
    const { rows, sourceNote } = await readPerformanceData(workerData.logDir);
    parentPort!.postMessage({ type: 'progress', message: '正在分析耗时、失败共性与并发情况…' });
    const analyzed = analyzePerformance(rows);
    parentPort!.postMessage({ type: 'progress', message: '正在整理诊断证据…' });
    parentPort!.postMessage({ type: 'result', result: { ...analyzed, sourceNote, report: performanceReport(rows, sourceNote) } });
  } catch { parentPort!.postMessage({ type: 'error', message: '诊断未完成：日志读取或分析失败，请重试并检查日志目录权限。' }); }
})();
