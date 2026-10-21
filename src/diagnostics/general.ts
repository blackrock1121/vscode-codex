import { createHash } from 'node:crypto';
import { diagnosticId, type PerformanceRow } from '../codex/performanceTrace';
import type { DiagnosticFinding } from './analysis';
import { redactDiagnosticText } from './redact';

export interface GeneralSummary { errors: number; warnings: number; retries: number; recoveries: number; compactionErrors: number; groups: number; overflow: number;
  correlatedErrors?: number; failureChains?: number; correlationOverflow?: number }
export interface LogLocation { file: string; line: number; atMs?: number; pluginVersion?: string; windowId?: string; traceId?: string }
interface Incident { category: string; severity: 'warning' | 'error'; title: string; message: string }
const bad = /\b(?:errors?|failed|failures?|exception|panic|fatal|unhandled|ENOENT|EACCES|ECONNRESET|ECONNREFUSED|ETIMEDOUT|MODULE_NOT_FOUND)\b|\b\w+Error\b|(?:\b(?:ok|success)|"(?:ok|success)")\s*[:=]\s*false\b|(?:\bisError|"isError")\s*[:=]\s*true\b|崩溃|异常|失败|报错|超时|断开|无响应|(?:脚本|运行时)错误/i;
const warning = /\b(?:warn(?:ing)?|retry|fallback|reconnect(?:ing)?)\b|重试|降级|警告|重连/i;
const component = (line: string) => /compaction|compact|压缩/i.test(line) ? '压缩' : /webview|脚本|渲染|布局/i.test(line) ? '页面脚本' :
  /snapshot|checkpoint|快照|还原点/i.test(line) ? '快照与还原点' : /restore|resume|恢复/i.test(line) ? '会话恢复' :
  /rpc|transport|connection|连接|CLI|进程|stderr/i.test(line) ? '连接与进程' : /notify|webhook|通知/i.test(line) ? '通知' :
  /sessionSettings|config|设置|配置/i.test(line) ? '配置' : /tool|bash|command|工具|命令/i.test(line) ? '工具执行' : '插件运行';

