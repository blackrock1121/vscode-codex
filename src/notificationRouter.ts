import { observeOperation, operationLog, operationFailure } from './operations';
import * as http from "node:http";
import { randomUUID } from "node:crypto";

/** 每个扩展宿主独立接收点击，绕过 VS Code 把 window:1 匹配到 window:19 的 URI 路由。
 * 随机路径只交给本机通知程序；不按项目目录、窗口标题或会话历史猜测来源。
 */
export class NotificationRouter {
    private readonly routes = new Map<string, { path: string; open: () => Promise<void>; running?: Promise<void> }>();
    private readonly server = http.createServer((req, res) => {
        const route = [...this.routes.values()].find(route => route.path === req.url);
        if (req.method !== "POST" || req.headers.origin || !route || this.disposed) {
            res.writeHead(404).end();
            req.resume();
            return;
        }
        req.resume();
        // 先验证来源窗口仍存活，再把准确的主进程交给通知程序完成 macOS 焦点交接。
        // 预检不打开会话；旧通知不能仅凭应用名称唤起另一个窗口。
        const action = req.headers['x-codex-notification-action'];
        if (action === 'prepare') {
            if (!Number.isInteger(this.appPid) || this.appPid <= 0 || this.appPid > 0x7fffffff) {
                operationLog('notification.activate', 'unavailable', { reason: 'missing_app_pid' });
                res.writeHead(503).end();
            } else {
                operationLog('notification.activate', 'prepared');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                    .end(JSON.stringify({ pid: this.appPid }));
            }
            return;
        }
        if (action !== undefined) { res.writeHead(404).end(); return; }
        void Promise.resolve().then(() => {
            if (!route.running) {
                const running = observeOperation('notification.click', () => {
                    if (this.disposed) throw Object.assign(new Error("通知来源窗口已关闭。"), { name: 'AbortError' });
                    return route.open();
                });
                route.running = running.finally(() => { route.running = undefined; });
            }
            return route.running;
        }).then(
            () => res.writeHead(204).end(),
            () => res.writeHead(500).end(),
        );
    });
    private starting?: Promise<string>;
    private cancelStart?: () => void;
    private disposed = false;

    constructor(private readonly appPid = Number(process.env.VSCODE_PID)) {
        this.server.requestTimeout = 5000;
        this.server.headersTimeout = 5000;
        this.server.keepAliveTimeout = 1000;
        this.server.unref();
        this.server.on('error', error => { if (this.server.listening && !this.disposed) operationFailure('notification.server', error); });
    }

    async endpoint(key: string, open: () => Promise<void>): Promise<string> {
        if (this.disposed) throw new Error("通知来源窗口已关闭。");
        this.starting ??= new Promise<string>((resolve, reject) => {
            this.cancelStart = () => reject(new Error("通知来源窗口已关闭。"));
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
                this.server.off('error', reject);
                this.cancelStart = undefined;
                if (this.disposed) { this.server.close(); reject(new Error("通知来源窗口已关闭。")); return; }
                const address = this.server.address() as import("node:net").AddressInfo;
                resolve(`http://127.0.0.1:${address.port}`);
            });
        }).catch(error => { this.starting = undefined; throw error; });
        const origin = await this.starting;
        if (this.disposed) throw new Error("通知来源窗口已关闭。");
        const route = this.routes.get(key) ?? { path: `/notification/${randomUUID()}`, open };
        route.open = open;
        this.routes.set(key, route);
        return origin + route.path;
    }

    dispose(): void {
        this.disposed = true;
        this.cancelStart?.();
        this.cancelStart = undefined;
        this.routes.clear();
        this.server.close();
        this.server.closeAllConnections();
    }
}
