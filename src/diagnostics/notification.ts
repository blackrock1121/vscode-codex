import type { DiagnosticRecord } from './jobs';
import { kindLabel } from './options';

export function diagnosticNotification(record: DiagnosticRecord): { text: string; extra: Record<string, unknown> } {
  const success = record.status === 'completed' && record.modelAnalysis?.status !== 'failed';
  const text = `${success ? `✅ Codex ${kindLabel(record.options?.kind)}完成` : `⚠️ Codex ${kindLabel(record.options?.kind)}未全部完成`}\n诊断编号：${record.id.slice(0, 8)}\n` +
    `范围：${record.diagnosticScope === 'local-plugin-full' ? '本机整个插件（跨窗口、会话和版本）' : '旧版全局采样'}\n发起位置：${record.workspaceName}\n诊断器插件版本：${record.pluginVersion}\n` +
    (record.coverage ? `覆盖 ${record.coverage.windows} 个窗口、${record.coverage.sessions} 个会话/子线程、${record.coverage.readFiles}/${record.coverage.files} 个日志文件。\n` : '') +
    (record.general ? `错误 ${record.general.errors} 条，警告 ${record.general.warnings} 条，压缩错误 ${record.general.compactionErrors} 条。\n` : '') +
    (record.options ? `方式：${record.options.engine === 'model' ? `${record.options.model} / ${record.options.effort}` : '本地规则'}；时间：${record.options.hours ? `最近 ${record.options.hours} 小时` : '全部保留日志'}。\n` : '') +
    (record.modelAnalysis?.status === 'failed' ? '模型诊断失败，本地检查结果已保留。\n' : '') +
    (success ? `发现 ${record.findings.length} 项待核验问题；分析 ${record.summary?.turns ?? 0} 轮任务。` : '请在诊断中心查看失败记录并重试。') +
    '\n在 VS Code 点击输入框旁的虫子图标，按编号找到记录，点击“创建修复会话”开始修复。';
  return { text, extra: { diagnosticId: record.id, isError: !success,
    durationMs: Math.max(0, (record.finishedAt ?? record.createdAt) - record.createdAt), project: record.workspaceName,
    question: `诊断 ${record.id.slice(0, 8)} · ${success ? `发现 ${record.findings.length} 项待核验问题` : '未全部完成，请查看诊断记录'}` } };
}
