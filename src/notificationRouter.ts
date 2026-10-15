import * as http from "node:http";
import { randomUUID } from "node:crypto";

/** 每个扩展宿主独立接收点击，绕过 VS Code 把 window:1 匹配到 window:19 的 URI 路由。
 * 随机路径只交给本机通知程序；不按项目目录、窗口标题或会话历史猜测来源。
 */
export class NotificationRouter {
    private readonly routes = new Map<string, { path: string; open: () => Promise<void> }>();
    private readonly server = http.createServer((req, res) => {
        const route = [...this.routes.values()].find(route => route.path === req.url);
        if (req.method !== "POST" || req.headers.origin || !route || this.disposed) {
            res.writeHead(404).end();
            req.resume();
            return;
        }
        req.resume();
        void Promise.resolve().then(() => {
            if (this.disposed) throw new Error("通知来源窗口已关闭。");
            return route.open();
        }).then(
            () => res.writeHead(204).end(),
            () => res.writeHead(500).end(),
        );
    });
    private starting?: Promise<string>;
    private cancelStart?: () => void;
    private disposed = false;

    constructor() {
        this.server.requestTimeout = 5000;
        this.server.headersTimeout = 5000;
        this.server.keepAliveTimeout = 1000;
        this.server.unref();
    }

    async endpoint(key: string, open: () => Promise<void>): Promise<string> {
        if (this.disposed) throw new Error("通知来源窗口已关闭。");
        this.starting ??= new Promise<string>((resolve, reject) => {
            this.cancelStart = () => reject(new Error("通知来源窗口已关闭。"));
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
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
