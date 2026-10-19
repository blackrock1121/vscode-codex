import { operationFailure, operationLog } from '../operations';
import type { ModelChoice } from '../shared';
import { DiagnosticOptions, diagnosticOptions } from './options';
import { diagnosticWait } from './wait';
import { redactDiagnosticText } from './redact';
export interface DiagnosticConfiguration { models: ModelChoice[]; options: DiagnosticOptions; error?: string }

/** 先保留用户设置；目录失败不能把本地规则或已选模型静默换成其它模式。 */
export async function loadDiagnosticConfiguration(value: unknown, defaults: { model?: string; effort: string },
  readModels: () => PromiseLike<ModelChoice[]>, timeoutMs = 10000, forceModels = false): Promise<DiagnosticConfiguration> {
  let saved: DiagnosticOptions | undefined, configurationError: string | undefined;
  try { saved = diagnosticOptions(value); } catch (error) {
    if (value !== undefined) { operationFailure('diagnostics.configuration', error); configurationError = '保存的诊断设置无效，请核对设置后再开始。'; }
  }
  if (saved?.engine === 'rules' && !forceModels) return { models: [], options: saved };
  let models: ModelChoice[] = [], error: string | undefined;
  try { models = await diagnosticWait(readModels, undefined, timeoutMs, '模型目录读取超时，可重试或选择本地规则检查'); operationLog('diagnostics.models', 'completed', { count: models.length }); }
  catch (failure) { operationFailure('diagnostics.models', failure); error = redactDiagnosticText(String((failure as Error).message), 250); }
  const preferred = saved?.model || defaults.model;
  const model = preferred ? models.find(m => m.id === preferred) : models.find(m => m.isDefault) ?? models[0];
  const options: DiagnosticOptions = saved ?? { kind: 'general', hours: 24, engine: 'model', model: preferred || model?.id,
    effort: model?.efforts.includes(defaults.effort) ? defaults.effort : model?.defaultEffort ?? model?.efforts[0] };
  return { models, options, error: [configurationError, error].filter(Boolean).join('；') || undefined };
}
