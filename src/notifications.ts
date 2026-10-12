import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export const NOTIFIER_APP = "Codex Copilot Notifications.app";

export function localNotificationsSupported(): boolean {
    return process.platform === "darwin" && !vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop;
}

/** 通过独立 macOS 应用发送系统通知；与 webhook 完全独立，不使用 shell 拼接内容。 */
export async function sendLocalNotification(extensionPath: string, title: string, body: string, url: string): Promise<void> {
    if (!localNotificationsSupported()) throw new Error("本机通知目前仅支持本机 macOS 的 VS Code；飞书推送不受影响。");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-chat-notify-"));
    await fs.chmod(dir, 0o700);
    try {
        const request = path.join(dir, "request.codex-notification");
        await fs.writeFile(request, JSON.stringify({ id: randomUUID(), title, body, url }), { mode: 0o600 });
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
