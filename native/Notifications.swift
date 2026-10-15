import AppKit
import CoreServices
import UserNotifications

struct Notice: Decodable {
    let id: String
    let operation: String?
    let sessionId: String?
    let createdAt: Double?
    let title: String?
    let body: String?
    let url: String?
    let clickEndpoint: String?
}

// 点击只回到发送通知的本机扩展宿主，地址与随机路径由插件生成。
func notificationClickEndpoint(_ value: String) -> URL? {
    guard let url = URL(string: value),
          let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          parts.scheme == "http", parts.host == "127.0.0.1",
          let port = parts.port, (1...65535).contains(port),
          parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
          url.path.hasPrefix("/notification/"),
          UUID(uuidString: String(url.path.dropFirst("/notification/".count))) != nil else { return nil }
    return url
}

// 只允许通知回到本扩展，不能让通知成为任意 URL/命令执行入口。
func callbackURL(_ value: String) -> URL? {
    guard let url = URL(string: value),
          ["vscode", "vscode-insiders"].contains(url.scheme ?? ""),
          url.host == "blackrock1121.vscode-codex",
          url.path == "/notification" else { return nil }
    return url
}

func notificationSession(_ value: String) -> String? {
    guard let url = callbackURL(value),
          let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery else { return nil }
    // vscode.Uri.toString() 会把整个 query 中的 = 和 & 也编码。
    // 仅在没有明文分隔符时解开这一层；不能修改用于系统跳转的原始 URL。
    let query = raw.contains("=") ? raw : (raw.removingPercentEncoding ?? "")
    let values = query.split(separator: "&", omittingEmptySubsequences: false).compactMap { item -> String? in
        let pair = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        guard pair[0].removingPercentEncoding == "session" else { return nil }
        return pair.count == 2 ? String(pair[1]) : ""
    }
    guard values.count == 1,
          let session = values[0].replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
          !session.isEmpty else { return nil }
    return session
}

// 清理只接受完整会话 ID；编号与回调互相矛盾、缺失或重复参数时宁可保留。
// 旧版随机编号仅通过有效的回调会话识别，不按标题、项目或 ID 前缀猜测。
func notificationBelongsToSession(identifier: String, url: String, sessionId: String?) -> Bool {
    guard let sessionId = sessionId, !sessionId.isEmpty,
          notificationSession(url) == sessionId else { return false }
    return !identifier.hasPrefix("codex-session:") || identifier == "codex-session:\(sessionId)"
}

// 辅助程序重启后内存中的 latest 为空，用系统已展示通知的时间继续保护新提醒。
func notificationIsNewer(identifier: String, url: String, sessionId: String?,
                         createdAt: Double?, deliveredAt: Double, than requestedAt: Double) -> Bool {
    return notificationBelongsToSession(identifier: identifier, url: url, sessionId: sessionId)
        && (createdAt ?? deliveredAt) > requestedAt
}

final class NotificationClickClient: NSObject, URLSessionTaskDelegate {
    lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    func open(_ value: String, completion: @escaping (Bool) -> Void) {
        guard let endpoint = notificationClickEndpoint(value) else { completion(false); return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        session.dataTask(with: request) { _, response, error in
            completion(error == nil && (response as? HTTPURLResponse)?.statusCode == 204)
        }.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class NotificationApp: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    // 所有队列状态只在主线程访问；同一会话串行，不同会话互不阻塞。
    var queues: [String: [() -> Void]] = [:]
    var latest: [String: Double] = [:]
    let clicks = NotificationClickClient()

    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
    }

    func enqueue(_ notice: Notice, finish: @escaping (String?) -> Void) {
        let key = notice.sessionId.map { "codex-session:\($0)" } ?? notice.id
        let time = notice.createdAt ?? Date().timeIntervalSince1970 * 1000
        latest[key] = max(latest[key] ?? time, time)
        let current = { self.latest[key] == time }
        let done: (String?) -> Void = { error in
            DispatchQueue.main.async {
                finish(error)
                self.queues[key]?.removeFirst()
                if self.queues[key]?.isEmpty == true { self.queues.removeValue(forKey: key) }
                else { self.queues[key]?.first?() }
            }
        }
        let action = {
            guard current() else { done(nil); return }
            if notice.operation == "clear" {
                self.replace(notice, key: key, current: current, finish: done)
                return
            }
            self.center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                DispatchQueue.main.async {
                    guard current() else { done(nil); return }
                    guard granted else {
                        done(error?.localizedDescription ?? "通知权限未开启，请在 macOS 系统设置 → 通知 → Codex Copilot Notifications 中允许通知。")
                        return
                    }
                    self.replace(notice, key: key, current: current, finish: done)
                }
            }
        }
        queues[key, default: []].append(action)
        if queues[key]?.count == 1 { action() }
    }

