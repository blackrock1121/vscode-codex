import { checkLoggingConfiguration } from './diagnostics/loggingAudit';
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ChatViewProvider } from "./panel/chatViewProvider";
import { DailyLogWriter, LogIdentity } from "./logging";
import { RemoteBridgeClient } from "./remote/bridgeClient";
import { DiagnosticJobs, workerRunner } from "./diagnostics/jobs";
import { DiagnosticsPage } from "./diagnostics/page";
import { diagnosticOptions } from './diagnostics/options';
import { analyzeWithModel } from './diagnostics/model';
import { CodexRpc } from './codex/rpc';
import { redactDiagnosticText } from './diagnostics/redact';
import { diagnosticWait } from './diagnostics/wait';
import { loadDiagnosticConfiguration } from './diagnostics/configuration';

/** 固定日志目录：~/.codex-chat/logs/codex-chat-YYYY-MM-DD.log（按天分文件）。
 *  VS Code 输出通道的落盘路径深埋且每次会话都变，用户/同事根本找不到——
 *  所有日志双写到这里，收日志只需要拿这个目录。 */
const LOG_DIR = path.join(os.homedir(), ".codex-chat", "logs");
const logWriters = new Set<DailyLogWriter>();
const diagnosticServices = new Set<DiagnosticJobs>();

