const {test}=require('node:test');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
const exec=require('node:util').promisify(require('node:child_process').execFile);

test('点击失败提示立即返回、复用窗口且可关闭；不阻塞后续主队列回调', {skip:process.platform!=='darwin',timeout:60000}, async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-notification-nonmodal-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source=await fs.readFile(path.join(__dirname,'../native/Notifications.swift'),'utf8');
 const methods=source.slice(source.indexOf('    private var clickFailureAlert:'),source.indexOf('    func applicationWillFinishLaunching('));
 // 执行生产展示/关闭逻辑，以无界面的窗口接口替换 AppKit，避免测试抢占用户焦点。
 const fixture=`import Foundation
var created = 0
final class FakeButton: NSObject { weak var target: NSObject?; var action: Selector? }
final class FakeWindow { var isReleasedWhenClosed = true; var visible = false
 func center() {} ; func makeKeyAndOrderFront(_ sender: Any?) { visible = true }; func close() { visible = false }
}
var shown: NSAlert?
final class NSAlert {
 var messageText = "", informativeText = ""; let window = FakeWindow(); let button = FakeButton()
 init() { created += 1; shown = self }
 func addButton(withTitle title: String) -> FakeButton { button }
 func layout() {}
}
final class FakeApp {func activate(ignoringOtherApps: Bool) {}}
let NSApp = FakeApp()
final class Presenter: NSObject {\n${methods}\n}
let presenter = Presenter(); var delivered = false
DispatchQueue.main.async {
 presenter.showClickFailure()
 precondition(shown?.window.visible == true)
 presenter.showClickFailure(); precondition(created == 1, "重复失败只能保留一个提示")
 DispatchQueue.main.async { delivered = true }
}
let deadline = Date().addingTimeInterval(2)
while !delivered && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.001)) }
precondition(delivered, "用户未关闭失败提示时，后续主队列回调仍须执行")
let button = shown!.button
precondition(button.target === presenter && button.action != nil)
_ = button.target?.perform(button.action!)
precondition(shown?.window.visible == false)
presenter.showClickFailure();precondition(created == 2)
presenter.dismissClickFailure()
print("nonmodal callback and dismissal passed")
`;
 const file=path.join(dir,'main.swift'),binary=path.join(dir,'nonmodal');await fs.writeFile(file,fixture);
 await exec('/usr/bin/swiftc',[file,'-o',binary],{timeout:45000});
 assert.match((await exec(binary,[],{timeout:5000})).stdout,/dismissal passed/);
 assert.doesNotMatch(source,/\.runModal\(/,'生产代码不能进入应用级模态循环');
});
