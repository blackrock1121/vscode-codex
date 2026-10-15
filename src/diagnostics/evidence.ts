import type { DiagnosticFinding } from './analysis';

/** 各异常类别及性能/采集问题轮流取证，避免高频工具错误挤掉压缩等低频故障。 */
export function selectDiagnosticEvidence(findings: DiagnosticFinding[], limit = 60): DiagnosticFinding[] {
  const groups = new Map<string, DiagnosticFinding[]>();
  for (const finding of findings) {
    const category = finding.category ?? (finding.id === 'log-coverage' || finding.id === 'coverage' ? '采集完整性' :
      finding.id.startsWith('phase-') || ['host', 'serial', 'repeat'].includes(finding.id) ? '性能阶段' :
      finding.id === 'tail' ? '子 Agent' : finding.id.startsWith('failure-') ? '工具失败分类' : '其他');
    const group = groups.get(category) ?? []; group.push(finding); groups.set(category, group);
  }
  const buckets = [...groups.values()];
  for (const group of buckets) group.sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || (b.occurrences ?? 0) - (a.occurrences ?? 0));
  const selected: DiagnosticFinding[] = [];
  for (let index = 0; selected.length < limit; index++) {
    let found = false;
    for (const group of buckets) if (group[index]) {
      found = true; selected.push(group[index]); if (selected.length === limit) break;
    }
    if (!found) break;
  }
  return selected;
}
