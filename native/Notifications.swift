import AppKit
import CoreServices
import UserNotifications

struct Notice: Decodable {
    let id: String
    let title: String
    let body: String
    let url: String
}

// 只允许通知回到本扩展，不能让通知成为任意 URL/命令执行入口。
func callbackURL(_ value: String) -> URL? {
    guard let url = URL(string: value),
          ["vscode", "vscode-insiders"].contains(url.scheme ?? ""),
          url.host == "blackrock1121.vscode-codex",
          url.path == "/notification" else { return nil }
    return url
}

final class NotificationApp: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()

    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
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
                  callbackURL(notice.url) != nil else {
                finish("本机通知内容无效。")
                continue
            }
            center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                guard granted else {
                    finish(error?.localizedDescription ?? "通知权限未开启，请在 macOS 系统设置 → 通知 → Codex Copilot Notifications 中允许通知。")
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = notice.title
                content.body = notice.body
                content.sound = .default
                content.userInfo = ["url": notice.url]
                self.center.add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil)) { error in
                    finish(error?.localizedDescription)
                }
            }
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
