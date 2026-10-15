import type { DiagnosticRecord, NotificationResult } from './jobs';
import { kindLabel } from './options';
import { isFeishuWebhook } from '../workdayCalendar';

export async function notifyDiagnostic(record: DiagnosticRecord, webhook: string, request: typeof fetch = fetch): Promise<NotificationResult> {
  if (!webhook.trim()) return { status: 'not_configured', message: '尚未配置飞书 Webhook' };
  if (!isFeishuWebhook(webhook) || new URL(webhook).protocol !== 'https:') return { status: 'not_configured', message: '请在通知设置中配置飞书机器人 Webhook' };
  const success = record.status === 'completed' && record.modelAnalysis?.status !== 'failed';
  const text = `${success ? `✅ Codex ${kindLabel(record.options?.kind)}完成` : `⚠️ Codex ${kindLabel(record.options?.kind)}未全部完成`}\n诊断编号：${record.id.slice(0, 8)}\n` +
    `范围：${record.diagnosticScope === 'local-plugin-full' ? '本机整个插件（跨窗口、会话和版本）' : '旧版全局采样'}\n发起位置：${record.workspaceName}\n诊断器插件版本：${record.pluginVersion}\n` +
    (record.coverage ? `覆盖 ${record.coverage.windows} 个窗口、${record.coverage.sessions} 个会话/子线程、${record.coverage.readFiles}/${record.coverage.files} 个日志文件。\n` : '') +
    (record.general ? `错误 ${record.general.errors} 条，警告 ${record.general.warnings} 条，压缩错误 ${record.general.compactionErrors} 条。\n` : '') +
    (record.options ? `方式：${record.options.engine === 'model' ? `${record.options.model} / ${record.options.effort}` : '本地规则'}；时间：${record.options.hours ? `最近 ${record.options.hours} 小时` : '全部保留日志'}。\n` : '') +
    (record.modelAnalysis?.status === 'failed' ? '模型诊断失败，本地检查结果已保留。\n' : '') +
    (success ? `发现 ${record.findings.length} 项待核验问题；分析 ${record.summary?.turns ?? 0} 轮任务。` : '请在诊断中心查看失败记录并重试。') +
    '\n在 VS Code 点击输入框旁的虫子图标，按编号找到记录，点击“创建修复会话”开始修复。';
  try {
    const response = await request(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { status: 'failed', message: `飞书请求失败（HTTP ${response.status}），可重试通知` };
    const body = await response.json() as { code?: number; StatusCode?: number };
    if ((body.code ?? body.StatusCode) !== 0) return { status: 'failed', message: `飞书未确认发送成功（错误码 ${Number.isInteger(body.code ?? body.StatusCode) ? body.code ?? body.StatusCode : '未知'}），请检查配置` };
    return { status: 'sent', message: '飞书已确认接收诊断通知' };
  } catch { return { status: 'failed', message: '飞书通知发送超时或网络失败，可重试通知' }; }
}
