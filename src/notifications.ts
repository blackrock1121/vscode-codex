import { observeOperation } from './operations';
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export const NOTIFIER_APP = "Codex Copilot Notifications.app";

// 在生成跳转 URI 之前排队，避免较早通知的慢回调盖过新通知或回复后的清理。
const sessionOperations = new Map<string, Promise<unknown>>();
export async function queueSessionNotification<T>(sessionId: string | undefined, action: () => Promise<T>): Promise<T> {
    if (!sessionId) return action(); // 无会话的测试通知独立处理
    const previous = sessionOperations.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    sessionOperations.set(sessionId, next);
    try { return await next; }
    finally { if (sessionOperations.get(sessionId) === next) sessionOperations.delete(sessionId); }
}

export function localNotificationId(sessionId: string): string { return `codex-session:${sessionId}`; }
let lastNoticeTime = 0;
export function notificationTime(): number {
    return lastNoticeTime = Math.max(Date.now(), lastNoticeTime + 1);
}

const PROJECT_TITLE_WIDTH = 26;
const graphemeWidth = (value: string): number => /[^\x00-\xff]/.test(value) ? 2 : value.length;
const displayWidth = (value: string): number => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    .reduce((total, { segment }) => total + graphemeWidth(segment), 0);

function compact(value: string, limit: number): string {
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.replace(/\s+/g, " ").trim())];
    if (segments.reduce((total, item) => total + graphemeWidth(item.segment), 0) <= limit) return segments.map(item => item.segment).join("");
    let text = "", used = 0;
    for (const { segment } of segments) {
        if (used + graphemeWidth(segment) > limit - 2) break;
        text += segment;
        used += graphemeWidth(segment);
    }
    return text + "…";
}

/** 未保存工作区用目录组合识别，不依赖“无标题”的界面语言。 */
export function localNotificationProject(fallback = ""): string {
    const { name, workspaceFile, workspaceFolders } = vscode.workspace;
    if (workspaceFile?.scheme !== "untitled" && name?.trim()) return name;
    const folders = (workspaceFolders ?? []).map(folder => folder.name.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (folders.length < 2) return folders[0] || fallback;
    const suffix = folders.length > 2 ? ` +${folders.length - 2}` : "";
    const available = PROJECT_TITLE_WIDTH - displayWidth(suffix) - 3; // “ / ”分隔符
    // 分别截短两个目录，避免首个长名称挤掉第二个目录和剩余数量。
    const firstLimit = Math.max(Math.ceil(available / 2), available - displayWidth(folders[1]));
    const secondLimit = available - Math.min(displayWidth(folders[0]), firstLimit);
    return `${compact(folders[0], firstLimit)} / ${compact(folders[1], secondLimit)}${suffix}`;
}

/** 标题突出来源工作区，正文只放耗时和一行摘要，完整内容在会话里查看。 */
export function formatLocalNotification(message: string, extra: Record<string, unknown>): { title: string; body: string } {
    const [originalTitle, ...lines] = message.split("\n");
    const duration = originalTitle.match(/（(?:耗时|距上次操作)\s*(.*?)）/)?.[1]
        .replace(/\s+/g, "").replace(/分0秒$/, "分");
    const project = typeof extra.project === "string" ? extra.project : "";
    let status = "", icon = "";
    if (originalTitle.startsWith("⏳ Codex 正在等你输入")) {
        icon = "⏳";
        status = typeof extra.ask === "string" && extra.ask.startsWith("待授权：") ? "待授权" : "待回答";
    } else if (originalTitle.startsWith("✅ Codex 任务完成")) { icon = "✅"; status = "已完成"; }
    else if (originalTitle.startsWith("⚠️ Codex 任务出错")) { icon = "⚠️"; status = "出错"; }
    else if (originalTitle === "🔔 Codex Copilot 本机通知测试") { icon = "🔔"; status = "通知测试"; }
    // 给状态留出空间，长工作区名只截断名称，避免标题换行或丢失状态。
    const title = status ? `${icon} ${compact(project || "未命名工作区", PROJECT_TITLE_WIDTH)} · ${status}` : originalTitle;
    const detail = extra.waiting && typeof extra.ask === "string" ? extra.ask.replace(/^待(?:回答|授权)：/, "")
        : typeof extra.question === "string" ? extra.question : "";
    const timing = duration ? `${extra.waiting ? "等待" : "耗时"} ${duration}` : "";
    const body = status ? [timing, detail || lines.join(" ")].filter(Boolean).map(value => compact(value, 40)).join("\n")
        : project || detail ? [project, detail].filter(Boolean).map(value => compact(value, 40)).join("\n")
        : compact(lines.join(" "), 80);
    return { title: compact(title, 40), body };
}

export function localNotificationsSupported(): boolean {
    return process.platform === "darwin" && !vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop;
}

/** 原生程序完成应用激活后，核对来源窗口确实获得焦点，不能仅凭命令返回就应答成功。 */
export async function focusNotificationWindow(): Promise<void> {
    await observeOperation('notification.focus', async () => {
        await vscode.commands.executeCommand("workbench.action.focusWindow");
        if (vscode.window.state.focused) return;
        await new Promise<void>((resolve, reject) => {
            const subscription = vscode.window.onDidChangeWindowState(state => {
                if (state.focused) { cleanup(); resolve(); }
            });
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("通知来源窗口未能切到前台。"));
            }, 2000);
            const cleanup = () => { clearTimeout(timer); subscription.dispose(); };
            if (vscode.window.state.focused) { cleanup(); resolve(); }
        });
    });
}

