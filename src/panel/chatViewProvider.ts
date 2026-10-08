import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import { WorkspaceSnapshot } from "../snapshot";
import { diffCounts } from "../diff";
import { randomUUID } from "node:crypto";
import { questionStateFile, deleteQuestionState, CodexProcess, PermissionRequest } from "../codex/process";
import { usageView, quotaEvents } from "../codex/events";
import { SessionStore } from "../codex/session";
import { CheckpointManager, shortLabel } from "../checkpoints";
import { ChangedFile, CheckpointSummary, contextWindowFor, CTX_OPEN, CTX_CLOSE, FromWebview, ICONS, modelChoices, ModelChoice, SessionSummary, ToWebview } from "../shared";
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function stripHeredocs(cmd: string): string {
    const lines = cmd.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]);
        if (!m)
            continue;
        for (i = i + 1; i < lines.length; i++)
            if (lines[i].replace(/^\t+/, "") === m[2])
                break;
    }
    return out.join("\n");
}
const MODE_NAMES: Record<string, string> = {
    default: "按需审批",
    acceptEdits: "自动编辑",
    plan: "只读模式",
    bypassPermissions: "绕过权限",
};
function bashWritePaths(cmd: string, cwd: string): string[] {
    const toks: string[] = [];
    let cur = "";
    let q: string | null = null;
    const flush = () => { if (cur)
        toks.push(cur); cur = ""; };
    const src = stripHeredocs(cmd);
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (q) {
            if (ch === q)
                q = null;
            else
                cur += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            q = ch;
            continue;
        }
        if (ch === "\\" && i + 1 < src.length) {
            cur += src[++i];
            continue;
        }
        if (ch === ">") {
            if (cur === "2" || cur === "&")
                cur = "";
            else
                flush();
            let op = ">";
            if (src[i + 1] === ">") {
                op = ">>";
                i++;
            }
            if (src[i + 1] === "|")
                i++;
            toks.push(op);
            continue;
        }
        if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && src[i + 1] === "&")) {
            flush();
            toks.push(";");
            if ((ch === "|" && src[i + 1] === "|") || ch === "&")
                i++;
            continue;
        }
        if (/\s/.test(ch)) {
            flush();
            continue;
        }
        cur += ch;
    }
    flush();
    const out = new Set<string>();
    const bad = (t: string) => !t || t.startsWith("-") || /[$*?`{}]/.test(t) || t.includes("<<") || t === "/dev/null";
    const add = (t: string) => {
        if (bad(t))
            return;
        const p = path.isAbsolute(t) ? t : path.resolve(cwd, t);
        try {
            if (fs.statSync(p).isDirectory())
                return;
        }
        catch { }
        out.add(p);
    };
    const segs: string[][] = [[]];
    for (const t of toks) {
        if (t === ";")
            segs.push([]);
        else
            segs[segs.length - 1].push(t);
    }
    for (const seg of segs) {
        if (!seg.length)
            continue;
        const words: string[] = [];
        for (let i = 0; i < seg.length; i++) {
            if (seg[i] === ">" || seg[i] === ">>") {
                if (i + 1 < seg.length)
                    add(seg[++i]);
                continue;
            }
            words.push(seg[i]);
        }
        let k = 0;
        while (k < words.length && (words[k] === "sudo" || words[k] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])))
            k++;
        const name = path.basename(words[k] ?? "");
        const args = words.slice(k + 1);
        const positional = args.filter((a) => !a.startsWith("-"));
        if (name === "tee")
            positional.forEach(add);
        else if (name === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
            let exprTaken = args.some((a) => a === "-e" || a.startsWith("--expression"));
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === "-e" || a === "--expression" || a === "-f") {
                    i++;
                    continue;
                }
                if (a.startsWith("-"))
                    continue;
                if (!exprTaken) {
                    exprTaken = true;
                    continue;
                }
                add(a);
            }
        }
        else if ((name === "cp" || name === "mv") && positional.length >= 2)
            add(positional[positional.length - 1]);
        else if (name === "rm" || name === "touch" || name === "truncate")
            positional.forEach(add);
    }
    return [...out];
}
const ORIG_SCHEME = "codex-orig";
const LAST_SESSION_KEY = "codexChat.lastSession";
interface SessionCtx {
    snapshot?: WorkspaceSnapshot;
    finalizing?: Promise<void>;
    panel: vscode.WebviewPanel;
    webview: vscode.Webview;
    sessionId?: string;
    proc?: CodexProcess;
    starting?: Promise<CodexProcess | undefined>;
    checkpoints: CheckpointManager;
    pendingContext?: {
        label: string;
        text: string;
    };
    pendingPrefill?: string;
    pendingPerm?: ToWebview;
    pendingQuestionAt?: number;
    readOnlyToolIds?: Set<string>;
    mayHaveModifiedWorkspace?: boolean;
    blank: boolean;
    ready: boolean;
    sendSeq?: number;
    stopSeq?: number;
    coldStart?: boolean;
    lastUsedAt?: number;
    sendAt?: number;
    lastUserText?: string;
    lastUserActionAt?: number;
    lastEventAt?: number;
    missedPings?: number;
    rebuildAt?: number;
    lastEmitAt?: number;
    draft?: string;
    draftImages?: {
        mediaType: string;
        data: string;
    }[];
}
export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "codex-chat.chatView";
    private view?: vscode.WebviewView;
    private readonly sessions = new Set<SessionCtx>();
    private readonly forking = new Set<SessionCtx>();
    private readonly restoring = new Set<SessionCtx>();
    private activeCtx?: SessionCtx;
    private store: SessionStore;
    private lastActiveFilePath?: string;
    private updateAvailable?: string;
    private installedPending?: string;
    private lastUsageAt = 0;
    private usageFails = 0;
    private usageInFlight = false;
    private lastUsage?: ToWebview;
    private readonly snapshotWarningSignatures = new Map<string, string>();
    private readonly snapshotWarningPaths = new Map<string, Set<string>>();
    private layoutFixing = false;
    private readonly origChanged = new vscode.EventEmitter<vscode.Uri>();
    private terminal?: vscode.Terminal;
    private usageTimer?: ReturnType<typeof setInterval>;
    private watchdogTimer?: ReturnType<typeof setInterval>;
    private sidebarMissedPings = 0;
    private notifyPanel?: vscode.WebviewPanel;
    constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
        this.store = new SessionStore(this.cwd(), () => this.config().get<string>("codexPath", "codex"));
        const origChanged = this.origChanged;
        const sessions = this.sessions;
        this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, {
            onDidChange: origChanged.event,
            provideTextDocumentContent(uri: vscode.Uri): string {
                if (uri.query === "empty")
                    return "";
                for (const s of sessions) {
                    const orig = s.checkpoints.originalOf(uri.path);
                    if (orig != null)
                        return orig;
                }
                return "";
            },
        }), origChanged, vscode.window.onDidCloseTerminal((t) => {
            if (t === this.terminal)
                this.terminal = undefined;
        }), vscode.window.onDidChangeActiveTextEditor((ed) => {
            this.postActiveFile();
            void this.keepFilesLeft(ed);
        }), vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.uri.scheme !== "file")
                return;
            this.postActiveFile(doc.uri.fsPath === this.lastActiveFilePath);
        }), vscode.window.tabGroups.onDidChangeTabs(() => {
            const p = this.lastActiveFilePath;
            if (!p)
                return;
            const stillOpen = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => ((t.input as {
                uri?: vscode.Uri;
            } | undefined)?.uri?.fsPath ?? "") === p));
            if (!stillOpen)
                this.postActiveFile(true);
        }));
        this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(ev => {
            if (!ev.affectsConfiguration("codexChat.fastMode")) return;
            const enabled = this.config().get<boolean>("fastMode", false);
            void Promise.all(this.allProcs().map(p => p.setFastMode(enabled)));
            this.broadcastModelConfig();
        }));
        this.usageTimer = setInterval(() => this.fetchUsage(), 3 * 60000);
        this.watchdogTimer = setInterval(() => {
            for (const ctx of [...this.sessions, ...this.detached.values()])
                this.checkTurnStall(ctx);
            for (const ctx of this.sessions) {
                if (!ctx.ready)
                    continue;
                ctx.missedPings = (ctx.missedPings ?? 0) + 1;
                if ((ctx.missedPings ?? 0) > 3) {
                    ctx.missedPings = 0;
                    if (Date.now() - (ctx.rebuildAt ?? 0) < 5 * 60000) {
                        this.output.appendLine(`[${new Date().toISOString()}] [watchdog] 面板仍未响应，但 5min 内已重建过，跳过`);
                        continue;
                    }
                    ctx.rebuildAt = Date.now();
                    this.output.appendLine(`[${new Date().toISOString()}] [watchdog] 面板 ${ctx.sessionId?.slice(0, 8) ?? "新会话"} 通道无响应 30s，重建 webview`);
                    ctx.ready = false;
                    try {
                        ctx.panel.webview.html = this.html(ctx.panel.webview);
                    }
                    catch (err) {
                        this.output.appendLine(`[watchdog] 重建失败: ${String(err)}`);
                    }
                    continue;
                }
                this.post(ctx, { kind: "ping", id: Date.now() });
            }
            if (this.view?.visible) {
                this.sidebarMissedPings++;
                if (this.sidebarMissedPings > 3) {
                    this.output.appendLine(`[${new Date().toISOString()}] [watchdog] 侧边栏通道无响应 30s，重建 webview`);
                    this.sidebarMissedPings = 0;
                    try {
                        this.view.webview.html = this.sidebarHtml();
                    }
                    catch (err) {
                        this.output.appendLine(`[watchdog] 侧边栏重建失败: ${String(err)}`);
                    }
                }
                else {
                    this.view.webview.postMessage({ kind: "ping", id: Date.now() } satisfies ToWebview);
                }
            }
            else {
                this.sidebarMissedPings = 0;
            }
        }, 10000);
    }
    private readonly detached = new Map<string, SessionCtx>();
    private postActiveFile(allowClear = false): void {
        if (!this.activeCtx)
            return;
        let p: string | undefined;
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document.uri.scheme === "file") {
            p = ed.document.uri.fsPath;
        }
        else {
            const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as {
                uri?: vscode.Uri;
            } | undefined;
            if (input?.uri && input.uri.scheme === "file")
                p = input.uri.fsPath;
        }
        if (p) {
            this.lastActiveFilePath = p;
            this.post(this.activeCtx, { kind: "active_file", path: p });
        }
        else if (allowClear) {
            this.lastActiveFilePath = undefined;
            this.post(this.activeCtx, { kind: "active_file", path: null });
        }
    }
    private buildFileContext(paths: string[]): string {
        const MAX_FILE = 60 * 1024;
        let budget = 200 * 1024;
        const parts: string[] = [];
        for (const p of paths) {
            let stat: fs.Stats;
            try {
                stat = fs.statSync(p);
            }
            catch {
                continue;
            }
            const rel = vscode.workspace.asRelativePath(p);
            if (stat.isDirectory()) {
                let entries: string[] = [];
                try {
                    entries = fs.readdirSync(p).slice(0, 200);
                }
                catch {
                }
                parts.push(`目录 ${rel}/ 包含:\n${entries.map((e) => "  " + e).join("\n")}`);
            }
            else if (stat.size > 0 && budget > 0) {
                try {
                    const limit = Math.min(MAX_FILE, budget);
                    const fd = fs.openSync(p, "r");
                    const buf = Buffer.allocUnsafe(limit);
                    let read: number;
                    try { read = fs.readSync(fd, buf, 0, limit, 0); }
                    finally { fs.closeSync(fd); }
                    const content = buf.subarray(0, read).toString("utf8");
                    const note = stat.size > read ? `\n…（已截断，完整内容请用 Read 工具读取 ${rel}）` : "";
                    budget -= read;
                    const ext = path.extname(p).replace(".", "");
                    parts.push(`文件 ${rel}:\n\`\`\`${ext}\n${content}\n\`\`\`${note}`);
                }
                catch {
                    parts.push(`文件 ${rel}（无法读取，请用 Read 工具）`);
                }
            }
            else {
                parts.push(`文件 ${rel}`);
            }
        }
        if (!parts.length)
            return "";
        return `${CTX_OPEN}\n用户附带了以下文件作为上下文：\n\n${parts.join("\n\n")}\n${CTX_CLOSE}`;
    }
    private importDropped(ctx: SessionCtx, roots: {
        name: string;
        isDir: boolean;
    }[], files: {
        rel: string;
        base64: string;
    }[], skipped?: number): void {
        const base = path.join(this.storageDir(), "dropped");
        try {
            for (const d of fs.readdirSync(base)) {
                const ts = Number(d);
                if (Number.isFinite(ts) && Date.now() - ts > 7 * 24 * 3600000) {
                    fs.rmSync(path.join(base, d), { recursive: true, force: true });
                }
            }
        }
        catch {
        }
        const safe = (rel: string) => rel
            .split(/[\\/]+/)
            .filter((s) => s && s !== ".." && s !== ".")
            .join(path.sep);
        const dir = path.join(base, String(Date.now()));
        for (const f of files) {
            const rel = safe(f.rel);
            if (!rel)
                continue;
            try {
                const dest = path.join(dir, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, Buffer.from(f.base64, "base64"));
            }
            catch (err) {
                this.output.appendLine(`[dropped] 写入失败 ${f.rel}: ${String(err)}`);
            }
        }
        const paths: string[] = [];
        for (const r of roots) {
            const rel = safe(r.name);
            if (!rel)
                continue;
            const p = path.join(dir, rel);
            try {
                if (r.isDir)
                    fs.mkdirSync(p, { recursive: true });
            }
            catch {
            }
            if (fs.existsSync(p))
                paths.push(p);
        }
        if (skipped) {
            this.output.appendLine(`[dropped] 跳过 ${skipped} 个文件（超出单文件 10MB / 总量 30MB / 300 个上限）`);
        }
        this.output.appendLine(`[dropped] 镜像 ${files.length} 个文件到 ${dir}`);
        if (paths.length)
            this.post(ctx, { kind: "attach_files", paths });
    }
    private runInTerminal(code: string): void {
        const text = code.replace(/\n+$/, "");
        if (!text.trim())
            return;
        if (!this.terminal) {
            this.terminal = vscode.window.createTerminal({ name: "Codex Chat", cwd: this.cwd() });
        }
        this.terminal.show(true);
        this.terminal.sendText(text, true);
    }
    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.onDidDispose(() => {
            if (this.view === view)
                this.view = undefined;
        });
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
        };
        view.webview.html = this.sidebarHtml();
        view.webview.onDidReceiveMessage((m: FromWebview) => this.onSidebarMessage(m));
        this.postUpdateDot();
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.post2(view.webview, {
                    kind: "sessions",
                    list: this.withPinned(this.store.list()),
                    activeId: this.activeCtx?.sessionId,
                    runningIds: this.runningIds(),
                });
                this.postUpdateDot();
            }
        });
    }
    private post2(target: vscode.Webview | undefined, e: ToWebview): void {
        target?.postMessage(e);
    }
    private postUpdateDot(): void {
        this.view?.webview.postMessage({ kind: "update_available", version: this.updateAvailable ?? "" });
        if (this.view) {
            this.view.badge = this.updateAvailable
                ? { value: 1, tooltip: `发现新版本 v${this.updateAvailable}` }
                : undefined;
        }
    }
    private refreshSessions(): void {
        void this.store.refresh().then(async () => {
            const last = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
            // thread/list 已排除归档会话。不能凭残留的 checkpoint 文件把它重新放回列表。
            const live = last && [...this.sessions, ...this.detached.values()].some(ctx => ctx.sessionId === last && ctx.proc && !ctx.proc.isExited);
            if (last && !live && !this.store.list().some(s => s.id === last))
                await this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
            this.renderSessions();
        }).catch(e => this.output.appendLine(`[sessions] ${String(e)}`));
    }
    private renderSessions(): void {
        const list = this.store.list();
        try {
            this.view?.webview.postMessage({
                kind: "sessions",
                list: this.withPinned(list),
                activeId: this.activeCtx?.sessionId,
                runningIds: this.runningIds(),
            } satisfies ToWebview);
        }
        catch {
        }
        for (const ctx of this.sessions) {
            try {
                this.setPanelTitle(ctx, list);
            }
            catch {
            }
        }
    }
    private setPanelTitle(ctx: SessionCtx, list?: ReturnType<SessionStore["list"]>): void {
        const title = ctx.sessionId
            ? (list ?? this.store.list()).find((s) => s.id === ctx.sessionId)?.title
            : undefined;
        ctx.panel.title = title?.trim() || "Codex Copilot";
    }
    async openSession(sessionId?: string): Promise<void> {
        this.output.appendLine(`[${new Date().toISOString()}] [open] ${sessionId ? sessionId.slice(0, 8) : "新会话"}`);
        if (sessionId) {
            for (const ctx of this.sessions) {
                if (ctx.sessionId === sessionId) {
                    ctx.panel.reveal(ctx.panel.viewColumn, false);
                    this.activeCtx = ctx;
                    await this.lockChatGroup(ctx.panel);
                    return;
                }
            }
            const det = this.detached.get(sessionId);
            if (det) {
                this.detached.delete(sessionId);
                await this.reopenDetached(det);
                return;
            }
        }
        const panel = vscode.window.createWebviewPanel("codex-chat.editor", "Codex Copilot", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
        });
        const ctx: SessionCtx = {
            panel,
            webview: panel.webview,
            sessionId,
            checkpoints: new CheckpointManager(this.storageDir()),
            blank: !sessionId,
            ready: false,
        };
        if (sessionId)
            ctx.checkpoints.setSession(sessionId);
        this.adoptPanel(ctx);
        this.sessions.add(ctx);
        this.activeCtx = ctx;
        await this.lockChatGroup(panel);
    }
    private async reopenDetached(det: SessionCtx): Promise<void> {
        const panel = vscode.window.createWebviewPanel("codex-chat.editor", "Codex Copilot", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
        });
        det.panel = panel;
        det.webview = panel.webview;
        det.ready = false;
        det.blank = false;
        this.adoptPanel(det);
        this.sessions.add(det);
        this.activeCtx = det;
        await this.lockChatGroup(panel);
    }
    private adoptPanel(ctx: SessionCtx): void {
        const panel = ctx.panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
        };
        panel.title = "Codex Copilot";
        panel.iconPath = { light: vscode.Uri.joinPath(this.context.extensionUri, "media", "icon-light.svg"), dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg") };
        panel.webview.html = this.html(panel.webview);
        ctx.webview = panel.webview;
        panel.webview.onDidReceiveMessage((m: FromWebview) => {
            this.activeCtx = ctx;
            this.onPanelMessage(ctx, m);
        });
        panel.onDidDispose(() => this.onPanelClosed(ctx));
    }
    private lastClosedSessionId?: string;
    reopenClosedSession(): void {
        const id = this.lastClosedSessionId;
        if (!id)
            return;
        if (!this.store.list().some((s) => s.id === id)) {
            this.lastClosedSessionId = undefined;
            return;
        }
        void this.openSession(id);
    }
    private onPanelClosed(ctx: SessionCtx): void {
        this.sessions.delete(ctx);
        if (ctx.sessionId)
            this.lastClosedSessionId = ctx.sessionId;
        if (this.activeCtx === ctx)
            this.activeCtx = undefined;
        if (ctx.proc && !ctx.proc.isExited && ctx.sessionId) {
            ctx.lastUsedAt = Date.now();
            this.detached.set(ctx.sessionId, ctx);
            this.trimBackground();
        }
        else {
            ctx.proc?.dispose();
            ctx.proc = undefined;
            ctx.starting = undefined;
        }
        this.broadcastRunning();
        this.refreshSessions();
    }
    private static readonly MAX_BACKGROUND = 5;
    private trimBackground(): void {
        let overflow = this.detached.size - ChatViewProvider.MAX_BACKGROUND;
        if (overflow <= 0)
            return;
        const idle = [...this.detached.values()]
            .filter((c) => c.proc && !c.proc.isBusy && c.sessionId && Date.now() - (c.lastEmitAt ?? 0) > 60000)
            .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
        for (const c of idle) {
            if (overflow <= 0)
                break;
            c.checkpoints.flush();
            c.proc?.dispose();
            c.proc = undefined;
            this.detached.delete(c.sessionId!);
            overflow--;
            this.output.appendLine(`[codex] LRU 回收后台进程 ${c.sessionId!.slice(0, 8)}（后台剩 ${this.detached.size}）`);
        }
    }
    async revivePanel(panel: vscode.WebviewPanel, sessionId?: string): Promise<void> {
        if (sessionId)
            await this.store.hydrate(sessionId).catch(e => this.output.appendLine(String(e)));
        let sid = sessionId && this.store.findFile(sessionId) ? sessionId : undefined;
        if (sid) {
            for (const other of this.sessions) {
                if (other.sessionId === sid) {
                    sid = undefined;
                    break;
                }
            }
        }
        const ctx: SessionCtx = {
            panel,
            webview: panel.webview,
            sessionId: sid,
            checkpoints: new CheckpointManager(this.storageDir()),
            blank: !sid && !!sessionId,
            ready: false,
        };
        if (sid)
            ctx.checkpoints.setSession(sid);
        this.adoptPanel(ctx);
        this.sessions.add(ctx);
        this.activeCtx = ctx;
        await this.lockChatGroup(panel);
    }
    private async keepFilesLeft(ed?: vscode.TextEditor): Promise<void> {
        if (this.layoutFixing || !ed || ed.viewColumn === undefined)
            return;
        if (!this.sessions.size)
            return;
        if (ed.document.uri.scheme === ORIG_SCHEME)
            return;
        const chatCol = (): number | undefined => {
            let m: number | undefined;
            for (const ctx of this.sessions) {
                const c = ctx.panel.viewColumn;
                if (c && (m === undefined || c < m))
                    m = c;
            }
            return m;
        };
        const cc = chatCol();
        if (cc === undefined || ed.viewColumn < cc)
            return;
        this.layoutFixing = true;
        try {
            for (let i = 0; i < 8; i++) {
                const a = vscode.window.activeTextEditor;
                const col = a?.viewColumn;
                if (!a || col === undefined || col === vscode.ViewColumn.One)
                    break;
                const ck = chatCol();
                if (ck !== undefined && col < ck)
                    break;
                await vscode.commands.executeCommand("workbench.action.moveActiveEditorGroupLeft");
                if (vscode.window.activeTextEditor?.viewColumn === col)
                    break;
            }
        }
        catch {
        }
        finally {
            this.layoutFixing = false;
        }
    }
    private async lockChatGroup(panel: vscode.WebviewPanel): Promise<void> {
        try {
            panel.reveal(panel.viewColumn, false);
            await new Promise((r) => setTimeout(r, 60));
            if (!panel.active)
                return;
            await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
        }
        catch {
        }
    }
    async login(): Promise<void> {
        try {
            const rpc = await this.store.connection();
            const onNotification = (m: any) => {
                if (m.method !== "account/login/completed")
                    return;
                rpc.off("notification", onNotification);
                if (m.params.success) {
                    void vscode.window.showInformationMessage("Codex 登录成功");
                    this.fetchUsage(true);
                }
                else
                    void vscode.window.showErrorMessage(`Codex 登录失败：${m.params.error ?? "请重试"}`);
            };
            rpc.on("notification", onNotification);
            const response = await rpc.request("account/login/start", { type: "chatgpt" });
            if (response.authUrl)
                await vscode.env.openExternal(vscode.Uri.parse(response.authUrl));
        }
        catch (e) {
            void vscode.window.showErrorMessage(`无法启动登录：${String(e)}`);
        }
    }
    async account(): Promise<void> {
        try {
            const r = await (await this.store.connection()).request("account/read", {});
            void vscode.window.showInformationMessage(r.account ? `Codex 已登录 · ${r.account.type === "chatgpt" ? "ChatGPT 订阅" : r.account.type} · ${r.account.planType ?? ""}` : "Codex 尚未登录，请执行“Codex: 登录账号”。");
        }
        catch (e) {
            void vscode.window.showErrorMessage(String(e));
        }
    }
    async newSession(): Promise<void> {
        await this.openSession(undefined);
    }
    async openInEditor(): Promise<void> {
        await this.store.refresh();
        const last = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
        await this.openSession(last && this.store.findFile(last) ? last : undefined);
    }
    async showSessions(): Promise<void> {
        this.refreshSessions();
        this.reveal();
    }
    async stop(): Promise<void> {
        const ctx = this.activeCtx;
        if (!ctx)
            return;
        ctx.pendingPerm = undefined;
        ctx.lastEventAt = undefined;
        ctx.stopSeq = ctx.sendSeq ?? 0;
        this.post(ctx, { kind: "busy", busy: false });
        await ctx.proc?.interrupt();
    }
    focusInput(): void {
        this.reveal();
        if (this.activeCtx)
            this.post(this.activeCtx, { kind: "notice", message: "" });
    }
    addSelection(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage("没有选中的代码。");
            return;
        }
        const ctx = this.activeCtx;
        if (!ctx) {
            vscode.window.showInformationMessage("请先打开一个会话。");
            return;
        }
        const sel = editor.document.getText(editor.selection);
        const rel = vscode.workspace.asRelativePath(editor.document.uri);
        const lang = editor.document.languageId;
        const start = editor.selection.start.line + 1;
        const end = editor.selection.end.line + 1;
        const label = `${rel}:${start}-${end}`;
        const text = `选中代码 \`${label}\`:\n\`\`\`${lang}\n${sel}\n\`\`\``;
        if (ctx.ready) {
            this.post(ctx, { kind: "context_added", label, text });
        }
        else {
            ctx.pendingContext = { label, text };
        }
        this.reveal();
    }
    private async onSidebarMessage(m: FromWebview): Promise<void> {
        this.sidebarMissedPings = 0;
        try {
            switch (m.type) {
                case "pong":
                    break;
                case "ready":
                case "listSessions":
                    this.refreshSessions();
                    this.postUpdateDot();
                    this.fetchUsage();
                    break;
                case "checkUpdate":
                    await this.checkForUpdate(!m.fromBanner, false);
                    break;
                case "refreshUsage":
                    this.fetchUsage(true);
                    break;
                case "openSession":
                    await this.openSession(m.sessionId);
                    break;
                case "newInEditor":
                    await this.openSession(undefined);
                    break;
                case "deleteSessions":
                    await this.deleteSessions(m.sessionIds);
                    break;
                case "renameSession":
                    await this.renameSession(m.sessionId, m.title);
                    break;
                case "pinSession":
                    await this.setPinned(m.sessionId, m.pinned);
                    break;
                case "webviewError":
                    this.output.appendLine(`[${new Date().toISOString()}] [webview] 侧边栏脚本错误: ${m.message}`);
                    break;
            }
        }
        catch (err) {
            this.output.appendLine(`[onSidebarMessage:${m.type}] ${String(err)}`);
        }
    }
    private async onPanelMessage(ctx: SessionCtx, m: FromWebview): Promise<void> {
        ctx.missedPings = 0;
        try {
            switch (m.type) {
                case "pong":
                    break;
                case "draft":
                    ctx.draft = m.text;
                    if (!m.text)
                        ctx.draftImages = undefined;
                    break;
                case "excludeSnapshotPaths":
                    await this.excludeSnapshotPaths(ctx, m.paths, m.all);
                    break;
                case "dismissRateLimit": {
                    const until = m.resetsAt ? m.resetsAt * 1000 : Date.now() + 6 * 3600000;
                    const map = { ...this.context.globalState.get<Record<string, number>>("codexChat.rateLimitDismissed") };
                    map[m.limitLabel] = until;
                    await this.context.globalState.update("codexChat.rateLimitDismissed", map);
                    this.output.appendLine(`[${new Date().toISOString()}] [ratelimit] 「${m.limitLabel}」警告已关闭至 ${new Date(until).toLocaleString()}`);
                    break;
                }
                case "webviewError":
                    this.output.appendLine(`[${new Date().toISOString()}] [webview] 聊天面板脚本错误: ${m.message}`);
                    break;
                case "ready":
                    ctx.ready = true;
                    void this.store.read("model/list").then(r => {
                        const models = modelChoices(r.data);
                        this.modelCatalog = models;
                        this.post(ctx, { kind: "models", models });
                    }).catch(e => this.post(ctx, { kind: "notice", message: `模型列表读取失败：${String(e)}` }));
                    this.post(ctx, {
                        kind: "config",
                        permissionMode: this.config().get<string>("permissionMode", "default"),
                        model: this.config().get<string>("model", ""),
                        effort: this.config().get<string>("effort", ""),
                        fastMode: this.config().get<boolean>("fastMode", false),
                        modEnterToSend: this.config().get<boolean>("modEnterToSend", false),
                    });
                    this.loadCtxSession(ctx);
                    this.postActiveFile();
                    if (ctx.pendingContext) {
                        this.post(ctx, { kind: "context_added", ...ctx.pendingContext });
                        ctx.pendingContext = undefined;
                    }
                    if (ctx.pendingPrefill) {
                        this.post(ctx, { kind: "prefill", text: ctx.pendingPrefill });
                        ctx.pendingPrefill = undefined;
                    }
                    if (this.lastUsage)
                        this.post(ctx, this.lastUsage);
                    this.fetchUsage();
                    break;
                case "checkUpdate":
                    await this.checkForUpdate(!m.fromBanner, false);
                    break;
                case "refreshUsage":
                    this.fetchUsage(true);
                    break;
                case "send":
                    await this.handleSend(ctx, m.text, m.context, m.images, m.files);
                    break;
                case "editMessage":
                    await this.editMessage(ctx, m.checkpointId, m.text, m.images);
                    break;
                case "interrupt":
                    ctx.pendingPerm = undefined;
                    ctx.lastUserActionAt = Date.now();
                    ctx.lastEventAt = undefined;
                    ctx.stopSeq = ctx.sendSeq ?? 0;
                    this.post(ctx, { kind: "busy", busy: false });
                    void ctx.proc?.interrupt();
                    break;
                case "newContext":
                    await this.newContext(ctx, m);
                    break;
                case "compact": {
                    const proc = await this.ensureProcess(ctx);
                    if (proc) {
                        proc.compact();
                        ctx.lastEventAt = Date.now();
                    }
                    else
                        this.post(ctx, { kind: "busy", busy: false });
                    break;
                }
                case "permission":
                    ctx.pendingPerm = undefined;
                    ctx.lastUserActionAt = Date.now();
                    if (ctx.lastEventAt !== undefined)
                        ctx.lastEventAt = Date.now();
                    this.handlePermission(ctx, m.requestId, m.behavior, m.suggestionId);
                    break;
                case "answerQuestion":
                    if (!ctx.proc?.answerQuestion(m.requestId, m.answers)) break;
                    if (ctx.pendingPerm?.kind === "permission_request" && ctx.pendingPerm.requestId === m.requestId && ctx.pendingQuestionAt !== undefined)
                        this.output.appendLine(`[${new Date().toISOString()}] [question] 用户等待 ${Date.now() - ctx.pendingQuestionAt}ms，答案已转交 Codex`);
                    ctx.pendingQuestionAt = undefined;
                    ctx.pendingPerm = undefined;
                    ctx.lastUserActionAt = Date.now();
                    if (ctx.lastEventAt !== undefined)
                        ctx.lastEventAt = Date.now();
                    break;
                case "restoreCheckpoint":
                    await this.restoreCheckpoint(ctx, m.checkpointId);
                    break;
                case "forkCheckpoint":
                    await this.forkCheckpoint(ctx, m.checkpointId);
                    break;
                case "setPermissionMode":
                    await this.setPermissionMode(ctx, m.mode);
                    break;
                case "setModel":
                    await this.setModel(ctx, m.model);
                    break;
                case "setFastMode":
                    await this.setFastMode(ctx, m.enabled);
                    break;
                case "setEffort":
                    await this.setEffort(ctx, m.effort);
                    break;
                case "addContext":
                    this.addSelection();
                    break;
                case "pickFiles": {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        canSelectFiles: true,
                        canSelectFolders: true,
                        openLabel: "附加到会话",
                        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
                    });
                    if (picked?.length)
                        this.post(ctx, { kind: "attach_files", paths: picked.map((u) => u.fsPath) });
                    break;
                }
                case "importDropped":
                    this.importDropped(ctx, m.roots, m.files, m.skipped);
                    break;
                case "openDiff":
                    await this.openDiff(ctx, m.path);
                    break;
                case "acceptFile":
                    ctx.checkpoints.accept(m.path);
                    this.refreshChangedFiles(ctx);
                    break;
                case "revertFile":
                    this.revertFile(ctx, m.path);
                    this.refreshChangedFiles(ctx);
                    break;
                case "acceptAll":
                    for (const f of this.getChangedFiles(ctx).files)
                        ctx.checkpoints.accept(f.path);
                    this.refreshChangedFiles(ctx);
                    break;
                case "revertAll": {
                    const files = this.getChangedFiles(ctx).files;
                    if (files.length) {
                        const ok = await vscode.window.showWarningMessage(`回滚全部 ${files.length} 个文件的改动？`, { modal: true, detail: "将把这些文件恢复到 Codex 改动前的状态，此操作不可撤销。" }, "回滚全部");
                        if (ok === "回滚全部") {
                            for (const f of files)
                                this.revertFile(ctx, f.path);
                            this.refreshChangedFiles(ctx);
                        }
                    }
                    break;
                }
                case "runInTerminal":
                    this.runInTerminal(m.code);
                    break;
                case "openFile":
                    await this.openFile(ctx, m.path, m.line, m.endLine);
                    break;
                case "openExternalLink": {
                    try {
                        const uri = vscode.Uri.parse(m.url);
                        if (["http", "https", "mailto"].includes(uri.scheme)) {
                            if (!(await vscode.env.openExternal(uri)))
                                vscode.window.showWarningMessage(`系统未能打开链接: ${m.url}`);
                        }
                    }
                    catch (err) {
                        this.output.appendLine(`[openExternalLink] ${m.url} 打开失败: ${String((err as Error)?.message ?? err)}`);
                        vscode.window.showErrorMessage(`无法打开链接: ${m.url}`);
                    }
                    break;
                }
                case "loadLocalImage": {
                    const dataUri = await this.loadLocalImage(m.path);
                    this.post(ctx, { kind: "local_image", path: m.path, dataUri });
                    break;
                }
                case "openSymbol":
                    await this.openSymbol(ctx, m.name);
                    break;
                case "validateSymbols": {
                    const invalid = await this.validateSymbols(m.syms);
                    if (invalid.length)
                        this.post(ctx, { kind: "refs_validated", invalid });
                    break;
                }
                case "validateRefs": {
                    const invalid: string[] = [];
                    for (const r of m.refs) {
                        if (!(await this.fileRefResolves(r.path)))
                            invalid.push(r.id);
                    }
                    if (invalid.length)
                        this.post(ctx, { kind: "refs_validated", invalid });
                    break;
                }
                case "copy":
                    await vscode.env.clipboard.writeText(m.text);
                    break;
                case "saveImage":
                    await this.saveImage(m.dataUri);
                    break;
            }
        }
        catch (err) {
            this.output.appendLine(`[onPanelMessage:${m.type}] ${String(err)}`);
            this.post(ctx, { kind: "error", message: String((err as Error)?.message ?? err) });
        }
    }
    private loadCtxSession(ctx: SessionCtx): void {
        if (ctx.draft || ctx.draftImages?.length)
            this.post(ctx, { kind: "draft", text: ctx.draft ?? "", images: ctx.draftImages });
        if (ctx.sessionId) {
            this.loadSessionInto(ctx, ctx.sessionId);
            return;
        }
        if (ctx.blank) {
            this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
            this.refreshChangedFiles(ctx);
            return;
        }
        let sid = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
        if (sid) {
            for (const other of this.sessions) {
                if (other !== ctx && other.sessionId === sid) {
                    sid = undefined;
                    break;
                }
            }
        }
        if (sid && this.store.findFile(sid)) {
            ctx.sessionId = sid;
            ctx.checkpoints.setSession(sid);
            this.loadSessionInto(ctx, sid);
        }
        else {
            this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
            this.refreshChangedFiles(ctx);
        }
    }
    private loadSessionInto(ctx: SessionCtx, sid: string): void {
        void this.store.hydrate(sid).then(() => { if (ctx.sessionId === sid)
            this.renderSessionInto(ctx, sid); }).catch(e => this.post(ctx, { kind: "error", message: `读取历史失败：${String(e)}` }));
    }
    private renderSessionInto(ctx: SessionCtx, sid: string): void {
        const items = this.store.load(sid);
        const checkpoints = this.checkpointsForView(ctx, sid);
        const points = ctx.checkpoints.list();
        const latest = points[points.length - 1];
        // 只补界面，不伪造服务端历史；重载后仍能找到未落盘提问的还原入口。
        if (latest && this.emptyInterruptedCheckpoint(ctx, latest.id)) {
            items.push({ type: "user", text: latest.userText });
            checkpoints.push(latest);
        }
        this.post(ctx, { kind: "load_history", items, sessionId: sid, checkpoints });
        this.maybePrespawn(ctx);
        if (ctx.proc?.isBusy) {
            this.post(ctx, { kind: "busy", busy: true });
            if (ctx.pendingPerm)
                this.post(ctx, ctx.pendingPerm);
        }
        this.refreshSessions();
        this.refreshChangedFiles(ctx);
    }
    private async newContext(ctx: SessionCtx, m: {
        text?: string;
        context?: string;
        images?: {
            mediaType: string;
            data: string;
        }[];
        files?: string[];
    }): Promise<void> {
        const old = ctx.sessionId;
        ctx.proc?.dispose();
        ctx.proc = undefined;
        ctx.starting = undefined;
        ctx.sessionId = undefined;
        ctx.blank = true;
        ctx.coldStart = false;
        ctx.pendingPerm = undefined;
        ctx.sendAt = undefined;
        ctx.lastEventAt = undefined;
        ctx.checkpoints.flush();
        ctx.checkpoints = new CheckpointManager(this.storageDir());
        this.output.appendLine(`[${new Date().toISOString()}] [clear] ${old?.slice(0, 8) ?? "空"} → 新上下文`);
        this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
        this.refreshChangedFiles(ctx);
        this.refreshSessions();
        if (m.text || m.images?.length) {
            await this.handleSend(ctx, m.text ?? "", m.context, m.images, m.files);
        }
    }
    private reportSnapshotSkips(ctx: SessionCtx, snapshot: WorkspaceSnapshot): void {
        const key = this.workspaceDirs().join("\0");
        const entries = [...snapshot.skipReasons.entries()].sort(([a], [b]) => a.localeCompare(b));
        this.snapshotWarningPaths.set(key, new Set(entries.map(([file]) => file)));
        if (!entries.length) { this.snapshotWarningSignatures.delete(key); return; }
        const signature = JSON.stringify(entries);
        if (this.snapshotWarningSignatures.get(key) === signature) return;
        this.snapshotWarningSignatures.set(key, signature);
        const names: Record<string, string> = { large: "超过 2 MB", binary: "二进制", limit: "扫描或容量上限", symlink: "符号链接", unreadable: "无法读取" };
        const details = entries.map(([file, reason]) => `${vscode.workspace.asRelativePath(file)}（${names[reason]}）`);
        this.output.appendLine(`[snapshot] 未纳入自动回滚快照 ${entries.length} 项：\n${details.join("\n")}`);
        this.post(ctx, { kind: "snapshot_skips", files: entries.slice(0, 20).map(([file, reason]) => ({ path: file, rel: vscode.workspace.asRelativePath(file), reason: names[reason] })), total: entries.length });
    }
    private async excludeSnapshotPaths(ctx: SessionCtx, paths?: string[], all?: boolean): Promise<void> {
        const key = this.workspaceDirs().join("\0");
        const warned = this.snapshotWarningPaths.get(key);
        const selected = all ? [...(warned ?? [])] : [...new Set(paths ?? [])];
        if (!warned || !selected.length || selected.some(file => !warned.has(file))) {
            this.post(ctx, { kind: "snapshot_exclude_result", ok: false, message: "快照清单已过期，请在下一轮重新选择。", paths: [] });
            return;
        }
        try {
            const byFolder = new Map<string, string[]>();
            for (const file of selected) {
                const folder = this.workspaceDirs().filter(root => file.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0];
                if (!folder) throw new Error("文件不在当前工作区中");
                const rel = path.relative(folder, file).split(path.sep).join("/");
                if (!byFolder.has(folder)) byFolder.set(folder, []);
                byFolder.get(folder)!.push(rel);
            }
            for (const [folder, rels] of byFolder) {
                const config = vscode.workspace.getConfiguration("codexChat", vscode.Uri.file(folder));
                const existing = config.get<string[]>("snapshotExclude", []);
                const next = [...new Set([...existing, ...rels])];
                const target = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder))
                    ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
                await config.update("snapshotExclude", next, target);
            }
            this.post(ctx, { kind: "snapshot_exclude_result", ok: true, message: `已排除 ${selected.length} 项，下一轮快照生效。`, paths: selected });
        } catch (err) {
            this.post(ctx, { kind: "snapshot_exclude_result", ok: false, message: `排除失败：${String(err)}`, paths: [] });
        }
    }
    private async handleSend(ctx: SessionCtx, text: string, context?: string, images?: {
        mediaType: string;
        data: string;
    }[], files?: string[]): Promise<void> {
        const prepareAt = Date.now();
        await ctx.finalizing;
        if (ctx.proc?.isBusy) {
            this.post(ctx, { kind: "error", message: "上一轮尚未结束，请稍后发送。" });
            return;
        }
        let attached = context;
        const mySeq = (ctx.sendSeq = (ctx.sendSeq ?? 0) + 1);
        if (files && files.length) {
            const fileCtx = this.buildFileContext(files);
            attached = attached ? `${fileCtx}\n\n${attached}` : fileCtx;
        }
        const hadSession = !!ctx.sessionId;
        ctx.mayHaveModifiedWorkspace = false;
        if (this.config().get<boolean>("autosave", true)) {
            const saved = await Promise.all(vscode.workspace.textDocuments.filter(d => d.isDirty && !d.isUntitled && vscode.workspace.getWorkspaceFolder(d.uri)).map(d => d.save()));
            if (saved.some(ok => !ok))
                throw new Error("部分文件未保存，已取消发送，避免覆盖编辑器改动。");
        }
        // Existing threads can reconnect while the local snapshot is captured.
        // Keep new-thread creation after the snapshot so Stop can still cancel it.
        const processReady = hadSession ? this.ensureProcess(ctx) : undefined;
        const historyReady = hadSession && ctx.sessionId ? this.store.hydrate(ctx.sessionId) : Promise.resolve();
        const snapshotReady = (async () => {
            if (!this.config().get<boolean>("snapshotFilesForRestore", true)) return;
            const roots = this.workspaceDirs();
            const excludes = new Map(roots.map(root => [root, vscode.workspace.getConfiguration("codexChat", vscode.Uri.file(root)).get<string[]>("snapshotExclude", [])]));
            const snapshot = new WorkspaceSnapshot(roots, 20000, excludes);
            const snapshotAt = Date.now();
            await snapshot.capture();
            ctx.snapshot = snapshot;
            this.output.appendLine(`[${new Date().toISOString()}] [snapshot] 基线 ${snapshot.files.size} 文件，跳过 ${snapshot.skipped.size} 项，耗时 ${Date.now() - snapshotAt}ms`);
            this.reportSnapshotSkips(ctx, snapshot);
        })();
        await Promise.all([historyReady, snapshotReady]);
        if ((ctx.stopSeq ?? -1) >= mySeq) {
            this.post(ctx, { kind: "busy", busy: false });
            return;
        }
        // A new thread is only durable after its first turn starts. Do not create
        // it during the (potentially slow) snapshot: Stop may cancel the send.
        const proc = processReady ? await processReady : await this.ensureProcess(ctx);
        if (!proc) {
            ctx.draft = text;
            ctx.draftImages = images;
            this.post(ctx, { kind: "draft", text, images });
            this.post(ctx, { kind: "busy", busy: false });
            return;
        }
        await this.modelSelectionQueue;
        await proc.setFastMode(this.config().get<boolean>("fastMode", false));
        if ((ctx.stopSeq ?? -1) >= mySeq || ctx.proc !== proc) {
            if (!hadSession && ctx.proc === proc) {
                ctx.proc = undefined;
                ctx.sessionId = undefined;
                ctx.blank = true;
                ctx.checkpoints.clear();
                void this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
                await proc.disposeAndWait();
            }
            this.post(ctx, { kind: "busy", busy: false });
            return;
        }
        if (proc.isBusy) {
            // 初始化可能刚恢复出待答问题，不能把“等待输入”误判为进程退出。
            ctx.draft = text;
            ctx.draftImages = images;
            this.post(ctx, { kind: "draft", text, images });
            this.post(ctx, { kind: "notice", message: "已恢复等待中的问题，请先提交答案；新消息已保留为草稿。" });
            return;
        }
        const lineBefore = ctx.sessionId ? this.store.countLines(ctx.sessionId) : 0;
        if (!proc.sendUserMessage(text, attached, images)) {
            this.output.appendLine("[codex] send dropped: process not writable (exited mid-send)");
            if (ctx.proc === proc)
                ctx.proc = undefined;
            this.post(ctx, { kind: "error", message: "codex 进程已退出，本条消息未送出——请重新发送（会自动重启进程）。" });
            ctx.draft = text;
            ctx.draftImages = images;
            this.post(ctx, { kind: "draft", text, images });
            this.post(ctx, { kind: "busy", busy: false });
            return;
        }
        if (!hadSession && ctx.sessionId) {
            this.store.notePending(ctx.sessionId, text || "(图片)");
            this.renderSessions();
        }
        ctx.draft = undefined;
        ctx.draftImages = undefined;
        ctx.sendAt = Date.now();
        ctx.lastEventAt = ctx.sendAt;
        ctx.lastUserText = (text || "(图片)").slice(0, 200);
        ctx.lastUserActionAt = ctx.sendAt;
        this.output.appendLine(`[${new Date().toISOString()}] [send] session=${ctx.sessionId?.slice(0, 8)} 准备${Date.now() - prepareAt}ms 正文${text.length}字 附加${attached?.length ?? 0}字 图片${images?.length ?? 0}`);
        const checkpointId = ctx.checkpoints.beginTurn(text || "(图片)", lineBefore);
        this.post(ctx, { kind: "checkpoint_marker", checkpointId, userText: text });
    }
    private async editMessage(ctx: SessionCtx, checkpointId: string, text: string, images?: {
        mediaType: string;
        data: string;
    }[]): Promise<void> {
        const rewindAt = Date.now();
        const meta = checkpointId ? this.cpMeta(ctx, checkpointId) : undefined;
        if (!meta) {
            this.post(ctx, {
                kind: "error",
                message: checkpointId ? "找不到该还原点（可能已被清理），无法重新生成。" : "这条消息没有还原点，无法重新生成。",
            });
            this.post(ctx, { kind: "busy", busy: false });
            this.loadCtxSession(ctx);
            return;
        }
        if (ctx.sessionId && !this.checkpointAligned(ctx.sessionId, meta)) {
            this.post(ctx, { kind: "error", message: "还原点与当前对话不匹配，无法重新生成。" });
            this.post(ctx, { kind: "busy", busy: false });
            this.loadCtxSession(ctx);
            return;
        }
        this.post(ctx, { kind: "restoring" });
        while (ctx.proc) {
            const dying = ctx.proc;
            ctx.proc = undefined;
            ctx.starting = undefined;
            await dying.disposeAndWait();
            await this.captureFinalSnapshot(ctx);
        }
        try {
            await this.forkRewind(ctx, checkpointId, meta.truncateLine);
        }
        catch (err) {
            this.output.appendLine(`[restore] 派生失败: ${String(err)}`);
            this.post(ctx, { kind: "error", message: `回退对话失败：${String(err)}` });
            this.post(ctx, { kind: "busy", busy: false });
            this.loadCtxSession(ctx);
            return;
        }
        this.refreshChangedFiles(ctx);
        this.output.appendLine(`[${new Date().toISOString()}] [rewind] 回退准备 ${Date.now() - rewindAt}ms`);
        await this.handleSend(ctx, text, undefined, images);
    }
    private async saveImage(dataUri: string): Promise<void> {
        const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(dataUri);
        if (!m)
            return;
        const ext = m[1] === "jpeg" ? "jpg" : m[1].replace(/[^a-z0-9]/gi, "") || "png";
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", `codex-image-${Date.now()}.${ext}`)),
            filters: { 图片: [ext] },
        });
        if (!uri)
            return;
        fs.writeFileSync(uri.fsPath, Buffer.from(m[2], "base64"));
        vscode.window.showInformationMessage(`图片已保存到 ${uri.fsPath}`);
    }
    private handlePermission(ctx: SessionCtx, requestId: string, behavior: "allow" | "deny", suggestionId?: string): void {
        if (!ctx.proc)
            return;
        ctx.proc.respondPermission(requestId, { behavior, suggestionId });
    }
    private async updateConfig(key: string, value: unknown): Promise<boolean> {
        const insp = this.config().inspect(key);
        const target = (key === "fastMode" && vscode.workspace.workspaceFolders?.length) || insp?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        try {
            await this.config().update(key, value, target);
            return true;
        }
        catch (err) {
            this.output.appendLine(`[updateConfig:${key}] ${String(err)}`);
            vscode.window.showWarningMessage(`无法保存设置 codexChat.${key}，请检查工作区设置是否只读。`);
            return false;
        }
    }
    private allProcs(): CodexProcess[] {
        const out: CodexProcess[] = [];
        for (const c of this.sessions)
            if (c.proc)
                out.push(c.proc);
        for (const c of this.detached.values())
            if (c.proc)
                out.push(c.proc);
        return out;
    }
    private modelCatalog: ModelChoice[] = [];
    private modelSelectionQueue: Promise<void> = Promise.resolve();
    private queueModelSelection(change: () => Promise<void>): Promise<void> {
        const task = this.modelSelectionQueue.then(change);
        this.modelSelectionQueue = task.catch(() => undefined);
        return task;
    }
    private broadcastModelConfig(): void {
        const cfg: ToWebview = {
            kind: "config",
            permissionMode: this.config().get<string>("permissionMode", "default"),
            model: this.config().get<string>("model", ""),
            effort: this.config().get<string>("effort", ""),
            fastMode: this.config().get<boolean>("fastMode", false),
        };
        for (const session of this.sessions) this.post(session, cfg);
    }
    private modeSeq = 0;
    private async setPermissionMode(_ctx: SessionCtx, mode: string): Promise<void> {
        const seq = ++this.modeSeq;
        const prev = this.config().get<string>("permissionMode", "default");
        await this.updateConfig("permissionMode", mode);
        if (seq !== this.modeSeq)
            return;
        const broadcast = (m: string): void => {
            const cfg: ToWebview = {
                kind: "config",
                permissionMode: m,
                model: this.config().get<string>("model", ""),
                effort: this.config().get<string>("effort", ""),
                fastMode: this.config().get<boolean>("fastMode", false),
                modEnterToSend: this.config().get<boolean>("modEnterToSend", false),
            };
            for (const c of this.sessions)
                this.post(c, cfg);
        };
        broadcast(mode);
        const results = await Promise.allSettled(this.allProcs().map((p) => p.setPermissionMode(mode)));
        if (seq !== this.modeSeq)
            return;
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (!rejected.length)
            return;
        const raw = String((rejected[0].reason as Error)?.message ?? rejected[0].reason ?? "").trim();
        const why = raw || "Codex 拒绝了这次切换";
        if (rejected.length === results.length) {
            await this.updateConfig("permissionMode", prev);
            if (seq !== this.modeSeq)
                return;
            broadcast(prev);
            this.post(_ctx, { kind: "error", message: `无法切换到「${MODE_NAMES[mode] ?? mode}」：${why}。已切回「${MODE_NAMES[prev] ?? prev}」。` });
            return;
        }
        this.post(_ctx, { kind: "error", message: `有 ${rejected.length} 个会话未能切换到「${MODE_NAMES[mode] ?? mode}」：${why}。` });
    }
    private setModel(ctx: SessionCtx, model: string): Promise<void> {
        return this.queueModelSelection(async () => {
            const previousModel = this.config().get<string>("model", "");
            if (!await this.updateConfig("model", model)) {
                this.broadcastModelConfig();
                return;
            }
            const details = this.modelCatalog.find(m => m.id === model) ?? (model === "" ? this.modelCatalog.find(m => m.isDefault) : undefined);
            const oldEffort = this.config().get<string>("effort", "");
            if (oldEffort && details?.efforts.length && !details.efforts.includes(oldEffort)) {
                if (!await this.updateConfig("effort", "")) {
                    await this.updateConfig("model", previousModel);
                    this.broadcastModelConfig();
                    return;
                }
                await Promise.all(this.allProcs().map(p => p.setEffort("")));
                this.post(ctx, { kind: "notice", message: `新模型不支持原推理强度，已改用模型默认值。` });
            }
            const results = await Promise.allSettled(this.allProcs().map((p) => p.setModel(model)));
            this.broadcastModelConfig();
            const failed = results.filter((r) => r.status === "rejected").length;
            if (failed) {
                this.post(ctx, { kind: "error", message: `有 ${failed} 个会话未能切换模型，请重试或新建会话。` });
            }
        });
    }
    private setFastMode(ctx: SessionCtx, enabled: boolean): Promise<void> {
        return this.queueModelSelection(async () => {
            if (typeof enabled !== "boolean") return;
            const model = this.config().get<string>("model", "");
            const details = this.modelCatalog.find(m => m.id === model);
            if (enabled && details?.fastModeSupported === false) {
                this.post(ctx, { kind: "error", message: "当前模型不支持快速模式，请先选择支持的模型。" });
                this.broadcastModelConfig();
                return;
            }
            if (await this.updateConfig("fastMode", enabled)) {
                await Promise.all(this.allProcs().map(p => p.setFastMode(enabled)));
                this.post(ctx, { kind: "notice", message: enabled
                    ? "已开启快速模式：下轮生效，适用于当前工作区各会话，额度消耗更高；不改变模型与推理强度。"
                    : "已关闭快速模式：下轮恢复普通速度。" });
            }
            this.broadcastModelConfig();
        });
    }
    private setEffort(ctx: SessionCtx, effort: string): Promise<void> {
        return this.queueModelSelection(async () => {
            const model = this.config().get<string>("model", "");
            const details = this.modelCatalog.find(m => m.id === model) ?? (model === "" ? this.modelCatalog.find(m => m.isDefault) : undefined);
            if (effort && details?.efforts.length && !details.efforts.includes(effort)) {
                this.post(ctx, { kind: "error", message: `当前模型不支持推理强度「${effort}」。` });
                this.broadcastModelConfig();
                return;
            }
            if (!await this.updateConfig("effort", effort)) {
                this.broadcastModelConfig();
                return;
            }
            await Promise.all(this.allProcs().map(p => p.setEffort(effort)));
            this.broadcastModelConfig();
        });
    }
    private codeColumn(ctx: SessionCtx): vscode.ViewColumn {
        return ctx.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    }
    private async openDiff(ctx: SessionCtx, absPath: string): Promise<void> {
        const original = ctx.checkpoints.originalOf(absPath);
        const rel = vscode.workspace.asRelativePath(absPath);
        const left = vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath });
        const exists = fs.existsSync(absPath);
        const right = exists
            ? vscode.Uri.file(absPath)
            : vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath, query: "empty" });
        const tag = original == null ? "新增" : exists ? "改动" : "删除";
        await vscode.commands.executeCommand("vscode.diff", left, right, `${rel} (Codex ${tag})`, {
            preview: true,
            viewColumn: this.codeColumn(ctx),
        });
        if (exists && typeof original === "string") {
            try {
                const current = fs.readFileSync(absPath, "utf8");
                const line = firstChangedLine(original, current);
                const ed = vscode.window.activeTextEditor;
                if (ed && line >= 0) {
                    const pos = new vscode.Position(line, 0);
                    ed.selection = new vscode.Selection(pos, pos);
                    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            }
            catch {
            }
        }
    }
    private revertFile(ctx: SessionCtx, absPath: string): void {
        if (ctx.proc?.isBusy || ctx.snapshot) { this.post(ctx, {kind: "notice", message: "请先停止当前任务，待文件快照完成后再回滚。"}); return; }
        if (vscode.workspace.textDocuments.some(d => d.uri.fsPath === absPath && d.isDirty)) { this.post(ctx, {kind: "notice", message: "该文件有未保存的编辑，请先保存或撤销编辑后再回滚。"}); return; }
        const base = ctx.checkpoints.originalOf(absPath);
        try {
            if (base === null) {
                if (fs.existsSync(absPath))
                    fs.unlinkSync(absPath);
            }
            else if (base !== undefined) {
                fs.mkdirSync(path.dirname(absPath), { recursive: true });
                fs.writeFileSync(absPath, base, "utf8");
            }
        }
        catch (err) {
            this.output.appendLine(`[revertFile] ${absPath}: ${String(err)}`);
        }
        ctx.checkpoints.accept(absPath);
        this.origChanged.fire(vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath }));
    }
    private async autosaveBefore(toolName: string, input: Record<string, unknown>): Promise<void> {
        if (!this.config().get<boolean>("autosave", true))
            return;
        const cwd = this.cwd();
        const want = new Set<string>();
        if (toolName === "Bash") {
            const cmd = typeof input.command === "string" ? input.command : "";
            if (!cmd)
                return;
            for (const p of bashWritePaths(cmd, cwd))
                want.add(p);
            for (const doc of vscode.workspace.textDocuments) {
                if (!doc.isDirty || doc.isUntitled)
                    continue;
                const fp = doc.uri.fsPath;
                const rel = path.relative(cwd, fp);
                if (cmd.includes(fp) || (rel && !rel.startsWith("..") && cmd.includes(rel)))
                    want.add(fp);
            }
        }
        else {
            for (const p of [input.file_path, input.notebook_path])
                if (typeof p === "string" && path.isAbsolute(p))
                    want.add(p);
        }
        if (!want.size)
            return;
        const saves = vscode.workspace.textDocuments
            .filter((d) => d.isDirty && !d.isUntitled && want.has(d.uri.fsPath))
            .map((d) => d.save().then(() => undefined, () => undefined));
        if (!saves.length)
            return;
        await Promise.race([Promise.all(saves), new Promise<void>((r) => setTimeout(r, 2000))]);
    }
    private refreshChangedFiles(ctx: SessionCtx): void {
        if (!this.alive(ctx))
            return;
        const { files, totalAdded, totalRemoved } = this.getChangedFiles(ctx);
        for (const f of files)
            this.origChanged.fire(vscode.Uri.from({ scheme: ORIG_SCHEME, path: f.path }));
        this.post(ctx, { kind: "changed_files", files, totalAdded, totalRemoved });
    }
    private getChangedFiles(ctx: SessionCtx): {
        files: ChangedFile[];
        totalAdded: number;
        totalRemoved: number;
    } {
        const files: ChangedFile[] = [];
        let totalAdded = 0;
        let totalRemoved = 0;
        for (const p of ctx.checkpoints.changedPaths()) {
            const original = ctx.checkpoints.originalOf(p);
            if (original === undefined)
                continue;
            const exists = fs.existsSync(p);
            let current = "";
            if (exists) {
                try {
                    current = fs.readFileSync(p, "utf8");
                }
                catch {
                    continue;
                }
            }
            const status: ChangedFile["status"] = original === null ? "added" : exists ? "modified" : "deleted";
            if (original === current) continue;
            const { added, removed } = diffCounts(original ?? "", current);
            if (added === 0 && removed === 0)
                continue;
            files.push({ path: p, rel: vscode.workspace.asRelativePath(p), added, removed, status });
            totalAdded += added;
            totalRemoved += removed;
        }
        files.sort((a, b) => a.rel.localeCompare(b.rel));
        return { files, totalAdded, totalRemoved };
    }
    private async forkCheckpoint(ctx: SessionCtx, checkpointId: string): Promise<void> {
        if (this.forking.has(ctx)) return;
        this.forking.add(ctx);
        try {
            await this.forkCheckpointInner(ctx, checkpointId);
        } finally {
            this.forking.delete(ctx);
        }
    }
    private async forkCheckpointInner(ctx: SessionCtx, checkpointId: string): Promise<void> {
        const sourceId = ctx.sessionId;
        const meta = this.cpMeta(ctx, checkpointId);
        const cut = meta?.truncateLine;
        if (cut === undefined || !sourceId) {
            this.post(ctx, { kind: "error", message: "找不到该还原点，无法派生。" });
            return;
        }
        if (cut <= 0) {
            this.post(ctx, { kind: "notice", message: "该点之前没有对话内容，无法派生新会话。" });
            return;
        }
        const preview = this.cpPreview(ctx, checkpointId);
        const confirm = await vscode.window.showWarningMessage("从此处派生新会话？", {
            modal: true,
            detail: (preview ? `消息：${preview.userText}\n\n` : "") +
                "将复制这条消息之前的对话开一个新会话（新标签页打开）。当前会话不受影响，两边此后各自独立。",
        }, "派生");
        if (confirm !== "派生")
            return;
        await ctx.finalizing;
        if (ctx.sessionId !== sourceId) {
            this.post(ctx, { kind: "error", message: "原会话已切换，请重新选择派生位置。" });
            return;
        }
        if (!this.checkpointAligned(sourceId, meta!)) {
            this.post(ctx, { kind: "error", message: "还原点与当前对话不匹配，已取消派生。" });
            return;
        }
        const leaf = this.store.rewindLeafFor(sourceId, cut);
        if (!leaf) {
            this.post(ctx, { kind: "error", message: "派生失败：该点之前没有可用对话。" });
            return;
        }
        ctx.checkpoints.flush();
        let newId: string;
        try {
            newId = await this.store.fork(sourceId, leaf);
        }
        catch (err) {
            this.output.appendLine(`[fork] ${String(err)}`);
            this.post(ctx, { kind: "error", message: `派生失败：${String(err)}` });
            return;
        }
        const copied = CheckpointManager.forkFor(this.storageDir(), sourceId, newId, cut, this.store.userTurnLines(newId));
        if (ctx.checkpoints.hasAny() && !copied) {
            try { await this.store.delete(newId); }
            finally { CheckpointManager.deleteFor(this.storageDir(), newId); }
            this.post(ctx, { kind: "error", message: "派生失败：复制文件还原点失败，原会话未受影响。" });
            return;
        }
        try {
            await this.openSession(newId);
        } catch (err) {
            this.output.appendLine(String(err));
            this.refreshSessions();
            this.post(ctx, { kind: "error", message: "派生会话已创建，但新窗口未能打开。可从会话历史中打开。" });
            return;
        }
        vscode.window.showInformationMessage("已从该点派生新会话，与原会话互不影响。");
    }
    private checkpointsForView(ctx: SessionCtx, sid: string): CheckpointSummary[] {
        const real = ctx.checkpoints.list();
        const turns = this.store.userTurnLines(sid);
        const norm = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 80);
        const assigned = new Map<number, CheckpointSummary>();
        let from = 0;
        for (const c of real) {
            for (let k = from; k < turns.length; k++) {
                const t = turns[k];
                const ok = c.userText === "(图片)" ? t.hasImages && !norm(t.text) : norm(t.text) === norm(c.userText);
                if (ok) {
                    ctx.checkpoints.alignTurn(c.id, t.line - 1);
                    assigned.set(k, c);
                    from = k + 1;
                    break;
                }
            }
        }
        const out: CheckpointSummary[] = [];
        turns.forEach((t, k) => {
            const c = assigned.get(k);
            if (c)
                out.push(c);
            else if (t.text)
                out.push({ id: `turn:${t.line}`, label: shortLabel(t.text), createdAt: 0, userText: t.text, fileCount: 0, synthetic: true });
        });
        return out;
    }
    private syntheticTurn(ctx: SessionCtx, checkpointId: string): {
        truncateLine: number;
        userText: string;
    } | undefined {
        if (!checkpointId.startsWith("turn:") || !ctx.sessionId)
            return undefined;
        const line = Number(checkpointId.slice(5));
        const t = this.store.userTurnLines(ctx.sessionId).find((x) => x.line === line);
        return t ? { truncateLine: line - 1, userText: t.text } : undefined;
    }
    private cpMeta(ctx: SessionCtx, checkpointId: string): {
        truncateLine: number;
        userText: string;
    } | undefined {
        return checkpointId.startsWith("turn:") ? this.syntheticTurn(ctx, checkpointId) : ctx.checkpoints.metaOf(checkpointId);
    }
    private checkpointAligned(sessionId: string, meta: { truncateLine: number; userText: string }): boolean {
        const target = this.store.firstUserTurnAfter(sessionId, meta.truncateLine);
        if (!target) return false;
        const norm = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 80);
        return meta.userText === "(图片)"
            ? target.images.length > 0 && !norm(target.text)
            : norm(target.text) === norm(meta.userText);
    }
    private emptyInterruptedCheckpoint(ctx: SessionCtx, checkpointId: string): boolean {
        if (!ctx.sessionId || ctx.proc?.isBusy || checkpointId.startsWith("turn:")) return false;
        const points = ctx.checkpoints.list();
        const latest = points[points.length - 1];
        const meta = ctx.checkpoints.metaOf(checkpointId);
        // 只能处理最后一个无文件改动的本地还原点，不能把任意失配放行。
        // 同一位置存在多个未落盘还原点时身份有歧义，仍交给原有保护拦截。
        return latest?.id === checkpointId && latest.fileCount === 0 && latest.userText !== "(图片)" && !!meta
            && (meta.truncateLine === 0 || points.length > 1)
            && points.slice(0, -1).every(p => ctx.checkpoints.cutLineOf(p.id)! < meta.truncateLine)
            && this.store.isEmptyInterruptedTail(ctx.sessionId, meta.truncateLine);
    }
    private cpPreview(ctx: SessionCtx, checkpointId: string): {
        userText: string;
    } | undefined {
        if (!checkpointId.startsWith("turn:"))
            return ctx.checkpoints.preview(checkpointId);
        const t = this.syntheticTurn(ctx, checkpointId);
        return t ? { userText: shortLabel(t.userText) } : undefined;
    }
    private cpRestore(ctx: SessionCtx, checkpointId: string, cutLine: number) {
        if (!checkpointId.startsWith("turn:"))
            return ctx.checkpoints.restore(checkpointId);
        const t = this.syntheticTurn(ctx, checkpointId);
        if (!t)
            return undefined;
        ctx.checkpoints.pruneFrom(cutLine);
        return { restoredFiles: 0, skipped: [] as string[], userText: t.userText, truncateLine: cutLine };
    }
    private async forkRewind(ctx: SessionCtx, checkpointId: string, cutLine: number): Promise<{
        result: NonNullable<ReturnType<CheckpointManager["restore"]>>;
        rewoundToStart: boolean;
    }> {
        const oldId = ctx.sessionId;
        // 回退文件时 CheckpointManager 会重写当前会话的快照。先保存原文件，
        // 让保留在历史列表里的原会话仍能使用自己的还原点。
        ctx.checkpoints.flush();
        const oldCheckpointFile = oldId ? path.join(this.storageDir(), `checkpoints-${oldId}.json`) : undefined;
        const oldCheckpoints = oldCheckpointFile && fs.existsSync(oldCheckpointFile) ? fs.readFileSync(oldCheckpointFile) : undefined;
        const preserveOldCheckpoints = () => {
            if (!oldCheckpointFile) return;
            if (oldCheckpoints) fs.writeFileSync(oldCheckpointFile, oldCheckpoints);
            else fs.rmSync(oldCheckpointFile, { force: true });
        };
        const hasEarlierTurn = !!oldId && cutLine > 0 && this.store.userTurnLines(oldId).some((t) => t.line <= cutLine);
        const leaf = hasEarlierTurn ? this.store.rewindLeafFor(oldId!, cutLine) : undefined;
        if (!oldId || !leaf) {
            let result: ReturnType<CheckpointManager["restore"]>;
            try { result = this.cpRestore(ctx, checkpointId, cutLine); }
            finally { preserveOldCheckpoints(); }
            if (!result)
                throw new Error("找不到该还原点");
            ctx.sessionId = undefined;
            ctx.checkpoints = new CheckpointManager(this.storageDir());
            if (this.context.workspaceState.get<string>(LAST_SESSION_KEY) === oldId)
                await this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
            return { result, rewoundToStart: true };
        }
        const newId = await this.store.fork(oldId, leaf);
        const copied = CheckpointManager.forkFor(this.storageDir(), oldId, newId, cutLine, this.store.userTurnLines(newId));
        if (ctx.checkpoints.hasAny() && !copied) {
            try { await this.store.delete(newId); }
            finally { CheckpointManager.deleteFor(this.storageDir(), newId); }
            throw new Error("复制文件还原点失败，原会话未受影响");
        }
        let result: ReturnType<CheckpointManager["restore"]>;
        try { result = this.cpRestore(ctx, checkpointId, cutLine); }
        finally { preserveOldCheckpoints(); }
        if (!result) {
            await this.store.delete(newId);
            CheckpointManager.deleteFor(this.storageDir(), newId);
            throw new Error("找不到该还原点");
        }
        ctx.checkpoints = new CheckpointManager(this.storageDir());
        ctx.checkpoints.setSession(newId);
        ctx.sessionId = newId;
        this.store.notePending(newId, this.store.userTurnLines(newId)[0]?.text || this.store.list().find(s => s.id === oldId)?.title || "派生会话");
        this.renderSessions();
        void this.context.workspaceState.update(LAST_SESSION_KEY, newId);
        const det = this.detached.get(oldId);
        if (det) {
            if (det.proc)
                await det.proc.disposeAndWait();
            this.detached.delete(oldId);
        }
        this.refreshSessions();
        this.output.appendLine(`[restore] ${oldId.slice(0, 8)} → 派生 ${newId.slice(0, 8)}（原会话保留，回退点 ${leaf.slice(0, 8)}，还原点 ${ctx.checkpoints.list().length} 个）`);
        return { result, rewoundToStart: false };
    }
    private async restoreCheckpoint(ctx: SessionCtx, checkpointId: string): Promise<void> {
        if (this.restoring.has(ctx)) return;
        this.restoring.add(ctx);
        try {
            await this.restoreCheckpointInner(ctx, checkpointId);
        } finally {
            this.restoring.delete(ctx);
        }
    }
    private async restoreCheckpointInner(ctx: SessionCtx, checkpointId: string): Promise<void> {
        const sourceId = ctx.sessionId;
        const preview = this.cpPreview(ctx, checkpointId);
        const confirm = await vscode.window.showWarningMessage("还原到这条消息之前？", {
            modal: true,
            detail: (preview ? `消息：${preview.userText}\n\n` : "") +
                (checkpointId.startsWith("turn:")
                    ? "当前窗口会从这里开新分支，原会话保留在历史中。这一轮不是从本插件发出的，没有文件快照：只回退对话，工作区文件保持现状。"
                    : "将回滚此后的文件改动，并从这里开新分支；原会话保留在历史中。文件回滚不可撤销。") +
                (ctx.proc?.isBusy ? "\n\nCodex 正在回复中，还原会先自动停止本轮。" : ""),
        }, "还原");
        if (confirm !== "还原")
            return;
        if (!sourceId || ctx.sessionId !== sourceId) {
            this.post(ctx, { kind: "error", message: "原会话已切换，请重新选择还原位置。" });
            return;
        }
        await this.store.hydrate(sourceId);
        if (ctx.sessionId !== sourceId) return;
        this.checkpointsForView(ctx, sourceId);
        const meta = this.cpMeta(ctx, checkpointId);
        if (!meta) {
            this.post(ctx, { kind: "error", message: "找不到该还原点。" });
            return;
        }
        const nextTurn = ctx.sessionId
            ? this.store.firstUserTurnAfter(ctx.sessionId, meta.truncateLine)
            : undefined;
        if (!ctx.sessionId || (!this.checkpointAligned(ctx.sessionId, meta)
            && !this.emptyInterruptedCheckpoint(ctx, checkpointId))) {
            this.output.appendLine(`[restore] 中止：还原点与 transcript 对不上 truncateLine=${meta.truncateLine}`);
            this.post(ctx, {
                kind: "error",
                message: "还原点对应的消息未能在当前会话历史中确认，已中止还原以免误删上下文。",
            });
            return;
        }
        const wasLive = !!ctx.proc?.isBusy;
        this.post(ctx, { kind: "restoring" });
        while (ctx.proc) {
            const dying = ctx.proc;
            ctx.proc = undefined;
            ctx.starting = undefined;
            await dying.disposeAndWait();
            await this.captureFinalSnapshot(ctx);
        }
        this.post(ctx, { kind: "busy", busy: false });
        let rewind: {
            result: NonNullable<ReturnType<CheckpointManager["restore"]>>;
            rewoundToStart: boolean;
        };
        try {
            rewind = await this.forkRewind(ctx, checkpointId, meta.truncateLine);
        }
        catch (err) {
            this.output.appendLine(`[restore] 派生失败: ${String(err)}`);
            this.post(ctx, { kind: "error", message: `还原未完成：${String(err)}。请检查当前文件和会话状态。` });
            return;
        }
        const { result, rewoundToStart } = rewind;
        this.output.appendLine(`[restore] truncateLine=${result.truncateLine} 还原文件=${result.restoredFiles} 自动停止=${wasLive ? "是" : "否"} ` +
            `${rewoundToStart ? "→ 回到开头，转为新对话（原会话保留）" : `→ 已派生 ${ctx.sessionId?.slice(0, 8)}（原会话保留）`}`);
        if (rewoundToStart) {
            this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
        }
        else {
            const items = this.store.load(ctx.sessionId!);
            this.post(ctx, { kind: "load_history", items, sessionId: ctx.sessionId, checkpoints: this.checkpointsForView(ctx, ctx.sessionId!) });
        }
        const skippedNote = result.skipped.length
            ? `⚠️ ${result.skipped.length} 个文件因过大或为二进制无法还原：${result.skipped.map((p) => path.basename(p)).join("、")}。`
            : "";
        this.post(ctx, {
            kind: "notice",
            message: `${wasLive ? "已自动停止进行中的回复。" : ""}` +
                `已还原 ${result.restoredFiles} 个文件，并从这条消息之前继续。原会话保留在历史中。${skippedNote}`,
        });
        const draftText = result.userText === "(图片)" ? "" : result.userText;
        const draftImages = nextTurn?.images.length ? nextTurn.images : undefined;
        if (draftText || draftImages) {
            ctx.draft = draftText;
            ctx.draftImages = draftImages;
            this.post(ctx, { kind: "draft", text: draftText, images: draftImages });
        }
        this.refreshChangedFiles(ctx);
    }
    private ensureProcess(ctx: SessionCtx): Promise<CodexProcess | undefined> {
        if (ctx.starting)
            return ctx.starting;
        if (ctx.proc?.isExited) {
            this.output.appendLine("[codex] discarding exited process, respawning");
            ctx.proc = undefined;
        }
        if (ctx.proc)
            return Promise.resolve(ctx.proc);
        ctx.starting = this.spawnProcess(ctx).finally(() => {
            ctx.starting = undefined;
        });
        return ctx.starting;
    }
    private async spawnProcess(ctx: SessionCtx): Promise<CodexProcess | undefined> {
        const isResume = !!ctx.sessionId;
        const sessionId = ctx.sessionId ?? randomUUID();
        if (!isResume) {
            ctx.sessionId = sessionId;
            ctx.checkpoints.setSession(sessionId);
        }
        const proc = new CodexProcess({
            questionStateDir: this.storageDir(),
            codexPath: this.config().get<string>("codexPath", "codex"),
            cwd: this.cwd(),
            model: this.config().get<string>("model", "") || undefined,
            effort: this.config().get<string>("effort", "") || undefined,
            fastMode: this.config().get<boolean>("fastMode", false),
            permissionMode: this.config().get<string>("permissionMode", "default"),
            resumeSessionId: isResume ? sessionId : undefined,
            addDirs: this.workspaceDirs(),
            appendSystemPrompt: this.config().get<string>("appendSystemPrompt", "") || undefined,
        }, {
            emit: (e) => this.handleEmit(ctx, e),
            onPreTool: (name, input) => this.autosaveBefore(name, input),
            onPermission: (req) => this.onPermission(ctx, req),
            onSessionId: (id, resumed) => this.onSessionId(ctx, id, resumed),
            onClose: (code) => this.onProcessClose(ctx, code, proc),
        });
        ctx.proc = proc;
        const t0 = Date.now();
        try {
            await proc.start();
            this.output.appendLine(`[codex] spawned+initialized in ${Date.now() - t0}ms (resume=${isResume})`);
        }
        catch (err) {
            proc.dispose();
            if (ctx.proc !== proc)
                return undefined;
            const raw = String(err);
            if (isResume && /session\s+\S+\s+is archived/i.test(raw)) {
                this.output.appendLine(`[codex] 归档会话 ${sessionId.slice(0, 8)} 无法恢复，切换到新会话`);
                ctx.proc = undefined;
                ctx.sessionId = undefined;
                ctx.blank = true;
                ctx.checkpoints.clear();
                ctx.checkpoints = new CheckpointManager(this.storageDir());
                if (this.context.workspaceState.get<string>(LAST_SESSION_KEY) === sessionId)
                    await this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
                this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
                this.post(ctx, { kind: "notice", message: "原会话已归档，已切换到空白会话。输入内容已保留，请重新发送。" });
                this.refreshSessions();
                return undefined;
            }
            const hint = /not found|ENOENT|no such file/i.test(raw)
                ? `\n请检查设置 codexChat.codexPath，或确认 \`codex\` 在 PATH 中（终端里 \`codex --version\` 能跑通）。`
                : "";
            this.post(ctx, { kind: "error", message: `初始化 codex 失败: ${raw}${hint}` });
            ctx.proc = undefined;
            if (!isResume)
                ctx.sessionId = undefined;
            return undefined;
        }
        return proc;
    }
    private maybePrespawn(ctx: SessionCtx): void {
        if (!this.config().get<boolean>("prespawnOnOpen", true) && !(ctx.sessionId && fs.existsSync(questionStateFile(this.storageDir(), ctx.sessionId))))
            return;
        if (!ctx.sessionId)
            return;
        if (ctx.proc || ctx.starting)
            return;
        void this.ensureProcess(ctx);
    }
    private async compactSession(ctx: SessionCtx): Promise<void> {
        if (!this.alive(ctx)) {
            vscode.window.showInformationMessage("该会话的窗口已关闭，请重新打开会话后再压缩。");
            return;
        }
        if (ctx.proc?.isBusy) {
            vscode.window.showInformationMessage("当前会话正在回复中，等这一轮结束再压缩。");
            return;
        }
        const proc = await this.ensureProcess(ctx);
        if (!proc) {
            this.post(ctx, { kind: "busy", busy: false });
            vscode.window.showErrorMessage("启动 Codex 失败，无法压缩。");
            return;
        }
        if (!this.alive(ctx)) {
            vscode.window.showInformationMessage("会话窗口已关闭，本次压缩已取消。");
            return;
        }
        this.post(ctx, { kind: "busy", busy: true });
        proc.compact();
        ctx.lastEventAt = Date.now();
    }
    private static readonly PINNED_KEY = "codexChat.pinnedSessions";
    private pinnedSet(): Set<string> {
        return new Set(this.context.globalState.get<string[]>(ChatViewProvider.PINNED_KEY) ?? []);
    }
    private withPinned(list: SessionSummary[]): SessionSummary[] {
        const pinned = this.pinnedSet();
        return list.map((s) => (pinned.has(s.id) ? { ...s, pinned: true } : s));
    }
    private async setPinned(sessionId: string, pinned: boolean): Promise<void> {
        const set = this.pinnedSet();
        if (pinned)
            set.add(sessionId);
        else
            set.delete(sessionId);
        await this.context.globalState.update(ChatViewProvider.PINNED_KEY, [...set]);
        this.refreshSessions();
    }
    showNotifyConfig(): void {
        if (this.notifyPanel) {
            this.notifyPanel.reveal();
            this.postNotifyConfig();
            return;
        }
        const panel = vscode.window.createWebviewPanel("codex-chat.notify", "任务推送", { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
        this.notifyPanel = panel;
        panel.webview.html = this.notifyHtml();
        panel.webview.onDidReceiveMessage(async (m: FromWebview) => {
            try {
                switch (m.type) {
                    case "webviewError":
                        this.output.appendLine(`[${new Date().toISOString()}] [webview] 推送面板脚本错误: ${m.message}`);
                        break;
                    case "notifyLoad":
                        this.postNotifyConfig();
                        break;
                    case "notifySave": {
                        const cfg = vscode.workspace.getConfiguration("codexChat");
                        await cfg.update("notifyWebhook", m.webhook.trim(), vscode.ConfigurationTarget.Global);
                        await cfg.update("notifyMinDurationSec", Math.max(0, Math.round(m.minSec) || 0), vscode.ConfigurationTarget.Global);
                        panel.webview.postMessage({ kind: "notify_result", ok: true, message: "已保存。" } satisfies ToWebview);
                        break;
                    }
                    case "notifyTest": {
                        const url = m.webhook.trim();
                        if (!url) {
                            panel.webview.postMessage({ kind: "notify_result", ok: false, message: "请先填写 webhook 地址。" } satisfies ToWebview);
                            break;
                        }
                        const r = await this.sendWebhook(url, "🔔 Codex Copilot 推送测试：webhook 配置成功。", { test: true });
                        panel.webview.postMessage({
                            kind: "notify_result",
                            ok: r.ok,
                            message: r.ok ? `测试消息已发出（HTTP ${r.status}），请到群里确认。` : `发送失败：${r.error}`,
                        } satisfies ToWebview);
                        break;
                    }
                }
            }
            catch (err) {
                this.output.appendLine(`[notify] 面板消息处理失败(${m.type}): ${String(err)}`);
            }
        });
        const cfgSub = vscode.workspace.onDidChangeConfiguration((ev) => {
            if (ev.affectsConfiguration("codexChat.notifyWebhook") || ev.affectsConfiguration("codexChat.notifyMinDurationSec")) {
                this.postNotifyConfig();
            }
        });
        panel.onDidDispose(() => {
            cfgSub.dispose();
            if (this.notifyPanel === panel)
                this.notifyPanel = undefined;
        });
    }
    private postNotifyConfig(): void {
        const cfg = vscode.workspace.getConfiguration("codexChat");
        this.notifyPanel?.webview.postMessage({
            kind: "notify_config",
            webhook: cfg.get<string>("notifyWebhook") ?? "",
            minSec: cfg.get<number>("notifyMinDurationSec") ?? 60,
        } satisfies ToWebview);
    }
    private notifyHtml(): string {
        const nonce = randomUUID().replace(/-/g, "");
        return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; justify-content: center; }
  .wrap { width: 100%; max-width: 560px; padding: 24px 20px 40px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 16px; }
  label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
  label.f > span { font-weight: 600; opacity: .85; }
  input[type=text], input[type=number] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,.35)); border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 12.5px; }
  input:focus { outline: none; border-color: var(--vscode-focusBorder, #3794ff); }
  .status { font-size: 12px; line-height: 1.6; padding: 7px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-all;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); }
  .status.hidden { display: none; }
  .status.ok { color: #3fb950; }
  .status.err { color: var(--vscode-errorForeground, #e5534b); }
  .acts { display: flex; gap: 10px; }
  button.btn { flex: 1; padding: 7px 0; font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 6px;
    border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); background: none; color: var(--vscode-foreground); }
  button.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button.btn:hover { filter: brightness(1.1); }
  .sub { font-size: 11px; opacity: .65; line-height: 1.7; }
</style>
</head>
<body>
<div class="wrap">
  <h2>🔔 任务推送</h2>
  <div class="sub">长任务跑完时向 webhook 推一条通知：任务耗时达到阈值即推送。Codex 停下来等你输入（工具授权 / 选项提问）且你离开超过同一阈值时，也会推一条「等你输入」。</div>
  <label class="f"><span>Webhook 地址</span><input id="webhook" type="text" spellcheck="false" placeholder="飞书/企业微信/钉钉群机器人的 webhook，或任意接收 JSON 的地址" /></label>
  <label class="f"><span>耗时阈值（秒）</span><input id="minsec" type="number" min="0" step="10" placeholder="60" /></label>
  <div id="status" class="status hidden"></div>
  <div class="acts">
    <button id="test" class="btn">发送测试消息</button>
    <button id="save" class="btn primary">保存</button>
  </div>
  <div class="sub">飞书 / 企业微信 / 钉钉的群机器人按域名自动适配报文格式，直接收到文本；其他地址收到通用 JSON：{ text, isError, durationMs, project, question }（等待输入的推送另带 waiting:true 与 ask）。配置与 VS Code 设置（codexChat.notifyWebhook / notifyMinDurationSec）互通。</div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener("error", (e) => {
    try { vscode.postMessage({ type: "webviewError", message: (e.message || "?") + " @notify:" + e.lineno }); } catch {}
  });
  const $ = (id) => document.getElementById(id);
  function status(text, kind) {
    const el = $("status");
    el.textContent = text || "";
    el.className = "status" + (text ? "" : " hidden") + (kind ? " " + kind : "");
  }
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.kind === "notify_config") {
      $("webhook").value = m.webhook || "";
      $("minsec").value = m.minSec;
    } else if (m.kind === "notify_result") {
      status(m.message, m.ok ? "ok" : "err");
    }
  });
  $("save").addEventListener("click", () => {
    // 阈值留空按默认 60 处理——空值存成 0 会变成"任何时长都推"，与占位符暗示不符
    const raw = $("minsec").value.trim();
    vscode.postMessage({ type: "notifySave", webhook: $("webhook").value, minSec: raw === "" ? 60 : Number(raw) });
  });
  $("test").addEventListener("click", () => {
    status("发送中…");
    vscode.postMessage({ type: "notifyTest", webhook: $("webhook").value });
  });
  vscode.postMessage({ type: "notifyLoad" });
