import type { DiagnosticRecord, NotificationResult } from './jobs';
import { isFeishuWebhook } from '../workdayCalendar';

export async function notifyDiagnostic(record: DiagnosticRecord, webhook: string, request: typeof fetch = fetch): Promise<NotificationResult> {
  if (!webhook.trim()) return { status: 'not_configured', message: '尚未配置飞书 Webhook' };
  if (!isFeishuWebhook(webhook) || new URL(webhook).protocol !== 'https:') return { status: 'not_configured', message: '请在通知设置中配置飞书机器人 Webhook' };
  const success = record.status === 'completed';
  const text = `${success ? '✅ Codex 速度诊断完成' : '⚠️ Codex 速度诊断未完成'}\n诊断编号：${record.id.slice(0, 8)}\n` +
    `项目：${record.workspaceName}\n插件版本：${record.pluginVersion}\n` +
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
