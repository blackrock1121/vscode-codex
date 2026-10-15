import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ModelChoice } from '../shared';

export type ModelFamily = 'astra' | 'sol' | 'luna';
export interface CompactionSelection { model: string; effort: string }
export type CompactionSelector = (source: string, tier: string | null) => CompactionSelection | undefined;
export const VALIDATION_REVISION = 'native-compact-v1';
export const VALIDATION_TOTAL = 22;
// 历史评测的锚点，不是固定路由；后继型号通过验证后从持久化记录选择。
export const VALIDATED_BASELINES: readonly CompactionSelection[] = [{ model: 'gpt-6.1-sol', effort: 'xhigh' }];
export function modelFamily(id: string): ModelFamily | undefined {
  return /^gpt-\d+(?:\.\d+)*-(astra|sol|luna)(?:-\d{4}-\d{2}-\d{2})?$/.exec(id)?.[1] as ModelFamily | undefined;
}
export function modelRank(id: string): number | undefined {
  const family = modelFamily(id); return family ? { astra: 3, sol: 2, luna: 1 }[family] : undefined;
}
function available(model: ModelChoice, tier: string | null): boolean {
  return model.efforts.includes('xhigh') && (tier === null || tier === 'default' ||
    ((tier === 'priority' || tier === 'fast') && model.speedModes?.includes('fast') === true));
}
function newer(a: ModelChoice, b: ModelChoice): number {
  const version = (id: string) => id.match(/^gpt-([\d.]+)/)?.[1].split('.').map(Number) ?? [];
  const av = version(a.id), bv = version(b.id);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (bv[i] ?? 0) - (av[i] ?? 0);
  return b.id.localeCompare(a.id);
}
export interface ValidationResult {
  passed: boolean; baselineModel: string; baselineMs: number; candidateMs: number;
  baselineScore: number; candidateScore: number; total: number;
}
interface ValidationRecord { revision: string; model: string; effort: string; status: 'running' | 'passed' | 'failed'; result?: ValidationResult }

/** 小型、无正文的验证记录。原子独占文件确保多个窗口不会为同一型号重复付费评测。 */
export class CompactionValidationStore {
  private cache = new Map<string, ValidationRecord>();
  constructor(private readonly dir?: string) {}
  private file(model: string): string | undefined {
    return this.dir && path.join(this.dir, createHash('sha256').update(`${VALIDATION_REVISION}:${model}:xhigh`).digest('hex') + '.json');
  }
  record(model: string): ValidationRecord | undefined {
    const file = this.file(model); if (!file) return this.cache.get(model);
    try {
      if (fs.statSync(file).size > 16_384) return;
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (row.revision === VALIDATION_REVISION && row.model === model && row.effort === 'xhigh' &&
        ['running', 'passed', 'failed'].includes(row.status)) return row;
    } catch { /* 未验证或记录损坏时不擅自采用新模型 */ }
  }
  validated(model: string): boolean {
    if (VALIDATED_BASELINES.some(x => x.model === model)) return true;
    const r = this.record(model), v = r?.result;
    return r?.status === 'passed' && v?.passed === true && v.total === VALIDATION_TOTAL && v.baselineScore === v.total &&
      v.candidateScore === v.total && v.baselineMs > 0 && v.candidateMs > 0 && v.candidateMs <= v.baselineMs * 1.25;
  }
  claim(model: string): boolean {
    if (this.validated(model) || this.record(model)) return false;
    const row: ValidationRecord = { revision: VALIDATION_REVISION, model, effort: 'xhigh', status: 'running' };
    const file = this.file(model);
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        // 所有窗口每天合计最多领取一个新型号评测；崩溃也不重复扣费。
        const daily = path.join(path.dirname(file), `daily-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(daily, JSON.stringify({ model }), { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(file, JSON.stringify(row), { flag: 'wx', mode: 0o600 });
      }
      catch { return false; }
    }
    this.cache.set(model, row); return true;
  }
  complete(model: string, result?: ValidationResult): void {
    // 只有本实例成功领取的任务才能覆盖记录；崩溃残留 running 也不自动重试收费请求。
    if (this.cache.get(model)?.status !== 'running') return;
    const row: ValidationRecord = { revision: VALIDATION_REVISION, model, effort: 'xhigh', status: result?.passed ? 'passed' : 'failed', result };
    this.cache.set(model, row);
    const file = this.file(model);
    if (file) { const tmp = `${file}.${randomUUID()}.tmp`; try { fs.writeFileSync(tmp, JSON.stringify(row), { mode: 0o600 }); fs.renameSync(tmp, file); } catch { /* 写盘失败不影响用户任务；保留 running 防止重复收费 */ } finally { try { fs.rmSync(tmp, { force: true }); } catch {} } }
  }
}

export class CompactionPolicy {
  constructor(private readonly store: CompactionValidationStore, private readonly configured = 'auto') {}
  private candidates(models: ModelChoice[]): ModelChoice[] {
    const sol = models.filter(m => modelFamily(m.id) === 'sol').sort(newer);
    if (this.configured && this.configured !== 'auto') return sol.filter(m => m.id === this.configured);
    // 官方升级关系优先；目录没有关系时，仅把目录中真实存在的 Sol 列为候选，仍须评测。
    const recommended = new Set(models.flatMap(m => modelFamily(m.id) === 'sol' && this.store.validated(m.id) ? [m.upgrade, m.upgradeInfo?.model].filter((x): x is string => !!x) : []));
    return [...sol.filter(m => recommended.has(m.id)), ...sol.filter(m => !recommended.has(m.id))];
  }
  select(source: string, tier: string | null, models: ModelChoice[]): CompactionSelection | undefined {
    // Sol/Luna/未知家族无论如何都沿用会话，指定目标也不能绕过这一条。
    if ((modelRank(source) ?? 0) <= 2) return;
    const selected = this.candidates(models).filter(m => available(m, tier) && this.store.validated(m.id)).sort(newer)[0];
    return selected && { model: selected.id, effort: 'xhigh' };
  }
  pending(source: string, models: ModelChoice[]): ModelChoice | undefined {
    if ((modelRank(source) ?? 0) <= 2) return;
    const candidates = this.candidates(models).filter(m => available(m, null));
    const selected = candidates.filter(m => this.store.validated(m.id)).sort(newer)[0];
    return candidates.find(m => (!selected || newer(m, selected) < 0) && !this.store.validated(m.id) && !this.store.record(m.id));
  }
}
