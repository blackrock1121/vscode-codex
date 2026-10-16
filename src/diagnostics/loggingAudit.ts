import type { DiagnosticFinding, DiagnosticOutput } from './analysis';
import manifest from './loggingAuditData';

type CandidateKind = 'catch-unlogged' | 'error-propagated' | 'handler-delegated' | 'operation-unlogged' | 'branch-unlogged' | 'entry-unlogged';
interface Candidate { line: number; symbol: string; kind: CandidateKind }
export interface LoggingAuditManifest {
  schema: 1; version: string; sourceHash: string;
  files: { file: string; sha256: string; functions: number; operations: number; catches: number; logSites: number; candidates: Candidate[] }[];
  unsupported: string[];
}
export interface LoggingAuditSummary {
  status: 'review-required' | 'no-candidates' | 'unavailable'; version?: string; sourceHash?: string;
  files: number; functions: number; operations: number; catches: number; logSites: number; candidates: number; unsupported: number;
}
const labels: Record<CandidateKind, string> = {
  'catch-unlogged': '错误处理未见直接日志，可能静默忽略或返回默认值',
  'error-propagated': '错误继续传播但未见直接日志，需核验上游是否落盘',
  'handler-delegated': '错误处理委派给其他函数，需核验最终日志落点',
  'operation-unlogged': '包含异步或外部操作，未见直接日志，需核验调用链覆盖',
  'branch-unlogged': '操作分支未见直接日志，其他分支的记录不能证明此路径已覆盖',
  'entry-unlogged': '命令入口或事件回调未见直接日志，需核验实际处理函数是否记录结果',
};
const advice = '结合对应版本源码逐条核验调用链；确认缺口后，为功能入口、关键分支、成功/失败/取消/超时/重试/恢复补齐必要日志，包含时间、操作标识、阶段和脱敏错误分类。已由上游统一记录或属于预期探测的路径说明依据，避免重复日志；验证故障注入后日志可关联且全面诊断能检出。禁止记录凭据、正文或完整工具输出。';

export function checkLoggingConfiguration(output: DiagnosticOutput, transportEnabled: boolean): DiagnosticOutput {
  if (transportEnabled) return output;
  const finding: DiagnosticFinding = { id: 'logging-transport-disabled', category: '采集完整性', severity: 'warning', traceIds: [],
    title: '当前窗口配置关闭了详细诊断采集', evidence: 'codexChat.transportDiagnostics=false；新连接将缺少部分阶段耗时、RPC、CLI 与传输观测。此设置快照不代表其他窗口或已有连接的实际采集状态。',
    recommendation: '如需完整诊断，在当前窗口开启详细诊断采集并重新连接，执行相关功能后检查新增日志。开启配置不能补回此前未记录的数据，也不证明所有代码路径已覆盖。' };
  return { ...output, findings: [...output.findings, finding], report: `${output.report}\n\n## 诊断采集配置\n\n${finding.evidence}\n\n${finding.recommendation}\n` };
}

/** 不依赖故障已发生或存在运行日志；源码审查证据随同一构建封装进工作线程。 */
export function auditLoggingCoverage(data: LoggingAuditManifest | undefined = manifest): { loggingAudit: LoggingAuditSummary; findings: DiagnosticFinding[]; report: string } {
  const loggingAudit: LoggingAuditSummary = { status: 'unavailable', files: 0, functions: 0, operations: 0, catches: 0, logSites: 0, candidates: 0, unsupported: 0 };
  if (!data || data.schema !== 1 || !data.files.length) {
    const finding: DiagnosticFinding = { id: 'logging-audit-unavailable', category: '日志覆盖审查', severity: 'warning', traceIds: [],
      title: '源码日志覆盖审查不可用', evidence: '当前构建没有可用的源码审查清单；不能仅凭运行日志无报错判断插件正常。',
      recommendation: '重新构建并安装包含源码日志覆盖审查清单的插件，再执行全面诊断。' };
    return { loggingAudit, findings: [finding], report: `# 源码日志覆盖审查\n\n${finding.evidence}\n` };
  }
  Object.assign(loggingAudit, { version: data.version, sourceHash: data.sourceHash, files: data.files.length, unsupported: data.unsupported.length });
  for (const file of data.files) {
    for (const key of ['functions', 'operations', 'catches', 'logSites'] as const) loggingAudit[key] += file[key];
    loggingAudit.candidates += file.candidates.length;
  }
  loggingAudit.status = loggingAudit.candidates || loggingAudit.unsupported ? 'review-required' : 'no-candidates';
  const findings: DiagnosticFinding[] = [], report = ['# 源码日志覆盖审查', '',
    `审查对象：当前诊断器构建 ${data.version}；源码指纹 ${data.sourceHash}。本检查不依赖运行日志，不受所选日志时间范围影响，也不代表历史版本的源码覆盖。`, '',
    `已扫描 ${loggingAudit.files} 个脚本源码文件、${loggingAudit.functions} 个函数/回调、${loggingAudit.operations} 个异步或外部操作路径、${loggingAudit.catches} 个错误处理器；识别 ${loggingAudit.logSites} 处日志调用线索，发现 ${loggingAudit.candidates} 处待核验覆盖线索。`, '',
    '静态规则检查命令/事件入口、catch、Promise 错误回调及异步/外部操作分支中的直接日志调用；控制台输出和界面提示不当作文件日志。不证明日志一定执行或落盘。条件分支、跨函数调用、动态注册、原生组件及日志写入故障仍需核验；没有候选项也不等于所有功能均已覆盖。纯计算函数不要求逐个打日志。', '',
    advice, '', '## 按源码文件检查', ''];
  for (const file of data.files) {
    report.push(`### ${file.file}`, '', `函数/回调 ${file.functions}；异步/外部操作 ${file.operations}；错误处理 ${file.catches}；日志调用线索 ${file.logSites}。`);
    if (!file.candidates.length) { report.push('当前规则未发现覆盖候选缺口，不能据此认定所有路径均有日志。', ''); continue; }
    const priority: Record<CandidateKind, number> = { 'catch-unlogged': 0, 'entry-unlogged': 1, 'branch-unlogged': 1, 'operation-unlogged': 2, 'error-propagated': 3, 'handler-delegated': 3 };
    const details = [...file.candidates].sort((a, b) => priority[a.kind] - priority[b.kind] || a.line - b.line)
      .map(c => `${file.file}:${c.line} · ${c.symbol}：${labels[c.kind]}`);
    findings.push({ id: `logging-source-${file.file}`, category: '日志覆盖审查', severity: 'warning', traceIds: [], occurrences: details.length,
      title: `日志覆盖待核验：${file.file}（${details.length} 处）`,
      evidence: `源码版本 ${data.version}，与运行日志是否存在无关。\n${details.slice(0, 8).join('\n')}${details.length > 8 ? `\n其余 ${details.length - 8} 处见完整报告。` : ''}`,
      recommendation: advice });
    report.push(...details.map(detail => `- ${detail}`), '');
  }
  if (data.unsupported.length) {
    const evidence = `以下源码尚无自动日志覆盖规则：${data.unsupported.join('、')}。不能视为已覆盖。`;
    findings.push({ id: 'logging-source-unsupported', category: '日志覆盖审查', severity: 'warning', traceIds: [],
      title: '部分组件的日志覆盖尚未审查', evidence, recommendation: '结合原生组件源码及其调用方检查功能、异常与结果记录，并补充对应语言的审查规则或验证证据。' });
    report.push('## 未覆盖的源码语言', '', evidence, '');
  }
  return { loggingAudit, findings, report: report.join('\n') };
}
