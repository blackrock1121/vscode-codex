import type { PerformanceRow } from '../codex/performanceTrace';

export interface DiagnosticFinding {
  id: string; title: string; severity: 'warning' | 'error'; evidence: string; recommendation: string; traceIds: string[];
}
export interface DiagnosticSummary { turns: number; tools: number; failures: number; longestTurnMs: number; versions: string[] }
export interface DiagnosticOutput { report: string; findings: DiagnosticFinding[]; summary: DiagnosticSummary; sourceNote: string }
const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const ids = (rows: PerformanceRow[]) => [...new Set(rows.map(r => r.traceId).filter((id): id is string => typeof id === 'string'))].slice(0, 8);

/** 从观测证据提取待核验的优化项；不把并发累计、未知等待和宿主共享资源当作确定根因。 */
export function analyzePerformance(rows: PerformanceRow[]): Pick<DiagnosticOutput, 'summary' | 'findings'> {
  const turns = rows.filter(r => r.event === 'turn_summary');
  const tools = rows.filter(r => r.event === 'span_end' && ['tool', 'bash'].includes(String(r.kind)));
  const findings: DiagnosticFinding[] = [];
  const failures = tools.filter(r => r.outcome === 'failed');
  const categories = new Set(failures.map(r => String(r.failureCategory ?? 'unknown')));
  for (const category of categories) {
    const group = failures.filter(r => r.failureCategory === category || category === 'unknown' && !r.failureCategory);
    findings.push({ id: `failure-${category}`, title: `工具失败：${category}`, severity: group.length > 1 ? 'error' : 'warning',
      evidence: `${group.length} 次失败，工具累计耗时 ${seconds(group.reduce((sum, r) => sum + n(r.durationMs), 0))}（可能重叠）。`,
      recommendation: '先按任务和工具 ID 核对失败条件，区分环境依赖、参数、网络和代码问题；验证后修复共性原因，避免原样重跑。', traceIds: ids(group) });
  }
  const phases: Record<string, { title: string; min: number; advice: string }> = {
    preparation: { title: '发送前准备较慢', min: 5000, advice: '检查快照、历史、连接和自动保存的分项耗时，优化最慢步骤。' },
    compaction: { title: '上下文压缩耗时较长', min: 30000, advice: '核对实际压缩模型、重试、上下文增长和配置恢复耗时，验证重复压缩与等待原因。' },
    tools: { title: '工具执行占用较长', min: 60000, advice: '检查最慢工具的首次输出、静默时长、退出码和准备步骤，确认可缓存或并行的独立工作。' },
    unobserved: { title: '存在较长的未归因等待', min: 60000, advice: '结合对应 RPC、模型后端 timing 和心跳补齐证据，避免直接归因给模型或调度。' },
  };
  for (const [key, rule] of Object.entries(phases)) {
    const group = turns.filter(r => n((r.phasesMs as Record<string, unknown>)?.[key]) >= rule.min);
    if (!group.length) continue;
    const max = Math.max(...group.map(r => n((r.phasesMs as Record<string, unknown>)?.[key])));
    findings.push({ id: `phase-${key}`, title: rule.title, severity: 'warning', evidence: `${group.length} 轮出现，最长 ${seconds(max)}。`, recommendation: rule.advice, traceIds: ids(group) });
  }
  const special: [string, string, (r: PerformanceRow) => boolean, string][] = [
    ['serial', '可检查工具并发机会', r => n(r.toolCount) >= 6 && n(r.maxParallelTools) <= 1 && n((r.phasesMs as any)?.tools) > 30000,
      '先核对依赖关系，验证独立工具是否能并发；有顺序依赖的操作保持顺序。'],
    ['tail', '子 Agent 尾部等待较长', r => n(r.childTailMs) > 30000, '检查任务划分是否失衡、子任务是否卡在工具或审批，按证据调整调度。'],
    ['repeat', '重复命令较多', r => n(r.repeatedCommands) >= 3, '对照命令指纹和退出码，确认是合理轮询还是失败重试，减少无变化的重复检查。'],
    ['coverage', '诊断阶段存在缺失', r => n(r.incompleteSpans) + n(r.droppedSpans) > 0, '核对停止、重连、事件缺失或采集上限，先提高耗时归因的完整性。'],
    ['host', '扩展宿主出现延迟', r => n(r.maxEventLoopDelayMs) > 500 || n(r.maxHandlerMs) > 100 || n(r.maxDecodeMs) > 100,
      '检查扩展宿主的消息处理、JSON 解码、渲染和其他扩展活动，测量后定位阻塞点。共享宿主指标不等于本插件独占耗时。'],
  ];
  for (const [id, title, predicate, recommendation] of special) {
    const group = turns.filter(predicate); if (group.length) findings.push({ id, title, severity: 'warning', evidence: `${group.length} 轮符合检查条件。`, recommendation, traceIds: ids(group) });
  }
  return { findings: findings.slice(0, 24), summary: { turns: turns.length, tools: tools.length, failures: failures.length,
    longestTurnMs: Math.max(0, ...turns.map(r => n(r.elapsedMs))),
    versions: [...new Set(rows.map(r => r.pluginVersion).filter((v): v is string => typeof v === 'string'))] } };
}
