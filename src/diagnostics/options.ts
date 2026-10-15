export interface DiagnosticOptions {
  kind: 'general' | 'performance'; hours: 0 | 24 | 168; engine: 'rules' | 'model'; model?: string; effort?: string;
}
export interface DiagnosticRequest extends DiagnosticOptions { fromMs?: number; toMs: number }
export const DEFAULT_DIAGNOSTIC_OPTIONS: DiagnosticOptions = { kind: 'general', hours: 24, engine: 'rules' };
export function diagnosticOptions(value: unknown): DiagnosticOptions {
  const v = value as Partial<DiagnosticOptions> | undefined;
  if (!v || !['general', 'performance'].includes(v.kind!) || ![0, 24, 168].includes(v.hours!) || !['rules', 'model'].includes(v.engine!)) throw new Error('诊断设置无效，请重新选择。');
  if (v.engine === 'model' && (typeof v.model !== 'string' || !/^[\w./:-]{1,160}$/.test(v.model) || typeof v.effort !== 'string' || !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(v.effort))) throw new Error('请选择可用的诊断模型和 reasoning effort。');
  return { kind: v.kind!, hours: v.hours!, engine: v.engine!, ...(v.engine === 'model' ? { model: v.model, effort: v.effort } : {}) };
}
export const kindLabel = (kind?: string) => kind === 'general' ? '全面诊断' : '速度诊断';