/** 通过独立 macOS 应用发送系统通知；与 webhook 完全独立，不使用 shell 拼接内容。 */
export async function sendLocalNotification(extensionPath: string, title: string, body: string, url: string,
    sessionId?: string, createdAt = notificationTime(), clickEndpoint?: string): Promise<void> {
    await requestLocalNotification(extensionPath, { operation: "show", id: sessionId ? localNotificationId(sessionId) : randomUUID(), title, body, url, sessionId, createdAt, clickEndpoint });
}

export async function clearLocalNotification(extensionPath: string, sessionId: string, createdAt = notificationTime()): Promise<void> {
    await requestLocalNotification(extensionPath, { operation: "clear", id: localNotificationId(sessionId), sessionId, createdAt });
}

/** 升级会改变辅助应用路径；macOS 将各路径的已展示通知分别管理。
 * 仅向兼容清理协议的历史安装发送同一个完整会话 ID，不扫描或删除其他会话。
 */
export async function clearPreviousLocalNotifications(extensionPath: string, sessionId: string, createdAt: number): Promise<{ completed: number; failed: number }> {
    const match = /^blackrock1121\.vscode-codex-(\d+)\.(\d+)\.(\d+)$/.exec(path.basename(extensionPath));
    if (!match || !sessionId) return { completed: 0, failed: 0 };
    const current = match.slice(1).map(Number);
    const older = (version: number[]) => {
        for (let i = 0; i < 3; i++) if (version[i] !== current[i]) return version[i] < current[i];
        return false;
    };
    const parent = path.dirname(extensionPath);
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const candidates = entries.filter(entry => {
        const found = /^blackrock1121\.vscode-codex-(\d+)\.(\d+)\.(\d+)$/.exec(entry.name);
        if (!entry.isDirectory() || !found) return false;
        const version = found.slice(1).map(Number);
        // 0.1.68 起才可靠识别编码后的通知会话，不启动不支持此协议的旧程序。
        return older(version) && (version[0] > 0 || version[1] > 1 || version[1] === 1 && version[2] >= 68);
    });
    let completed = 0, failed = 0;
    // 历史路径独立于当前路径，不占用当前会话的发送队列；限制并发启动数。
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
        while (next < candidates.length) {
            const folder = path.join(parent, candidates[next++].name);
            try {
                await fs.access(path.join(folder, 'dist', NOTIFIER_APP));
                await clearLocalNotification(folder, sessionId, createdAt);
                completed++;
            } catch { failed++; }
        }
    }));
    return { completed, failed };
}

function requestLocalNotification(extensionPath: string, payload: Record<string, unknown>): Promise<void> {
    return observeOperation(payload.operation === 'clear' ? 'notification.clear' : 'notification.show', () => requestLocalNotificationInner(extensionPath, payload));
}
async function requestLocalNotificationInner(extensionPath: string, payload: Record<string, unknown>): Promise<void> {
    if (!localNotificationsSupported()) throw new Error("本机通知目前仅支持本机 macOS 的 VS Code；飞书推送不受影响。");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-chat-notify-"));
    await fs.chmod(dir, 0o700);
    try {
        const request = path.join(dir, "request.codex-notification");
        await fs.writeFile(request, JSON.stringify(payload), { mode: 0o600 });
        await exec("/usr/bin/open", ["-g", "-a", path.join(extensionPath, "dist", NOTIFIER_APP), request], { timeout: 10000 });
        // 原生程序只在系统接受通知后写回结果，权限拒绝不能显示“发送成功”。
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            let raw: string;
            try { raw = await fs.readFile(path.join(dir, "result.json"), "utf8"); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }
            const result = JSON.parse(raw) as { ok: boolean; error?: string };
            if (!result.ok) throw new Error(result.error || "系统未接受本机通知。");
            return;
        }
        throw new Error("本机通知未及时确认，请在 macOS 系统设置 → 通知中检查 Codex Copilot Notifications 的权限后重试。");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