    func replace(_ notice: Notice, key: String, current: @escaping () -> Bool, finish: @escaping (String?) -> Void) {
        center.getDeliveredNotifications { delivered in
            DispatchQueue.main.async {
                guard current() else { finish(nil); return }
                let clearing = notice.operation == "clear"
                let requestedAt = notice.createdAt ?? Date().timeIntervalSince1970 * 1000
                if delivered.contains(where: { item in
                    notificationIsNewer(identifier: item.request.identifier,
                        url: item.request.content.userInfo["url"] as? String ?? "", sessionId: notice.sessionId,
                        createdAt: item.request.content.userInfo["createdAt"] as? Double,
                        deliveredAt: item.date.timeIntervalSince1970 * 1000, than: requestedAt)
                }) { finish(nil); return }
                // 同时识别旧版随机 ID 通知；只清理该会话，派生后的不同 ID 不受影响。
                let old = delivered.filter { notification in
                    let request = notification.request
                    return notificationBelongsToSession(identifier: request.identifier,
                        url: request.content.userInfo["url"] as? String ?? "", sessionId: notice.sessionId)
                        && (clearing || request.identifier != key)
                }.map { $0.request.identifier }
                self.center.removeDeliveredNotifications(withIdentifiers: old)
                if clearing {
                    self.center.removePendingNotificationRequests(withIdentifiers: [key])
                    finish(nil)
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = notice.title ?? ""
                content.body = notice.body ?? ""
                content.sound = .default
                content.userInfo = ["url": notice.url ?? "", "createdAt": requestedAt]
                if let endpoint = notice.clickEndpoint { content.userInfo["clickEndpoint"] = endpoint }
                content.threadIdentifier = key
                // 相同 request identifier 会替换通知中心里已展示的旧通知并再次提醒。
                self.center.add(UNNotificationRequest(identifier: key, content: content, trigger: nil)) { error in
                    finish(error?.localizedDescription)
                }
            }
        }
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        for filename in filenames {
            let file = URL(fileURLWithPath: filename)
            guard file.lastPathComponent == "request.codex-notification",
                  file.deletingLastPathComponent().lastPathComponent.hasPrefix("codex-chat-notify-") else { continue }
            let finish: (String?) -> Void = { error in
                let result: [String: Any] = error.map { ["ok": false, "error": $0] } ?? ["ok": true]
                if let data = try? JSONSerialization.data(withJSONObject: result) {
                    try? data.write(to: file.deletingLastPathComponent().appendingPathComponent("result.json"), options: .atomic)
                }
            }
            guard let data = try? Data(contentsOf: file), data.count <= 16384,
                  let notice = try? JSONDecoder().decode(Notice.self, from: data),
                  notice.operation == nil || ["show", "clear"].contains(notice.operation!),
                  notice.operation == "clear" ? !(notice.sessionId ?? "").isEmpty : callbackURL(notice.url ?? "") != nil,
                  notice.sessionId == nil || notice.id == "codex-session:\(notice.sessionId!)",
                  notice.operation == "clear" || notice.sessionId == nil || notificationSession(notice.url ?? "") == notice.sessionId else {
                finish("本机通知内容无效。")
                continue
            }
            if let endpoint = notice.clickEndpoint, notificationClickEndpoint(endpoint) == nil {
                finish("本机通知跳转地址无效。")
                continue
            }
            enqueue(notice, finish: finish)
        }
        sender.reply(toOpenOrPrint: .success)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let value = response.notification.request.content.userInfo["url"] as? String,
           let url = callbackURL(value) {
            if let value = response.notification.request.content.userInfo["clickEndpoint"] as? String {
                clicks.open(value) { opened in
                    if !opened {
                        // 原窗口已失效时不能退回系统 URI 路由，否则又可能激活无关窗口。
                        DispatchQueue.main.async {
                            let alert = NSAlert()
                            alert.messageText = "未能返回通知来源窗口"
                            alert.informativeText = "原窗口可能已关闭或重载，请在对应工作区的会话历史中打开任务。"
                            alert.addButton(withTitle: "好")
                            NSApp.activate(ignoringOtherApps: true)
                            alert.runModal()
                        }
                    }
                    completionHandler()
                }
                return
            }
            // 仅兼容升级前已经展示、没有直连地址的通知。
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        }
        completionHandler()
    }
}

let app = NSApplication.shared
// 升级后辅助应用所在的扩展目录会变化，先让系统登记当前完整应用及其图标。
LSRegisterURL(Bundle.main.bundleURL as CFURL, true)
let delegate = NotificationApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
