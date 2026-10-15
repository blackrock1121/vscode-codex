import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatViewProvider } from "./panel/chatViewProvider";
import { DailyLogWriter } from "./logging";
import { RemoteBridgeClient } from "./remote/bridgeClient";
import { readPerformanceReport } from "./diagnosticsReport";

/** 固定日志目录：~/.codex-chat/logs/codex-chat-YYYY-MM-DD.log（按天分文件）。
 *  VS Code 输出通道的落盘路径深埋且每次会话都变，用户/同事根本找不到——
 *  所有日志双写到这里，收日志只需要拿这个目录。 */
const LOG_DIR = path.join(os.homedir(), ".codex-chat", "logs");
const logWriters = new Set<DailyLogWriter>();

/** 包一层 OutputChannel：appendLine 同时落盘到固定目录。写盘失败静默（日志不能反噬功能）。 */
function teeOutput(channel: vscode.OutputChannel): vscode.OutputChannel {
  const writer = new DailyLogWriter(LOG_DIR);
  logWriters.add(writer);
  // 窗口长期不重启、甚至没有新日志时，也要持续清理过期文件。
  const pruneTimer = setInterval(() => writer.prune(), 60 * 60 * 1000);
  return {
    name: channel.name,
    append: (v) => channel.append(v),
    appendLine: (v) => {
      channel.appendLine(v);
      writer.write(v);
    },
    replace: (v) => channel.replace(v),
    clear: () => channel.clear(),
    show: ((...args: unknown[]) => (channel.show as (...a: unknown[]) => void)(...args)) as vscode.OutputChannel["show"],
    hide: () => channel.hide(),
    dispose: () => { clearInterval(pruneTimer); void writer.dispose().finally(() => logWriters.delete(writer)); channel.dispose(); },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.isTrusted) return;
  const output = teeOutput(vscode.window.createOutputChannel("Codex Chat"));
  output.appendLine(`[boot] Codex Copilot v${(context.extension.packageJSON as { version?: string }).version ?? "?"} 日志目录 ${LOG_DIR}`);
  const provider = new ChatViewProvider(context, output);
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
    vscode.commands.registerCommand("codex-chat.performanceReport", async () => {
      await Promise.all([...logWriters].map(writer => writer.flush()));
      const content = await readPerformanceReport(LOG_DIR);
      const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("codex-chat.openLogs", () => {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
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
  await Promise.all([...logWriters].map(writer => writer.flush()));
}
