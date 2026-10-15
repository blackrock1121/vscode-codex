import type { PerformanceRow } from '../codex/performanceTrace';
import type { GeneralSummary } from './general';

export interface DiagnosticFinding {
  id: string; title: string; severity: 'warning' | 'error'; evidence: string; recommendation: string; traceIds: string[];
  category?: string; origin?: 'rule' | 'model'; occurrences?: number;
}
export interface DiagnosticSummary { turns: number; tools: number; failures: number; longestTurnMs: number; versions: string[] }
export interface DiagnosticSource { pluginVersion: string; windowId: string; hostId: string; records: number; turns: number; tools: number; failures: number; logLines?: number }
export interface DiagnosticCoverage {
  mode: 'local-plugin-full'; files: number; readFiles: number; unreadableFiles: number; bytes: number; lines: number;
  records: number; invalidLines: number; oversizedLines: number; droppedLines: number;
  windows: number; sessions: number; fromMs?: number; toMs?: number; firstDay?: string; lastDay?: string; sources: DiagnosticSource[];
  requestedFromMs?: number; requestedToMs?: number; includedLines?: number; outsideRangeLines?: number; unknownTimeLines?: number;
}
export interface DiagnosticModelAnalysis { status: 'completed' | 'failed'; model: string; effort: string; message?: string; durationMs: number }
export interface DiagnosticOutput { report: string; findings: DiagnosticFinding[]; summary: DiagnosticSummary; sourceNote: string; coverage?: DiagnosticCoverage; general?: GeneralSummary; modelAnalysis?: DiagnosticModelAnalysis }
const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const failureCategories = new Set(['command_not_found', 'missing_dependency', 'architecture_mismatch', 'permission', 'timeout',
  'rate_limit', 'dns', 'network_or_service', 'authentication', 'syntax', 'build_or_test', 'missing_file', 'nonzero_exit', 'unknown']);
const phases: Record<string, { title: string; min: number; advice: string }> = {
  preparation: { title: '发送前准备较慢', min: 5000, advice: '检查快照、历史、连接和自动保存的分项耗时，优化最慢步骤。' },
  compaction: { title: '上下文压缩耗时较长', min: 30000, advice: '核对实际压缩模型、重试、上下文增长和配置恢复耗时，验证重复压缩与等待原因。' },
  tools: { title: '工具执行占用较长', min: 60000, advice: '检查最慢工具的首次输出、静默时长、退出码和准备步骤，确认可缓存或并行的独立工作。' },
  unobserved: { title: '存在较长的未归因等待', min: 60000, advice: '结合对应 RPC、模型后端 timing 和心跳补齐证据，避免直接归因给模型或调度。' },
};
const special: [string, string, (r: PerformanceRow) => boolean, string][] = [
  ['serial', '可检查工具并发机会', r => n(r.toolCount) >= 6 && n(r.maxParallelTools) <= 1 && n((r.phasesMs as any)?.tools) > 30000,
    '先核对依赖关系，验证独立工具是否能并发；有顺序依赖的操作保持顺序。'],
  ['tail', '子 Agent 尾部等待较长', r => n(r.childTailMs) > 30000, '检查任务划分是否失衡、子任务是否卡在工具或审批，按证据调整调度。'],
  ['repeat', '重复命令较多', r => n(r.repeatedCommands) >= 3, '对照命令指纹和退出码，确认是合理轮询还是失败重试，减少无变化的重复检查。'],
  ['coverage', '诊断阶段存在缺失', r => n(r.incompleteSpans) + n(r.droppedSpans) > 0, '核对停止、重连、事件缺失或采集上限，先提高耗时归因的完整性。'],
  ['host', '扩展宿主出现延迟', r => n(r.maxEventLoopDelayMs) > 500 || n(r.maxHandlerMs) > 100 || n(r.maxDecodeMs) > 100,
    '检查扩展宿主的消息处理、JSON 解码、渲染和其他扩展活动，测量后定位阻塞点。共享宿主指标不等于本插件独占耗时。'],
];
interface Group { count: number; totalMs: number; maxMs: number; traceIds: Set<string> }

/** 逐条累计全部记录，仅保留每类问题的计数和有限示例，不在内存堆积整份历史日志。 */
export class PerformanceAccumulator {
  private turns = 0; private tools = 0; private failures = 0; private longestTurnMs = 0;
  private readonly versions = new Set<string>();
  private readonly groups = new Map<string, Group>();
  private group(id: string, row: PerformanceRow, ms = 0): void {
    const group = this.groups.get(id) ?? { count: 0, totalMs: 0, maxMs: 0, traceIds: new Set<string>() };
    group.count++; group.totalMs += ms; group.maxMs = Math.max(group.maxMs, ms);
    if (typeof row.traceId === 'string' && group.traceIds.size < 8) group.traceIds.add(row.traceId);
    this.groups.set(id, group);
  }
  add(row: PerformanceRow): void {
    if (typeof row.pluginVersion === 'string') this.versions.add(row.pluginVersion);
    if (row.event === 'span_end' && ['tool', 'bash'].includes(String(row.kind))) {
      this.tools++;
      if (row.outcome === 'failed') {
        this.failures++;
        // 类别来自采集白名单；异常旧日志不允许生成无限种类别。
        const category = typeof row.failureCategory === 'string' && failureCategories.has(row.failureCategory) ? row.failureCategory : 'unknown';
        this.group(`failure-${category}`, row, n(row.durationMs));
      }
    }
    if (row.event !== 'turn_summary') return;
    this.turns++; this.longestTurnMs = Math.max(this.longestTurnMs, n(row.elapsedMs));
    for (const [key, rule] of Object.entries(phases)) {
      const ms = n((row.phasesMs as Record<string, unknown>)?.[key]);
      if (ms >= rule.min) this.group(`phase-${key}`, row, ms);
    }
    for (const [id, , predicate] of special) if (predicate(row)) this.group(id, row);
  }
  result(): Pick<DiagnosticOutput, 'summary' | 'findings'> {
    const findings: DiagnosticFinding[] = [];
    for (const [id, group] of this.groups) {
      const base = { id, traceIds: [...group.traceIds] };
      if (id.startsWith('failure-')) findings.push({ ...base, title: `工具失败：${id.slice(8)}`, severity: group.count > 1 ? 'error' : 'warning',
        evidence: `${group.count} 次失败，工具累计耗时 ${seconds(group.totalMs)}（可能重叠）。`,
        recommendation: '先按任务和工具 ID 核对失败条件，区分环境依赖、参数、网络和代码问题；验证后修复共性原因，避免原样重跑。' });
      else if (id.startsWith('phase-')) {
        const rule = phases[id.slice(6)]; findings.push({ ...base, title: rule.title, severity: 'warning',
          evidence: `${group.count} 轮出现，最长 ${seconds(group.maxMs)}。`, recommendation: rule.advice });
      } else {
        const rule = special.find(r => r[0] === id)!; findings.push({ ...base, title: rule[1], severity: 'warning',
          evidence: `${group.count} 轮符合检查条件。`, recommendation: rule[3] });
      }
    }
    return { findings: findings.slice(0, 24), summary: { turns: this.turns, tools: this.tools, failures: this.failures,
      longestTurnMs: this.longestTurnMs, versions: [...this.versions] } };
  }
}
export function analyzePerformance(rows: PerformanceRow[]): Pick<DiagnosticOutput, 'summary' | 'findings'> {
  const accumulator = new PerformanceAccumulator();
  for (const row of rows) accumulator.add(row);
  return accumulator.result();
}