export function classifyIncident(line: string, row?: PerformanceRow): Incident | undefined {
  if (row) {
    if (row.event === 'codex.tool_result' && row.expectedCancellation === true && row.cancellationReason === 'question_pause' && row.outcome === 'waiting_for_user' && ['unknown', 'interrupted'].includes(String(row.failureCategory))) return;
    const compaction = row.diagnosticType === 'compaction' || row.diagnosticType === 'compaction_route' || String(row.operation ?? '').startsWith('compaction.') || /compact/i.test(String(row.method ?? ''));
    const stage = String(row.stage ?? row.event ?? ''), outcome = String(row.outcome ?? row.status ?? '');
    const failed = /error|failed|failure|timeout|closed|disconnected/.test(stage) || /failed|error|connection_closed/.test(outcome) ||
      row.success === false || row.hasError === true || row.isError === true || row.type === 'runtime_error' && row.severity !== 'warning';
    const retry = stage === 'retry' || row.event === 'retry';
    const fallback = /fallback|restore_pending|unavailable|partial/.test(stage) || /unavailable/.test(outcome) || row.type === 'runtime_error' && row.severity === 'warning';
    if (!failed && !retry && !fallback) return;
    // 旧 stderr 脱敏可能留下 ANSI 的 [2m 前缀，不能依赖模块名前的单词边界。
    const telemetry = row.type === 'runtime_error' && /opentelemetry_sdk\b.*\b(?:ExportError|export error)\b/i.test(String(row.message ?? ''));
    const category = telemetry || String(row.operation ?? '').startsWith('telemetry.') ? '遥测采集' : row.diagnosticType === 'logging' || row.event === 'logging_health' ? '采集完整性' : compaction ? '压缩' : row.operation ? component(String(row.operation)) : row.type === 'runtime_error' ? component(String(row.message ?? 'stderr')) : row.kind === 'bash' || row.kind === 'tool' || row.event === 'codex.tool_result' ? '工具执行' : row.type === 'rpc' ? '连接与进程' : '插件运行';
    const httpCode = row.httpStatusCode ?? row['http.response.status_code'] ?? row.status_code;
    const detail = [row.diagnosticType, row.operation, row.method, stage, outcome, row.errorCategory ?? row.failureCategory, row.errorCode, row.rpcCode, row.targetKind, row.errorType, row.failureEvidence,
      diagnosticId(row.tool_name ?? row.tool ?? row['tool.name']) ? `tool=${diagnosticId(row.tool_name ?? row.tool ?? row['tool.name'])}` : undefined,
      diagnosticId(row.call_id ?? row.tool_call_id ?? row.itemId) ? `callId=${diagnosticId(row.call_id ?? row.tool_call_id ?? row.itemId)}` : undefined,
      httpCode !== undefined ? `HTTP ${httpCode}` : undefined,
      row.exitCode !== undefined && row.exitCode !== null ? `exitCode=${row.exitCode}` : undefined,
      ...['model', 'effort', 'trigger', 'speedMode', 'id', 'compactionId', 'reason', 'scope', 'operationId', 'diagnosticId', 'processRunId', 'failureId', 'errorOrigin'].filter(key => typeof row[key] === 'string').map(key => `${key}=${row[key]}`),
      Number.isSafeInteger(row.requestId) ? `requestId=${row.requestId}` : undefined, row.message]
      .filter(v => typeof v === 'string' || typeof v === 'number').join(' · ');
    return { category, severity: failed ? 'error' : 'warning', title: `${category}${retry ? '重试' : fallback ? '警告或降级' : '异常'}`, message: redactDiagnosticText(detail) };
  }
  const signal = line.replace(/\b(?:failed|failures?|errors?|warnings?|errorCount|failedCount)\s*[:=]\s*(?:0|false|null)\b/gi, '')
    .replace(/"(?:isError|error|errors|warnings?|failures|failed)"\s*:\s*(?:(?:0|false|null)\b|\[\s*\])/gi, '').replace(/\b0\s+(?:errors?|warnings?|failures?)\b/gi, '');
  if (!bad.test(signal) && !warning.test(signal)) return;
  // 用户主动取消不是内部错误；原有错误仍通过其它记录呈现。
  if (/用户.*(?:取消|停止)|user.*(?:cancel|interrupt)|outcome[=:]cancelled/i.test(line)) return;
  const category = component(line);
  const severity = bad.test(signal) && !/\[(?:warn|warning|notice|status)\]/i.test(line) ? 'error' : 'warning';
  return { category, severity, title: `${category}${severity === 'error' ? '异常' : '警告'}`, message: redactDiagnosticText(line.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').replace(/\[pluginVersion=[^\]]+\]\s*/, '').replace(/\[\d{4}-\d\d-\d\dT[^\]]+\]\s*/, '')) };
}

export class GeneralAccumulator {
  private readonly counts: GeneralSummary = { errors: 0, warnings: 0, retries: 0, recoveries: 0, compactionErrors: 0, groups: 0, overflow: 0 };
  private readonly groups = new Map<string, { incident: Incident; count: number; examples: string[]; traces: Set<string> }>();
  private readonly failureChains = new Set<string>();
  add(line: string, row: PerformanceRow | undefined, where: LogLocation): void {
    if (row?.stage === 'recovered') {
      this.counts.recoveries++;
      if (!(Number(row.lostRecords) > 0)) return;
      row = { ...row, stage: 'unavailable', failureCategory: 'logging_loss', message: `恢复前有 ${Number(row.lostRecords)} 条记录未交给日志出口` };
    }
    if (!row && /恢复成功|恢复完成|recovered|retry succeeded|connection restored/i.test(line) && !/失败|异常|error|failed|未能|尚未|没有/i.test(line)) { this.counts.recoveries++; return; }
    const incident = classifyIncident(line, row); if (!incident) return;
    if (incident.severity === 'error') this.counts.errors++; else this.counts.warnings++;
    if (incident.severity === 'error' && typeof row?.failureId === 'string' && /^[a-f\d-]{36}$/i.test(row.failureId)) {
      const key = `${where.windowId ?? ''}:${row.processRunId ?? ''}:${row.failureId}`;
      if (this.failureChains.has(key) || this.failureChains.size < 20000) {
        this.failureChains.add(key); this.counts.correlatedErrors = (this.counts.correlatedErrors ?? 0) + 1;
      } else this.counts.correlationOverflow = (this.counts.correlationOverflow ?? 0) + 1;
    }
    if (/retry|重试/i.test(String(row?.stage ?? row?.event ?? line))) this.counts.retries++;
    if (incident.category === '压缩' && incident.severity === 'error') this.counts.compactionErrors++;
    const signature = incident.message.replace(/(ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)[^@]*)(?:@.*)?/i, '$1')
      .replace(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b/gi, '<id>')
      .replace(/\bcallId=[\w.:-]+/g, 'callId=<id>')
      .replace(/\b(?:attempt|elapsedMs|durationMs|requestId|request_id|retry)\s*[:=]?\s*\d+(?:\.\d+)?/gi, match => match.replace(/\d+(?:\.\d+)?$/, '<n>'))
      .replace(/\b\d+(?:\.\d+)?(?:ms|秒)\b/g, '<duration>');
    const id = createHash('sha256').update(incident.category + incident.severity + signature).digest('hex').slice(0, 12);
    let group = this.groups.get(id);
    if (!group) {
      if (this.groups.size >= 160) {
        const entries = [...this.groups];
        let replace = incident.severity === 'error' ? entries.filter(([, g]) => g.incident.severity === 'warning').sort(([, a], [, b]) => a.count - b.count)[0] : undefined;
        if (!replace && !entries.some(([, g]) => g.incident.category === incident.category)) {
          const categories = new Map<string, number>();
          for (const [, g] of entries) categories.set(g.incident.category, (categories.get(g.incident.category) ?? 0) + 1);
          replace = entries.filter(([, g]) => (categories.get(g.incident.category) ?? 0) > 1 && (incident.severity === 'error' || g.incident.severity === 'warning'))
            .sort(([, a], [, b]) => categories.get(b.incident.category)! - categories.get(a.incident.category)! || a.count - b.count)[0];
        }
        if (!replace) { this.counts.overflow++; return; }
        this.groups.delete(replace[0]); this.counts.overflow += replace[1].count;
      }
      group = { incident, count: 0, examples: [], traces: new Set() }; this.groups.set(id, group);
    }
    group.count++;
    const time = where.atMs ? new Date(where.atMs).toISOString() : '时间未标注';
    const example = `${where.file}:${where.line} · ${time} · 版本 ${where.pluginVersion ?? '未标注'} · 窗口 ${where.windowId ?? '未标注'} · ${incident.message}`;
    if (group.examples.length < 3) group.examples.push(example); else group.examples[2] = example;
    if (where.traceId && group.traces.size < 8) group.traces.add(where.traceId);
  }
  result(): { summary: GeneralSummary; findings: DiagnosticFinding[]; report: string } {
    this.counts.groups = this.groups.size;
    this.counts.failureChains = this.failureChains.size;
    const findings: DiagnosticFinding[] = [...this.groups].sort(([, a], [, b]) => (a.incident.severity === 'error' ? 0 : 1) - (b.incident.severity === 'error' ? 0 : 1) || b.count - a.count)
      .map(([id, group]) => ({ id: `log-${id}`, category: group.incident.category, origin: 'rule', occurrences: group.count,
        title: group.incident.title, severity: group.incident.severity, evidence: `${group.count} 条异常/警告日志。\n${group.examples.join('\n')}`,
        recommendation: group.incident.category === '遥测采集' ? '此记录来自遥测导出链路，可能造成诊断数据缺失；不能据此认定主对话连接中断。请另行核对同一进程的 RPC、轮次和进程退出事件。' : '按文件和行号核对前后事件，确认是否恢复、是否影响用户和实际根因；区分插件故障、环境依赖、后端服务和预期取消，再实施修复。', traceIds: [...group.traces] }));
    const report = ['# 最近日志异常检查', '', `错误 ${this.counts.errors} 条，警告 ${this.counts.warnings} 条；压缩错误 ${this.counts.compactionErrors} 条，重试 ${this.counts.retries} 条，明确恢复 ${this.counts.recoveries} 条。`,
      '以上为日志事件数，同一次故障可能产生多条记录；恢复记录不代表所有错误都已恢复。',
      `其中 ${this.counts.correlatedErrors ?? 0} 条错误通过明确 failureId 关联为 ${this.failureChains.size} 条故障链；其余 ${this.counts.errors - (this.counts.correlatedErrors ?? 0)} 条缺少完整关联或超过上限，不能按事件数推算独立事故。关联上限未纳入 ${this.counts.correlationOverflow ?? 0} 条。`,
      `异常分组 ${this.counts.groups} 个；超过分组上限的事件 ${this.counts.overflow} 条仍计入错误/警告总数。`, '',
      ...findings.flatMap(f => [`## ${f.title} · ${f.id}`, '', f.evidence, '', f.recommendation, ''])].join('\n');
    return { summary: { ...this.counts }, findings, report };
  }
}
