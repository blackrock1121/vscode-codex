const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('原生清理只匹配完整会话，保留其他会话、派生分支、测试通知和身份冲突通知', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-notification-ownership-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = await fs.readFile(path.join(__dirname, '../native/Notifications.swift'), 'utf8');
  // 编译生产代码中的纯归属判断，不启动通知程序、不接触用户的通知中心。
  const policy = source.slice(0, source.indexOf('final class NotificationApp:'))
    .replace(/^import (AppKit|CoreServices|UserNotifications)$/gm, '');
  const fixture = `
let a = "01999999-aaaa-7000-8000-000000000001"
let branch = "01999999-aaaa-7000-8000-000000000002"
func url(_ id: String) -> String { "vscode://blackrock1121.vscode-codex/notification?window=old-window&session=\\(id)" }
let notices: [(String, String)] = [
    ("codex-session:\\(a)", url(a)),
    ("legacy-a-1", url(a)), ("legacy-a-2", url(a)),
    ("codex-session:\\(branch)", url(branch)),
    ("legacy-branch", url(branch)),
    ("codex-session:other", url("other")),
    ("test", "vscode://blackrock1121.vscode-codex/notification?window=current"),
    ("codex-session:\\(a)", url(branch)),
    ("codex-session:\\(branch)", url(a)),
    ("unknown", ""),
    ("ambiguous", url(a) + "&session=\\(branch)"),
    ("wrong-app", "vscode://other.app/notification?session=\\(a)")
]
let removed = notices.enumerated().filter {
    notificationBelongsToSession(identifier: $0.element.0, url: $0.element.1, sessionId: a)
}.map { $0.offset }
precondition(removed == [0, 1, 2], "不允许误清其他会话")
for notice in notices {
    precondition(!notificationBelongsToSession(identifier: notice.0, url: notice.1, sessionId: nil))
    precondition(!notificationBelongsToSession(identifier: notice.0, url: notice.1, sessionId: ""))
}
let encoded = "vscode://blackrock1121.vscode-codex/notification?window%3Dold-window%26session%3D\\(a)%26windowId%3D42"
precondition(notificationSession(encoded) == a, "必须识别 VS Code 编码后的完整查询串")
precondition(notificationBelongsToSession(identifier: "codex-session:\\(a)", url: encoded, sessionId: a))
precondition(!notificationBelongsToSession(identifier: "codex-session:\\(branch)", url: encoded, sessionId: a))
precondition(notificationSession(encoded + "%26session%3D\\(branch)") == nil)
precondition(notificationSession("vscode://blackrock1121.vscode-codex/notification?window%3Dtest%26session%3D") == nil)
// 程序已重启（无内存队列）时，旧 clear/show 不能覆盖更新的同会话提醒。
precondition(notificationIsNewer(identifier: "codex-session:\\(a)", url: encoded, sessionId: a, createdAt: 200, deliveredAt: 300, than: 100))
precondition(!notificationIsNewer(identifier: "codex-session:\\(a)", url: encoded, sessionId: a, createdAt: 100, deliveredAt: 300, than: 200))
precondition(!notificationIsNewer(identifier: "codex-session:\\(branch)", url: url(branch), sessionId: a, createdAt: 300, deliveredAt: 300, than: 100))
precondition(notificationIsNewer(identifier: "legacy", url: url(a), sessionId: a, createdAt: nil, deliveredAt: 200, than: 100))
for query in ["", "&", "&&", "session", "session=", "window=hello%26session%3Dfake"] {
    precondition(notificationSession("vscode://blackrock1121.vscode-codex/notification?" + query) == nil)
}
print("ownership verified")
`;
  const file = path.join(dir, 'main.swift'), binary = path.join(dir, 'ownership');
  await fs.writeFile(file, 'import Foundation\n' + policy + fixture);
  execFileSync('/usr/bin/swiftc', [file, '-o', binary], { timeout: 60000 });
  assert.match(execFileSync(binary, { encoding: 'utf8', timeout: 10000 }), /ownership verified/);
  assert.doesNotMatch(source, /removeAllDeliveredNotifications|removeAllPendingNotificationRequests|func applicationDidFinishLaunching/);
});
