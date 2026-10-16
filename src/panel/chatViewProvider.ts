import { postWebviewMessage } from '../webviewDelivery';
import { expectedFileError, operationFailure, operationLog } from '../operations';
import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import { performance } from "node:perf_hooks";
import { parseFileRef } from "../fileRef";
import { DEFAULT_QUIET_HOURS, isFeishuWebhook, parseQuietHours, WorkdayCalendar } from "../workdayCalendar";
import { formatLocalNotification, localNotificationProject, localNotificationsSupported, sendLocalNotification, clearLocalNotification, clearPreviousLocalNotifications, queueSessionNotification, notificationTime } from "../notifications";
import { NotificationRouter } from "../notificationRouter";
import { diagnosticNotification } from "../diagnostics/notification";
import type { DiagnosticRecord, NotificationResult } from "../diagnostics/jobs";
import { WorkspaceSnapshot } from "../snapshot";
import { QuestionImages } from "../questionImages";
import { diffCounts, readDiffFile } from "../diff";
import { createHash, randomUUID } from "node:crypto";
import { parseCommand, type Command } from "../remote/command";
import type { RemoteRegistration, RemoteReply } from "../remote/bridgeClient";
import { transcriptSnapshot } from "../remote/transcript";
import { remoteImages } from "../remote/images";
import { questionStateFile, deleteQuestionState, saveQuestionState, CodexProcess, PermissionRequest } from "../codex/process";
import { usageView, quotaEvents, userView, checkpointTextKey, QUESTION_REPLY_PREFIX } from "../codex/events";
import { performanceContext } from "../codex/performanceTrace";
import { executionMode } from "../codex/executionPolicy";
import { SessionStore, sessionTabTitle, ForkPreparation } from "../codex/session";
import { CheckpointManager, shortLabel } from "../checkpoints";
import { ChangedFile, CheckpointSummary, contextWindowFor, CTX_OPEN, CTX_CLOSE, FromWebview, ICONS, modelChoices, ModelChoice, SpeedMode, configuredSpeedMode, isSpeedMode, speedLabel, supportsSpeed, billingKind, SessionSummary, ToWebview } from "../shared";
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
const LOCAL_SNAPSHOT_EXCLUDES_KEY = "codexChat.localSnapshotExcludes";
interface SessionCtx {
    sending?: boolean;
    remotePrivate?: boolean;
    remoteRead?: Promise<void>;
    remoteReadAt?: number;
    snapshot?: WorkspaceSnapshot;
    finalizing?: Promise<void>;
    changedFilesRefresh?: Promise<void>;
    changedFilesRefreshPending?: boolean;
    panel: vscode.WebviewPanel;
    webview: vscode.Webview;
    sessionId?: string;
    model?: string;
    speedMode?: SpeedMode;
    effort?: string;
    settingsQueue?: Promise<void>;
    proc?: CodexProcess;
    starting?: Promise<CodexProcess | undefined>;
    checkpoints: CheckpointManager;
    pendingContext?: {
        label: string;
        text: string;
    };
    pendingPrefill?: string;
    pendingDiagnosticRepair?: { start: () => void; cancel: () => void };
    pendingPerm?: ToWebview;
    pendingPerms?: Map<string, Extract<ToWebview, { kind: "permission_request" }>>;
    pendingQuestionAt?: number;
    answeringQuestion?: boolean;
    questionAnswerSeq?: number;
    readOnlyToolIds?: Set<string>;
    mayHaveModifiedWorkspace?: boolean;
    blank: boolean;
    ready: boolean;
    sendSeq?: number;
    stopSeq?: number;
    coldStart?: boolean;
    lastUsedAt?: number;
    sendAt?: number;
    performanceTraceId?: string;
    lastUserText?: string;
    lastUserActionAt?: number;
    initialHistoryCached?: boolean;
    initialHistoryRead?: Promise<void>;
    historyLoadSeq?: number;
    historyPending?: boolean;
    lastEventAt?: number;
    responseWaitShown?: boolean;
    compacting?: boolean;
    compactionPreparing?: boolean;
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
    private lastUsageUpdatedAt = 0;
    private usageFails = 0;
    private usageInFlight = false;
    private lastUsage?: ToWebview;
    private usageAlertPending = new Set<string>();
    private usageAlertDelivered = new Map<string, string>();
    private readonly snapshotWarningSignatures = new Map<string, string>();
    private readonly snapshotWarningPaths = new Map<string, Set<string>>();
    private snapshotExclusionUpdate: Promise<void> = Promise.resolve();
    private layoutFixing = false;
    private readonly origChanged = new vscode.EventEmitter<vscode.Uri>();
    private terminal?: vscode.Terminal;
    private usageTimer?: ReturnType<typeof setInterval>;
    private watchdogTimer?: ReturnType<typeof setInterval>;
    private sidebarMissedPings = 0;
    private notifyPanel?: vscode.WebviewPanel;
    private readonly workdayCalendar: WorkdayCalendar;
    private readonly notificationWindowKey = randomUUID();
    private readonly notifyTimers = new Set<ReturnType<typeof setTimeout>>();
    private notificationEpochs = new Map<string, number>();
    private notificationUris = new Map<string, Promise<vscode.Uri>>();
    private notificationRouter?: NotificationRouter;
    private disposed = false;
    private readonly remoteWindowId = randomUUID();
    remoteRegistration(): RemoteRegistration | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!vscode.workspace.isTrusted || vscode.env.remoteName || !folders?.length || folders.some(f => f.uri.scheme !== 'file')) return;
        return { windowId: this.remoteWindowId,
            workspaceId: 'project-' + createHash('sha256').update(JSON.stringify(folders.map(f => f.uri.fsPath))).digest('hex').slice(0, 24),
            label: folders.map(f => f.name).join(' · ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) };
    }
    /** 手机只能操作本窗口已打开或转入后台的原会话；不接收 Webview 任意指令。 */
    async executeRemote(input: Command, connected: () => boolean): Promise<RemoteReply> {
        const command = parseCommand(input, Date.now()), registration = this.remoteRegistration();
        const denied = (error: string): RemoteReply => ({ accepted: false, error });
        const active = () => connected() && !this.disposed && command.expiresAt > Date.now() &&
            this.remoteRegistration()?.workspaceId === registration?.workspaceId;
        if (!registration || !active() || command.target?.windowId !== registration.windowId || command.target.workspaceId !== registration.workspaceId)
            return denied('TARGET_OFFLINE');
        const contexts = () => [...new Set([...this.sessions, ...this.detached.values()])];
        const op = command.operation;
        if (op.kind === 'session.list') {
            const titles = new Map(this.store.list().map(s => [s.id, s.title]));
            const all = contexts().filter(c => c.sessionId);
            return { accepted: true, result: { kind: 'session.list', total: all.length,
                sessions: all.slice(0, 20).map(c => ({ id: c.sessionId, title: (titles.get(c.sessionId!) || c.lastUserText || '已打开会话').slice(0, 60),
                    busy: !!c.proc?.isBusy || !!c.sending, waiting: c.pendingPerm?.kind === 'permission_request' })) } };
        }
        let ctx = contexts().find(c => c.sessionId === command.target!.sessionId);
        if (op.kind === 'session.create') {
            ctx = await this.openSession();
            if (!active()) return denied('COMMAND_EXPIRED');
        }
        if (!ctx || !ctx.sessionId && op.kind !== 'session.create') return denied('SESSION_NOT_OPEN');
        const selected = ctx, sourceId = ctx.sessionId, checkpoints = ctx.checkpoints;
        const selectedActive = () => active() && contexts().includes(selected) && selected.checkpoints === checkpoints &&
            (selected.sessionId === sourceId || op.kind === 'session.create');
        // 此标记随会话持久保存；以后即便桥接断线，也不能把该会话正文回退到飞书等 Webhook。
        ctx.remotePrivate = true;
        if (sourceId && !this.context.workspaceState.get<boolean>('codexChat.remotePrivate.' + sourceId))
            await this.context.workspaceState.update('codexChat.remotePrivate.' + sourceId, true);
        if (!selectedActive()) return denied('TARGET_CHANGED');
        if (op.kind === 'session.snapshot') {
            if (!ctx.remoteRead && Date.now() - (ctx.remoteReadAt ?? 0) >= 4000) {
                ctx.remoteRead = this.store.hydrate(sourceId!).then(() => { selected.remoteReadAt = Date.now(); }).finally(() => { selected.remoteRead = undefined; });
            }
            await ctx.remoteRead;
            if (!selectedActive()) return denied('TARGET_CHANGED');
            const items = this.store.load(sourceId!);
            this.fetchUsage();
            const usage = this.lastUsage?.kind === 'usage' ? this.lastUsage : undefined;
            const state = { kind: 'session.snapshot', sessionId: sourceId, busy: !!ctx.proc?.isBusy || !!ctx.sending,
                turnId: ctx.proc?.currentTurnId ?? null, waiting: ctx.pendingPerm?.kind === 'permission_request',
                model: this.sessionModel(ctx).slice(0, 120), effort: this.sessionEffort(ctx).slice(0, 40),
                speed: this.speedMode(ctx), usage: usage ? { sessionPct: usage.sessionPct, sessionResetAt: usage.sessionResetAt,
                    weekPct: usage.weekPct, weekResetAt: usage.weekResetAt, planType: usage.planType, updatedAt: this.lastUsageUpdatedAt } : null };
            return { accepted: true, result: transcriptSnapshot(items, state, op) };
        }
        if (op.kind === 'message.send' || op.kind === 'session.create') {
            let images: {mediaType:string;data:string}[];
            try { images=remoteImages(command,op.attachmentIds??[]); } catch { return denied('IMAGE_NOT_AVAILABLE'); }
            if (ctx.sending || ctx.proc?.isBusy || ctx.pendingPerm?.kind === 'permission_request' ||
                this.forking.has(ctx) || this.restoring.has(ctx) || ctx.answeringQuestion || ctx.compactionPreparing) return denied('SESSION_BUSY');
            const accepted = await this.handleSend(ctx, op.text, undefined, images.length?images:undefined, undefined, selectedActive);
            if (!accepted) return denied('MESSAGE_NOT_SENT');
            return { accepted: true, result: { kind: 'message.accepted', sessionId: ctx.sessionId, delivery: 'handed_to_original_session' } };
        }
        if (op.kind === 'turn.stop') {
            if (!ctx.proc?.isBusy || ctx.proc.currentTurnId !== op.turnId) return denied('TURN_CHANGED');
            await this.stopContext(ctx);
            return { accepted: true, result: { kind: 'turn.stop', sessionId: sourceId, stopping: !!ctx.proc?.isBusy } };
        }
        return denied('OPERATION_NOT_READY');
    }
    constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
        this.workdayCalendar = new WorkdayCalendar(path.join(context.globalStorageUri.fsPath, "holiday-cn"),
            message => this.output.appendLine(message), () => this.postNotifyCalendar());
        const configureCalendar = () => {
            const cfg = vscode.workspace.getConfiguration("codexChat");
            this.workdayCalendar.configure(localNotificationsSupported() && cfg.get<boolean>("notifyLocal") === true &&
                parseQuietHours(cfg.get("notifyFeishuQuietHours"))?.enabled === true);
        };
        configureCalendar();
        this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("codexChat.notifyFeishuQuietHours") || event.affectsConfiguration("codexChat.notifyLocal")) configureCalendar();
        }));
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
        this.usageTimer = setInterval(() => this.fetchUsage(), 3 * 60000);
        this.watchdogTimer = setInterval(() => this.checkWatchdog(), 10000);
    }
    private checkWatchdog(): void {
        for (const ctx of [...this.sessions, ...this.detached.values()])
            this.checkTurnStall(ctx);
        // 关闭时仍在运行或刚结束的会话当时不能回收，空闲后必须再次检查。
        this.trimBackground();
        for (const ctx of this.sessions) {
            // 隐藏的 webview 可被 VS Code 暂停，未回心跳不代表页面损坏。
            if (!ctx.ready || !ctx.panel.visible) {
                ctx.missedPings = 0;
                continue;
            }
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
                    ctx.panel.webview.html = this.html(ctx.panel.webview, ctx.sessionId);
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
                postWebviewMessage(this.view.webview, { kind: "ping", id: Date.now() } satisfies ToWebview);
            }
        }
        else {
            this.sidebarMissedPings = 0;
        }
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
            catch (error) { operationFailure('context.file', error);
                continue;
            }
            const rel = vscode.workspace.asRelativePath(p);
            if (stat.isDirectory()) {
                let entries: string[] = [];
                try {
                    entries = fs.readdirSync(p).slice(0, 200);
                }
                catch (error) { operationFailure('context.file', error);
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
                catch (error) { operationFailure('context.file', error);
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
        catch (error) { if (!expectedFileError(error)) operationFailure('context.import', error);
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
            catch (error) { if (!expectedFileError(error)) operationFailure('context.import', error);
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
        postWebviewMessage(target, e);
    }
    private postUpdateDot(): void {
        postWebviewMessage(this.view?.webview, { kind: "update_available", version: this.updateAvailable ?? "" });
        if (this.view) {
            this.view.badge = this.updateAvailable
                ? { value: 1, tooltip: `发现新版本 v${this.updateAvailable}` }
                : undefined;
        }
    }
    private sessionsRefreshing?: Promise<void>;
    private refreshSessions(): void {
        if (this.sessionsRefreshing) return;
        this.sessionsRefreshing = this.store.refresh().then(async () => {
            const last = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
            // 已合并普通与归档会话；不能凭残留的 checkpoint 文件放回真正缺失的会话。
            const live = last && [...this.sessions, ...this.detached.values()].some(ctx => ctx.sessionId === last && ctx.proc && !ctx.proc.isExited);
            if (last && !live && !this.store.list().some(s => s.id === last))
                await this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
            this.renderSessions();
        }).catch(e => this.output.appendLine(`[sessions] ${String(e)}`))
            .finally(() => { this.sessionsRefreshing = undefined; });
    }
    private renderSessions(): void {
        const list = this.store.list();
        try {
            postWebviewMessage(this.view?.webview, {
                kind: "sessions",
                list: this.withPinned(list),
                activeId: this.activeCtx?.sessionId,
                runningIds: this.runningIds(),
            } satisfies ToWebview);
        }
        catch (error) { operationFailure('sessions.render', error);
        }
        for (const ctx of this.sessions) {
            try {
                this.setPanelTitle(ctx, list);
            }
            catch (error) { operationFailure('sessions.render', error);
            }
        }
    }
    private setPanelTitle(ctx: SessionCtx, list?: ReturnType<SessionStore["list"]>): void {
        const title = ctx.sessionId
            ? (list ?? this.store.list()).find((s) => s.id === ctx.sessionId)?.title
            : undefined;
        ctx.panel.title = sessionTabTitle(title);
    }
    closeActiveSession(): void {
        // 只关闭当前聚焦的会话，不能误用切到文件编辑器前残留的 activeCtx。
        const ctx = [...this.sessions].find(session => session.panel.active);
        ctx?.panel.dispose();
    }
    private createSessionPanel(): vscode.WebviewPanel {
        // Beside 相对当前活动组，会把新会话插到中间；指定末列之后的新组。
        // 快速连建时 tabGroups 可能尚未同步，已创建面板的列号也要计入。
        const groups = vscode.window.tabGroups.all;
        const lastColumn = Math.max(
            vscode.ViewColumn.One,
            ...groups.map(group => group.viewColumn),
            ...[...this.sessions].map(ctx => ctx.panel.viewColumn ?? 0),
        );
        // VS Code 会在唯一空组内打开首个面板，使用同一列号避免随后的 reveal 再建组。
        const viewColumn = !this.sessions.size && groups.length === 1 && !groups[0].tabs.length
            ? groups[0].viewColumn
            : lastColumn + 1;
        return vscode.window.createWebviewPanel("codex-chat.editor", "Codex Copilot", { viewColumn, preserveFocus: false }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
        });
    }
    async openSession(sessionId?: string, initialHistoryCached = false): Promise<SessionCtx> {
        this.output.appendLine(`[${new Date().toISOString()}] [open] ${sessionId ? sessionId.slice(0, 8) : "新会话"}`);
        if (sessionId) {
            for (const ctx of this.sessions) {
                if (ctx.sessionId === sessionId) {
                    ctx.panel.reveal(ctx.panel.viewColumn, false);
                    this.activeCtx = ctx;
                    await this.lockChatGroup(ctx.panel);
                    return ctx;
                }
            }
            const det = this.detached.get(sessionId);
            if (det) {
                this.detached.delete(sessionId);
                await this.reopenDetached(det);
                return det;
            }
        }
        const panel = this.createSessionPanel();
        const ctx: SessionCtx = {
            panel,
            webview: panel.webview,
            sessionId,
            initialHistoryCached,
            checkpoints: new CheckpointManager(this.storageDir()),
            blank: !sessionId,
            ready: false,
        };
        if (sessionId)
            ctx.checkpoints.setSession(sessionId);
        this.sessionModel(ctx);
        this.speedMode(ctx);
        this.sessionEffort(ctx);
        this.adoptPanel(ctx);
        this.sessions.add(ctx);
        this.activeCtx = ctx;
        await this.lockChatGroup(panel);
        return ctx;
    }
    private async reopenDetached(det: SessionCtx): Promise<void> {
        const panel = this.createSessionPanel();
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
        panel.webview.html = this.html(panel.webview, ctx.sessionId);
        ctx.webview = panel.webview;
        panel.webview.onDidReceiveMessage((m: FromWebview) => {
            // 心跳、历史读取和其他后台消息不能改变命令的目标会话。
            if (panel.active)
                this.activeCtx = ctx;
            this.onPanelMessage(ctx, m);
        });
        panel.onDidChangeViewState(() => {
            if (panel.active) {
                this.activeCtx = ctx;
                this.postActiveFile();
            }
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
        ctx.pendingDiagnosticRepair?.cancel();
        this.sessions.delete(ctx);
        // 关闭标签清理当前提醒，并使关闭前仍在排队的旧提醒失效。
        void this.clearSessionNotification(ctx.sessionId, "session_closed");
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
            .filter((c) => c.proc && !c.proc.isBusy && c.sessionId && !c.starting && !c.snapshot &&
                !c.finalizing && !this.restoring.has(c) && !this.forking.has(c) && !c.answeringQuestion && !c.pendingPerm &&
                Date.now() - (c.lastEmitAt ?? 0) > 60000)
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
        let sid = sessionId;
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
            blank: !sid,
            ready: false,
        };
        if (sid) {
            // 与 Webview 启动并行读取；ready 后复用此结果，避免完整历史读两遍。
            // 临时读取失败也保留标签绑定，不能悄悄变成新对话。
            ctx.historyPending = true;
            ctx.initialHistoryRead = this.store.hydrate(sid);
            void ctx.initialHistoryRead.catch(() => {}); // ready 后统一展示失败与重试入口
        }
        if (sid)
            ctx.checkpoints.setSession(sid);
        this.sessionModel(ctx);
        this.speedMode(ctx);
        this.sessionEffort(ctx);
        this.adoptPanel(ctx);
        this.sessions.add(ctx);
        // 重载时分组位置、锁定状态和焦点由 VS Code 恢复。反序列化期间
        // viewColumn 尚可能是内部的 0 起始编号，不能调用 reveal/lockChatGroup，
        // 否则会把会话移到其他组并合并原有分屏。后台标签也不能覆盖当前会话。
        if (panel.active)
            this.activeCtx = ctx;
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
        catch (error) { operationFailure('panel.keepFilesLeft', error);
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
        catch (error) { operationFailure('panel.lockChatGroup', error);
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
        catch (e) { operationFailure('panel.login', e);
            void vscode.window.showErrorMessage(`无法启动登录：${String(e)}`);
        }
    }
    async account(): Promise<void> {
        try {
            const r = await (await this.store.connection()).request("account/read", {});
            void vscode.window.showInformationMessage(r.account ? `Codex 已登录 · ${r.account.type === "chatgpt" ? "ChatGPT 订阅" : r.account.type} · ${r.account.planType ?? ""}` : "Codex 尚未登录，请执行“Codex: 登录账号”。");
        }
        catch (e) { operationFailure('panel.account', e);
            void vscode.window.showErrorMessage(String(e));
        }
    }
    async newSession(): Promise<void> {
        await this.openSession(undefined);
    }
    async diagnosticModels(): Promise<ModelChoice[]> {
        return modelChoices((await this.store.readModelCatalog()).data);
    }
    async createDiagnosticRepairSession(prompt: string, title: string): Promise<string> {
        const ctx = await this.openSession(undefined);
        ctx.panel.title = title;
        return new Promise<string>((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined;
            let started = false;
            const cancel = () => {
                if (started) return;
                started = true; clearTimeout(timer); ctx.pendingDiagnosticRepair = undefined;
                reject(new Error('修复会话尚未就绪或已关闭，请重试。'));
            };
            const start = () => {
                if (started) return;
                started = true; clearTimeout(timer); ctx.pendingDiagnosticRepair = undefined;
                void (async () => {
                    if (!this.alive(ctx)) throw new Error('修复会话已关闭');
                    this.post(ctx, { kind: 'remote_user', text: prompt });
                    if (!await this.handleSend(ctx, prompt) || !ctx.sessionId) throw new Error('修复消息尚未发送，请检查新会话中的提示后重试。');
                    void this.store.setCustomTitle(ctx.sessionId, title).then(() => this.refreshSessions()).catch(() => {});
                    return ctx.sessionId;
                })().then(resolve, reject);
            };
            ctx.pendingDiagnosticRepair = { start, cancel };
            if (ctx.ready) start();
            else { timer = setTimeout(cancel, 15000); timer.unref(); }
        });
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
        await this.stopContext(ctx);
    }
    private async stopContext(ctx: SessionCtx): Promise<void> {
        ctx.questionAnswerSeq = (ctx.questionAnswerSeq ?? 0) + 1;
        if (!ctx.proc && ctx.sessionId && ctx.pendingPerm?.kind === "permission_request" && ctx.pendingPerm.toolName === "AskUserQuestion")
            deleteQuestionState(this.storageDir(), ctx.sessionId);
        ctx.pendingPerm = undefined;
        ctx.pendingPerms?.clear();
        ctx.lastEventAt = undefined;
        ctx.lastUserActionAt = Date.now();
        ctx.stopSeq = ctx.sendSeq ?? 0;
        const proc = ctx.proc;
        this.output.appendLine(`[interrupt] session=${ctx.sessionId?.slice(0, 8)} requested busy=${!!proc?.isBusy}`);
        // 准备流程尚未退出时不能放行队列；由 handleSend 的 finally 确认取消并解锁。
        if (!proc?.isBusy) {
            if (!ctx.sending) this.post(ctx, { kind: "busy", busy: false });
            return;
        }
        this.post(ctx, { kind: "status", label: "正在停止，确认后再处理排队消息…" });
        try { await proc.interrupt(); }
        catch (err) {
            this.output.appendLine(`[interrupt] ${String(err)}`);
            this.post(ctx, { kind: "notice", message: "停止请求失败，正在关闭连接。" });
            await proc.disposeAndWait();
        }
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
                case "performanceReport":
                    await vscode.commands.executeCommand("codex-chat.performanceReport");
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
                case "performanceReport": {
                    try {
                        await vscode.commands.executeCommand("codex-chat.performanceReport");
                        this.post(ctx, { kind: "performance_report_result", requestId: m.requestId, ok: true, message: "插件诊断中心已打开" });
                    } catch (error) {
                        this.output.appendLine(`[performanceReport] ${String(error)}`);
                        this.post(ctx, { kind: "performance_report_result", requestId: m.requestId, ok: false, message: "诊断报告打开失败，请重试或查看插件日志。" });
                    }
                    break;
                }
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
                    void this.store.readAccountInfo().then(r => {
                        this.post(ctx, { kind: "speed_context", billing: billingKind(r.account?.type),
                            planType: r.account?.type === "chatgpt" ? r.account.planType : undefined });
                    }).catch(() => this.post(ctx, { kind: "speed_context", billing: "unknown" }));
                    void this.store.readModelCatalog().then(r => {
                        const models = modelChoices(r.data);
                        this.modelCatalog = models;
                        this.post(ctx, { kind: "models", models });
                    }).catch(e => this.post(ctx, { kind: "notice", message: `模型列表读取失败：${String(e)}` }));
                    this.loadCtxSession(ctx);
                    if (!ctx.sessionId) this.maybePrespawn(ctx);
                    this.post(ctx, {
                        kind: "config",
                        permissionMode: this.config().get<string>("permissionMode", "default"),
                        model: this.sessionModel(ctx),
                        effort: this.sessionEffort(ctx),
                        speedMode: this.speedMode(ctx),
                        modEnterToSend: this.config().get<boolean>("modEnterToSend", false),
                    });
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
                    ctx.pendingDiagnosticRepair?.start();
                    break;
                case "reloadHistory":
                    if (ctx.sessionId) this.loadSessionInto(ctx, ctx.sessionId);
                    break;
                case "checkUpdate":
                    await this.checkForUpdate(!m.fromBanner, false);
                    break;
                case "refreshUsage":
                    this.fetchUsage(true);
                    break;
                case "send":
                    await this.handleSend(ctx, m.text, m.context, m.images, m.files, undefined, m.queueMs, m.sendId);
                    break;
                case "editMessage":
                    await this.editMessage(ctx, m.checkpointId, m.text, m.images);
                    break;
                case "interrupt":
                    await this.stopContext(ctx);
                    break;
                case "newContext":
                    await this.newContext(ctx, m);
                    break;
                case "compact": {
                    await this.compactSession(ctx);
                    break;
                }
                case "permission":
                    this.handlePermission(ctx, m.requestId, m.behavior, m.suggestionId);
                    break;
                case "answerQuestion": {
                    if (ctx.answeringQuestion) break;
                    ctx.answeringQuestion = true;
                    const answerStartedAt = performance.now();
                    const answerSessionId = ctx.sessionId ?? "none";
                    try {
                        await this.submitQuestionAnswer(ctx, m.requestId, m.answers, m.images);
                    } catch (err) {
                        this.output.appendLine(`[question] rejected session=${answerSessionId} elapsedMs=${Math.round(performance.now() - answerStartedAt)} errorType=${err instanceof Error ? err.name : typeof err}`);
                        this.post(ctx, { kind: "question_answer_rejected", requestId: m.requestId, message: String((err as Error)?.message ?? err) });
                        break;
                    } finally {
                        ctx.answeringQuestion = false;
                    }
                    this.output.appendLine(`[question] accepted session=${answerSessionId} elapsedMs=${Math.round(performance.now() - answerStartedAt)}`);
                    this.resolvePendingPermission(ctx, m.requestId);
                    ctx.lastUserActionAt = Date.now();
                    if (ctx.lastEventAt !== undefined)
                        ctx.lastEventAt = Date.now();
                    break;
                }
                case "restoreCheckpoint":
                    await this.restoreCheckpoint(ctx, m.checkpointId, false, m.draft);
                    break;
                case "reanswerQuestion":
                    await this.restoreCheckpoint(ctx, m.checkpointId, true);
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
                case "setSpeedMode":
                    await this.setSpeedMode(ctx, m.mode);
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
                case "acceptAll": {
                    const checkpoints = ctx.checkpoints, sessionId = ctx.sessionId;
                    const { files } = await this.getChangedFiles(ctx);
                    if (ctx.checkpoints !== checkpoints || ctx.sessionId !== sessionId) break;
                    for (const f of files)
                        checkpoints.accept(f.path);
                    this.refreshChangedFiles(ctx);
                    break;
                }
                case "revertAll": {
                    const checkpoints = ctx.checkpoints, sessionId = ctx.sessionId;
                    const files = (await this.getChangedFiles(ctx)).files;
                    if (ctx.checkpoints !== checkpoints || ctx.sessionId !== sessionId) break;
                    if (files.length) {
                        const ok = await vscode.window.showWarningMessage(`回滚全部 ${files.length} 个文件的改动？`, { modal: true, detail: "将把这些文件恢复到 Codex 改动前的状态，此操作不可撤销。" }, "回滚全部");
                        if (ok === "回滚全部" && ctx.checkpoints === checkpoints && ctx.sessionId === sessionId) {
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
            ctx.model = undefined;
            ctx.speedMode = undefined;
            ctx.effort = undefined;
            this.speedMode(ctx);
            ctx.checkpoints.setSession(sid);
            this.loadSessionInto(ctx, sid);
        }
        else {
            this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
            this.refreshChangedFiles(ctx);
        }
    }
    private loadSessionInto(ctx: SessionCtx, sid: string): void {
        this.rememberSessionModel(ctx);
        this.rememberSessionSpeed(ctx);
        this.rememberSessionEffort(ctx);
        if (ctx.initialHistoryCached && ctx.sessionId === sid) {
            ctx.initialHistoryCached = false;
            this.renderSessionInto(ctx, sid);
            return;
        }
        const seq = ctx.historyLoadSeq = (ctx.historyLoadSeq ?? 0) + 1;
        const current = () => ctx.sessionId === sid && ctx.historyLoadSeq === seq && this.alive(ctx);
        ctx.historyPending = true;
        this.post(ctx, { kind: "history_status", sessionId: sid });
        const read = ctx.initialHistoryRead ?? this.store.hydrate(sid);
        ctx.initialHistoryRead = undefined;
        void read.then(() => {
            if (current()) this.renderSessionInto(ctx, sid);
        }).catch(e => {
            if (!current()) return;
            this.output.appendLine(`[history] 读取 ${sid.slice(0, 8)} 失败：${String(e)}`);
            this.post(ctx, { kind: "history_status", sessionId: sid, error: `读取历史失败：${String(e)}` });
        });
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
        ctx.historyPending = false;
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
        await this.waitSessionSettings(ctx);
        const old = ctx.sessionId;
        this.resetRestoredNotifications(ctx, old);
        ctx.proc?.dispose();
        ctx.proc = undefined;
        ctx.starting = undefined;
        ctx.sessionId = undefined;
        ctx.historyPending = false;
        ctx.initialHistoryRead = undefined;
        ctx.model = undefined;
        ctx.speedMode = undefined;
        ctx.effort = undefined;
        this.postModelConfig(ctx);
        ctx.blank = true;
        ctx.coldStart = false;
        ctx.pendingPerm = undefined;
        ctx.pendingPerms?.clear();
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
        else this.maybePrespawn(ctx);
    }
    private reportSnapshotSkips(ctx: SessionCtx, snapshot: WorkspaceSnapshot): void {
        const key = this.workspaceDirs().join("\0");
        const problemKey = key + "\0problems";
        const entries = [...snapshot.skipReasons.entries()].sort(([a], [b]) => a.localeCompare(b));
        this.snapshotWarningPaths.set(key, new Set(entries.map(([file]) => file)));
        if (!entries.length) {
            this.snapshotWarningSignatures.delete(key);
            this.snapshotWarningSignatures.delete(problemKey);
            return;
        }
        const signature = JSON.stringify(entries);
        if (this.snapshotWarningSignatures.get(key) === signature) return;
        this.snapshotWarningSignatures.set(key, signature);
        const names: Record<string, string> = { large: "超过 2 MB", binary: "二进制", limit: "扫描或容量上限", symlink: "符号链接", unreadable: "无法读取" };
        const details = entries.map(([file, reason]) => `${vscode.workspace.asRelativePath(file)}（${names[reason]}）`);
        this.output.appendLine(`[snapshot] 未纳入自动回滚快照 ${entries.length} 项：\n${details.join("\n")}`);
        // 格式/体积/链接限制是正常跳过，无需用户逐项目点击“排除”。
        // 保留变更检测：被跳过的资源若真被修改，还原时仍应阻止不完整回滚。
        const problems = entries.filter(([, reason]) => reason === "limit" || reason === "unreadable");
        if (!problems.length) { this.snapshotWarningSignatures.delete(problemKey); return; }
        const problemSignature = JSON.stringify(problems);
        if (this.snapshotWarningSignatures.get(problemKey) === problemSignature) return;
        this.snapshotWarningSignatures.set(problemKey, problemSignature);
        this.post(ctx, { kind: "notice", message: `工作区快照有 ${problems.length} 项读取失败或达到扫描/容量上限，部分文件可能无法完整回滚。无需逐项点击排除；原因见“输出 → Codex Chat”。` });
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
            await this.queueSnapshotExclusionUpdate(async () => {
                const saved = { ...this.context.workspaceState.get<Record<string, string[]>>(LOCAL_SNAPSHOT_EXCLUDES_KEY, {}) };
                for (const [folder, rels] of byFolder)
                    saved[folder] = [...new Set([...(saved[folder] ?? []), ...rels])];
                // 用户从提示卡选择的排除项属于本机偏好，不能写入项目 settings.json。
                await this.context.workspaceState.update(LOCAL_SNAPSHOT_EXCLUDES_KEY, saved);
            });
            this.post(ctx, { kind: "snapshot_exclude_result", ok: true, message: `已在本机排除 ${selected.length} 项，下一轮快照生效；未修改项目文件。`, paths: selected });
        } catch (err) { operationFailure('panel.excludeSnapshotPaths', err);
            this.post(ctx, { kind: "snapshot_exclude_result", ok: false, message: `排除失败：${String(err)}`, paths: [] });
        }
    }
    private queueSnapshotExclusionUpdate(update: () => Promise<void>): Promise<void> {
        const pending = this.snapshotExclusionUpdate.then(update);
        this.snapshotExclusionUpdate = pending.catch(() => {});
        return pending;
    }
    private localSnapshotExcludedPaths(roots: string[]): Set<string> {
        const saved = this.context.workspaceState.get<Record<string, string[]>>(LOCAL_SNAPSHOT_EXCLUDES_KEY, {});
        return new Set(roots.flatMap(root => (saved[root] ?? []).map(rel => path.join(root, rel))));
    }
    async resetLocalSnapshotExcludes(): Promise<void> {
        await this.queueSnapshotExclusionUpdate(async () => { await this.context.workspaceState.update(LOCAL_SNAPSHOT_EXCLUDES_KEY, undefined); });
        this.snapshotWarningSignatures.clear();
        vscode.window.showInformationMessage("已清除当前工作区的本机快照排除记录，下一轮恢复扫描。settings.json 中已有的手动规则保持不变。");
    }
    private async handleSend(ctx: SessionCtx, text: string, context?: string, images?: {
        mediaType: string; data: string;
    }[], files?: string[], allowed?: () => boolean, queueMs?: number, sendId?: string): Promise<boolean> {
        if (ctx.historyPending) {
            this.post(ctx, { kind: "error", message: "历史尚未加载完成，请重试加载后再发送。" });
            return false;
        }
        if (ctx.sending) { this.post(ctx, { kind: 'notice', message: '上一条消息正在准备，请稍后再发送。' }); return false; }
        ctx.sending = true;
        const mySeq = (ctx.sendSeq = (ctx.sendSeq ?? 0) + 1);
        const priorSnapshot = ctx.snapshot;
        let accepted = false;
        try { accepted = await this.handleSendInner(ctx, text, context, images, files, allowed, queueMs, sendId); return accepted; }
        finally {
            if (!accepted && !ctx.proc?.isBusy && ctx.snapshot !== priorSnapshot) ctx.snapshot = undefined;
            ctx.sending = false;
            if (!accepted && (ctx.stopSeq ?? -1) >= mySeq) {
                if (sendId) this.post(ctx, { kind: "send_cancelled", sendId });
                if (!ctx.proc?.isBusy) this.post(ctx, { kind: "busy", busy: false });
            }
        }
    }
    private async handleSendInner(ctx: SessionCtx, text: string, context?: string, images?: {
        mediaType: string;
        data: string;
    }[], files?: string[], allowed?: () => boolean, queueMs?: number, sendId?: string): Promise<boolean> {
        const mySeq = ctx.sendSeq!;
        const trace = performanceContext(queueMs);
        const enabled = this.config().get<boolean>("transportDiagnostics", true);
        const record = (event: string, fields: Record<string, unknown>) => {
            try { if (enabled) this.output.appendLine(`[perf] ${JSON.stringify({ schema: 1, event, traceId: trace.traceId, threadId: ctx.sessionId ?? null, atMs: Date.now(), ...fields })}`); }
            catch { /* 诊断失败不能取消发送 */ }
        };
        const stage = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
            const at = performance.now(); let outcome = "completed";
            try { return await work(); } catch (error) { outcome = "failed"; throw error; }
            finally { record("preparation_stage", { stage: name, durationMs: Math.round(performance.now() - at), outcome }); }
        };
        const syncStage = <T>(name: string, work: () => T): T => {
            const at = performance.now(); let outcome = "completed";
            try { return work(); } catch (error) { outcome = "failed"; throw error; }
            finally { record("preparation_stage", { stage: name, durationMs: Math.round(performance.now() - at), outcome }); }
        };
        let dispatched = false;
        record("preparation_start", { queueMs: trace.queueMs ?? 0, images: images?.length ?? 0, files: files?.length ?? 0 });
        try {
        const prepareAt = Date.now();
        const finalizingAt = performance.now();
        await ctx.finalizing;
        record("preparation_stage", { stage: "previous_finalization_wait", durationMs: Math.round(performance.now() - finalizingAt), outcome: "completed" });
        if ((ctx.stopSeq ?? -1) >= mySeq) return false;
        if (allowed && !allowed()) return false;
        if (ctx.proc?.isBusy || ctx.pendingPerm?.kind === "permission_request") {
            this.post(ctx, { kind: "error", message: "上一轮尚未结束，请先完成问题或审批。", keepBusy: true });
            return false;
        }
        let attached = context;
        if (files && files.length) {
            const fileCtx = syncStage("attachments", () => this.buildFileContext(files));
            attached = attached ? `${fileCtx}\n\n${attached}` : fileCtx;
        }
        const hadSession = !!ctx.sessionId;
        this.post(ctx, { kind: "status", label: "正在准备文件与 Codex 连接…" });
        if (!hadSession) this.prepareProcess(ctx);
        ctx.mayHaveModifiedWorkspace = false;
        if (this.config().get<boolean>("autosave", true)) {
            const saved = await stage("autosave", () => Promise.all(vscode.workspace.textDocuments.filter(d => d.isDirty && !d.isUntitled && vscode.workspace.getWorkspaceFolder(d.uri)).map(d => d.save())));
            if (saved.some(ok => !ok))
                throw new Error("部分文件未保存，已取消发送，避免覆盖编辑器改动。");
        }
        // Existing threads can reconnect while the local snapshot is captured.
        // Keep new-thread creation after the snapshot so Stop can still cancel it.
        const processReady = hadSession ? stage("connection", () => this.ensureProcess(ctx)) : undefined;
        const historyAt = Date.now();
        const historySessionId = ctx.sessionId;
        const historyReady = hadSession && historySessionId ? stage("history", () => this.store.readTurnCount(historySessionId)).finally(() => {
            this.output.appendLine(`[${new Date().toISOString()}] [prepare] 历史读取 ${Date.now() - historyAt}ms`);
        }) : Promise.resolve(0);
        const snapshotReady = (async () => {
            if (!this.config().get<boolean>("snapshotFilesForRestore", true)) return;
            const roots = this.workspaceDirs();
            const excludes = new Map(roots.map(root => [root, vscode.workspace.getConfiguration("codexChat", vscode.Uri.file(root)).get<string[]>("snapshotExclude", [])]));
            const snapshot = new WorkspaceSnapshot(roots, 20000, excludes, this.localSnapshotExcludedPaths(roots));
            const snapshotAt = Date.now();
            await stage("snapshot", () => snapshot.capture());
            record("snapshot_size", { files: snapshot.files.size, skipped: snapshot.skipped.size });
            ctx.snapshot = snapshot;
            this.output.appendLine(`[${new Date().toISOString()}] [snapshot] 基线 ${snapshot.files.size} 文件，跳过 ${snapshot.skipped.size} 项，耗时 ${Date.now() - snapshotAt}ms`);
            this.reportSnapshotSkips(ctx, snapshot);
        })();
        const [lineBefore] = await Promise.all([historyReady, snapshotReady]);
        if ((ctx.stopSeq ?? -1) >= mySeq || (allowed && !allowed())) {
            if ((ctx.stopSeq ?? -1) < mySeq) this.post(ctx, { kind: "busy", busy: false });
            return false;
        }
        // A new thread is only durable after its first turn starts. Do not create
        // it during the (potentially slow) snapshot: Stop may cancel the send.
        this.post(ctx, { kind: "status", label: hadSession ? "正在连接 Codex 会话…" : "正在创建 Codex 会话…" });
        const proc = processReady ? await processReady : await stage("connection", () => this.ensureProcess(ctx));
        if (!proc) {
            if (!allowed) {
                ctx.draft = text; ctx.draftImages = images;
                this.post(ctx, { kind: "draft", text, images });
            }
            this.post(ctx, { kind: "busy", busy: false });
            return false;
        }
        await stage("session_settings_wait", () => this.waitSessionSettings(ctx));
        await proc.setModel(this.sessionModel(ctx));
        await proc.setSpeedMode(this.speedMode(ctx));
        await proc.setEffort(this.sessionEffort(ctx));
        if ((ctx.stopSeq ?? -1) >= mySeq || ctx.proc !== proc || (allowed && !allowed())) {
            if (!hadSession && ctx.proc === proc) {
                ctx.proc = undefined;
                ctx.sessionId = undefined;
                ctx.blank = true;
                ctx.checkpoints.clear();
                void this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
                await proc.disposeAndWait();
            }
            if ((ctx.stopSeq ?? -1) < mySeq) this.post(ctx, { kind: "busy", busy: false });
            return false;
        }
        if (proc.isBusy) {
            // 初始化可能刚恢复出待答问题，不能把“等待输入”误判为进程退出。
            if (!allowed) {
                ctx.draft = text; ctx.draftImages = images;
                this.post(ctx, { kind: "draft", text, images });
            }
            this.post(ctx, { kind: "notice", message: allowed ? "已恢复等待中的问题，请先提交答案；手机消息未发送。" : "已恢复等待中的问题，请先提交答案；新消息已保留为草稿。" });
            return false;
        }
        if (hadSession && ctx.sessionId !== historySessionId) return false;
        if (ctx.remotePrivate && ctx.sessionId && !this.context.workspaceState.get<boolean>('codexChat.remotePrivate.' + ctx.sessionId))
            await this.context.workspaceState.update('codexChat.remotePrivate.' + ctx.sessionId, true);
        if (allowed && (!allowed() || ctx.proc !== proc || proc.isBusy)) return false;
        if (!proc.sendUserMessage(text, attached, images, trace)) {
            this.output.appendLine("[codex] send dropped: process not writable (exited mid-send)");
            if (ctx.proc === proc)
                ctx.proc = undefined;
            this.post(ctx, { kind: "error", message: "codex 进程已退出，本条消息未送出——请重新发送（会自动重启进程）。" });
            if (!allowed) {
                ctx.draft = text; ctx.draftImages = images;
                this.post(ctx, { kind: "draft", text, images });
            }
            this.post(ctx, { kind: "busy", busy: false });
            return false;
        }
        if (allowed) this.post(ctx, { kind: 'remote_user', text });
        dispatched = true;
        if (!hadSession && ctx.sessionId) {
            this.store.notePending(ctx.sessionId, text || "(图片)");
            this.renderSessions();
        }
        if (!allowed) { ctx.draft = undefined; ctx.draftImages = undefined; }
        ctx.sendAt = Date.now();
        this.clearSessionNotification(ctx.sessionId);
        ctx.lastEventAt = ctx.sendAt;
        ctx.lastUserText = (text || "(图片)").slice(0, 200);
        ctx.lastUserActionAt = ctx.sendAt;
        this.output.appendLine(`[${new Date().toISOString()}] [send] session=${ctx.sessionId?.slice(0, 8)} 准备${Date.now() - prepareAt}ms 正文${text.length}字 附加${attached?.length ?? 0}字 图片${images?.length ?? 0}`);
        const checkpointId = ctx.checkpoints.beginTurn(text || "(图片)", lineBefore, !!ctx.snapshot);
        this.post(ctx, { kind: "checkpoint_marker", checkpointId, userText: text, sendId });
        return true;
        } finally { record("preparation_end", { durationMs: Math.round(performance.now() - trace.startedAt), outcome: dispatched ? "dispatched" : "not_dispatched" }); }
    }
    private async editMessage(ctx: SessionCtx, checkpointId: string, text: string, images?: {
        mediaType: string;
        data: string;
    }[]): Promise<void> {
        if (this.forking.has(ctx) || this.restoring.has(ctx) || ctx.answeringQuestion) {
            this.post(ctx, { kind: "notice", message: "派生、还原或答案提交尚未完成，请稍后重新生成。" });
            return;
        }
        this.restoring.add(ctx);
        let restored = false;
        try { restored = await this.editMessageRewind(ctx, checkpointId); }
        finally { this.restoring.delete(ctx); }
        if (restored) {
            // 编辑重发保留前端刚追加的用户气泡，不会通过 load_history 清理还原态。
            // 必须在开始新轮次前显式收尾，否则停止后新消息仍会被当作还原中而排队。
            this.post(ctx, { kind: "restored" });
            await this.handleSend(ctx, text, undefined, images);
        }
    }
    private async editMessageRewind(ctx: SessionCtx, checkpointId: string): Promise<boolean> {
        const sourceId = ctx.sessionId;
        const preparation = sourceId && this.cpMeta(ctx, checkpointId)?.truncateLine
            ? this.store.prepareFork() : undefined;
        const startedAt = performance.now();
        try {
            return await this.editMessageRewindPrepared(ctx, checkpointId, sourceId, preparation);
        } finally {
            await preparation?.dispose();
            this.output.appendLine(`[rewind] 全部准备 elapsedMs=${Math.round(performance.now() - startedAt)}`);
        }
    }
    private async editMessageRewindPrepared(ctx: SessionCtx, checkpointId: string, sourceId: string | undefined,
        preparation?: ForkPreparation): Promise<boolean> {
        await ctx.finalizing;
        if (sourceId) await this.store.hydrate(sourceId);
        if (ctx.sessionId !== sourceId) return false;
        if (sourceId) this.checkpointsForView(ctx, sourceId);
        const rewindAt = Date.now();
        const meta = checkpointId ? this.cpMeta(ctx, checkpointId) : undefined;
        if (!meta) {
            this.post(ctx, {
                kind: "error",
                message: checkpointId ? "找不到该还原点（可能已被清理），无法重新生成。" : "这条消息没有还原点，无法重新生成。",
            });
            this.post(ctx, { kind: "busy", busy: false });
            this.loadCtxSession(ctx);
            return false;
        }
        if (ctx.sessionId && !this.checkpointAligned(ctx.sessionId, meta)) {
            this.post(ctx, { kind: "error", message: "还原点与当前对话不匹配，无法重新生成。" });
            this.post(ctx, { kind: "busy", busy: false });
            this.loadCtxSession(ctx);
            return false;
        }
        this.post(ctx, { kind: "restoring" });
        while (ctx.proc) {
            const dying = ctx.proc;
            ctx.proc = undefined;
            ctx.starting = undefined;
            await dying.disposeAndWait();
        }
        try {
            // 连接已关闭时仍可能保留待整理快照，必须统一收齐。
            await this.captureFinalSnapshot(ctx);
            await this.forkRewind(ctx, checkpointId, meta.truncateLine, undefined, preparation);
        }
        catch (err) {
            this.output.appendLine(`[restore] 派生失败: ${String(err)}`);
            this.post(ctx, { kind: "error", message: `回退对话失败：${String(err)}` });
            this.post(ctx, { kind: "busy", busy: false });
            this.loadCtxSession(ctx);
            return false;
        }
        this.refreshChangedFiles(ctx);
        this.output.appendLine(`[${new Date().toISOString()}] [rewind] 回退准备 ${Date.now() - rewindAt}ms`);
        return true;
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
        const sourceId = ctx.sessionId;
        if (ctx.pendingPerm?.kind !== "permission_request" || ctx.pendingPerm.requestId !== requestId ||
            !ctx.proc?.respondPermission(requestId, { behavior, suggestionId })) return;
        this.resolvePendingPermission(ctx, requestId);
        ctx.lastUserActionAt = Date.now();
        if (ctx.lastEventAt !== undefined) ctx.lastEventAt = Date.now();
        this.clearSessionNotification(sourceId);
    }
    private async updateConfig(key: string, value: unknown): Promise<boolean> {
        const insp = this.config().inspect(key);
        const target = insp?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
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
    /** 同一会话的选择和恢复保存按顺序执行，各会话之间互不等待。 */
    private queueSessionSettings(ctx: SessionCtx, change: () => Promise<void>): Promise<void> {
        const task = (ctx.settingsQueue ?? Promise.resolve()).then(change);
        ctx.settingsQueue = task.catch(() => undefined);
        return task;
    }
    private async waitSessionSettings(ctx: SessionCtx): Promise<void> {
        let pending: Promise<void> | undefined;
        do {
            pending = ctx.settingsQueue;
            await pending;
        } while (pending !== ctx.settingsQueue);
    }
    private postModelConfig(ctx: SessionCtx): void {
        const cfg: ToWebview = {
            kind: "config",
            permissionMode: this.config().get<string>("permissionMode", "default"),
            model: this.sessionModel(ctx),
            effort: this.sessionEffort(ctx),
            speedMode: this.speedMode(ctx),
        };
        this.post(ctx, cfg);
    }
    private broadcastModelConfig(): void {
        for (const session of this.sessions) this.postModelConfig(session);
    }
    private modeSeq = 0;
    private async setPermissionMode(_ctx: SessionCtx, mode: string): Promise<void> {
        const seq = ++this.modeSeq;
        const prev = this.config().get<string>("permissionMode", "default");
        if (!await this.updateConfig("permissionMode", mode)) {
            if (seq === this.modeSeq) this.broadcastModelConfig();
            return;
        }
        if (seq !== this.modeSeq)
            return;
        const broadcast = (m: string): void => {
            for (const ctx of this.sessions) {
                const cfg: ToWebview = {
                    kind: "config",
                    permissionMode: m,
                    model: this.sessionModel(ctx),
                    effort: this.sessionEffort(ctx),
                    speedMode: this.speedMode(ctx),
                    modEnterToSend: this.config().get<boolean>("modEnterToSend", false),
                };
                this.post(ctx, cfg);
            }
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
    /** 公共配置仅作为初始值；空字符串也是会话独立保存的“默认模型”选择。 */
    private sessionModel(ctx: SessionCtx): string {
        if (ctx.model !== undefined) return ctx.model;
        const saved = ctx.sessionId
            ? this.context.workspaceState.get<string>(`codexChat.sessionModel.${ctx.sessionId}`) : undefined;
        ctx.model = typeof saved === "string" ? saved : this.config().get<string>("model", "");
        return ctx.model;
    }
    private async saveSessionModel(ctx: Pick<SessionCtx, "sessionId">, model: string): Promise<void> {
        if (ctx.sessionId)
            await this.context.workspaceState.update(`codexChat.sessionModel.${ctx.sessionId}`, model);
    }
    private rememberSessionModel(ctx: SessionCtx): void {
        this.sessionModel(ctx);
        void this.queueSessionSettings(ctx, () => this.saveSessionModel(ctx, this.sessionModel(ctx))).catch(err => {
            this.output.appendLine(`[sessionModel] ${String(err)}`);
            this.post(ctx, { kind: "error", message: "无法保存此会话的模型，重新打开后可能丢失，请重新选择。" });
        });
    }
    private setModel(ctx: SessionCtx, model: string): Promise<void> {
        return this.queueSessionSettings(ctx, async () => {
            const previousModel = this.sessionModel(ctx);
            const effort = this.sessionEffort(ctx);
            const details = this.modelCatalog.find(m => m.id === model) ?? (model === "" ? this.modelCatalog.find(m => m.isDefault) : undefined);
            const resetEffort = !!(effort && details?.efforts.length && !details.efforts.includes(effort));
            let modelSaved = false;
            try {
                await this.saveSessionModel(ctx, model);
                modelSaved = true;
                if (resetEffort) await this.saveSessionEffort(ctx, "");
            } catch (err) {
                this.output.appendLine(`[sessionModel] ${String(err)}`);
                if (modelSaved)
                    await this.saveSessionModel(ctx, previousModel).catch(e => this.output.appendLine(`[sessionModel] ${String(e)}`));
                this.post(ctx, { kind: "error", message: "无法保存此会话的模型设置，模型切换已取消。" });
                this.postModelConfig(ctx);
                return;
            }
            ctx.model = model;
            if (resetEffort) {
                ctx.effort = "";
                await ctx.proc?.setEffort("");
                this.post(ctx, { kind: "notice", message: "新模型不支持此会话原推理强度，已改用模型默认值。" });
            }
            await ctx.proc?.setModel(model);
            this.postModelConfig(ctx);
        });
    }
    private speedMode(ctx: SessionCtx): SpeedMode {
        if (ctx.speedMode !== undefined) return ctx.speedMode === "ultrafast" ? ctx.speedMode = "default" : ctx.speedMode;
        const savedMode = ctx.sessionId
            ? this.context.workspaceState.get<SpeedMode>(`codexChat.sessionSpeed.${ctx.sessionId}`) : undefined;
        const mode = isSpeedMode(savedMode) && savedMode !== "ultrafast" ? savedMode : savedMode === "ultrafast" ? "default" : this.defaultSpeedMode();
        ctx.speedMode = mode;
        return mode;
    }
    private async saveSessionSpeed(ctx: Pick<SessionCtx, "sessionId">, mode: SpeedMode): Promise<void> {
        if (ctx.sessionId)
            await this.context.workspaceState.update(`codexChat.sessionSpeed.${ctx.sessionId}`, mode);
    }
    private rememberSessionSpeed(ctx: SessionCtx): void {
        this.speedMode(ctx);
        void this.queueSessionSettings(ctx, () => this.saveSessionSpeed(ctx, this.speedMode(ctx))).catch(err => {
            this.output.appendLine(`[sessionSpeed] ${String(err)}`);
            this.post(ctx, { kind: "error", message: "无法保存此会话的速度模式，重新打开后可能丢失，请重新选择。" });
        });
    }
    private defaultSpeedMode(): SpeedMode {
        const cfg = this.config();
        const saved = cfg.inspect<string>("speedMode");
        const explicit = saved?.workspaceFolderValue ?? saved?.workspaceValue ?? saved?.globalValue;
        const mode = configuredSpeedMode(explicit, cfg.get<boolean>("fastMode", false));
        return mode === "ultrafast" ? "default" : mode;
    }
    private setSpeedMode(ctx: SessionCtx, mode: SpeedMode): Promise<void> {
        return this.queueSessionSettings(ctx, async () => {
            if (!isSpeedMode(mode) || mode === "ultrafast") {
                this.post(ctx, { kind: "error", message: "无效的速度模式。" });
                this.postModelConfig(ctx);
                return;
            }
            const model = this.sessionModel(ctx) || ctx.proc?.modelForNextTurn || "";
            const details = this.modelCatalog.find(m => m.id === model);
            if (!supportsSpeed(details, mode)) {
                this.post(ctx, { kind: "error", message: model
                    ? `当前账号的模型「${model}」未提供${speedLabel(mode)}档位，或能力尚未确认；请选择可用档位。`
                    : "默认模型尚未确认，请先选择具体模型再切换加速档位。" });
                this.postModelConfig(ctx);
                return;
            }
            // 有会话 ID 时先保存，失败不能改变正在使用的档位。
            try {
                await this.saveSessionSpeed(ctx, mode);
            } catch (err) {
                this.output.appendLine(`[sessionSpeed] ${String(err)}`);
                this.post(ctx, { kind: "error", message: "无法保存此会话的速度模式，请重试。" });
                this.postModelConfig(ctx);
                return;
            }
            ctx.speedMode = mode;
            await ctx.proc?.setSpeedMode(mode);
            this.postModelConfig(ctx);
            this.post(ctx, { kind: "speed_mode_saved", mode });
        });
    }
    /** 默认设置只用于初始化；同一个会话的选择独立保存，不广播到其他会话。 */
    private sessionEffort(ctx: SessionCtx): string {
        if (ctx.effort !== undefined) return ctx.effort;
        const saved = ctx.sessionId
            ? this.context.workspaceState.get<string>(`codexChat.sessionEffort.${ctx.sessionId}`) : undefined;
        ctx.effort = typeof saved === "string" ? saved : this.config().get<string>("effort", "medium");
        return ctx.effort;
    }
    private async saveSessionEffort(ctx: Pick<SessionCtx, "sessionId">, effort: string): Promise<void> {
        if (ctx.sessionId)
            await this.context.workspaceState.update(`codexChat.sessionEffort.${ctx.sessionId}`, effort);
    }
    private rememberSessionEffort(ctx: SessionCtx): void {
        this.sessionEffort(ctx);
        void this.queueSessionSettings(ctx, () => this.saveSessionEffort(ctx, this.sessionEffort(ctx))).catch(err => {
            this.output.appendLine(`[sessionEffort] ${String(err)}`);
            this.post(ctx, { kind: "error", message: "无法保存此会话的推理强度，重新打开后可能丢失，请重新选择。" });
        });
    }
    private setEffort(ctx: SessionCtx, effort: string): Promise<void> {
        return this.queueSessionSettings(ctx, async () => {
            const model = this.sessionModel(ctx) || ctx.proc?.modelForNextTurn || "";
            const details = this.modelCatalog.find(m => m.id === model) ?? (model === "" ? this.modelCatalog.find(m => m.isDefault) : undefined);
            const supported = details?.efforts.length ? details.efforts : ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
            if (typeof effort !== "string" || (effort && !supported.includes(effort))) {
                this.post(ctx, { kind: "error", message: `当前模型不支持推理强度「${effort}」。` });
                this.postModelConfig(ctx);
                return;
            }
            try {
                await this.saveSessionEffort(ctx, effort);
            } catch (err) {
                this.output.appendLine(`[sessionEffort] ${String(err)}`);
                this.post(ctx, { kind: "error", message: "无法保存此会话的推理强度，请重试。" });
                this.postModelConfig(ctx);
                return;
            }
            ctx.effort = effort;
            await ctx.proc?.setEffort(effort);
            this.postModelConfig(ctx);
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
            catch (error) { operationFailure('panel.openDiff', error);
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
            this.post(ctx, { kind: "notice", message: `回滚失败，已保留文件备份，可修复后重试：${absPath}（${String(err)}）` });
            return;
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
            .map((d) => d.save().then(saved => { if (!saved) operationLog('autosave.tool', 'unavailable'); }, error => operationFailure('autosave.tool', error)));
        if (!saves.length)
            return;
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([Promise.all(saves), new Promise<void>(resolve => { timer = setTimeout(() => { operationLog('autosave.tool', 'fallback', { reason: 'timeout' }); resolve(); }, 2000); })]); }
        finally { clearTimeout(timer); }
    }
    private refreshChangedFiles(ctx: SessionCtx): void {
        if (!this.alive(ctx))
            return;
        ctx.changedFilesRefreshPending = true;
        if (ctx.changedFilesRefresh) return;
        // 工具可能连续返回：合并刷新，异步读取不能挡住停止消息和停止超时计时器。
        ctx.changedFilesRefresh = (async () => {
            await new Promise<void>(resolve => setImmediate(resolve));
            while (ctx.changedFilesRefreshPending && this.alive(ctx)) {
                ctx.changedFilesRefreshPending = false;
                const checkpoints = ctx.checkpoints, sessionId = ctx.sessionId;
                const changes = await this.getChangedFiles(ctx);
                if (!this.alive(ctx) || ctx.checkpoints !== checkpoints || ctx.sessionId !== sessionId) continue;
                if (ctx.changedFilesRefreshPending) continue;
                for (const f of changes.files)
                    this.origChanged.fire(vscode.Uri.from({ scheme: ORIG_SCHEME, path: f.path }));
                this.post(ctx, { kind: "changed_files", ...changes });
            }
        })().catch(err => {
            this.output.appendLine(`[changed-files] ${String(err)}`);
        }).finally(() => { ctx.changedFilesRefresh = undefined; });
    }
    private async getChangedFiles(ctx: SessionCtx): Promise<{
        files: ChangedFile[];
        totalAdded: number;
        totalRemoved: number;
    }> {
        const files: ChangedFile[] = [];
        let totalAdded = 0;
        let totalRemoved = 0;
        const checkpoints = ctx.checkpoints;
        for (const p of checkpoints.changedPaths()) {
            const original = checkpoints.originalOf(p);
            if (original === undefined)
                continue;
            const content = await readDiffFile(p);
            if (!content || (original === null && !content.exists)) continue;
            const { exists, text: current, unavailable } = content;
            const status: ChangedFile["status"] = original === null ? "added" : exists ? "modified" : "deleted";
            if (unavailable) {
                files.push({ path: p, rel: vscode.workspace.asRelativePath(p), added: 0, removed: 0, status, diffUnavailable: unavailable });
                continue;
            }
            if (exists && original === current) continue;
            const { added, removed } = diffCounts(original ?? "", current ?? "");
            if (added === 0 && removed === 0 && status === "modified")
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
        if (this.restoring.has(ctx)) {
            this.post(ctx, { kind: "notice", message: "正在还原，请完成后再派生。" });
            this.post(ctx, { kind: "forking", checkpointId, busy: false });
            return;
        }
        this.forking.add(ctx);
        const startedAt = performance.now();
        this.post(ctx, { kind: "forking", checkpointId, busy: true, label: "等待确认派生…" });
        try {
            await this.forkCheckpointInner(ctx, checkpointId);
        } catch (error) {
            this.output.appendLine(`[fork] ${String(error)}`);
            this.post(ctx, { kind: "error", message: `派生失败：${String(error)}`, keepBusy: true });
        } finally {
            this.forking.delete(ctx);
            this.post(ctx, { kind: "forking", checkpointId, busy: false });
            this.output.appendLine(`[fork] session=${ctx.sessionId?.slice(0, 8)} 总耗时 ${Math.round(performance.now() - startedAt)}ms（含用户确认）`);
        }
    }
    private async forkCheckpointInner(ctx: SessionCtx, checkpointId: string): Promise<void> {
        const sourceId = ctx.sessionId;
        if (!sourceId || !this.cpMeta(ctx, checkpointId)) {
            this.post(ctx, { kind: "error", message: "找不到该还原点，无法派生。" });
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
        const preparation = this.store.prepareFork();
        try { await this.forkCheckpointPrepared(ctx, checkpointId, sourceId, preparation); }
        finally { await preparation.dispose(); }
    }
    private async forkCheckpointPrepared(ctx: SessionCtx, checkpointId: string, sourceId: string, preparation: ForkPreparation): Promise<void> {
        const startedAt = performance.now();
        const progress = (label: string) => {
            this.post(ctx, { kind: "forking", checkpointId, busy: true, label });
            this.output.appendLine(`[fork] session=${sourceId.slice(0, 8)} ${label} +${Math.round(performance.now() - startedAt)}ms`);
        };
        progress("正在读取派生位置的对话…");
        await ctx.finalizing;
        if (ctx.sessionId !== sourceId) {
            this.post(ctx, { kind: "error", message: "原会话已切换，请重新选择派生位置。" });
            return;
        }
        // 直播期间缓存可能尚未包含当前轮次；确认期间还原点位置也可能更新。
        // 与还原流程一致，读取最新历史并重新对齐后，再取元数据校验和截断。
        await this.store.hydrate(sourceId);
        if (ctx.sessionId !== sourceId) {
            this.post(ctx, { kind: "error", message: "原会话已切换，请重新选择派生位置。" });
            return;
        }
        this.checkpointsForView(ctx, sourceId);
        const meta = this.cpMeta(ctx, checkpointId);
        if (!meta) {
            this.post(ctx, { kind: "error", message: "找不到该还原点，无法派生。" });
            return;
        }
        if (!this.checkpointAligned(sourceId, meta)) {
            this.post(ctx, { kind: "error", message: "还原点与当前对话不匹配，已取消派生。" });
            return;
        }
        const cut = meta.truncateLine;
        if (cut <= 0) {
            this.post(ctx, { kind: "notice", message: "该点之前没有对话内容，无法派生新会话。" });
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
            progress("正在创建独立会话…");
            newId = await this.store.fork(sourceId, leaf, preparation);
        }
        catch (err) {
            this.output.appendLine(`[fork] ${String(err)}`);
            this.post(ctx, { kind: "error", message: `派生失败：${String(err)}` });
            return;
        }
        progress("正在复制文件还原点…");
        this.assertForkDestination(sourceId, newId);
        await this.waitSessionSettings(ctx);
        if (ctx.sessionId !== sourceId) {
            this.refreshSessions();
            this.post(ctx, { kind: "notice", message: "派生会话已创建，原窗口已切换。可从会话历史打开新分支。" });
            return;
        }
        const copied = CheckpointManager.forkFor(this.storageDir(), sourceId, newId, cut, this.store.userTurnLines(newId));
        if (ctx.checkpoints.hasAny() && !copied) {
            try { await this.store.delete(newId); }
            finally { CheckpointManager.deleteFor(this.storageDir(), newId); }
            this.post(ctx, { kind: "error", message: "派生失败：复制文件还原点失败，原会话未受影响。" });
            return;
        }
        const model = this.sessionModel(ctx), speed = this.speedMode(ctx), effort = this.sessionEffort(ctx);
        try {
            await this.saveSessionModel({ sessionId: newId }, model);
            await this.saveSessionSpeed({ sessionId: newId }, speed);
            await this.saveSessionEffort({ sessionId: newId }, effort);
        } catch (err) {
            this.output.appendLine(`[sessionSettings] ${String(err)}`);
            this.post(ctx, { kind: "error", message: "派生会话已创建，但模型、速度或推理强度未能保存，请在新会话中重新选择。" });
        }
        try {
            progress("正在打开新会话…");
            await this.openSession(newId, true);
        } catch (err) {
            this.output.appendLine(String(err));
            this.refreshSessions();
            this.post(ctx, { kind: "error", message: "派生会话已创建，但新窗口未能打开。可从会话历史中打开。" });
            return;
        }
        vscode.window.showInformationMessage("已从该点派生新会话，与原会话互不影响。");
    }
    private assertForkDestination(sourceId: string, newId: string): void {
        if (newId === sourceId || [...this.sessions, ...this.detached.values()].some(ctx => ctx.sessionId === newId) ||
            fs.existsSync(path.join(this.storageDir(), `checkpoints-${newId}.json`)) ||
            fs.existsSync(questionStateFile(this.storageDir(), newId)))
            throw new Error("派生会话 ID 与现有会话冲突，已中止，未覆盖或删除已有会话。");
    }
    private checkpointsForView(ctx: SessionCtx, sid: string): CheckpointSummary[] {
        const real = ctx.checkpoints.list();
        const turns = this.store.userTurnLines(sid);
        const norm = checkpointTextKey;
        const assigned = new Map<number, CheckpointSummary>();
        let from = 0;
        for (const c of real) {
            for (let k = from; k < turns.length; k++) {
                const t = turns[k];
                if (c.userText.startsWith(QUESTION_REPLY_PREFIX) && t.line - 1 !== ctx.checkpoints.cutLineOf(c.id)) continue;
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
        const norm = checkpointTextKey;
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
    private async forkRewind(ctx: SessionCtx, checkpointId: string, cutLine: number, prepareBranch?: (id: string) => void, preparation?: ForkPreparation): Promise<{
        result: NonNullable<ReturnType<CheckpointManager["restore"]>>;
        rewoundToStart: boolean;
    }> {
        await this.waitSessionSettings(ctx);
        const oldId = ctx.sessionId;
        this.sessionModel(ctx);
        this.speedMode(ctx);
        this.sessionEffort(ctx);
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
            if (prepareBranch) throw new Error("缺少提问轮次，未回滚文件或对话");
            let result: ReturnType<CheckpointManager["restore"]>;
            try { result = this.cpRestore(ctx, checkpointId, cutLine); }
            finally { preserveOldCheckpoints(); }
            if (!result)
                throw new Error("找不到该还原点");
            this.resetRestoredNotifications(ctx, oldId);
            ctx.sessionId = undefined;
            ctx.checkpoints = new CheckpointManager(this.storageDir());
            if (this.context.workspaceState.get<string>(LAST_SESSION_KEY) === oldId)
                await this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
            return { result, rewoundToStart: true };
        }
        const newId = await this.store.fork(oldId, leaf, preparation);
        this.assertForkDestination(oldId, newId);
        const copied = CheckpointManager.forkFor(this.storageDir(), oldId, newId, cutLine, this.store.userTurnLines(newId));
        if (ctx.checkpoints.hasAny() && !copied) {
            try { await this.store.delete(newId); }
            finally { CheckpointManager.deleteFor(this.storageDir(), newId); }
            throw new Error("复制文件还原点失败，原会话未受影响");
        }
        let result: ReturnType<CheckpointManager["restore"]>;
        try {
            await this.waitSessionSettings(ctx);
            // 必须先保存待回答状态，落盘失败时不能已经回滚工作区。
            prepareBranch?.(newId);
            result = this.cpRestore(ctx, checkpointId, cutLine);
        }
        catch (err) {
            try {
                await this.store.delete(newId);
                CheckpointManager.deleteFor(this.storageDir(), newId);
                if (prepareBranch) {
                    deleteQuestionState(this.storageDir(), newId);
                    fs.rmSync(questionStateFile(this.storageDir(), newId) + ".tmp", { force: true });
                }
            } catch (cleanupError) {
                this.output.appendLine(`[restore] 清理未完成分支 ${newId} 失败：${String(cleanupError)}`);
            }
            throw err;
        }
        finally { preserveOldCheckpoints(); }
        if (!result) {
            await this.store.delete(newId);
            CheckpointManager.deleteFor(this.storageDir(), newId);
            if (prepareBranch) deleteQuestionState(this.storageDir(), newId);
            throw new Error("找不到该还原点");
        }
        ctx.checkpoints = new CheckpointManager(this.storageDir());
        ctx.checkpoints.setSession(newId);
        this.resetRestoredNotifications(ctx, oldId);
        ctx.sessionId = newId;
        this.rememberSessionModel(ctx);
        this.rememberSessionSpeed(ctx);
        this.rememberSessionEffort(ctx);
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
    private async submitQuestionAnswer(ctx: SessionCtx, requestId: string, answers: Record<string, string | string[]>, images?: QuestionImages): Promise<void> {
        const startedAt = performance.now();
        // 子 Agent 的阻塞提问答回原请求，不能为根会话派生新轮次或重建文件快照。
        if (ctx.proc?.isChildQuestion?.(requestId)) {
            if (!await ctx.proc.answerChildQuestion(requestId, answers, images))
                throw new Error("子 Agent 问题已失效，答案未提交。");
            void this.clearSessionNotification(ctx.sessionId, "question_answer");
            return;
        }
        const seq = ctx.questionAnswerSeq = (ctx.questionAnswerSeq ?? 0) + 1;
        await this.waitSessionSettings(ctx);
        const proc = ctx.proc && !ctx.proc.isExited ? ctx.proc : await this.ensureProcess(ctx);
        if (ctx.questionAnswerSeq !== seq) {
            if (ctx.proc === proc && ctx.pendingPerm?.kind === "permission_request" && ctx.pendingPerm.requestId === requestId) await proc?.interrupt();
            throw new Error("答案提交已取消。");
        }
        const sourceId = ctx.sessionId;
        const answer = proc?.prepareQuestionAnswer(requestId, answers, images);
        if (!sourceId || !proc || !answer) throw new Error("答案未提交，问题可能已失效，请重新打开会话后重试。");
        this.output.appendLine(`[question] preparing session=${sourceId}`);
        await this.store.hydrate(sourceId);
        this.output.appendLine(`[question] hydrated session=${sourceId} elapsedMs=${Math.round(performance.now() - startedAt)}`);
        const cut = this.store.countLines(sourceId);
        if (this.store.rewindLeafFor(sourceId, cut) !== answer.turnId) throw new Error("问题与当前会话进度不一致，未提交答案，请重新打开会话。");
        if (ctx.questionAnswerSeq !== seq || ctx.proc !== proc || ctx.sessionId !== sourceId) throw new Error("提交已取消，原问题或会话状态已变化。");
        // 将问题之前的改动先归入原还原点，再为答案之后的改动建立独立基线。
        await this.captureFinalSnapshot(ctx);
        let snapshot: WorkspaceSnapshot | undefined;
        if (this.config().get<boolean>("snapshotFilesForRestore", true)) {
            const roots = this.workspaceDirs();
            const excludes = new Map(roots.map(root => [root, vscode.workspace.getConfiguration("codexChat", vscode.Uri.file(root)).get<string[]>("snapshotExclude", [])]));
            snapshot = new WorkspaceSnapshot(roots, 20000, excludes, this.localSnapshotExcludedPaths(roots));
            await snapshot.capture();
        }
        this.output.appendLine(`[question] snapshot_ready session=${sourceId} elapsedMs=${Math.round(performance.now() - startedAt)}`);
        await this.waitSessionSettings(ctx);
        if (ctx.questionAnswerSeq !== seq || ctx.proc !== proc || ctx.sessionId !== sourceId || !proc.prepareQuestionAnswer(requestId, answers, images)) throw new Error("提交已取消，原问题或会话状态已变化。");
        const displayText = userView([{ type: "text", text: answer.text }]).text;
        const checkpointId = ctx.checkpoints.beginTurn(displayText, cut, !!snapshot);
        ctx.snapshot = snapshot;
        try {
            if (!proc.answerQuestion(requestId, answers, images)) throw new Error("问题已失效，答案未提交。");
        } catch (err) {
            ctx.checkpoints.discardEmpty(checkpointId);
            throw err;
        }
        this.output.appendLine(`[question] handed_off session=${sourceId} elapsedMs=${Math.round(performance.now() - startedAt)}; clearing_notification=true`);
        void this.clearSessionNotification(sourceId, "question_answer");
        this.post(ctx, { kind: "question_checkpoint", requestId, checkpointId });
        if (snapshot) this.reportSnapshotSkips(ctx, snapshot);
    }
    private async restoreCheckpoint(ctx: SessionCtx, checkpointId: string, reanswer = false,
        draft?: Extract<FromWebview, { type: "restoreCheckpoint" }>["draft"]): Promise<void> {
        if (this.forking.has(ctx)) {
            this.post(ctx, { kind: "notice", message: "正在派生，请完成后再还原。" });
            return;
        }
        if (ctx.answeringQuestion) {
            this.post(ctx, { kind: "notice", message: "答案正在提交，请等提交完成后再还原或重新回答。" });
            return;
        }
        if (this.restoring.has(ctx)) return;
        this.restoring.add(ctx);
        try {
            await this.restoreCheckpointInner(ctx, checkpointId, reanswer, draft);
        } finally {
            this.restoring.delete(ctx);
        }
    }
    private async restoreCheckpointInner(ctx: SessionCtx, checkpointId: string, reanswer = false,
        draft?: Extract<FromWebview, { type: "restoreCheckpoint" }>["draft"]): Promise<void> {
        const sourceId = ctx.sessionId;
        const blocked = reanswer ? ctx.checkpoints.restoreBlockReason(checkpointId, false) : undefined;
        if (blocked) {
            this.post(ctx, { kind: "notice", message: `无法完整还原并重新回答：${blocked}。未回退对话或修改文件；请使用更早且具备文件快照的还原点。` });
            return;
        }
        const preview = this.cpPreview(ctx, checkpointId);
        const confirm = await vscode.window.showWarningMessage(reanswer ? "还原到提交这次答案之前，重新回答？" : "还原到这条消息之前？", {
            modal: true,
            detail: (preview ? `消息：${preview.userText}\n\n` : "") +
                (reanswer ? "将撤回旧答案及之后的全部对话，并回滚旧答案提交后的文件改动（包括后续轮次和已点击保留的改动）。完成还原后重新展示问题卡，提交新答案后才继续。\n\n" : "") + (checkpointId.startsWith("turn:")
                    ? "当前窗口会从这里开新分支，原会话保留在历史中。此处没有可用的文件快照：只回退对话，工作区文件保持现状。"
                    : "将回滚此后的文件改动，并从这里开新分支；原会话保留在历史中。文件回滚不可撤销。") +
                (ctx.proc?.isBusy ? "\n\nCodex 正在回复中，还原会先自动停止本轮。" : ""),
        }, "还原");
        if (confirm !== "还原")
            return;
        if (!sourceId || ctx.sessionId !== sourceId) {
            this.post(ctx, { kind: "error", message: "原会话已切换，请重新选择还原位置。" });
            return;
        }
        // 仅准备连接，不创建分支或修改文件；与历史读取、旧进程退出并行。
        const preparation = this.cpMeta(ctx, checkpointId)?.truncateLine
            ? this.store.prepareFork() : undefined;
        const startedAt = performance.now();
        try {
            await this.restoreCheckpointPrepared(ctx, checkpointId, reanswer, sourceId, preparation, startedAt, draft);
        } finally {
            await preparation?.dispose();
            this.output.appendLine(`[restore] 流程结束 elapsedMs=${Math.round(performance.now() - startedAt)}`);
        }
    }
    private async restoreCheckpointPrepared(ctx: SessionCtx, checkpointId: string, reanswer: boolean,
        sourceId: string, preparation: ForkPreparation | undefined, startedAt: number,
        draft?: Extract<FromWebview, { type: "restoreCheckpoint" }>["draft"]): Promise<void> {
        const progress = (label: string) => {
            this.post(ctx, { kind: "status", label });
            this.output.appendLine(`[restore] ${label} +${Math.round(performance.now() - startedAt)}ms`);
        };
        progress("正在读取还原位置的对话…");
        await this.store.hydrate(sourceId);
        if (ctx.sessionId !== sourceId) return;
        this.checkpointsForView(ctx, sourceId);
        const meta = this.cpMeta(ctx, checkpointId);
        if (!meta) {
            this.post(ctx, { kind: "error", message: "找不到该还原点。" });
            return;
        }
        const question = reanswer ? this.store.questionBeforeAnswer(sourceId, meta.truncateLine) : undefined;
        if (reanswer && !question) {
            this.post(ctx, { kind: "notice", message: "这条旧问题没有可确认的独立回答轮次，无法准确还原到回答前。可以还原到它之前的用户消息重新提问。" });
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
        if (reanswer) this.post(ctx, { kind: "busy", busy: true });
        this.post(ctx, { kind: "restoring" });
        progress("正在停止原会话…");
        while (ctx.proc) {
            const dying = ctx.proc;
            ctx.proc = undefined;
            ctx.starting = undefined;
            await dying.disposeAndWait();
        }
        if (!reanswer) this.post(ctx, { kind: "busy", busy: false });
        let rewind: {
            result: NonNullable<ReturnType<CheckpointManager["restore"]>>;
            rewoundToStart: boolean;
        };
        let restoredQuestion: PermissionRequest | undefined;
        try {
            progress("正在收齐文件快照…");
            await this.captureFinalSnapshot(ctx);
            if (reanswer) {
                // 停止进行中的工具并收齐最后一批文件变更后，再做一次完整性检查。
                const reason = ctx.checkpoints.restoreBlockReason(checkpointId);
                if (reason) throw new Error(`无法完整回滚文件，未回退对话：${reason}`);
                const cuts = new Set(ctx.checkpoints.list().map(cp => ctx.checkpoints.cutLineOf(cp.id)));
                if (this.store.userTurnLines(sourceId).some(turn => turn.line - 1 >= meta.truncateLine && !cuts.has(turn.line - 1)))
                    throw new Error("后续轮次缺少文件还原点，未回退对话");
            }
            progress("正在创建分支并还原文件…");
            rewind = await this.forkRewind(ctx, checkpointId, meta.truncateLine, question ? newId => {
                const turnId = this.store.rewindLeafFor(newId, this.store.countLines(newId));
                if (!turnId) throw new Error("新分支缺少提问轮次，无法重新回答");
                restoredQuestion = { requestId: randomUUID(), toolName: "AskUserQuestion", ...question, suggestions: [] };
                saveQuestionState(this.storageDir(), newId, turnId, restoredQuestion);
            } : undefined, preparation);
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
                `已还原 ${result.restoredFiles} 个文件，${reanswer ? "请修改问题卡中的答案并重新提交" : "从这条消息之前继续"}。原会话保留在历史中。${skippedNote}`,
        });
        if (restoredQuestion) {
            ctx.draft = undefined;
            ctx.draftImages = undefined;
            this.post(ctx, { kind: "busy", busy: true });
            this.onPermission(ctx, restoredQuestion);
            this.refreshChangedFiles(ctx);
            return;
        }
        const draftText = draft ? draft.text : result.userText === "(图片)" ? "" : result.userText;
        const draftImages = draft ? draft.images : nextTurn?.images.length ? nextTurn.images : undefined;
        if (draftText || draftImages) {
            ctx.draft = draftText;
            ctx.draftImages = draftImages;
            this.post(ctx, { kind: "draft", ...draft, text: draftText, images: draftImages });
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
        if (ctx.proc?.currentSessionId)
            return Promise.resolve(ctx.proc);
        ctx.starting = this.spawnProcess(ctx).finally(() => {
            ctx.starting = undefined;
        });
        return ctx.starting;
    }
    private createProcess(ctx: SessionCtx): CodexProcess {
        const proc = new CodexProcess({
            questionStateDir: this.storageDir(),
            codexPath: this.config().get<string>("codexPath", "codex"),
            transportDiagnostics: this.config().get<boolean>("transportDiagnostics", true),
            compactionMode: this.config().get<string>("compactionMode", "balanced") === "session" ? "session" : "balanced",
            compactionModel: this.config().get<string>("compactionModel", "auto"),
            compactionAutoValidate: this.config().get<boolean>("compactionAutoValidate", true),
            compactionStateDir: path.join(this.storageDir(), "compaction-models"),
            executionMode: executionMode(this.config().get<string>("executionMode", "parallel")),
            cwd: this.cwd(),
            model: this.sessionModel(ctx) || undefined,
            effort: this.sessionEffort(ctx) || undefined,
            speedMode: this.speedMode(ctx),
            permissionMode: this.config().get<string>("permissionMode", "default"),
            resumeSessionId: ctx.sessionId,
            addDirs: this.workspaceDirs(),
            appendSystemPrompt: this.config().get<string>("appendSystemPrompt", "") || undefined,
        }, {
            emit: (e) => this.handleEmit(ctx, e),
            onPreTool: (name, input) => this.autosaveBefore(name, input),
            onPermission: (req) => this.onPermission(ctx, req),
            onSessionId: (id, resumed) => this.onSessionId(ctx, id, resumed),
            onClose: (code) => this.onProcessClose(ctx, code, proc),
        });
        return proc;
    }
    private prepareProcess(ctx: SessionCtx): CodexProcess {
        if (ctx.proc && !ctx.proc.isExited) return ctx.proc;
        const proc = this.createProcess(ctx);
        ctx.proc = proc;
        const t0 = Date.now();
        void proc.prepare().then(() => {
            this.output.appendLine(`[codex] connection prepared in ${Date.now() - t0}ms (threadCreated=false)`);
        }).catch(() => {
            proc.dispose();
            if (ctx.proc === proc) ctx.proc = undefined;
            this.output.appendLine("[codex] connection preparation failed; retry on send");
        });
        return proc;
    }
    private async spawnProcess(ctx: SessionCtx): Promise<CodexProcess | undefined> {
        this.speedMode(ctx);
        const isResume = !!ctx.sessionId;
        const sessionId = ctx.sessionId;
        const proc = ctx.proc ?? this.createProcess(ctx);
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
                this.output.appendLine(`[codex] 归档会话 ${sessionId!.slice(0, 8)} 无法继续，保留历史查看`);
                ctx.proc = undefined;
                this.post(ctx, { kind: "notice", message: "会话已归档，暂时无法继续对话。历史和输入内容已保留，可在会话列表中删除此归档记录。" });
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
        // 打开归档记录只查看历史，不自动恢复或切换为空白会话。
        if (ctx.sessionId && this.store.isArchived(ctx.sessionId)) return;
        if (!this.config().get<boolean>("prespawnOnOpen", true) && !(ctx.sessionId && fs.existsSync(questionStateFile(this.storageDir(), ctx.sessionId))))
            return;
        if (!ctx.sessionId) {
            this.prepareProcess(ctx);
            return;
        }
        if (ctx.proc || ctx.starting)
            return;
        void this.ensureProcess(ctx);
    }
    private async compactSession(ctx: SessionCtx): Promise<void> {
        if (ctx.compactionPreparing) return;
        if (this.forking.has(ctx) || this.restoring.has(ctx) || ctx.answeringQuestion) {
            this.post(ctx, { kind: "notice", message: "会话操作尚未完成，请稍后压缩。" });
            return;
        }
        ctx.compactionPreparing = true;
        try { await this.compactSessionPrepared(ctx); }
        finally { ctx.compactionPreparing = false; }
    }
    private async compactSessionPrepared(ctx: SessionCtx): Promise<void> {
        const sourceId = ctx.sessionId;
        if (!sourceId) {
            this.post(ctx, { kind: "notice", message: "当前没有可压缩的会话。" });
            return;
        }
        if (!this.alive(ctx)) {
            vscode.window.showInformationMessage("该会话的窗口已关闭，请重新打开会话后再压缩。");
            return;
        }
        if (ctx.proc?.isBusy) {
            vscode.window.showInformationMessage("当前会话正在回复中，等这一轮结束再压缩。");
            return;
        }
        const startedAt = performance.now();
        const reusedProcess = !!ctx.proc && !ctx.proc.isExited;
        const logPreparation = (stage: string, outcome?: string) => this.output.appendLine(
            `[${new Date().toISOString()}] [diag] session=${ctx.sessionId?.slice(0, 8)} [compaction_prepare] ${JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - startedAt), reusedProcess, outcome })}`);
        logPreparation("start");
        let proc: CodexProcess | undefined;
        try { proc = await this.ensureProcess(ctx); }
        finally { logPreparation("end", proc ? "ready" : "failed"); }
        if (!proc) {
            this.post(ctx, { kind: "busy", busy: false });
            vscode.window.showErrorMessage("启动 Codex 失败，无法压缩。");
            return;
        }
        // 刚切换速度后立即压缩，需等本会话设置保存并传入进程，再读取所选档位。
        await this.waitSessionSettings(ctx);
        if (!this.alive(ctx)) {
            vscode.window.showInformationMessage("会话窗口已关闭，本次压缩已取消。");
            return;
        }
        if (ctx.sessionId !== sourceId || ctx.proc !== proc ||
            this.forking.has(ctx) || this.restoring.has(ctx) || ctx.answeringQuestion ||
            proc.isBusy || proc.isExited) return;
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
        this.reviveNotifyPanel(panel);
    }
    /** 新建与窗口重载共用完整初始化：恢复 HTML、消息监听和配置订阅。 */
    reviveNotifyPanel(panel: vscode.WebviewPanel): void {
        if (this.notifyPanel === panel) return;
        // 命令可能先于 VS Code 的恢复回调创建面板，只保留已可用的那一个。
        if (this.notifyPanel) {
            panel.dispose();
            return;
        }
        this.notifyPanel = panel;
        panel.title = "任务推送";
        panel.webview.options = { enableScripts: true };
        let saving = false;
        const messageSub = panel.webview.onDidReceiveMessage(async (m: FromWebview) => {
            try {
                switch (m.type) {
                    case "webviewError":
                        this.output.appendLine(`[${new Date().toISOString()}] [webview] 推送面板脚本错误: ${m.message}`);
                        break;
                    case "notifyLoad":
                        this.postNotifyConfig();
                        break;
                    case "notifySave": {
                        if (saving) break;
                        const quietHours = parseQuietHours(m.quietHours);
                        if (!quietHours) {
                            postWebviewMessage(panel.webview, { kind: "notify_result", ok: false, message: "工作时间必须是同一天的 HH:mm，结束时间须晚于开始时间，例如 08:30–18:00。" } satisfies ToWebview);
                            break;
                        }
                        if (!Number.isInteger(m.usageThresholdPct) || m.usageThresholdPct < 1 || m.usageThresholdPct > 100) {
                            postWebviewMessage(panel.webview, { kind: "notify_result", ok: false, message: "每周用量预警阈值须为 1–100 的整数。" } satisfies ToWebview);
                            break;
                        }
                        saving = true;
                        try {
                            const cfg = vscode.workspace.getConfiguration("codexChat");
                            await cfg.update("notifyWebhook", m.webhook.trim(), vscode.ConfigurationTarget.Global);
                            await cfg.update("notifyMinDurationSec", Math.max(0, Math.round(m.minSec) || 0), vscode.ConfigurationTarget.Global);
                            await cfg.update("notifyLocal", m.local === true, vscode.ConfigurationTarget.Global);
                            await cfg.update("notifyFeishuQuietHours", quietHours, vscode.ConfigurationTarget.Global);
                            await cfg.update("notifyUsageThresholdPct", m.usageThresholdPct, vscode.ConfigurationTarget.Global);
                            await cfg.update("notifyUsageFeishu", m.usageFeishu === true, vscode.ConfigurationTarget.Global);
                            await cfg.update("notifyUsageLocal", m.usageLocal === true, vscode.ConfigurationTarget.Global);
                        } finally { saving = false; }
                        this.postNotifyConfig();
                        postWebviewMessage(panel.webview, { kind: "notify_result", ok: true,
                            message: m.usageFeishu && !m.webhook.trim() ? "已保存；飞书用量预警需要填写上方 Webhook 地址。" : "已保存。" } satisfies ToWebview);
                        break;
                    }
                    case "notifyCalendarRefresh": {
                        await this.workdayCalendar.refresh(true);
                        this.postNotifyCalendar();
                        break;
                    }
                    case "notifyLocalTest": {
                        try {
                            const notice = formatLocalNotification("🔔 Codex Copilot 本机通知测试", {
                                project: localNotificationProject(),
                                question: "点击返回当前窗口的任务推送设置。",
                            });
                            await this.sendLocalNotice(notice.title, notice.body);
                            postWebviewMessage(panel.webview, { kind: "notify_result", ok: true, message: "系统已接受本机通知，请点击通知验证返回本窗口。若未显示，请检查系统通知设置或专注模式。" } satisfies ToWebview);
                        } catch (error) {
                            postWebviewMessage(panel.webview, { kind: "notify_result", ok: false, message: `本机通知失败：${String((error as Error).message ?? error)}；飞书推送不受影响。` } satisfies ToWebview);
                        }
                        break;
                    }
                    case "notifyTest": {
                        const url = m.webhook.trim();
                        if (!url) {
                            postWebviewMessage(panel.webview, { kind: "notify_result", ok: false, message: "请先填写 webhook 地址。" } satisfies ToWebview);
                            break;
                        }
                        const r = await this.sendWebhook(url, "🔔 Codex Copilot 推送测试：webhook 配置成功。", { test: true });
                        postWebviewMessage(panel.webview, {
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
                postWebviewMessage(panel.webview, { kind: "notify_result", ok: false, message: `操作失败：${String((err as Error).message ?? err)}` } satisfies ToWebview);
                if (m.type === "notifyCalendarRefresh") this.postNotifyCalendar();
            }
        });
        const cfgSub = vscode.workspace.onDidChangeConfiguration((ev) => {
            if (ev.affectsConfiguration("codexChat.notifyWebhook") || ev.affectsConfiguration("codexChat.notifyMinDurationSec") || ev.affectsConfiguration("codexChat.notifyLocal") || ev.affectsConfiguration("codexChat.notifyFeishuQuietHours") || ev.affectsConfiguration("codexChat.notifyUsageThresholdPct") || ev.affectsConfiguration("codexChat.notifyUsageFeishu") || ev.affectsConfiguration("codexChat.notifyUsageLocal")) {
                if (!saving) this.postNotifyConfig();
            }
        });
        panel.onDidDispose(() => {
            messageSub.dispose();
            cfgSub.dispose();
            if (this.notifyPanel === panel)
                this.notifyPanel = undefined;
        });
        // 必须先绑定接收器，页面脚本加载后立即发送 notifyLoad。
        panel.webview.html = this.notifyHtml();
    }
    private postNotifyConfig(): void {
        const cfg = vscode.workspace.getConfiguration("codexChat");
        postWebviewMessage(this.notifyPanel?.webview, {
            kind: "notify_config",
            quietHours: parseQuietHours(cfg.get("notifyFeishuQuietHours")) ?? DEFAULT_QUIET_HOURS,
            local: cfg.get<boolean>("notifyLocal") ?? false,
            localSupported: localNotificationsSupported(),
            webhook: cfg.get<string>("notifyWebhook") ?? "",
            minSec: cfg.get<number>("notifyMinDurationSec") ?? 60,
            usageThresholdPct: cfg.get<number>("notifyUsageThresholdPct") ?? 98,
            usageFeishu: cfg.get<boolean>("notifyUsageFeishu") ?? true,
            usageLocal: cfg.get<boolean>("notifyUsageLocal") ?? false,
        } satisfies ToWebview);
        this.postNotifyCalendar();
    }
    private postNotifyCalendar(): void {
        postWebviewMessage(this.notifyPanel?.webview, { kind: "notify_calendar", message: this.workdayCalendar.status() } satisfies ToWebview);
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
  h3 { margin: 10px 0 0; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); font-size: 13px; }
  label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
  label.f > span { font-weight: 600; opacity: .85; }
  input[type=text], input[type=number], input[type=time] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
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
  <div class="sub">长任务跑完时向 webhook 推一条通知：任务耗时达到阈值即推送。Codex 停下来等你输入（工具授权 / 选项提问）且你离开超过同一阈值时，也会推一条「等你输入」。诊断通知共用这里的渠道、耗时阈值和静默设置。</div>
  <label class="f"><span>飞书等远程推送 Webhook 地址（主要提醒渠道）</span><input id="webhook" type="text" spellcheck="false" placeholder="飞书/企业微信/钉钉群机器人的 webhook，或任意接收 JSON 的地址" /></label>
  <label class="f"><span>耗时阈值（秒）</span><input id="minsec" type="number" min="0" step="10" placeholder="60" /></label>
  <label><input id="local" type="checkbox" /> 同时开启本机通知（可选）</label>
  <div class="sub" id="localhint">默认关闭，不影响飞书提醒。开启后，点击本机通知回到对应 VS Code 窗口和会话；首次使用请允许 macOS 通知。窗口关闭或重载后，旧通知可能失效。</div>
  <label><input id="quiet" type="checkbox" /> 工作日的工作时间内暂停飞书推送（可选）</label>
  <div class="sub" id="quiethint">需先开启本机通知；关闭本机通知后，飞书照常推送。</div>
  <div class="acts">
    <label class="f"><span>开始时间（北京时间）</span><input id="quietstart" type="time" value="08:30" step="60" /></label>
    <label class="f"><span>结束时间（北京时间）</span><input id="quietend" type="time" value="18:00" step="60" /></label>
  </div>
  <div class="sub">默认关闭。按中国大陆节假日和调休判断工作日，开始时刻起暂停，结束时刻恢复；影响飞书的任务完成、等待输入和诊断提醒，本机通知不受影响。静默期间的提醒不会在下班后补发；“测试远程推送”始终发送。</div>
  <div class="sub">启用后每天联网更新日历，断网最多使用七天内缓存；无有效日历时照常推送。请保持本机通知开启，以便上班时收到提醒。</div>
  <div class="sub" id="calendarstatus">日历尚未加载。</div>
  <button id="refreshcalendar" class="btn">立即更新节假日与调休日历</button>
  <h3>每周用量预警</h3>
  <label class="f"><span>已使用达到（%）</span><input id="usagethreshold" type="number" min="1" max="100" step="1" placeholder="98" /></label>
  <label><input id="usagefeishu" type="checkbox" /> 飞书通知（使用上方 Webhook 地址）</label>
  <label><input id="usagelocal" type="checkbox" /> 本机通知</label>
  <div class="sub" id="usagehint">达到阈值后，每个重置周期、每个勾选渠道只提醒一次；两个渠道可以同时勾选。飞书通知需填写上方 Webhook。用量预警不受任务耗时阈值和工作时间静默设置影响。</div>
  <div id="status" class="status hidden"></div>
  <div class="acts">
    <button id="test" class="btn">测试远程推送</button>
    <button id="testlocal" class="btn">测试本机通知</button>
    <button id="save" class="btn primary">保存</button>
  </div>
  <div class="sub">飞书 / 企业微信 / 钉钉的群机器人按域名自动适配报文格式，直接收到文本；其他地址收到通用 JSON：{ text, isError, durationMs, project, question }（等待输入的推送另带 waiting:true 与 ask）。配置与 VS Code 设置（codexChat.notifyWebhook / notifyMinDurationSec）互通。</div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  // 只保存恢复标记；已保存配置从 VS Code 设置重新读取，不复制 webhook。
  vscode.setState({ view: "notify", version: 1 });
  window.addEventListener("error", (e) => {
    try { vscode.postMessage({ type: "webviewError", message: "通知页面脚本异常" }); } catch {}
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
      $("usagethreshold").value = m.usageThresholdPct ?? 98;
      $("usagefeishu").checked = m.usageFeishu ?? true;
      $("usagelocal").checked = m.usageLocal ?? false;
      const quiet = m.quietHours || { enabled: false, start: "08:30", end: "18:00" };
      $("quiet").checked = quiet.enabled;
      $("quietstart").value = quiet.start;
      $("quietend").value = quiet.end;
      $("local").checked = m.local;
      updateQuietFields();
      $("local").disabled = !m.localSupported;
      $("testlocal").disabled = !m.localSupported;
      $("usagelocal").disabled = !m.localSupported;
      if (!m.localSupported) $("localhint").textContent = "本机通知目前仅支持本机 macOS 的 VS Code。SSH、容器、浏览器及其他系统请继续使用飞书等远程推送。";
    } else if (m.kind === "notify_calendar") {
      $("calendarstatus").textContent = m.message;
      $("refreshcalendar").disabled = false;
    } else if (m.kind === "notify_result") {
      status(m.message, m.ok ? "ok" : "err");
    }
  });
  function updateQuietFields() {
    const localEnabled = $("local").checked;
    $("quiet").disabled = !localEnabled;
    $("quietstart").disabled = !localEnabled || !$("quiet").checked;
    $("quietend").disabled = !localEnabled || !$("quiet").checked;
    $("quiethint").textContent = localEnabled
      ? "仅在本机通知开启时生效；关闭本机通知后，飞书照常推送。"
      : "本机通知未开启，飞书不会暂停推送。原静默设置保留，重新开启本机通知后才可生效。";
  }
  $("local").addEventListener("change", updateQuietFields);
  $("quiet").addEventListener("change", updateQuietFields);
  $("refreshcalendar").addEventListener("click", () => {
    $("calendarstatus").textContent = "正在更新节假日与调休日历…";
    $("refreshcalendar").disabled = true;
    vscode.postMessage({ type: "notifyCalendarRefresh" });
  });
  $("save").addEventListener("click", () => {
    // 阈值留空按默认 60 处理——空值存成 0 会变成"任何时长都推"，与占位符暗示不符
    const raw = $("minsec").value.trim();
    const usageRaw = $("usagethreshold").value.trim();
    vscode.postMessage({ type: "notifySave", webhook: $("webhook").value, minSec: raw === "" ? 60 : Number(raw), local: $("local").checked,
      usageThresholdPct: usageRaw === "" ? 98 : Number(usageRaw), usageFeishu: $("usagefeishu").checked, usageLocal: $("usagelocal").checked,
      quietHours: { enabled: $("quiet").checked, start: $("quietstart").value, end: $("quietend").value } });
  });
  $("test").addEventListener("click", () => {
    status("发送中…");
    vscode.postMessage({ type: "notifyTest", webhook: $("webhook").value });
  });
  $("testlocal").addEventListener("click", () => {
    status("发送本机通知中，如有系统权限提示请允许…");
    vscode.postMessage({ type: "notifyLocalTest" });
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
        // 压缩没有增量进度；静默不能说明卡死，也不能据此中断压缩。
        if (ctx.pendingPerm || ctx.compacting)
            return;
        const idle = Date.now() - last;
        if (idle < this.turnStallMs()) {
            if (idle >= 30000) {
                ctx.responseWaitShown = true;
                this.post(ctx, { kind: "response_wait", idleMs: idle });
            }
            return;
        }
        ctx.lastEventAt = undefined;
        ctx.sendAt = undefined;
        this.output.appendLine(`[${new Date().toISOString()}] [stall] session=${ctx.sessionId?.slice(0, 8)} CLI 静默 ${Math.round(idle / 1000)}s，达到静默超时设置，重置连接`);
        try {
            ctx.proc?.dispose();
        }
        catch (error) { operationFailure('session.stall.dispose', error);
        }
        ctx.proc = undefined;
        ctx.starting = undefined;
        if (!this.alive(ctx) && ctx.sessionId && this.detached.get(ctx.sessionId) === ctx) {
            ctx.checkpoints.flush();
            this.detached.delete(ctx.sessionId);
        }
        this.post(ctx, {
            kind: "error",
            message: `Codex 已 ${Math.round(idle / 60000)} 分钟未收到任务进展，达到配置的静默超时，已重置连接。这不一定代表任务卡死；可调整 codexChat.turnStallTimeoutSec 后重试。已有会话记录保留，请先确认执行结果，避免重复操作。`,
        });
        this.post(ctx, { kind: "busy", busy: false });
        this.broadcastRunning();
    }
    private alive(ctx: SessionCtx): boolean {
        return this.sessions.has(ctx);
    }
    private async captureFinalSnapshot(ctx: SessionCtx): Promise<void> {
        const snapshot = ctx.snapshot;
        const checkpoints = ctx.checkpoints;
        await ctx.finalizing;
        if (!snapshot || ctx.snapshot !== snapshot || ctx.checkpoints !== checkpoints)
            return;
        if (ctx.mayHaveModifiedWorkspace) {
            for (const [file, original] of await snapshot.changed())
                checkpoints.recordSnapshot(file, original);
            checkpoints.recordUnrestorable(snapshot.unrestorableChanges);
        }
        checkpoints.completeSnapshot();
        if (ctx.snapshot === snapshot) ctx.snapshot = undefined;
        checkpoints.flush();
    }
    private handleEmit(ctx: SessionCtx, e: ToWebview): void {
        if (e.kind === "busy" && !e.busy)
            return;
        if (e.kind === "result") {
            // 结果已收到；快照整理期间关闭或回复后，不能再补发这条旧提醒。
            const sessionId = ctx.sessionId;
            const epoch = this.notificationVersion(sessionId);
            const traceId = ctx.performanceTraceId;
            this.output.appendLine(`[finalize] session=${sessionId?.slice(0, 8)} 后台轮次已结束，开始整理还原点`);
            this.post(ctx, { kind: "finalizing" });
            ctx.finalizing = (async () => {
                const finalizeAt = Date.now();
                try {
                    if (ctx.snapshot && ctx.mayHaveModifiedWorkspace) {
                        for (const [file, original] of await ctx.snapshot.changed())
                            ctx.checkpoints.recordSnapshot(file, original);
                        ctx.checkpoints.recordUnrestorable(ctx.snapshot.unrestorableChanges);
                    }
                    if (ctx.snapshot) ctx.checkpoints.completeSnapshot();
                    ctx.snapshot = undefined;
                    ctx.checkpoints.flush();
                    if (ctx.mayHaveModifiedWorkspace) this.refreshChangedFiles(ctx);
                }
                catch (err) { operationFailure('panel.handleEmit', err);
                    this.post(ctx, { kind: "notice", message: `会话或文件快照刷新失败：${String(err)}` });
                }
                this.output.appendLine(`[${new Date().toISOString()}] [finalize] 文件差异与还原点整理 ${Date.now() - finalizeAt}ms`);
                if (traceId) this.output.appendLine(`[perf] ${JSON.stringify({ schema: 1, event: "finalization", traceId, threadId: sessionId, atMs: Date.now(), durationMs: Date.now() - finalizeAt })}`);
                this.handleEmitInner(ctx, { kind: "busy", busy: false });
                this.handleEmitInner(ctx, e, ctx.sessionId === sessionId && this.notificationVersion(sessionId) === epoch);
            })();
            return;
        }
        this.handleEmitInner(ctx, e);
    }
    private handleEmitInner(ctx: SessionCtx, e: ToWebview, notifyTurnDone = true): void {
        if (e.kind === "usage") this.maybeNotifyUsage(e);
        if (e.kind === "models") this.modelCatalog = e.models;
        if (e.kind === "compacting") ctx.compacting = true;
        else if (e.kind === "compacted" || e.kind === "busy" || e.kind === "result" ||
            (e.kind === "error" && !e.keepBusy)) ctx.compacting = false;
        // 额度查询、诊断及重试提示不是任务进展，不能掩盖长期静默。
        if (ctx.lastEventAt !== undefined && !["usage", "rate_limit", "rate_limit_cleared", "models", "speed_context", "diag", "status", "notice", "response_wait"].includes(e.kind)) {
            ctx.lastEventAt = Date.now();
            if (ctx.responseWaitShown) {
                ctx.responseWaitShown = false;
                this.post(ctx, { kind: "response_wait", idleMs: 0 });
            }
        }
        ctx.lastEmitAt = Date.now();
        if (e.kind === "tool_input" && ctx.snapshot && !["Read", "WebSearch", "TodoWrite", "Skill"].includes(e.name)) {
            const paths = Array.isArray(e.input.changes) ? e.input.changes.map((c: any) => c.path) : [e.input.file_path];
            for (const raw of paths) {
                if (typeof raw !== "string" || !raw) continue;
                const file = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(this.cwd(), raw);
                if (ctx.snapshot.files.has(file))
                    ctx.checkpoints.recordSnapshot(file, ctx.snapshot.files.get(file)!);
                else
                    ctx.checkpoints.recordUnrestorable([file]);
            }
        }
        if (e.kind === "rate_limit" && (e.level === "warning" || (e.level === "exhausted" && e.modelScoped))) {
            const until = this.context.globalState.get<Record<string, number>>("codexChat.rateLimitDismissed")?.[e.limitLabel] ?? 0;
            if (Date.now() < until) {
                this.output.appendLine(`[${new Date().toISOString()}] [ratelimit] 「${e.limitLabel}」警告已被关闭，跳过（至 ${new Date(until).toLocaleString()}）`);
                return;
            }
        }
        if (e.kind === "diag") {
            if (e.message.startsWith('[perf] {"schema":1,"event":"turn_start"')) {
                try { ctx.performanceTraceId = JSON.parse(e.message.slice(7)).traceId; } catch { /* 不影响消息 */ }
            }
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
        if (e.kind === "permission_resolved") this.resolvePendingPermission(ctx, e.requestId);
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
            ctx.pendingPerms?.clear();
            this.output.appendLine(`[${new Date().toISOString()}] [turn] session=${ctx.sessionId?.slice(0, 8)} 完成 ${e.durationMs}ms 轮次${e.numTurns}${e.isError ? " (出错)" : ""}`);
            if (ctx.sessionId)
                void this.store.hydrate(ctx.sessionId).catch(e => this.output.appendLine(String(e)));
            this.refreshSessions();
            this.fetchUsage();
            this.maybeNotifyTurnDone(ctx, e, notifyTurnDone);
        }
    }
    private maybeNotifyTurnDone(ctx: SessionCtx, e: {
        durationMs?: number;
        isError: boolean;
    }, notificationValid = true): void {
        const lastText = ctx.lastUserText;
        ctx.lastUserText = undefined;
        if (!lastText || !notificationValid)
            return;
        const cfg = vscode.workspace.getConfiguration("codexChat");
        const url = (cfg.get<string>("notifyWebhook") || "").trim();
        if (!url && !cfg.get<boolean>("notifyLocal"))
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
        this.dispatchNotification(ctx, msg, { isError: e.isError, durationMs: dur, project: proj, question: q });
    }
    private maybeNotifyWaiting(ctx: SessionCtx, req: PermissionRequest): void {
        const cfg = vscode.workspace.getConfiguration("codexChat");
        const url = (cfg.get<string>("notifyWebhook") || "").trim();
        if (!url && !cfg.get<boolean>("notifyLocal"))
            return;
        const minSec = cfg.get<number>("notifyMinDurationSec") ?? 60;
        const since = ctx.lastUserActionAt ?? Date.now();
        const delay = Math.max(0, minSec * 1000 - (Date.now() - since));
        const proc = ctx.proc;
        const sessionId = ctx.sessionId;
        const epoch = this.notificationVersion(sessionId);
        const timer = setTimeout(() => {
            this.notifyTimers.delete(timer);
            if (ctx.proc !== proc || ctx.sessionId !== sessionId || this.notificationVersion(sessionId) !== epoch)
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
            this.dispatchNotification(ctx, msg, { waiting: true, project: proj, question: q, ask });
        }, delay);
        this.notifyTimers.add(timer);
    }
    async notifyDiagnostic(record: DiagnosticRecord): Promise<NotificationResult> {
        const cfg = vscode.workspace.getConfiguration("codexChat");
        if (!(cfg.get<string>("notifyWebhook") ?? "").trim() && !cfg.get<boolean>("notifyLocal"))
            return { status: "not_configured", message: "全局通知未开启，请在通知设置中开启本机通知或配置 Webhook" };
        const { text, extra } = diagnosticNotification(record);
        const minSec = cfg.get<number>("notifyMinDurationSec") ?? 60;
        if ((extra.durationMs as number) < minSec * 1000)
            return { status: "skipped", message: `诊断耗时未达到全局通知阈值（${minSec} 秒）` };
        return this.dispatchNotification({}, text, extra);
    }
    /** 两个通道分别执行；诊断复用相同设置和静默失败回退，并等待实际发送结果。 */
    private dispatchNotification(ctx: Pick<SessionCtx, 'sessionId' | 'remotePrivate'>, msg: string, extra: Record<string, unknown>): Promise<NotificationResult> {
        const sessionId = ctx.sessionId;
        const epoch = this.notificationVersion(sessionId);
        const cfg = vscode.workspace.getConfiguration("codexChat");
        const privateSession = ctx.remotePrivate || (sessionId && this.context.workspaceState?.get<boolean>('codexChat.remotePrivate.' + sessionId));
        const url = privateSession ? '' : (cfg.get<string>("notifyWebhook") || "").trim();
        const event = extra.waiting === true ? "waiting" : extra.isError === true ? "error" : "complete";
        const localEnabled = cfg.get<boolean>("notifyLocal") === true;
        const quiet = parseQuietHours(cfg.get("notifyFeishuQuietHours"));
        let muted = false;
        if (localEnabled && localNotificationsSupported() && isFeishuWebhook(url) && quiet?.enabled) {
            try {
                void this.workdayCalendar.refresh();
                muted = this.workdayCalendar.shouldMute(quiet);
            } catch (error) {
                this.output.appendLine(`[notify] 日历判断失败，飞书照常推送: ${String(error)}`);
            }
        }
        this.output.appendLine(`[notify] dispatch session=${sessionId ?? "none"} event=${event} local=${localEnabled} remote=${!!url && !muted} muted=${muted} epoch=${epoch}`);
        if (muted) this.output.appendLine("[notify] 当前为中国大陆工作日的配置时段，已跳过飞书推送（本机通知不受影响）");
        const sent: string[] = [], failed: string[] = [], pending: Promise<void>[] = [];
        const sendRemote = () => {
            const remoteStartedAt = performance.now();
            return this.sendWebhook(url, msg, extra).then(r => {
                this.output.appendLine(`[notify] remote_result session=${sessionId ?? "none"} event=${event} ok=${r.ok} status=${r.status ?? "none"} elapsedMs=${Math.round(performance.now() - remoteStartedAt)}`);
                if (r.ok) sent.push("远程通知已发送");
                else failed.push(`远程通知发送失败${r.error ? `（${r.error}）` : r.status ? `（HTTP ${r.status}）` : ''}`);
            }).catch(error => {
                this.output.appendLine(`[notify] remote_error session=${sessionId ?? "none"} event=${event} errorType=${error instanceof Error ? error.name : typeof error}`);
                failed.push("远程通知发送失败，请检查通知设置和网络");
            });
        };
        if (url && !muted) pending.push(sendRemote());
        if (localEnabled) {
            const { title, body } = formatLocalNotification(msg, {
                ...extra,
                project: typeof extra.project === "string" ? localNotificationProject(extra.project) : extra.project,
            });
            const localStartedAt = performance.now();
            const local = typeof extra.diagnosticId === 'string' ? this.sendLocalNotice(title, body, undefined, extra.diagnosticId) : this.sendLocalNotice(title, body, sessionId);
            pending.push(local.then(accepted => {
                this.output.appendLine(`[notify] local_result session=${sessionId ?? "none"} event=${event} result=${accepted === false ? "stale" : "accepted"} elapsedMs=${Math.round(performance.now() - localStartedAt)}`);
                if (accepted !== false) sent.push("本机通知已发送");
                else failed.push("本机通知未发送，来源窗口或任务状态已变化");
            }).catch(error => {
                this.output.appendLine(`[notify] local_error session=${sessionId ?? "none"} event=${event} elapsedMs=${Math.round(performance.now() - localStartedAt)} errorType=${error instanceof Error ? error.name : typeof error}`);
                failed.push("本机通知发送失败，请检查系统通知权限");
                if (muted && ctx.sessionId === sessionId && this.notificationVersion(sessionId) === epoch) {
                    this.output.appendLine(`[notify] remote_fallback session=${sessionId ?? "none"} event=${event}`);
                    muted = false;
                    return sendRemote();
                }
            }));
        }
        return Promise.all(pending).then(() => ({
            status: failed.length ? 'failed' : sent.length ? 'sent' : 'not_configured',
            message: [...sent, ...failed, ...(muted ? ['远程通知按全局工作时段规则静默'] : [])].join('；') || '全局通知未开启',
        }));
    }
    private async sendLocalNotice(title: string, body: string, sessionId?: string, diagnosticId?: string): Promise<boolean> {
        const createdAt = notificationTime();
        const epoch = this.notificationVersion(sessionId);
        // 地址解析不占据原生操作队列，用户回复后的清理无需等旧解析完成。
        const uri = await this.notificationUri(sessionId, diagnosticId);
        if (this.disposed) return false;
        const router = this.notificationRouter ??= new NotificationRouter();
        const clickEndpoint = await router.endpoint(diagnosticId ? `diagnostic:${diagnosticId}` : sessionId ?? "", () => this.handleNotificationUri(uri, true));
        return queueSessionNotification(sessionId, async () => {
            if (this.notificationVersion(sessionId) !== epoch) return false;
            await sendLocalNotification(this.context.extensionUri.fsPath, title, body, uri.toString(), sessionId, createdAt, clickEndpoint);
            return true;
        });
    }
    private notificationUri(sessionId?: string, diagnosticId?: string): Promise<vscode.Uri> {
        const key = diagnosticId ? `diagnostic:${diagnosticId}` : sessionId ?? "";
        this.notificationUris ??= new Map();
        const cached = this.notificationUris.get(key);
        if (cached) return cached;
        const query = new URLSearchParams({ window: this.notificationWindowKey });
        if (sessionId) query.set("session", sessionId);
        if (diagnosticId) query.set("diagnostic", diagnosticId);
        // 保留 VS Code 返回的完整 URI；只在本窗口生命周期内复用，失败允许重试。
        const pending = Promise.resolve().then(() => vscode.env.asExternalUri(vscode.Uri.from({
            scheme: vscode.env.uriScheme, authority: this.context.extension.id,
            path: "/notification", query: query.toString(),
        }))).catch(error => {
            if (this.notificationUris.get(key) === pending) this.notificationUris.delete(key);
            throw error;
        });
        this.notificationUris.set(key, pending);
        return pending;
    }
    private notificationVersion(sessionId?: string): number {
        return sessionId ? this.notificationEpochs?.get(sessionId) ?? 0 : 0;
    }
    private resetRestoredNotifications(ctx: SessionCtx, oldId?: string): void {
        this.clearSessionNotification(oldId);
        ctx.pendingPerm = undefined;
        ctx.pendingPerms?.clear();
        ctx.pendingQuestionAt = undefined;
        ctx.lastUserText = undefined;
        ctx.lastUserActionAt = Date.now();
        ctx.sendAt = undefined;
        ctx.lastEventAt = undefined;
    }
    private async clearSessionNotification(sessionId?: string, reason = "user_action"): Promise<void> {
        if (!sessionId) return;
        const epoch = this.notificationVersion(sessionId) + 1;
        (this.notificationEpochs ??= new Map()).set(sessionId, epoch);
        const enabled = this.config().get<boolean>("notifyLocal") === true;
        const supported = enabled && localNotificationsSupported();
        if (!enabled || !supported) {
            this.output.appendLine(`[notify] clear_skipped session=${sessionId} reason=${reason} enabled=${enabled} supported=${supported} epoch=${epoch}`);
            return;
        }
        const createdAt = notificationTime();
        const extensionPath = this.context.extensionUri.fsPath;
        const startedAt = performance.now();
        this.output.appendLine(`[notify] clear_requested session=${sessionId} reason=${reason} epoch=${epoch}`);
        // 各安装路径对应不同的系统通知归属，旧路径清理不能阻塞当前路径的新通知。
        void clearPreviousLocalNotifications(extensionPath, sessionId, createdAt).then(result => {
            this.output.appendLine(`[notify] clear_previous session=${sessionId} completed=${result.completed} failed=${result.failed} elapsedMs=${Math.round(performance.now() - startedAt)}`);
        }).catch(error => this.output.appendLine(`[notify] clear_previous_error session=${sessionId} errorType=${error instanceof Error ? error.name : typeof error}`));
        return queueSessionNotification(sessionId, () => clearLocalNotification(extensionPath, sessionId, createdAt))
            .then(() => this.output.appendLine(`[notify] clear_acknowledged session=${sessionId} reason=${reason} elapsedMs=${Math.round(performance.now() - startedAt)}`))
            .catch(error => this.output.appendLine(`[notify] clear_error session=${sessionId} reason=${reason} errorType=${error instanceof Error ? error.name : typeof error}`));
    }
    async handleNotificationUri(uri: vscode.Uri, focusWindow = false): Promise<void> {
        if (uri.path !== "/notification") return;
        const query = new URLSearchParams(uri.query);
        const sessionId = query.get("session");
        const diagnosticId = query.get("diagnostic");
        if (query.get("window") !== this.notificationWindowKey) {
            this.output.appendLine(`[notify] click_rejected session=${sessionId ?? "none"} reason=other_window`);
            void vscode.window.showWarningMessage("该通知所属的 VS Code 窗口已关闭或重载，请在对应项目的会话历史中打开任务。");
            return;
        }
        try {
            // 在来源扩展宿主执行，直接聚焦对应原生窗口，不再经过有前缀歧义的 URI 路由。
            if (focusWindow) await vscode.commands.executeCommand("workbench.action.focusWindow");
            if (diagnosticId) {
                if (!/^[a-f\d-]{36}$/.test(diagnosticId)) throw new Error("诊断记录编号无效");
                await vscode.commands.executeCommand("codex-chat.openDiagnostics", diagnosticId);
            } else if (!sessionId) {
                this.output.appendLine("[notify] click_open_settings");
                this.showNotifyConfig();
            } else if ([...this.sessions].some(ctx => ctx.sessionId === sessionId) || this.detached.has(sessionId) ||
                       this.store.list().some(session => session.id === sessionId)) {
                this.output.appendLine(`[notify] click_open_session session=${sessionId}`);
                await this.openSession(sessionId);
            } else {
                this.output.appendLine(`[notify] click_rejected session=${sessionId} reason=missing_session`);
                void vscode.window.showWarningMessage("该通知对应的会话已不在当前项目的历史中。");
            }
        } catch (error) {
            this.output.appendLine(`[notify] click_error session=${sessionId ?? "none"} errorType=${error instanceof Error ? error.name : typeof error}`);
            if (focusWindow) throw error; // 原生点击由辅助程序提示失败，避免成功应答后实际未聚焦。
            void vscode.window.showWarningMessage("未能打开通知对应的会话，请从会话历史重试。");
        }
    }
    private async sendWebhook(url: string, msg: string, extra: Record<string, unknown> = {}): Promise<{
        ok: boolean;
        status?: number;
        error?: string;
    }> {
        try {
            const host = new URL(url).hostname;
            const feishu = isFeishuWebhook(url);
            const otherBot = host === 'qyapi.weixin.qq.com' || host === 'oapi.dingtalk.com';
            const payload = feishu ? { msg_type: "text", content: { text: msg } }
                : otherBot ? { msgtype: "text", text: { content: msg } }
                : { source: "codex-chat", text: msg, ...extra };
            const r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            if (r.ok && (feishu || otherBot)) {
                const body = await r.json() as { code?: number; StatusCode?: number; errcode?: number } | null;
                const code = feishu ? body?.code ?? body?.StatusCode : body?.errcode;
                if (code !== 0) return { ok: false, status: r.status, error: `机器人未确认接收，错误码 ${Number.isInteger(code) ? code : '未知'}` };
            }
            return { ok: r.ok, status: r.status, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) };
        }
        catch {
            return { ok: false, error: "请求超时、网络失败或机器人返回无效响应" };
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
            postWebviewMessage(this.view?.webview, { kind: "running", sessionIds: this.runningIds() } satisfies ToWebview);
        }
        catch {
        }
    }
    private fetchUsage(force = false): void {
        if (this.usageInFlight || (!force && Date.now() - this.lastUsageAt < 90000))
            return;
        this.usageInFlight = true;
        this.lastUsageAt = Date.now();
        void this.store.read("account/rateLimits/read", { excludeResetCreditDetails: false }).then(r => {
            this.lastUsage = usageView(r.rateLimits, r.rateLimitResetCredits);
            this.lastUsageUpdatedAt = Date.now();
            this.maybeNotifyUsage(this.lastUsage);
            for (const ctx of this.sessions)
                for (const event of quotaEvents(r.rateLimits, r.rateLimitResetCredits)) this.handleEmit(ctx, event);
        }).catch(e => this.output.appendLine(`[usage] ${String(e)}`)).finally(() => { this.usageInFlight = false; });
    }
    /** 周额度达到阈值后按重置周期和渠道分别记录成功通知；失败允许下次额度刷新重试。 */
    private maybeNotifyUsage(usage: Extract<ToWebview, { kind: "usage" }>): void {
        const pct = usage.weekPct;
        const resetAt = usage.weekResetAt;
        if (typeof pct !== "number" || !Number.isFinite(pct) ||
            typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= Date.now() / 1000) return;
        const cfg = this.config();
        const threshold = cfg.get<number>("notifyUsageThresholdPct") ?? 98;
        if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100 || pct < threshold) return;
        const signature = `${Math.trunc(resetAt)}:${threshold}`;
        const resetText = new Date(resetAt * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        const title = `⚠️ Codex 每周限额已使用 ${pct}%`;
        const message = `${title}（预警阈值 ${threshold}%）\n下次重置：${resetText}`;
        const deliver = (channel: "feishu" | "local", send: () => Promise<boolean>) => {
            const storageKey = `codexChat.usageAlert.${channel}`;
            const pendingKey = `${channel}:${signature}`;
            if (this.usageAlertDelivered.get(channel) === signature ||
                this.context.globalState.get<string>(storageKey) === signature ||
                this.usageAlertPending.has(pendingKey)) return;
            this.usageAlertPending.add(pendingKey);
            void send().then(async ok => {
                if (!ok) { this.output.appendLine(`[usage-alert] channel=${channel} result=failed resetAt=${Math.trunc(resetAt)}`); return; }
                this.usageAlertDelivered.set(channel, signature);
                await this.context.globalState.update(storageKey, signature);
                this.output.appendLine(`[usage-alert] channel=${channel} result=sent percent=${pct} threshold=${threshold} resetAt=${Math.trunc(resetAt)}`);
            }).catch(error => this.output.appendLine(`[usage-alert] channel=${channel} result=error errorType=${error instanceof Error ? error.name : typeof error}`))
                .finally(() => this.usageAlertPending.delete(pendingKey));
        };
        const webhook = (cfg.get<string>("notifyWebhook") ?? "").trim();
        if ((cfg.get<boolean>("notifyUsageFeishu") ?? true) && webhook)
            deliver("feishu", async () => (await this.sendWebhook(webhook, message, { usageAlert: true, usedPercent: pct, thresholdPercent: threshold, resetsAt: resetAt })).ok);
        if ((cfg.get<boolean>("notifyUsageLocal") ?? false) && localNotificationsSupported())
            deliver("local", () => this.sendLocalNotice(title, `下次重置：${resetText}`));
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
            agentLabel: req.agentLabel,
            input: req.input,
            initialAnswers: req.initialAnswers,
            initialImages: req.initialImages,
            description: req.description,
            suggestions: req.suggestions,
        };
        const queue = ctx.pendingPerms ??= new Map();
        // 兼容恢复的根问题；并行到达的审批按顺序展示，不能覆盖尚未处理的卡片。
        if (ctx.pendingPerm?.kind === "permission_request" && !queue.has(ctx.pendingPerm.requestId))
            queue.set(ctx.pendingPerm.requestId, ctx.pendingPerm);
        queue.set(req.requestId, msg);
        if (ctx.pendingPerm?.kind === "permission_request" && ctx.pendingPerm.requestId !== req.requestId) return;
        ctx.pendingPerm = msg;
        if (this.alive(ctx))
            this.post(ctx, msg);
        this.maybeNotifyWaiting(ctx, req);
    }
    private resolvePendingPermission(ctx: SessionCtx, requestId: string): void {
        ctx.pendingPerms?.delete(requestId);
        if (ctx.pendingPerm?.kind !== "permission_request" || ctx.pendingPerm.requestId !== requestId) return;
        ctx.pendingPerm = ctx.pendingPerms?.values().next().value;
        ctx.pendingQuestionAt = undefined;
        if (ctx.pendingPerm?.kind === "permission_request") {
            if (ctx.pendingPerm.toolName === "AskUserQuestion") ctx.pendingQuestionAt = Date.now();
            if (this.alive(ctx)) this.post(ctx, ctx.pendingPerm);
        }
    }
    private onSessionId(ctx: SessionCtx, id: string, resumed: boolean): void {
        if (!id || (!resumed && this.store.findFile(id)) ||
            [...this.sessions, ...this.detached.values()].some(other => other !== ctx && other.sessionId === id))
            throw new Error("会话 ID 已被其他标签页占用，已中止连接，避免覆盖会话及通知。");
        const isNew = ctx.sessionId !== id;
        this.sessionModel(ctx);
        this.speedMode(ctx);
        this.sessionEffort(ctx);
        ctx.blank = false;
        ctx.sessionId = id;
        this.rememberSessionModel(ctx);
        this.rememberSessionSpeed(ctx);
        this.rememberSessionEffort(ctx);
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
    private deletingSessions = false;
    private async deleteSessions(ids: string[]): Promise<void> {
        if (this.deletingSessions) return;
        ids = [...new Set(Array.isArray(ids) ? ids.filter(id => typeof id === "string" && id.length > 0) : [])];
        this.deletingSessions = true;
        const deletedIds: string[] = [], failedIds: string[] = [], failures: string[] = [];
        const titles = new Map(this.store.list().map(s => [s.id, s.title]));
        let message = "已取消删除。", error = false;
        const status = (text: string) => this.post2(this.view?.webview, { kind: "sessions_delete_status", busy: true, message: text });
        try {
            if (!ids.length) { message = "请先选择要删除的会话。"; return; }
            status("等待删除确认…");
            const detail = (ids.length === 1
                ? `会话「${titles.get(ids[0]) ?? ids[0]}」将被永久删除。`
                : `选中的 ${ids.length} 个会话将被永久删除。`) + "关联的子 Agent 会话也会被删除。";
            const ok = await vscode.window.showWarningMessage("删除会话？此操作不可撤销。", { modal: true, detail }, "删除");
            if (ok !== "删除") return;
            const ordered = this.store.deletionOrder(ids);
            for (const [index, id] of ordered.entries()) {
                status(`正在删除 ${index + 1}/${ordered.length}…`);
                try {
                    const waits: Promise<void>[] = [];
                    for (const ctx of [...this.sessions]) {
                        if (ctx.sessionId !== id) continue;
                        this.sessions.delete(ctx);
                        if (this.activeCtx === ctx) this.activeCtx = undefined;
                        if (ctx.proc) waits.push(ctx.proc.disposeAndWait());
                        ctx.proc = undefined;
                        ctx.panel.dispose();
                    }
                    const det = this.detached.get(id);
                    if (det) {
                        if (det.proc) waits.push(det.proc.disposeAndWait());
                        this.detached.delete(id);
                    }
                    await Promise.all(waits);
                    await this.store.delete(id);
                } catch (err) {
                    failedIds.push(id);
                    this.output.appendLine(`[deleteSessions:${id}] ${String(err)}`);
                    const reason = String((err as Error)?.message ?? err);
                    failures.push(`「${titles.get(id) ?? id}」：` + (/forked history still references/i.test(reason)
                        ? "仍被派生会话引用，请先删除相关派生会话（列表中包含标注“已归档”的会话，也可能位于其他项目）。"
                        : /no rollout found/i.test(reason) ? "找不到会话记录，请刷新列表后重试。"
                        : /\(-32601\)$/.test(reason) ? "当前 Codex CLI 不支持永久删除，请更新 CLI 后重试。"
                        : reason.slice(0, 200)));
                    continue;
                }
                deletedIds.push(id);
                if (this.lastClosedSessionId === id) this.lastClosedSessionId = undefined;
                try {
                    await this.context.workspaceState.update(`codexChat.sessionSpeed.${id}`, undefined);
                    deleteQuestionState(this.storageDir(), id);
                    CheckpointManager.deleteFor(this.storageDir(), id);
                } catch (err) {
                    // 后端已经删除，不能因本机辅助数据清理失败误报“会话未删除”。
                    this.output.appendLine(`[deleteSessions:cleanup:${id}] ${String(err)}`);
                }
            }
            error = failedIds.length > 0;
            message = `已删除 ${deletedIds.length} 个会话。`;
            if (error) message += `${failedIds.length} 个未删除。${failures.slice(0, 3).join(" ")}${failures.length > 3 ? " 其余原因见插件日志。" : ""}`;
        } catch (err) {
            error = true;
            message = `删除会话失败：${String((err as Error)?.message ?? err)}`;
            this.output.appendLine(`[deleteSessions] ${String(err)}`);
        } finally {
            this.broadcastRunning();
            this.refreshSessions();
            await this.sessionsRefreshing;
            this.renderSessions();
            this.deletingSessions = false;
            this.post2(this.view?.webview, { kind: "sessions_delete_status", busy: false, message, deletedIds, failedIds, error });
            if (error) void vscode.window.showErrorMessage(message);
        }
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
        catch (err) { operationFailure('panel.checkForUpdate', err);
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
        catch (err) { operationFailure('panel.checkForUpdate', err);
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
                res.on("error", reject);
                res.once("aborted", () => reject(new Error("下载响应提前中断")));
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
            catch (error) { operationFailure('panel.validateSymbols', error);
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
        const p = parseFileRef(ref).path;
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
            const ref = parseFileRef(p);
            p = ref.path;
            line ??= ref.line;
            endLine ??= ref.endLine;
            const abs = await this.resolveWorkspaceFile(p, true);
            if (!abs) {
                this.output.appendLine(`[openFile] ${p} 未找到 (${Date.now() - t0}ms)`);
                vscode.window.showWarningMessage(`找不到文件：${p}`);
                return;
            }
            const resolveMs = Date.now() - t0;
            if (abs !== p || resolveMs > 300)
                this.output.appendLine(`[openFile] ${p} → ${abs} (解析 ${resolveMs}ms)`);
            // 安装包/归档是可下载产物；定位文件即可，不能当成文本或直接运行安装器。
            if (/\.(?:apk|aab|ipa|vsix|dmg|pkg|exe|msi|deb|rpm|zip|tar|gz|bz2|xz|tgz|7z|rar|jar|war)$/i.test(abs)) {
                await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(abs));
                return;
            }
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
                    catch (error) { operationFailure('panel.openSymbolInner', error);
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
        catch (error) { operationFailure('panel.openSymbolInner', error);
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
        catch (error) { operationFailure('panel.openSymbolInner', error);
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
        catch (error) { operationFailure('panel.openSymbolInner', error);
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
        // 普通回复、问题续轮和停止都从这里报告空闲；不要让前端历史遗留的
        // 还原标记继续拦住队列。真正的还原过程仍持锁到 load_history/restored。
        if (e.kind === "busy" && !e.busy)
            e = { ...e, restoring: this.restoring.has(ctx) };
        // 设置、链接等操作报错不代表当前轮次结束，发送队列只能由真实结束事件放行。
        postWebviewMessage(ctx.webview, e.kind === "error" && ctx.proc?.isBusy ? { ...e, keepBusy: true } : e);
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
        this.disposed = true;
        this.notificationRouter?.dispose();
        this.workdayCalendar.dispose();
        for (const timer of this.notifyTimers) clearTimeout(timer);
        this.notifyTimers.clear();
        this.store.dispose();
        if (this.usageTimer)
            clearInterval(this.usageTimer);
        this.usageTimer = undefined;
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        this.watchdogTimer = undefined;
        for (const ctx of this.sessions)
            { ctx.pendingDiagnosticRepair?.cancel(); ctx.checkpoints.flush(); }
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
  button:disabled { opacity: .4; cursor: default; }
  .selection-tools { display: none; align-items: center; flex-wrap: wrap; gap: 4px; padding: 6px 10px 0; flex: 0 0 auto; }
  body.multi .selection-tools { display: flex; }
  .selection-count { flex: 1; font-size: 11px; opacity: .7; white-space: nowrap; }
  .selection-hint { display: none; padding: 4px 10px; font-size: 11px; opacity: .6; }
  body.multi .selection-hint { display: block; }
  .delete-status { padding: 6px 10px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; flex: 0 0 auto; }
  .delete-status:empty { display: none; }
  .delete-status.error { color: var(--vscode-errorForeground, #e55); }
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
  body.multi .row { user-select: none; }
  body.multi .row.selected { background: var(--vscode-list-activeSelectionBackground, rgba(80,120,255,.22)); color: var(--vscode-list-activeSelectionForeground); }
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
  </div>
  <div class="selection-tools">
    <button id="selectall" class="abtn">全选</button>
    <span id="selection-count" class="selection-count">已选 0 项</span>
    <button id="delsel" class="abtn danger" disabled>删除所选</button>
  </div>
  <div class="selection-hint">Shift + 点击连续选择 · Ctrl/⌘ + A 全选</div>
  <div id="delete-status" class="delete-status" role="status" aria-live="polite"></div>
  <button id="upd-banner" class="upd-banner hidden">${ICONS.update}<span>发现新版本 <b id="upd-ver"></b> · 点击更新</span></button>
  <button id="new" class="new">${ICONS.add}<span>新建会话</span></button>
  <div id="list" class="list"><div class="empty">暂无会话</div></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // 侧边栏脚本一旦抛错整个面板就会"点了没反应"且无迹可循——错误上报给 host 记日志。
    window.addEventListener("error", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: "侧边栏脚本异常" }); } catch {}
    });
    window.addEventListener("unhandledrejection", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: "侧边栏异步脚本异常" }); } catch {}
    });
    const TRASH = ${JSON.stringify(TRASH)};
    const PENCIL = ${JSON.stringify(PENCIL)};
    const PIN = ${JSON.stringify(PIN)};
    const EYE = ${JSON.stringify(EYE)}, EYE_OFF = ${JSON.stringify(EYE_OFF)};
    let sessions = [], activeId = null, runningIds = new Set(), multi = false, anchorId = null, deleting = false;
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
      row.className = "row" + (s.id === activeId ? " active" : "") + (s.pinned ? " pinned" : "") + (sel.has(s.id) ? " selected" : "");
      row.dataset.id = s.id;
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "chk"; chk.checked = sel.has(s.id); chk.disabled = deleting;
      chk.setAttribute("aria-label", "选择会话：" + (s.title || "新对话"));
      chk.addEventListener("click", (e) => { e.stopPropagation(); toggle(s.id, chk.checked, e.shiftKey); });
      const body = document.createElement("div"); body.className = "body";
      const tRow = document.createElement("div"); tRow.className = "trow";
      if (runningIds.has(s.id)) { const dot = document.createElement("span"); dot.className = "run-dot"; dot.title = "正在回复中"; tRow.appendChild(dot); }
      const t = document.createElement("div"); t.className = "t"; t.textContent = s.title || "新对话";
      tRow.appendChild(t);
      const meta = document.createElement("div"); meta.className = "meta";
      meta.textContent = (s.archived ? "已归档  ·  " : "") + fmt(s.updatedAt) + (s.messageCount ? "  ·  " + s.messageCount + " 条" : "");
      body.append(tRow, meta);
      const pin = document.createElement("button"); pin.className = "pin";
      pin.title = s.pinned ? "取消置顶" : "置顶"; pin.innerHTML = PIN;
      pin.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "pinSession", sessionId: s.id, pinned: !s.pinned }); });
      const edit = document.createElement("button"); edit.className = "edit"; edit.title = "重命名"; edit.innerHTML = PENCIL;
      edit.addEventListener("click", (e) => { e.stopPropagation(); rename(s.id); });
      const del = document.createElement("button"); del.className = "del"; del.title = "删除"; del.innerHTML = TRASH;
      del.disabled = deleting;
      del.addEventListener("click", (e) => { e.stopPropagation(); confirmDel([s.id]); });
      row.append(chk, body, pin, edit, del);
      row.addEventListener("click", (e) => {
        if (deleting) return;
        if (multi || e.shiftKey || e.ctrlKey || e.metaKey) {
          if (!multi) enterMulti();
          toggle(s.id, !sel.has(s.id), e.shiftKey);
        } else { anchorId = s.id; open(s.id); }
      });
      return row;
    }

    function render() {
      updateSelection();
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

    function updateSelection() {
      $("selection-count").textContent = "已选 " + sel.size + " 项";
      $("selectall").textContent = sessions.length && sel.size === sessions.length ? "取消全选" : "全选";
      $("selectall").disabled = deleting || !sessions.length;
      $("delsel").disabled = deleting || !sel.size;
      $("multi").disabled = deleting;
      for (const row of document.querySelectorAll(".row")) {
        row.classList.toggle("selected", sel.has(row.dataset.id));
        const chk = row.querySelector(".chk");
        chk.checked = sel.has(row.dataset.id); chk.disabled = deleting;
        row.querySelector(".del").disabled = deleting;
      }
    }
    function toggle(id, on, range) {
      if (deleting) return;
      const ordered = [...sessions.filter(s => s.pinned), ...sessions.filter(s => !s.pinned)].map(s => s.id);
      const start = ordered.indexOf(anchorId), end = ordered.indexOf(id);
      const ids = range && start >= 0 && end >= 0 ? ordered.slice(Math.min(start, end), Math.max(start, end) + 1) : [id];
      for (const selected of ids) { if (on) sel.add(selected); else sel.delete(selected); }
      anchorId = id;
      // 原地更新勾选，避免每次选择重建列表造成焦点、滚动位置丢失。
      updateSelection();
    }
    function selectAll() {
      if (deleting) return;
      const all = sessions.length > 0 && sel.size === sessions.length;
      sel.clear();
      if (!all) for (const s of sessions) sel.add(s.id);
      anchorId = null;
      updateSelection();
    }
    function open(id) { vscode.postMessage({ type: "openSession", sessionId: id }); }
    function deleteStatus(message, error) {
      $("delete-status").textContent = message;
      $("delete-status").classList.toggle("error", !!error);
      $("delete-status").setAttribute("role", error ? "alert" : "status");
    }
    function confirmDel(ids) {
      if (!ids.length || deleting) return;
      deleting = true; updateSelection(); deleteStatus("等待删除确认…", false);
      vscode.postMessage({ type: "deleteSessions", sessionIds: ids });
    }

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
      anchorId = null;
      updateSelection();
    }
    function enterMulti() {
      multi = true; document.body.classList.add("multi");
      $("multi").textContent = "取消";
      updateSelection();
    }
    $("multi").addEventListener("click", () => {
      if (deleting) return;
      if (multi) { exitMulti(); return; }
      enterMulti();
    });
    $("selectall").addEventListener("click", selectAll);
    $("delsel").addEventListener("click", () => confirmDel([...sel]));
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input:not([type=checkbox]), textarea, [contenteditable=true]")) return;
      if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (deleting) return;
        enterMulti();
        for (const s of sessions) sel.add(s.id);
        anchorId = null; updateSelection();
      } else if (e.key === "Escape" && multi && !deleting) { e.preventDefault(); exitMulti(); }
    });
    $("upd-banner").addEventListener("click", () => vscode.postMessage({ type: "checkUpdate", fromBanner: true }));

    window.addEventListener("message", (ev) => {
      const m = ev.data;
      if (m && m.kind === "ping") { vscode.postMessage({ type: "pong", id: m.id }); return; }
      if (m && m.kind === "sessions") {
        sessions = m.list || []; activeId = m.activeId || null;
        if (m.runningIds !== undefined) runningIds = new Set(m.runningIds || []);
        for (const id of [...sel]) if (!sessions.find((s) => s.id === id)) sel.delete(id);
        if (!sessions.some(s => s.id === anchorId)) anchorId = null;
        render();
      } else if (m && m.kind === "sessions_delete_status") {
        deleting = m.busy;
        const deleted = new Set(m.deletedIds || []);
        sessions = sessions.filter(s => !deleted.has(s.id));
        for (const id of deleted) sel.delete(id);
        if (!deleting && !m.error && deleted.size && multi && !sel.size) exitMulti();
        deleteStatus(m.message || "", m.error);
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
    private html(webview: vscode.Webview, sessionId?: string): string {
        const initialSessionId = (sessionId ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
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
<body data-session-id="${initialSessionId}">
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
            <button id="effort-trigger" class="composer-pick" aria-haspopup="true" aria-expanded="false" title="选择此会话的推理强度"><span id="effort-label" class="effort-label">medium</span><span class="pick-caret">${ICONS.chevron}</span></button>
            <button id="speed-trigger" type="button" class="composer-pick speed-toggle" role="switch" aria-checked="false" aria-label="快速模式"><span class="speed-bolt" aria-hidden="true">${ICONS.fast}</span></button>
            <button id="mode-trigger" class="composer-pick" aria-haspopup="true" aria-label="选择权限模式"><span id="mode-icon" class="pick-emoji"></span><span id="mode-label" class="pick-label"></span><span class="pick-caret">${ICONS.chevron}</span></button>
            <button id="diagnostics-trigger" type="button" class="composer-pick" title="插件诊断中心" aria-label="打开插件诊断中心"><span class="pick-emoji" aria-hidden="true">${ICONS.debug}</span></button>

            <span class="composer-state">
              <button id="ctx-gauge" type="button" class="ctx-gauge hidden" aria-label="上下文使用量，点击压缩" aria-describedby="ctx-tooltip"><span class="cg-ring"><span class="cg-pct"></span></span><span id="ctx-tooltip" class="ctx-tooltip" role="tooltip"></span></button>
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
      <div id="effort-menu" class="pick-menu hidden"></div>
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
