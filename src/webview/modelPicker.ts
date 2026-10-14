import type { ModelChoice } from "../shared";

function modelVersion(id: string) {
  const dated = id.match(/-(\d{4}-\d{2}-\d{2})$/);
  const base = dated ? id.slice(0, -dated[0].length) : id;
  const match = base.match(/^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i);
  return match ? {
    family: `gpt-${(match[2] || "").toLowerCase()}`,
    numbers: match[1].split(".").map(Number),
    // 同版本优先使用会自动更新的无日期别名。
    date: dated?.[1] || "9999-99-99",
  } : undefined;
}

/** 只精简选择器；完整能力列表仍用于已选模型和历史会话。 */
export function latestModelChoices(models: ModelChoice[]): ModelChoice[] {
  const latest = new Map<string, ModelChoice>();
  for (const model of models) {
    const version = modelVersion(model.id);
    const key = version?.family || model.id;
    const previous = latest.get(key);
    const old = previous && modelVersion(previous.id);
    if (!previous) latest.set(key, model);
    else if (version && old) {
      let diff = 0;
      for (let i = 0; i < Math.max(version.numbers.length, old.numbers.length); i++) {
        diff = (version.numbers[i] || 0) - (old.numbers[i] || 0);
        if (diff) break;
      }
      if (diff > 0 || (!diff && version.date > old.date)) latest.set(key, model);
    }
  }
  return models.filter(model => latest.get(modelVersion(model.id)?.family || model.id) === model);
}

export function modelDescription(model: ModelChoice): string {
  if (/[\u3400-\u9fff]/.test(model.description)) return model.description;
  const family = modelVersion(model.id)?.family;
  switch (family) {
    case "gpt-sol": return "擅长编程与日常任务，兼顾能力和效率";
    case "gpt-astra": return "适合复杂问题、深入推理与高难度任务";
    case "gpt-luna": return "轻量快速，适合简单任务";
    case "gpt-terra": return "能力均衡，适合通用任务";
    case "gpt-codex": return "专注编程、代码修改与工程任务";
    default: return "可用于当前会话";
  }
}