</script>
</body>
</html>`;
    }
    private turnStallMs(): number {
        const min = 60000;
        const v = this.config().get<number>("turnStallTimeoutSec", 720) * 1000;
        return Number.isFinite(v) && v >= min ? v : 720000;
    }
    private checkTurnStall(ctx: SessionCtx): void {
        const last = ctx.lastEventAt;
        if (last === undefined)
            return;
        if (ctx.pendingPerm)
            return;
        const idle = Date.now() - last;
        if (idle < this.turnStallMs())
            return;
        ctx.lastEventAt = undefined;
        ctx.sendAt = undefined;
        this.output.appendLine(`[${new Date().toISOString()}] [stall] session=${ctx.sessionId?.slice(0, 8)} CLI 静默 ${Math.round(idle / 1000)}s，判定卡死，丢弃进程`);
        try {
            ctx.proc?.dispose();
        }
        catch {
        }
        ctx.proc = undefined;
        ctx.starting = undefined;
        if (!this.alive(ctx) && ctx.sessionId && this.detached.get(ctx.sessionId) === ctx) {
            ctx.checkpoints.flush();
            this.detached.delete(ctx.sessionId);
        }
        this.post(ctx, {
            kind: "error",
            message: `Codex 已 ${Math.round(idle / 60000)} 分钟没有任何响应，判定为卡死并已重置连接。请重新发送这条消息（上下文不会丢失）。`,
        });
        this.post(ctx, { kind: "busy", busy: false });
        this.broadcastRunning();
    }
    private alive(ctx: SessionCtx): boolean {
        return this.sessions.has(ctx);
    }
    private async captureFinalSnapshot(ctx: SessionCtx): Promise<void> {
        await ctx.finalizing;
        if (!ctx.snapshot)
            return;
        if (ctx.mayHaveModifiedWorkspace)
            for (const [file, original] of await ctx.snapshot.changed())
                ctx.checkpoints.recordSnapshot(file, original);
        ctx.snapshot = undefined;
        ctx.checkpoints.flush();
    }
    private handleEmit(ctx: SessionCtx, e: ToWebview): void {
        if (e.kind === "busy" && !e.busy)
            return;
        if (e.kind === "result") {
            ctx.finalizing = (async () => {
                try {
                    if (ctx.snapshot && ctx.mayHaveModifiedWorkspace)
                        for (const [file, original] of await ctx.snapshot.changed())
                            ctx.checkpoints.recordSnapshot(file, original);
                    ctx.snapshot = undefined;
                    ctx.checkpoints.flush();
                    if (ctx.mayHaveModifiedWorkspace) this.refreshChangedFiles(ctx);
                }
                catch (err) {
                    this.post(ctx, { kind: "notice", message: `会话或文件快照刷新失败：${String(err)}` });
                }
                this.handleEmitInner(ctx, { kind: "busy", busy: false });
                this.handleEmitInner(ctx, e);
            })();
            return;
        }
        this.handleEmitInner(ctx, e);
    }
    private handleEmitInner(ctx: SessionCtx, e: ToWebview): void {
        if (ctx.lastEventAt !== undefined)
            ctx.lastEventAt = Date.now();
        ctx.lastEmitAt = Date.now();
        if (e.kind === "tool_input" && ctx.snapshot) {
            const paths = Array.isArray(e.input.changes) ? e.input.changes.map((c: any) => c.path) : [e.input.file_path];
            for (const file of paths)
                if (typeof file === "string" && ctx.snapshot.files.has(file))
                    ctx.checkpoints.recordSnapshot(file, ctx.snapshot.files.get(file)!);
        }
        if (e.kind === "rate_limit" && (e.level === "warning" || (e.level === "exhausted" && e.modelScoped))) {
            const until = this.context.globalState.get<Record<string, number>>("codexChat.rateLimitDismissed")?.[e.limitLabel] ?? 0;
            if (Date.now() < until) {
                this.output.appendLine(`[${new Date().toISOString()}] [ratelimit] 「${e.limitLabel}」警告已被关闭，跳过（至 ${new Date(until).toLocaleString()}）`);
                return;
            }
        }
        if (e.kind === "diag") {
            this.output.appendLine(`[${new Date().toISOString()}] [diag] session=${ctx.sessionId?.slice(0, 8)} ${e.message}`);
            return;
        }
        if ((e.kind === "error" || e.kind === "notice") && (e as {
            message: string;
        }).message) {
            this.output.appendLine(`[${new Date().toISOString()}] [${e.kind}] ${(e as {
                message: string;
            }).message}`);
        }
        if (e.kind === "status" && e.label) {
            this.output.appendLine(`[${new Date().toISOString()}] [status] ${e.label}`);
        }
        if (ctx.sendAt &&
            (e.kind === "block_start" || e.kind === "text_delta" || e.kind === "thinking_delta" || e.kind === "context" || e.kind === "tokens")) {
            this.output.appendLine(`[${new Date().toISOString()}] [ttfb] session=${ctx.sessionId?.slice(0, 8)} 首个流事件延迟 ${Date.now() - ctx.sendAt}ms`);
            ctx.sendAt = undefined;
        }
        this.post(ctx, e);
        if (e.kind === "tool_input") {
            if (["Read", "WebSearch", "TodoWrite", "Skill"].includes(e.name))
                (ctx.readOnlyToolIds ??= new Set()).add(e.toolId);
            else
                ctx.mayHaveModifiedWorkspace = true;
        }
        if (e.kind === "permission_resolved" && ctx.pendingPerm?.kind === "permission_request" && ctx.pendingPerm.requestId === e.requestId) {
            ctx.pendingPerm = undefined;
        }
        if (e.kind === "busy")
            this.broadcastRunning();
        if (e.kind === "tool_result") {
            const readOnly = ctx.readOnlyToolIds?.delete(e.toolUseId);
            if (!readOnly) ctx.mayHaveModifiedWorkspace = true;
            if (!readOnly && !e.isError) this.refreshChangedFiles(ctx);
        }
        if (e.kind === "result") {
            ctx.readOnlyToolIds?.clear();
            ctx.sendAt = undefined;
            ctx.lastEventAt = undefined;
            ctx.pendingPerm = undefined;
            this.output.appendLine(`[${new Date().toISOString()}] [turn] session=${ctx.sessionId?.slice(0, 8)} 完成 ${e.durationMs}ms 轮次${e.numTurns}${e.isError ? " (出错)" : ""}`);
            if (ctx.sessionId)
                void this.store.hydrate(ctx.sessionId).catch(e => this.output.appendLine(String(e)));
            this.refreshSessions();
            this.fetchUsage();
            this.maybeNotifyTurnDone(ctx, e);
        }
    }
    private maybeNotifyTurnDone(ctx: SessionCtx, e: {
        durationMs?: number;
        isError: boolean;
    }): void {
        const lastText = ctx.lastUserText;
        ctx.lastUserText = undefined;
        if (!lastText)
            return;
        const cfg = vscode.workspace.getConfiguration("codexChat");
        const url = (cfg.get<string>("notifyWebhook") || "").trim();
        if (!url)
            return;
        const minSec = cfg.get<number>("notifyMinDurationSec") ?? 60;
        const dur = e.durationMs ?? 0;
        if (dur < minSec * 1000)
            return;
        const mins = Math.floor(dur / 60000);
        const secs = Math.round((dur % 60000) / 1000);
        const durText = mins ? `${mins} 分 ${secs} 秒` : `${secs} 秒`;
        const proj = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
        const q = lastText.replace(/\s+/g, " ").slice(0, 80);
        const msg = `${e.isError ? "⚠️ Codex 任务出错" : "✅ Codex 任务完成"}（耗时 ${durText}）` +
            `${proj ? `\n项目：${proj}` : ""}${q ? `\n提问：${q}` : ""}`;
        void this.sendWebhook(url, msg, { isError: e.isError, durationMs: dur, project: proj, question: q }).then((r) => this.output.appendLine(`[${new Date().toISOString()}] [notify] ${r.ok ? `webhook HTTP ${r.status}` : `webhook 失败: ${r.error}`}`));
    }
    private maybeNotifyWaiting(ctx: SessionCtx, req: PermissionRequest): void {
        const cfg = vscode.workspace.getConfiguration("codexChat");
        const url = (cfg.get<string>("notifyWebhook") || "").trim();
        if (!url)
            return;
        const minSec = cfg.get<number>("notifyMinDurationSec") ?? 60;
        const since = ctx.lastUserActionAt ?? Date.now();
        const delay = Math.max(0, minSec * 1000 - (Date.now() - since));
        const proc = ctx.proc;
        setTimeout(() => {
            if (ctx.proc !== proc)
                return;
            const pend = ctx.pendingPerm;
            if (pend?.kind !== "permission_request" || pend.requestId !== req.requestId)
                return;
            const waited = Date.now() - (ctx.lastUserActionAt ?? since);
            const mins = Math.floor(waited / 60000);
            const secs = Math.round((waited % 60000) / 1000);
            const durText = mins ? `${mins} 分 ${secs} 秒` : `${secs} 秒`;
            const proj = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
            const q = (ctx.lastUserText ?? "").replace(/\s+/g, " ").slice(0, 80);
            let ask: string;
            if (req.toolName === "AskUserQuestion") {
                const qs = (req.input as {
                    questions?: {
                        question?: string;
                    }[];
                } | undefined)?.questions;
                const first = (qs?.[0]?.question ?? "").replace(/\s+/g, " ").slice(0, 80);
                ask = `待回答：${first || "（选项提问）"}${qs && qs.length > 1 ? `（共 ${qs.length} 问）` : ""}`;
            }
            else {
                ask = `待授权：${req.displayName || req.toolName}`;
            }
            const msg = `⏳ Codex 正在等你输入（距上次操作 ${durText}）` +
                `${proj ? `\n项目：${proj}` : ""}\n${ask}${q ? `\n本轮提问：${q}` : ""}`;
            void this.sendWebhook(url, msg, { waiting: true, project: proj, question: q, ask }).then((r) => this.output.appendLine(`[${new Date().toISOString()}] [notify] ${r.ok ? `等待输入推送 HTTP ${r.status}` : `等待输入推送失败: ${r.error}`}`));
        }, delay);
    }
    private async sendWebhook(url: string, msg: string, extra: Record<string, unknown> = {}): Promise<{
        ok: boolean;
        status?: number;
        error?: string;
    }> {
        let payload: unknown;
        if (/open\.feishu\.cn|open\.larksuite\.com/.test(url))
            payload = { msg_type: "text", content: { text: msg } };
        else if (/qyapi\.weixin\.qq\.com|oapi\.dingtalk\.com/.test(url))
            payload = { msgtype: "text", text: { content: msg } };
        else
            payload = { source: "codex-chat", text: msg, ...extra };
        try {
            const r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            return { ok: r.ok, status: r.status, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) };
        }
        catch (err) {
            return { ok: false, error: String((err as Error)?.message ?? err) };
        }
    }
    private runningIds(): string[] {
        const ids: string[] = [];
        for (const ctx of this.sessions)
            if (ctx.proc?.isBusy && ctx.sessionId)
                ids.push(ctx.sessionId);
        for (const ctx of this.detached.values())
            if (ctx.proc?.isBusy && ctx.sessionId)
                ids.push(ctx.sessionId);
        return ids;
    }
    private broadcastRunning(): void {
        try {
            this.view?.webview.postMessage({ kind: "running", sessionIds: this.runningIds() } satisfies ToWebview);
        }
        catch {
        }
    }
    private fetchUsage(force = false): void {
        if (this.usageInFlight || (!force && Date.now() - this.lastUsageAt < 90000))
            return;
        this.usageInFlight = true;
        this.lastUsageAt = Date.now();
        void this.store.read("account/rateLimits/read").then(r => {
            this.lastUsage = usageView(r.rateLimits);
            for (const ctx of this.sessions)
                for (const event of quotaEvents(r.rateLimits)) this.handleEmit(ctx, event);
        }).catch(e => this.output.appendLine(`[usage] ${String(e)}`)).finally(() => { this.usageInFlight = false; });
    }
    private onPermission(ctx: SessionCtx, req: PermissionRequest): void {
        if (req.toolName === "AskUserQuestion") {
            ctx.pendingQuestionAt = Date.now();
            this.output.appendLine(`[${new Date().toISOString()}] [question] 收到提问，距本轮发送 ${ctx.sendAt === undefined ? "未知" : `${Date.now() - ctx.sendAt}ms`}`);
        }
        const msg: ToWebview = {
            kind: "permission_request",
            requestId: req.requestId,
            toolUseId: req.toolUseId,
            toolName: req.toolName,
            displayName: req.displayName,
            input: req.input,
            description: req.description,
            suggestions: req.suggestions,
        };
        ctx.pendingPerm = msg;
        if (this.alive(ctx))
            this.post(ctx, msg);
        this.maybeNotifyWaiting(ctx, req);
    }
    private onSessionId(ctx: SessionCtx, id: string, resumed: boolean): void {
        const isNew = ctx.sessionId !== id;
        ctx.blank = false;
        ctx.sessionId = id;
        ctx.checkpoints.setSession(id);
        void this.context.workspaceState.update(LAST_SESSION_KEY, id);
        if (!resumed || isNew) {
            this.refreshSessions();
        }
    }
    private onProcessClose(ctx: SessionCtx, code: number | null, proc: CodexProcess): void {
        this.output.appendLine(`[codex] process closed (code ${code})`);
        if (ctx.proc !== proc)
            return;
        ctx.proc = undefined;
        ctx.lastEventAt = undefined;
        if (!this.alive(ctx) && ctx.sessionId) {
            this.detached.delete(ctx.sessionId);
        }
        else {
            this.post(ctx, { kind: "busy", busy: false });
        }
        this.broadcastRunning();
    }
    private async deleteSessions(ids: string[]): Promise<void> {
        if (!ids.length)
            return;
        const detail = ids.length === 1
            ? `会话「${this.store.list().find((s) => s.id === ids[0])?.title ?? ids[0]}」将被永久删除。`
            : `选中的 ${ids.length} 个会话将被永久删除。`;
        const ok = await vscode.window.showWarningMessage("删除会话？此操作不可撤销。", { modal: true, detail }, "删除");
        if (ok !== "删除")
            return;
        for (const id of ids) {
            const waits: Promise<void>[] = [];
            for (const ctx of [...this.sessions]) {
                if (ctx.sessionId === id) {
                    this.sessions.delete(ctx);
                    if (this.activeCtx === ctx)
                        this.activeCtx = undefined;
                    if (ctx.proc)
                        waits.push(ctx.proc.disposeAndWait());
                    ctx.proc = undefined;
                    ctx.panel.dispose();
                }
            }
            const det = this.detached.get(id);
            if (det) {
                if (det.proc)
                    waits.push(det.proc.disposeAndWait());
                this.detached.delete(id);
            }
            if (waits.length)
                await Promise.all(waits);
            await this.store.delete(id);
            deleteQuestionState(this.storageDir(), id);
            CheckpointManager.deleteFor(this.storageDir(), id);
        }
        this.broadcastRunning();
        this.refreshSessions();
    }
    private async renameSession(sessionId: string, title: string): Promise<void> {
        const clean = (title || "").trim().slice(0, 80);
        if (!(await this.store.setCustomTitle(sessionId, clean))) {
            vscode.window.showWarningMessage("重命名失败：找不到该会话的记录文件。");
            return;
        }
        this.refreshSessions();
    }
    private static readonly REPO_API = "https://api.github.com/repos/blackrock1121/vscode-codex/contents";
    async checkForUpdate(silent = false, quiet = silent): Promise<void> {
        const local = (this.context.extension.packageJSON.version as string) || "0.0.0";
        let remote = "";
        try {
            const pkg = await this.fetchRepoFile("package.json");
            remote = JSON.parse(pkg.toString("utf8")).version || "";
        }
        catch (err) {
            if (!quiet)
                vscode.window.showErrorMessage(`检查更新失败：${String((err as Error)?.message ?? err)}`);
            return;
        }
        if (!remote) {
            if (!quiet)
                vscode.window.showErrorMessage("检查更新失败：无法读取远程版本号");
            return;
        }
        if (cmpVersion(remote, local) <= 0) {
            this.installedPending = undefined;
            if (!quiet)
                vscode.window.showInformationMessage(`已是最新版本 v${local}`);
            return;
        }
        if (this.installedPending && cmpVersion(remote, this.installedPending) <= 0) {
            this.postUpdateDot();
            if (!quiet) {
                const reload = await vscode.window.showInformationMessage(`v${remote} 已安装，需重新加载窗口后生效。`, "重新加载");
                if (reload === "重新加载")
                    void vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
            return;
        }
        this.updateAvailable = remote;
        if (silent) {
            this.postUpdateDot();
            return;
        }
        const pick = await vscode.window.showInformationMessage(`发现新版本 v${remote}（当前 v${local}）`, "下载并安装", "取消");
        if (pick !== "下载并安装")
            return;
        try {
            const dest = path.join(os.tmpdir(), `codex-chat-${remote}.vsix`);
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在下载并安装 v${remote}…` }, async () => {
                const vsix = await this.fetchRepoFile("release/vscode-codex.vsix");
                fs.writeFileSync(dest, vsix);
                await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(dest));
            });
        }
        catch (err) {
            vscode.window.showErrorMessage(`更新失败：${String((err as Error)?.message ?? err)}`);
            return;
        }
        this.updateAvailable = undefined;
        this.installedPending = remote;
        this.postUpdateDot();
        const reload = await vscode.window.showInformationMessage(`已下载安装 v${remote}，必须重新加载窗口才会生效（在此之前仍显示旧版本，属正常现象）。`, "重新加载");
        if (reload === "重新加载")
            void vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    private async fetchRepoFile(repoPath: string): Promise<Buffer> {
        const url = `${ChatViewProvider.REPO_API}/${repoPath}?ref=main`;
        const json = await this.httpGetText(url);
        const obj = JSON.parse(json) as {
            content?: string;
            encoding?: string;
        };
        if (!obj.content)
            throw new Error("响应缺少内容");
        return Buffer.from(obj.content, (obj.encoding as BufferEncoding) || "base64");
    }
    private httpGetText(url: string, depth = 0): Promise<string> {
        return new Promise((resolve, reject) => {
            if (depth > 5)
                return reject(new Error("重定向次数过多"));
            const headers = { "User-Agent": "codex-chat", Accept: "application/vnd.github+json" };
            const req = https.get(url, { headers }, (res) => {
                const code = res.statusCode ?? 0;
                if (code >= 300 && code < 400 && res.headers.location) {
                    res.resume();
                    resolve(this.httpGetText(res.headers.location, depth + 1));
                    return;
                }
                if (code !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${code}`));
                    return;
                }
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (data += c));
                res.on("end", () => resolve(data));
            });
            req.on("error", reject);
            req.setTimeout(20000, () => req.destroy(new Error("请求超时")));
        });
    }
    private async resolveWorkspaceFile(p: string, interactive: boolean): Promise<string | undefined> {
        if (/^file:/i.test(p)) {
            try { p = vscode.Uri.parse(p).fsPath; }
            catch { return undefined; }
        }
        if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
        if (!p || /^[a-z][a-z\d+.-]*:/i.test(p)) return undefined;
        const direct = path.isAbsolute(p)
            ? [p]
            : [path.join(this.cwd(), p), ...this.workspaceDirs().map((d) => path.join(d, p))];
        for (const c of direct) {
            try {
                if (fs.statSync(c).isFile())
                    return c;
            }
            catch {
            }
        }
        // 绝对路径失效时不能退化为工作区中的同名文件，否则会跳错内容。
        if (path.isAbsolute(p)) return undefined;
        const base = p.split(/[\\/]/).pop() || "";
        if (!base)
            return undefined;
        let uris: vscode.Uri[];
        try {
            uris = await vscode.workspace.findFiles(`**/${base}`, "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/target/**,**/out/**}", 12);
        }
        catch {
            return undefined;
        }
        if (!uris.length)
            return undefined;
        const norm = "/" + path.normalize(p).replace(/\\/g, "/").replace(/^\.\//, "");
        const hasDir = p.includes("/") || p.includes("\\");
        const ranked = uris.map((u) => u.fsPath)
            .filter((f) => !hasDir || f.replace(/\\/g, "/").endsWith(norm))
            .sort((a, b) => a.length - b.length);
        if (!ranked.length) return undefined;
        if (ranked.length === 1 || !interactive)
            return ranked[0];
        const pick = await vscode.window.showQuickPick(ranked.map((f) => ({ label: vscode.workspace.asRelativePath(f), f })), { placeHolder: `找到多个「${base}」，选择要打开的文件` });
        return pick?.f;
    }
    private readonly symbolCache = new Map<string, boolean>();
    private lspSymbolUsable?: boolean;
    private lspMisses = 0;
    private lspEmptyCycles = 0;
    private async validateSymbols(syms: {
        id: string;
        name: string;
    }[]): Promise<string[]> {
        const results = new Map<string, boolean>();
        let anyHit = false;
        for (const { name } of syms) {
            if (!name || results.has(name))
                continue;
            const cached = this.symbolCache.get(name);
            if (cached !== undefined) {
                results.set(name, cached);
                if (cached)
                    anyHit = true;
                continue;
            }
            let ok = false;
            try {
                const found = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", name)) ?? [];
                if (found.length) {
                    this.lspSymbolUsable = true;
                    this.lspMisses = 0;
                }
                ok = found.some((s) => s.name === name || s.name.startsWith(name + "("));
            }
            catch {
                ok = true;
            }
            results.set(name, ok);
            if (ok)
                anyHit = true;
            if (this.symbolCache.size > 500)
                this.symbolCache.clear();
            this.symbolCache.set(name, ok);
        }
        if (!anyHit) {
            for (const { name } of syms)
                if (results.get(name) === false)
                    this.symbolCache.delete(name);
            return [];
        }
        return syms.filter(({ name }) => results.get(name) === false).map(({ id }) => id);
    }
    private async fileRefResolves(ref: string): Promise<boolean> {
        const p = ref.replace(/:\d+(?:-\d+)?$/, "").trim();
        if (!p)
            return false;
        return !!(await this.resolveWorkspaceFile(p, false));
    }
    private async loadLocalImage(ref: string): Promise<string | undefined> {
        try {
            const imagePath = await this.resolveWorkspaceFile(ref, false);
            if (!imagePath) return undefined;
            const mime: Record<string, string> = {
                ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
                ".bmp": "image/bmp", ".svg": "image/svg+xml",
            };
            const type = mime[path.extname(imagePath).toLowerCase()];
            if (!type || (await fs.promises.stat(imagePath)).size > 4 * 1024 * 1024) return undefined;
            return `data:${type};base64,${(await fs.promises.readFile(imagePath)).toString("base64")}`;
        }
        catch (err) {
            this.output.appendLine(`[loadLocalImage] ${ref} 读取失败: ${String((err as Error)?.message ?? err)}`);
            return undefined;
        }
    }
    private async openFile(ctx: SessionCtx, p: string, line?: number, endLine?: number): Promise<void> {
        const t0 = Date.now();
        try {
            const abs = await this.resolveWorkspaceFile(p, true);
            if (!abs) {
                this.output.appendLine(`[openFile] ${p} 未找到 (${Date.now() - t0}ms)`);
                vscode.window.showWarningMessage(`找不到文件：${p}`);
                return;
            }
            const resolveMs = Date.now() - t0;
            if (abs !== p || resolveMs > 300)
                this.output.appendLine(`[openFile] ${p} → ${abs} (解析 ${resolveMs}ms)`);
            // 图片交给 VS Code 预览；办公文档交给系统默认应用。
            if (/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?|svg)$/i.test(abs)) {
                await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs), {
                    viewColumn: this.codeColumn(ctx), preview: false,
                });
                return;
            }
            if (/\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(abs)) {
                if (!(await vscode.env.openExternal(vscode.Uri.file(abs))))
                    vscode.window.showWarningMessage(`系统未能打开文件: ${abs}`);
                return;
            }
            const doc = await vscode.workspace.openTextDocument(abs);
            const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.codeColumn(ctx), preview: false });
            if (line && line > 0) {
                const first = Math.min(line - 1, doc.lineCount - 1);
                const last = Math.min(endLine && endLine >= line ? endLine - 1 : first, doc.lineCount - 1);
                const start = new vscode.Position(first, 0);
                const end = new vscode.Position(last, doc.lineAt(last).text.length);
                editor.selection = new vscode.Selection(start, end);
                editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
            }
        }
        catch (err) {
            this.output.appendLine(`[openFile] ${p} 打开失败: ${String((err as Error)?.message ?? err)}`);
            vscode.window.showErrorMessage(`无法打开文件: ${p}`);
        }
    }
    private openingSymbol?: string;
    private async openSymbol(ctx: SessionCtx, name: string): Promise<void> {
        if (this.openingSymbol === name)
            return;
        this.openingSymbol = name;
        try {
            await this.openSymbolInner(ctx, name);
        }
        finally {
            this.openingSymbol = undefined;
        }
    }
    private async openSymbolInner(ctx: SessionCtx, name: string): Promise<void> {
        const t0 = Date.now();
        const done = (via: string) => this.output.appendLine(`[${new Date().toISOString()}] [symbol] ${name} 定位 ${Date.now() - t0}ms 途径=${via}` +
            (lspMs ? ` (其中 lsp ${lspMs}ms)` : ""));
        let lspMs = 0;
        const lspHit = this.lspSymbolUsable === false ? undefined : await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `定位 ${name}…` }, async () => {
            const lt = Date.now();
            const mayBeCold = this.lspSymbolUsable === undefined;
            const tries = mayBeCold ? 4 : 1;
            try {
                for (let attempt = 0; attempt < tries; attempt++) {
                    if (attempt)
                        await new Promise((r) => setTimeout(r, attempt * 500));
                    let syms: vscode.SymbolInformation[];
                    try {
                        syms =
                            (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", name)) ?? [];
                    }
                    catch {
                        return undefined;
                    }
                    if (syms.length) {
                        this.lspSymbolUsable = true;
                        this.lspMisses = 0;
                        this.lspEmptyCycles = 0;
                    }
                    else if (this.lspSymbolUsable) {
                        return undefined;
                    }
                    const exact = syms.filter((s) => s.name === name || s.name.startsWith(name + "("));
                    const candidates = exact.length ? exact : syms;
                    const order: Record<number, number> = {
                        [vscode.SymbolKind.Class]: 0,
                        [vscode.SymbolKind.Interface]: 0,
                        [vscode.SymbolKind.Enum]: 0,
                        [vscode.SymbolKind.Struct]: 0,
                        [vscode.SymbolKind.Constructor]: 1,
                        [vscode.SymbolKind.Method]: 1,
                        [vscode.SymbolKind.Function]: 1,
                    };
                    candidates.sort((a, b) => (order[a.kind] ?? 5) - (order[b.kind] ?? 5));
                    if (candidates[0])
                        return candidates[0];
                }
                if (++this.lspEmptyCycles >= 3 && this.lspSymbolUsable !== false) {
                    this.lspSymbolUsable = false;
                    this.output.appendLine(`[${new Date().toISOString()}] [symbol] 工作区符号索引连续 ${this.lspEmptyCycles} 次无响应，后续点击跳过 LSP`);
                }
                return undefined;
            }
            finally {
                lspMs = Date.now() - lt;
            }
        });
        if (lspHit) {
            done("lsp");
            await this.openFile(ctx, lspHit.location.uri.fsPath, lspHit.location.range.start.line + 1);
            return;
        }
        try {
            if (!/^[A-Z]/.test(name))
                throw new Error("skip");
            const matches = await vscode.workspace.findFiles(`**/${name}.{java,kt,kts,scala,cs,ts,tsx,go,rs,php,swift,dart}`, "**/{node_modules,dist,build,out,target,.git}/**", 3);
            if (matches.length) {
                this.noteLspMiss();
                done("file");
                const doc = await vscode.workspace.openTextDocument(matches[0]);
                await this.openFile(ctx, matches[0].fsPath, this.findDefLine(doc.getText(), name));
                return;
            }
        }
        catch {
        }
        try {
            const hit = await this.searchDefinition(name);
            if (hit) {
                this.noteLspMiss();
                done("search");
                await this.openFile(ctx, hit.uri.fsPath, hit.line);
                return;
            }
        }
        catch {
        }
        done("找不到→搜索面板");
        try {
            await vscode.commands.executeCommand("workbench.action.findInFiles", {
                query: name,
                triggerSearch: true,
                matchWholeWord: true,
                isCaseSensitive: true,
            });
        }
        catch {
            vscode.window.showInformationMessage(`未找到符号定义：${name}`);
        }
    }
    private findDefLine(text: string, name: string): number | undefined {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const def = new RegExp(`\\b(class|interface|enum|record|struct|trait|object|def|func|function|fun|type)\\s+${esc}\\b`);
        const word = new RegExp(`\\b${esc}\\b`);
        const lines = text.split("\n");
        let firstWord: number | undefined;
        for (let i = 0; i < lines.length; i++) {
            if (def.test(lines[i]))
                return i + 1;
            if (firstWord === undefined && word.test(lines[i]))
                firstWord = i + 1;
        }
        return firstWord;
    }
    private noteLspMiss(): void {
        if (this.lspSymbolUsable === true)
            return;
        if (++this.lspMisses >= 2) {
            if (this.lspSymbolUsable !== false) {
                this.output.appendLine(`[${new Date().toISOString()}] [symbol] 工作区无可用符号索引（未装语言服务？），后续点击跳过 LSP 直接走搜索`);
            }
            this.lspSymbolUsable = false;
        }
    }
    private srcFilesCache?: {
        at: number;
        uris: vscode.Uri[];
    };
    private async sourceFiles(): Promise<vscode.Uri[]> {
        const c = this.srcFilesCache;
        if (c && Date.now() - c.at < 60000)
            return c.uris;
        const uris = await vscode.workspace.findFiles("**/*.{java,kt,kts,scala,ts,tsx,js,jsx,go,rs,cs,py,php,rb,swift,dart,c,cpp,h,hpp}", "**/{node_modules,dist,build,out,target,.git}/**", 2500);
        this.srcFilesCache = { at: Date.now(), uris };
        return uris;
    }
    private async searchDefinition(name: string): Promise<{
        uri: vscode.Uri;
        line: number;
    } | undefined> {
        const files = await this.sourceFiles();
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const word = new RegExp(`\\b${esc}\\b`);
        const def = new RegExp(`\\b(class|interface|enum|record|struct|trait|object|def|func|function|fun|type)\\s+${esc}\\b` +
            `|\\b[\\w<>\\[\\].]+\\s+${esc}\\s*\\(` +
            `|\\b${esc}\\s*[:=]\\s*(?:function\\b|\\()`);
        let fallback: {
            uri: vscode.Uri;
            line: number;
        } | undefined;
        const BATCH = 48;
        for (let start = 0; start < files.length; start += BATCH) {
            const batch = files.slice(start, start + BATCH);
            const contents = await Promise.all(batch.map((u) => fs.promises.readFile(u.fsPath, "utf8").catch(() => undefined)));
            for (let b = 0; b < batch.length; b++) {
                const content = contents[b];
                if (content === undefined || !word.test(content))
                    continue;
                const uri = batch[b];
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    if (def.test(lines[i]))
                        return { uri, line: i + 1 };
                    if (!fallback && word.test(lines[i]))
                        fallback = { uri, line: i + 1 };
                }
            }
        }
        return fallback;
    }
    private reveal(): void {
        if (this.activeCtx)
            this.activeCtx.panel.reveal(this.activeCtx.panel.viewColumn, true);
        else
            this.view?.show?.(true);
    }
    private post(ctx: SessionCtx, e: ToWebview): void {
        if (!this.alive(ctx))
            return;
        ctx.webview.postMessage(e);
    }
    private config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration("codexChat");
    }
    private cwd(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0)
            return folders[0].uri.fsPath;
        const active = vscode.window.activeTextEditor?.document.uri;
        if (active && active.scheme === "file")
            return this.findProjectRoot(path.dirname(active.fsPath));
        return os.homedir();
    }
    private findProjectRoot(start: string): string {
        const markers = [".git", "package.json", "pom.xml", "build.gradle", "settings.gradle", "go.mod", "Cargo.toml", "pyproject.toml", "tsconfig.json", ".hg", ".svn"];
        let dir = start;
        for (let i = 0; i < 40; i++) {
            for (const m of markers) {
                try {
                    if (fs.existsSync(path.join(dir, m)))
                        return dir;
                }
                catch {
                }
            }
            const parent = path.dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
        return start;
    }
    private workspaceDirs(): string[] {
        const dirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        const root = this.cwd();
        if (root && !dirs.includes(root))
            dirs.push(root);
        return dirs;
    }
    private storageDir(): string {
        return this.context.globalStorageUri.fsPath;
    }
    dispose(): void {
        this.store.dispose();
        if (this.usageTimer)
            clearInterval(this.usageTimer);
        this.usageTimer = undefined;
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        this.watchdogTimer = undefined;
        for (const ctx of this.sessions)
            ctx.checkpoints.flush();
        for (const ctx of this.detached.values())
            ctx.checkpoints.flush();
        for (const ctx of this.sessions)
            ctx.proc?.dispose();
        for (const ctx of this.detached.values())
            ctx.proc?.dispose();
        this.sessions.clear();
        this.detached.clear();
        this.terminal?.dispose();
    }
    private sidebarHtml(): string {
        const nonce = randomUUID().replace(/-/g, "");
        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join("; ");
        const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3M5 4.5l.6 8a.8.8 0 0 0 .8.7h3.2a.8.8 0 0 0 .8-.7l.6-8"/></svg>';
        const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3.2H3.6a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V7.5"/><path d="M11 2.6a1.1 1.1 0 0 1 1.6 1.6L7.8 9 5.6 9.6 6.2 7.4z"/></svg>';
        const PIN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.6h5M6.6 2.6l-.5 4-2 2v.7h7.8v-.7l-2-2-.5-4M8 9.3V13"/></svg>';
        const EYE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>';
        const EYE_OFF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M3 3l10 10M5.3 5.3C3 6.4 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1 0 1.9-.2 2.7-.6M9.9 4.1C9.3 3.7 8.7 3.5 8 3.5"/></svg>';
        return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); display: flex; flex-direction: column; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; flex: 0 0 auto; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .head .ttl { font-weight: 600; opacity: .85; }
  .head .sp { flex: 1; }
  .abtn { background: none; border: none; color: var(--vscode-foreground); opacity: .8; cursor: pointer; font-size: 12px; padding: 3px 7px; border-radius: 5px; }
  .abtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18)); opacity: 1; }
  .abtn.primary { color: var(--vscode-button-background); font-weight: 600; }
  .abtn.danger { color: var(--vscode-errorForeground, #e55); }
  .abtn.hidden { display: none; }
  .new { display: flex; align-items: center; gap: 7px; width: calc(100% - 16px); margin: 8px; padding: 7px 10px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); border-radius: 7px; background: none; color: var(--vscode-foreground); cursor: pointer; font-size: 12.5px; flex: 0 0 auto; }
  .new:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.16)); }
  .new svg { width: 15px; height: 15px; }
  .upd-banner { display: flex; align-items: center; gap: 7px; width: calc(100% - 16px); margin: 8px 8px 0; padding: 7px 10px; border: 1px solid #d97757; border-radius: 7px; background: rgba(217,119,87,.12); color: var(--vscode-foreground); cursor: pointer; font-size: 12.5px; flex: 0 0 auto; }
  .upd-banner:hover { background: rgba(217,119,87,.22); }
  .upd-banner.hidden { display: none; }
  .upd-banner svg { width: 15px; height: 15px; color: #d97757; }
  .upd-banner b { font-weight: 600; }
  .list { padding: 2px 6px 12px; flex: 1 1 auto; min-height: 40px; overflow-y: auto; }
  .empty { opacity: .5; text-align: center; padding: 26px 10px; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; position: relative; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.14)); }
  .row.active { background: var(--vscode-list-activeSelectionBackground, rgba(80,120,255,.22)); }
  .row .chk { display: none; flex: 0 0 auto; width: 14px; height: 14px; }
  body.multi .row .chk { display: inline-block; }
  .row .body { flex: 1; min-width: 0; }
  .row .trow { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .row .trow .t { flex: 1; }
  .row .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
  .run-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: runpulse 1.6s ease-out infinite; }
  @keyframes runpulse { 0% { box-shadow: 0 0 0 0 rgba(63,185,80,.55); } 70% { box-shadow: 0 0 0 5px rgba(63,185,80,0); } 100% { box-shadow: 0 0 0 0 rgba(63,185,80,0); } }
  .row .meta { font-size: 10.5px; opacity: .55; margin-top: 1px; }
  .row .rename { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; padding: 1px 4px;
    border: 1px solid var(--vscode-focusBorder, #3794ff); border-radius: 4px; outline: none;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .row .edit, .row .del { flex: 0 0 auto; opacity: 0; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px; border-radius: 4px; }
  .row:hover .edit, .row:hover .del { opacity: .65; }
  .row .edit:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.25)); }
  .row .del:hover { opacity: 1; color: var(--vscode-errorForeground, #e55); }
  .row .edit svg, .row .del svg { width: 14px; height: 14px; }
  body.multi .row .edit, body.multi .row .del { display: none; }
  /* 置顶开关：与 edit/del 同款（hover 才现，pinned 行常亮实心图钉）。 */
  .row .pin { flex: 0 0 auto; opacity: 0; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px; border-radius: 4px; }
  .row:hover .pin { opacity: .65; }
  .row .pin:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.25)); }
  .row .pin svg { width: 14px; height: 14px; }
  .row.pinned .pin { opacity: .9; }
  .row.pinned .pin svg { fill: currentColor; }
  body.multi .row .pin { display: none; }
  /* 置顶区独立成组：中性浅底一整块，「置顶」组头（图钉 + 计数），「最近」分隔。 */
  .group-head { display: flex; align-items: center; gap: 6px; padding: 9px 8px 4px; font-size: 11px; opacity: .6; }
  .group-head svg { width: 12px; height: 12px; flex: 0 0 auto; }
  .group-head .gh-ttl { flex: 1; }
  .group-head .gh-count { font-variant-numeric: tabular-nums; opacity: .85; }
  .pin-zone { background: rgba(127,127,127,.08); border-radius: 8px; padding: 2px; margin: 0 2px 4px; }
  .recent-head { padding: 6px 8px 3px; font-size: 11px; opacity: .5; }
</style>
</head>
<body>
  <div class="head">
    <span class="ttl">会话</span>
    <span class="sp"></span>
    <button id="multi" class="abtn" title="多选">多选</button>
    <button id="delsel" class="abtn danger hidden">删除所选</button>
  </div>
  <button id="upd-banner" class="upd-banner hidden">${ICONS.update}<span>发现新版本 <b id="upd-ver"></b> · 点击更新</span></button>
  <button id="new" class="new">${ICONS.add}<span>新建会话</span></button>
  <div id="list" class="list"><div class="empty">暂无会话</div></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // 侧边栏脚本一旦抛错整个面板就会"点了没反应"且无迹可循——错误上报给 host 记日志。
    window.addEventListener("error", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: (e.message || "?") + " @sidebar:" + e.lineno }); } catch {}
    });
    window.addEventListener("unhandledrejection", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: "unhandledrejection@sidebar: " + String(e.reason).slice(0, 300) }); } catch {}
    });
    const TRASH = ${JSON.stringify(TRASH)};
    const PENCIL = ${JSON.stringify(PENCIL)};
    const PIN = ${JSON.stringify(PIN)};
    const EYE = ${JSON.stringify(EYE)}, EYE_OFF = ${JSON.stringify(EYE_OFF)};
    let sessions = [], activeId = null, runningIds = new Set(), multi = false;
    const sel = new Set();
    const $ = (id) => document.getElementById(id);

    function fmt(ts) {
      if (!ts) return "";
      const d = new Date(ts), now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) return d.toTimeString().slice(0, 5);
      return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }

    function makeRow(s) {
      const row = document.createElement("div");
      row.className = "row" + (s.id === activeId ? " active" : "") + (s.pinned ? " pinned" : "");
      row.dataset.id = s.id;
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "chk"; chk.checked = sel.has(s.id);
      chk.addEventListener("click", (e) => { e.stopPropagation(); toggle(s.id, chk.checked); });
      const body = document.createElement("div"); body.className = "body";
      const tRow = document.createElement("div"); tRow.className = "trow";
      if (runningIds.has(s.id)) { const dot = document.createElement("span"); dot.className = "run-dot"; dot.title = "正在回复中"; tRow.appendChild(dot); }
      const t = document.createElement("div"); t.className = "t"; t.textContent = s.title || "新对话";
      tRow.appendChild(t);
      const meta = document.createElement("div"); meta.className = "meta";
      meta.textContent = fmt(s.updatedAt) + (s.messageCount ? "  ·  " + s.messageCount + " 条" : "");
      body.append(tRow, meta);
      const pin = document.createElement("button"); pin.className = "pin";
      pin.title = s.pinned ? "取消置顶" : "置顶"; pin.innerHTML = PIN;
      pin.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "pinSession", sessionId: s.id, pinned: !s.pinned }); });
      const edit = document.createElement("button"); edit.className = "edit"; edit.title = "重命名"; edit.innerHTML = PENCIL;
      edit.addEventListener("click", (e) => { e.stopPropagation(); rename(s.id); });
      const del = document.createElement("button"); del.className = "del"; del.title = "删除"; del.innerHTML = TRASH;
      del.addEventListener("click", (e) => { e.stopPropagation(); confirmDel([s.id]); });
      row.append(chk, body, pin, edit, del);
      row.addEventListener("click", () => { if (multi) toggle(s.id, !sel.has(s.id)); else open(s.id); });
      return row;
    }

    function render() {
      const list = $("list");
      if (!sessions.length) { list.innerHTML = '<div class="empty">暂无会话</div>'; return; }
      list.innerHTML = "";
      const pinned = sessions.filter((s) => s.pinned);
      const others = sessions.filter((s) => !s.pinned);
      if (pinned.length) {
        const gh = document.createElement("div"); gh.className = "group-head";
        gh.innerHTML = PIN + '<span class="gh-ttl">置顶</span><span class="gh-count">' + pinned.length + '</span>';
        list.appendChild(gh);
        const zone = document.createElement("div"); zone.className = "pin-zone";
        for (const s of pinned) zone.appendChild(makeRow(s));
        list.appendChild(zone);
        if (others.length) {
          const rh = document.createElement("div"); rh.className = "recent-head"; rh.textContent = "最近";
          list.appendChild(rh);
        }
      }
      for (const s of others) list.appendChild(makeRow(s));
    }

    function toggle(id, on) { if (on) sel.add(id); else sel.delete(id); $("delsel").classList.toggle("hidden", sel.size === 0); render(); }
    function open(id) { vscode.postMessage({ type: "openSession", sessionId: id }); }
    function confirmDel(ids) { if (ids.length) vscode.postMessage({ type: "deleteSessions", sessionIds: ids }); }

    function rename(id) {
      const row = document.querySelector('.row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (!row) return;
      const t = row.querySelector(".t");
      const cur = (sessions.find((s) => s.id === id) || {}).title || "";
      const input = document.createElement("input");
      input.className = "rename"; input.value = cur;
      t.replaceWith(input); input.focus(); input.select();
      let done = false;
      const commit = (save) => {
        if (done) return; done = true;
        if (save) vscode.postMessage({ type: "renameSession", sessionId: id, title: input.value.trim() });
        render();
      };
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(true); }
        else if (e.key === "Escape") { e.preventDefault(); commit(false); }
      });
      input.addEventListener("blur", () => commit(true));
    }
    $("new").addEventListener("click", () => vscode.postMessage({ type: "newInEditor" }));
    function exitMulti() {
      multi = false;
      document.body.classList.remove("multi");
      $("multi").textContent = "多选";
      sel.clear();
      $("delsel").classList.add("hidden");
      render();
    }
    $("multi").addEventListener("click", () => {
      if (multi) { exitMulti(); return; }
      multi = true; document.body.classList.add("multi");
      $("multi").textContent = "取消";
      render();
    });
    $("delsel").addEventListener("click", () => confirmDel([...sel]));
    $("upd-banner").addEventListener("click", () => vscode.postMessage({ type: "checkUpdate", fromBanner: true }));

    window.addEventListener("message", (ev) => {
      const m = ev.data;
      if (m && m.kind === "ping") { vscode.postMessage({ type: "pong", id: m.id }); return; }
      if (m && m.kind === "sessions") {
        sessions = m.list || []; activeId = m.activeId || null;
        if (m.runningIds !== undefined) runningIds = new Set(m.runningIds || []);
        const hadSel = sel.size > 0;
        for (const id of [...sel]) if (!sessions.find((s) => s.id === id)) sel.delete(id);
        // 批量删除完成的信号：之前选中的会话全部从列表消失 → 自动退出多选。
        // （宿主弹窗点了取消时 sel 原样保留，不会误退。）
        if (multi && hadSel && sel.size === 0) { exitMulti(); return; }
        $("delsel").classList.toggle("hidden", sel.size === 0);
        render();
      } else if (m && m.kind === "running") {
        runningIds = new Set(m.sessionIds || []);
        render();
      } else if (m && m.kind === "update_available") {
        if (m.version) { $("upd-ver").textContent = "v" + m.version; $("upd-banner").classList.remove("hidden"); }
        else $("upd-banner").classList.add("hidden");
      }
    });

    vscode.postMessage({ type: "listSessions" });
  </script>
</body>
</html>`;
    }
    private html(webview: vscode.Webview): string {
        const nonce = randomUUID().replace(/-/g, "");
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js")).toString() +
            `?v=${nonce}`;
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")).toString() +
            `?v=${nonce}`;
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`,
        ].join("; ");
        return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Codex Copilot</title>
</head>
<body>
  <div id="app">
    <div id="lightbox" class="lightbox hidden">
      <div class="lightbox-actions">
        <button id="lb-copy" title="复制图片到剪贴板">${ICONS.copy} 复制</button>
        <button id="lb-save" title="保存图片到本地">${ICONS.file} 保存</button>
        <button id="lb-close" title="关闭">×</button>
      </div>
      <img id="lightbox-img" alt="预览" />
    </div>
    <div id="messages" class="messages"></div>
    <footer id="composer">
      <div id="changed-files" class="changed-files hidden collapsed">
        <div class="cf-header" id="cf-header">
          <span class="cf-caret">${ICONS.chevron}</span>
          <span class="cf-title">已更改文件</span>
          <span id="cf-count" class="cf-count"></span>
          <span id="cf-stat" class="cf-stat"></span>
        </div>
        <div id="cf-list" class="cf-list"></div>
      </div>
      <div id="task-queue" class="task-queue hidden"></div>
      <div id="context-chips"></div>
      <div id="file-chips"></div>
      <div id="image-previews"></div>
      <div id="queue-hint" class="queue-hint hidden"><span class="qh-key">↵</span> 任务进行中 · 回车将内容加入<b>等待队列</b></div>
      <div class="input-wrap">
        <textarea id="input" rows="1" placeholder="给 Codex 发消息…"></textarea>
        <div class="composer-bottom">
          <div class="composer-tools">
            <button id="btn-attach-file" class="composer-btn" title="附加文件/目录到会话">${ICONS.attach}</button>
            <span class="composer-sep"></span>
            <button id="model-trigger" class="composer-pick" title="选择模型"><span class="pick-emoji">${ICONS.model}</span><span id="model-label" class="pick-label">默认模型</span><span class="pick-caret">${ICONS.chevron}</span></button>
            <button id="fast-toggle" class="composer-pick" aria-pressed="false" title="快速模式：关闭；下轮生效，开启后额度消耗更高"><span class="pick-emoji">${ICONS.fast}</span><span id="fast-label" class="pick-label">快速：关</span></button>
            <button id="mode-trigger" class="composer-pick" title="选择模式"><span id="mode-icon" class="pick-emoji"></span><span id="mode-label" class="pick-label"></span><span class="pick-caret">${ICONS.chevron}</span></button>

            <span class="composer-state">
              <span id="ctx-gauge" class="ctx-gauge hidden" title="上下文使用量"><span class="cg-ring"><span class="cg-pct"></span></span></span>
              <button id="usage-pill" class="usage-pill hidden" title="Codex 订阅用量 · 点击查看详情"></button>
            </span>
          </div>
          <button id="btn-send" class="composer-send" title="发送">${ICONS.send}</button>
          <button id="btn-stop" class="composer-send stop hidden" title="停止">${ICONS.stop}</button>
        </div>
      </div>
      <div id="pick-backdrop" class="pick-backdrop hidden"></div>
      <div id="mode-menu" class="pick-menu hidden"></div>
      <div id="model-menu" class="pick-menu hidden"></div>
      <div id="usage-menu" class="pick-menu usage-menu hidden"></div>
      <div class="composer-foot">
        <span class="foot-keys"><kbd>Enter</kbd>发送<kbd>⇧↵</kbd>换行</span>
        <span class="foot-spacer"></span>
        <span id="status-line" class="status-line"></span>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
function cmpVersion(a: string, b: string): number {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0)
            return d > 0 ? 1 : -1;
    }
    return 0;
}
function firstChangedLine(a: string, b: string): number {
    const al = a.split("\n");
    const bl = b.split("\n");
    const n = Math.min(al.length, bl.length);
    for (let i = 0; i < n; i++)
        if (al[i] !== bl[i])
            return i;
    return al.length === bl.length ? 0 : n;
}
