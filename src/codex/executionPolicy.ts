/** 会话级调度偏好；不切换模型、推理强度、服务档位或执行权限。 */
export type ExecutionMode = 'parallel' | 'tools' | 'standard';

export function executionMode(value: unknown): ExecutionMode {
  return value === 'tools' || value === 'standard' ? value : 'parallel';
}

export function executionConfig(mode: ExecutionMode): Record<string, number> {
  // 不覆盖 agents.enabled；用户或管理员禁用的能力仍由 CLI 决定。
  return mode === 'parallel' ? { 'agents.max_concurrent_threads_per_session': 2 } : {};
}

export function executionInstructions(mode: ExecutionMode): string {
  if (mode === 'standard') return '';
  const agents = mode === 'parallel'
    ? '并行调度：值得委派的独立探索、排错、审查或测试，主动使用可用子 Agent，最多同时 2 个；简单任务不拆分。明确目标、文件范围和验收条件，优先只读，写入仅在文件互不冲突时并行。子 Agent 继承当前模型、推理强度和权限；不得强行启用已禁用的能力。主 Agent 推进独立工作，只在依赖结果时等待，汇总验证并统一处理需要用户决定的问题，避免重复探索。'
    : '仅优化工具执行；子 Agent 仅在用户或项目指令明确要求时使用。';
  return `${agents}
保持用户选择的模型、推理强度、服务档位和权限，不为提速自行调整。
- 批量并行已知互不依赖的读取、搜索和状态检查，检查每项结果；数据依赖、同一文件修改和共享端口/输出目录的操作按顺序，避免 CPU/内存争抢。
- 涉及新环境或外部依赖时，按需批量确认目录、现有脚本、必要工具/设备及目标架构；复用已知结果，不例行重复版本或 --help 检查。参数不确定再查本机帮助或项目文档，搜索限定范围和输出。
- 先做最小有效检查；依赖该检查的构建、启动或测试，必须先收齐前置检查的最终退出码并确认通过。后台会话返回或仍在运行不代表通过。长命令复用原会话收集增量结果，等待期间推进独立工作，不重复启动同一任务。
- 失败保留退出码、第一处有效错误和必要的 stderr 摘要，区分代码错误、缺依赖、环境未就绪、网络及认证问题。临时网络故障只做有上限的重试，不据此修改业务代码；rg 无匹配、已知预期的 registry 401 认证挑战按语义判断，其他认证失败须调查，不绕过权限。相同失败再次出现时先收集针对性证据，勿无变化重复完整流程；禁止用 || true、删除断言或降低标准掩盖失败。
- 服务测试等待真实就绪信号，有总期限并检查进程是否提前退出；超时保留必要日志，先调查原因，不能只加 sleep 或反复放宽期限。跨架构模拟的冷启动开销与业务断言分开判断。完成必要验证后，仅为新改动、新失败或未解决疑点补测，最终明确验证结果与限制。`;
}
