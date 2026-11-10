const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);

test('原生生产队列在授权、查询、提交回调丢失后恢复；迟到回调不重复结算或投递', { skip: process.platform !== 'darwin', timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-queue-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const source = await fs.readFile(path.join(__dirname, '../native/Notifications.swift'), 'utf8');
  const fixture = `
final class FakeCenter: NotificationCenterServing {
    var stall = ""
    var authorization: ((Bool, Error?) -> Void)?
    var lookup: (([UNNotification]) -> Void)?
    var submission: ((Error?) -> Void)?
    var submits = 0
    var removals = 0
    func setDelegate(_ delegate: UNUserNotificationCenterDelegate) {}
    func authorize(_ completion: @escaping (Bool, Error?) -> Void) {
        if stall == "authorization" { authorization = completion; stall = "" }
        else if stall == "denied" { completion(false, nil); stall = "" }
        else { completion(true, nil) }
    }
    func delivered(_ completion: @escaping ([UNNotification]) -> Void) {
        if stall == "delivered_lookup" { lookup = completion; stall = "" }
        else { completion([]) }
    }
    func removeDelivered(_ ids: [String]) { removals += 1 }
    func removePending(_ ids: [String]) { removals += 1 }
    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void) {
        submits += 1
        if stall == "submit" { submission = completion; stall = "" }
        else { completion(nil) }
    }
    func late() { authorization?(true, nil); lookup?([]); submission?(nil) }
}
func notice(_ id: String, _ at: Double, _ operation: String = "show", _ expires: Double? = nil) -> Notice {
    Notice(id: "codex-session:" + id, operation: operation, sessionId: id, createdAt: at,
           expiresAt: expires, title: "test", body: "", url: "vscode://blackrock1121.vscode-codex/notification?session=" + id, clickEndpoint: nil)
}
func until(_ condition: () -> Bool) {
    let limit = Date().addingTimeInterval(2)
    while !condition() && Date() < limit { RunLoop.main.run(until: Date().addingTimeInterval(0.001)) }
    precondition(condition(), "队列未恢复")
}
let now = Date().timeIntervalSince1970 * 1000
for stage in ["authorization", "delivered_lookup", "submit"] {
    let center = FakeCenter()
    // 明确注入系统边界，不调用真实通知中心。
    let queue = NotificationApp(center: center, operationTimeout: 0.15)
    center.stall = stage
    var results: [NoticeResult] = []
    queue.enqueue(notice("a", now)) { results.append($0) }
    until { center.authorization != nil || center.lookup != nil || center.submission != nil }
    queue.enqueue(notice("a", now + 1)) { results.append($0) }
    var other = false
    queue.enqueue(notice("b", now)) { other = $0.accepted }
    until { other }
    precondition(results.isEmpty, "其他会话不应等待卡住的会话")
    until { results.count == 2 }
    precondition(results[0].code == "ETIMEDOUT" && results[0].phase == stage)
    precondition(results[1].error == nil && results[1].accepted)
    let submits = center.submits, removals = center.removals
    center.late()
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    precondition(results.count == 2 && center.submits == submits && center.removals == removals,
                 "迟到回调不能重复出队、清理或发送")
    precondition(queue.queues.isEmpty)
}
let center = FakeCenter(), queue = NotificationApp(center: FakeCenter(), operationTimeout: 0.15)
let denied = NotificationApp(center: center, operationTimeout: 0.15)
center.stall = "denied"
var deniedResults: [NoticeResult] = []
denied.enqueue(notice("denied", now)) { deniedResults.append($0) }
until { deniedResults.count == 1 }
precondition(deniedResults[0].code == "EACCES" && center.submits == 0)
denied.enqueue(notice("denied", now + 1)) { deniedResults.append($0) }
until { deniedResults.count == 2 }
precondition(deniedResults[1].accepted && center.submits == 1)
var expired: NoticeResult?
queue.enqueue(notice("expired", now, "show", now - 1)) { expired = $0 }
precondition(expired?.code == "ETIMEDOUT" && queue.queues.isEmpty)
// 清理查询也必须有截止时间，恢复后保留新通知，旧查询不能再删除它。
let clearCenter = FakeCenter()
let cq = NotificationApp(center: clearCenter, operationTimeout: 0.15)
clearCenter.stall = "delivered_lookup"
var clears: [NoticeResult] = []
cq.enqueue(notice("clear", now, "clear")) { clears.append($0) }
until { clearCenter.lookup != nil }
cq.enqueue(notice("clear", now + 1)) { clears.append($0) }
until { clears.count == 2 }
let removed = clearCenter.removals
clearCenter.late()
RunLoop.main.run(until: Date().addingTimeInterval(0.02))
precondition(clearCenter.removals == removed && clears.count == 2 && clears[1].accepted)
print("native queue: timeout phases=3, recovery=4, denied, expired, late callbacks passed")
`;
  const main = path.join(dir, 'main.swift'), binary = path.join(dir, 'queue');
  await fs.writeFile(main, source.slice(0, source.indexOf('let app = NSApplication.shared')) + fixture);
  await exec('/usr/bin/swiftc', [main, '-o', binary], {timeout: 45000});
  const result = await exec(binary, [], {timeout: 10000});
  assert.match(result.stdout, /late callbacks passed/);
});