/** 包一层 OutputChannel：appendLine 同时落盘到固定目录。写盘失败静默（日志不能反噬功能）。 */
function teeOutput(channel: vscode.OutputChannel, identity: LogIdentity): vscode.OutputChannel {
  const writer = new DailyLogWriter(LOG_DIR, identity, text => channel.append(text));
  logWriters.add(writer);
  // 窗口长期不重启、甚至没有新日志时，也要持续清理过期文件。
  const pruneTimer = setInterval(() => void writer.prune(), 60 * 60 * 1000);
  return {
    name: channel.name,
    append: (v) => channel.append(v),
    appendLine: (v) => writer.write(v),
    replace: (v) => channel.replace(v),
    clear: () => channel.clear(),
    show: ((...args: unknown[]) => (channel.show as (...a: unknown[]) => void)(...args)) as vscode.OutputChannel["show"],
    hide: () => channel.hide(),
    dispose: () => { clearInterval(pruneTimer); void writer.dispose().finally(() => logWriters.delete(writer)); channel.dispose(); },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.isTrusted) return;
  // 捕获正在运行的扩展版本；其他窗口安装新版本不会改写此窗口的日志归属。
  const identity: LogIdentity = { pluginVersion: String(context.extension.packageJSON.version ?? 'unknown'),
    windowId: randomUUID(), hostId: String(process.pid) };
  const output = teeOutput(vscode.window.createOutputChannel("Codex Chat"), identity);
  output.appendLine(`[boot] Codex Copilot v${(context.extension.packageJSON as { version?: string }).version ?? "?"} 日志目录 ${LOG_DIR}`);
  const provider = new ChatViewProvider(context, output);
  const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
  const workspaceId = createHash('sha256').update(JSON.stringify(workspacePaths.length ? workspacePaths : [vscode.workspace.workspaceFile?.toString() ?? 'empty'])).digest('hex').slice(0, 24);
  const runner = workerRunner(path.join(context.extensionUri.fsPath, 'dist', 'diagnostics-worker.js'), LOG_DIR);
  const diagnosticsDir = path.join(os.homedir(), '.codex-chat', 'diagnostics');
  const diagnostics = new DiagnosticJobs(path.join(os.homedir(), '.codex-chat', 'diagnostics'), {
    pluginVersion: identity.pluginVersion, windowId: identity.windowId, workspaceId,
    workspaceName: vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? '未命名工作区',
  }, async (progress, signal, request) => {
    progress('正在保存最新诊断日志…');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...logWriters].map(writer => writer.flush())), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]); }
    finally { clearTimeout(timer); }
    const scanned = await runner(progress, signal, request);
    const result = request?.kind === 'general' ? checkLoggingConfiguration(scanned,
      vscode.workspace.getConfiguration('codexChat').get<boolean>('transportDiagnostics', true)) : scanned;
    if (request?.engine !== 'model') return result;
    try {
      progress('正在确认所选诊断模型…');
      const models = await diagnosticWait(() => provider.diagnosticModels(), signal), model = models.find(m => m.id === request.model);
      if (!model || !model.efforts.includes(request.effort!)) throw new Error('所选诊断模型或 reasoning effort 当前不可用，请在诊断页重新选择');
      return await analyzeWithModel(new CodexRpc(vscode.workspace.getConfiguration('codexChat').get<string>('codexPath', 'codex'), diagnosticsDir), result, request, diagnosticsDir, progress, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const message = redactDiagnosticText(String((error as Error).message), 300);
      return { ...result, modelAnalysis: { status: 'failed' as const, model: request.model!, effort: request.effort!, durationMs: 0, message }, report: `# 模型诊断未完成\n\n${message}\n\n` + result.report };
    }
  }, record => provider.notifyDiagnostic(record));
  diagnosticServices.add(diagnostics);
  const diagnosticsPage = new DiagnosticsPage(context, diagnostics,
    async id => { await diagnostics.repair(id, (prompt, title) => provider.createDiagnosticRepairSession(prompt, title), async sessionId => { await provider.openSession(sessionId); }); },
    async () => { provider.showNotifyConfig(); }, {
      load: forceModels => loadDiagnosticConfiguration(context.globalState.get('codexChat.diagnosticOptions'), {
        model: vscode.workspace.getConfiguration('codexChat').get<string>('model'),
        effort: vscode.workspace.getConfiguration('codexChat').get<string>('effort', 'medium'),
      }, () => provider.diagnosticModels(), 10000, forceModels),
      save: async options => { await context.globalState.update('codexChat.diagnosticOptions', diagnosticOptions(options)); },
    });
  context.subscriptions.push(diagnosticsPage, { dispose: () => { void diagnostics.dispose().finally(() => diagnosticServices.delete(diagnostics)); } });
  const registration = provider.remoteRegistration();
  if (registration && process.platform === 'darwin') {
    const remote = new RemoteBridgeClient(path.join(os.homedir(), '.codex-chat', 'remote-bridge'), registration,
      (command, active) => provider.executeRemote(command, active));
    remote.start(); context.subscriptions.push(remote);
  }

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("codex-chat.login", () => provider.login()),
    vscode.commands.registerCommand("codex-chat.account", () => provider.account()),
    provider,
    vscode.window.registerUriHandler({ handleUri: uri => provider.handleNotificationUri(uri) }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Rehydrate the editor-area chat panel after a window reload/restart so it
    // doesn't come back as a blank, titleless tab.
    vscode.window.registerWebviewPanelSerializer("codex-chat.editor", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { sessionId?: string } | undefined): Promise<void> {
        await provider.revivePanel(panel, state?.sessionId);
      },
    }),
    vscode.window.registerWebviewPanelSerializer("codex-chat.notify", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        provider.reviveNotifyPanel(panel);
      },
    }),
    vscode.commands.registerCommand("codex-chat.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("codex-chat.showSessions", () => provider.showSessions()),
    vscode.commands.registerCommand("codex-chat.closeSession", () => provider.closeActiveSession()),
    vscode.commands.registerCommand("codex-chat.stop", () => provider.stop()),
    vscode.commands.registerCommand("codex-chat.focusInput", () => provider.focusInput()),
    vscode.commands.registerCommand("codex-chat.addSelectionToChat", () => provider.addSelection()),
    // 手动检查：只点亮侧边栏横幅（不直接弹安装确认），但保留结果反馈。
    // 真正的"下载并安装"确认统一由点击横幅触发，避免同时冒出两个入口。
    vscode.commands.registerCommand("codex-chat.checkUpdate", () => provider.checkForUpdate(true, false)),


    vscode.commands.registerCommand("codex-chat.notifyConfig", () => provider.showNotifyConfig()),
    vscode.commands.registerCommand("codex-chat.resetLocalSnapshotExcludes", () => provider.resetLocalSnapshotExcludes()),
    vscode.commands.registerCommand("codex-chat.performanceReport", () => diagnosticsPage.show(false)),
    vscode.commands.registerCommand("codex-chat.startDiagnostics", () => diagnosticsPage.show(true)),
    vscode.commands.registerCommand("codex-chat.openDiagnostics", (id?: string) => diagnosticsPage.show(false, id)),
    vscode.window.registerWebviewPanelSerializer("codex-chat.diagnostics", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> { panel.dispose(); diagnosticsPage.show(false); },
    }),
    vscode.commands.registerCommand("codex-chat.openLogs", async () => {
      try {
        await fs.promises.mkdir(LOG_DIR, { recursive: true });
      } catch { /* ignore */ }
      void vscode.env.openExternal(vscode.Uri.file(LOG_DIR));
    }),
    vscode.commands.registerCommand("codex-chat.openInEditor", () => provider.openInEditor()),
    // Cmd+Shift+T（仅聊天面板聚焦时接管）：重开最近关闭的会话标签页，对齐官方插件。
    vscode.commands.registerCommand("codex-chat.reopenClosedSession", () => provider.reopenClosedSession()),
    // The icon on FILE editors' title bar: always start a FRESH conversation
    // (openInEditor would resurrect the last session).
    vscode.commands.registerCommand("codex-chat.open", () => provider.newSession()),
  );

  // Auto-check for updates: once shortly after startup, then every 3 hours —
  // a window left open for days would otherwise never see a new build (the
  // startup check was the only trigger). Silent: only speaks up if newer.
  const updateTimer = setTimeout(() => void provider.checkForUpdate(true), 4000);
  const UPDATE_POLL_MS = 3 * 60 * 60 * 1000;
  const updatePoll = setInterval(() => void provider.checkForUpdate(true), UPDATE_POLL_MS);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(updateTimer);
      clearInterval(updatePoll);
    },
  });

}

export async function deactivate(): Promise<void> {
  await Promise.all([...diagnosticServices].map(service => service.dispose()));
  await Promise.all([...logWriters].map(writer => writer.flush()));
}
