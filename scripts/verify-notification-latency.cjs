const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),ts=require('typescript');
async function run(source) {
 const start=source.indexOf('    private notificationUri('),end=source.indexOf('    private notificationVersion(',start);
 const raw=source.indexOf('    private rawNotificationUri(');
 const methods=(raw<0?'':source.slice(raw,start))+source.slice(start,end);
 const timers=new Map();let next=0;
 const vscode={Uri:{from:x=>x},env:{uriScheme:'vscode',asExternalUri:()=>new Promise(()=>{})}};
 const Provider=vm.runInNewContext(ts.transpile(`class Provider { ${methods} }; Provider;`,{target:ts.ScriptTarget.ES2022}),{
  vscode,URLSearchParams,setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)
 });
 const p=new Provider();p.notificationWindowKey='test';p.context={extension:{id:'blackrock1121.vscode-codex'}};
 let state='pending';p.notificationUri('test').then(()=>state='resolved',e=>state=e.code);
 await new Promise(r=>setImmediate(r));
 const deadline=[...timers.values()].map(t=>t.ms);
 for(const timer of [...timers.values()])if(timer.ms<=1000)timer.fn();
 await new Promise(r=>setImmediate(r));
 return {after1000Ms:state,deadlinesMs:deadline,cached:p.notificationUris.has('test')};
}
(async()=>{
 const baseline=execFileSync('git',['show','2424ae6:src/panel/chatViewProvider.ts'],{encoding:'utf8'});
 const before=await run(baseline),after=await run(fs.readFileSync('src/panel/chatViewProvider.ts','utf8'));
 assert.equal(before.after1000Ms,'pending');assert.equal(after.after1000Ms,'ETIMEDOUT');assert.equal(after.cached,false);
 const file='/Users/duodian/.codex-chat/logs/codex-chat-2026-11-10.log';
 const rows=fs.readFileSync(file,'utf8').split('\n');const values=[],samples=[];
 for(const [i,line] of rows.entries()){
  if(!line.includes('pluginVersion=0.1.208'))continue;
  const m=/local_result .*elapsedMs=(\d+)/.exec(line);
  if(m){values.push(Number(m[1]));samples.push({line:i+1,elapsedMs:Number(m[1])});}
 }
 const report={version:require('../package.json').version,at:new Date().toISOString(),baselineCommit:'2424ae6',
  sourceComparison:{scenario:'跳转地址解析永久不返回；执行生产方法并推进受控时钟1000ms',before,after,
   fallbackEvidence:'test/notifications.test.cjs 验证1秒后仍发送、HTTP直连只打开原窗口、迟到解析不重发、缓存恢复'},
  observed208:{file,samples,count:values.length,minMs:Math.min(...values),maxMs:Math.max(...values)},
  configuration:{observedNotifyMinDurationSec:30,changed:false,meaning:'完成任务耗时门槛；等待提醒距上次用户操作不足30秒时补足剩余时间'},
  fixes:['跳转地址解析有期限，直连降级保持窗口身份','点击失败提示不再进入应用级模态循环','隐私会话本机通知不含原文','排队期间窗口销毁不再发送','准备、地址解析、队列、启动、原生阶段与定时器延迟分别落盘'],
  sources:['https://developer.apple.com/documentation/appkit/nsalert/runmodal()','https://developer.apple.com/documentation/appkit/nswindow/makekeyandorderfront(_:)'],
  limits:['新版历史样本较少，不足以排除所有偶发延迟','日志系统接受时间不等于横幅可见时间','旧版9.3/13.5秒发送长尾不能证明由模态弹窗导致','非模态提示测试使用生产Swift方法和无界面窗口接口；未自动操作用户的真实窗口']};
 fs.writeFileSync('benchmarks/notification-latency.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
