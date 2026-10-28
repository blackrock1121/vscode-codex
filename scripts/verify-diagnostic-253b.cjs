// 固定源码基线、固定日志长度与时间窗口回放；不修改原始日志或用户配置。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),http=require('node:http'),{WebSocket}=require('ws');
const assert=require('node:assert/strict'),root=path.resolve(__dirname,'..'),baseline='74cde55';
const reportFile=process.argv[2]??path.join(os.homedir(),'.codex-chat/diagnostics/253b5021-b003-4ad9-9186-f99d6e5559a8.report.md');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-253b-verify-')),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function handshake(Relay){
 const sockets=new Set(),timers=new Set(),server=http.createServer();let attempts=0;
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 server.on('upgrade',(_req,socket)=>{attempts++;const timer=setTimeout(()=>{timers.delete(timer);socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');},80);timers.add(timer);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await Relay.start(`http://127.0.0.1:${server.address().port}/v1`,()=>undefined,()=>{});
 try{
  const result={upstreamDelayMs:80,prematureOpen:0,clientFrames:0,httpStatus:null};
  const start=performance.now();
  await new Promise((resolve,reject)=>{
   const ws=new WebSocket(relay.baseUrl.replace('http:','ws:')+'/responses');
   const deadline=setTimeout(()=>{ws.terminate();reject(Error('握手实验超过 3 秒'));},3000);
   ws.on('open',()=>{result.prematureOpen++;result.clientFrames++;ws.send('{"type":"response.create","model":"chosen","input":[]}');});
   ws.on('unexpected-response',(req,res)=>{result.httpStatus=res.statusCode;res.destroy();req.destroy();ws.terminate();});
   ws.on('error',()=>{});ws.on('close',()=>{clearTimeout(deadline);result.elapsedMs=+(performance.now()-start).toFixed(2);resolve();});
  });
  return {...result,upstreamAttempts:attempts};
 }finally{relay.close();for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
}
(async()=>{
 const archive=execFileSync('git',['archive',baseline,'src','scripts/log-audit.cjs','package.json'],{cwd:root,maxBuffer:16*1024*1024});
 const oldRoot=path.join(temp,'baseline');fs.mkdirSync(oldRoot);execFileSync('tar',['-x','-C',oldRoot],{input:archive});
 await require('esbuild').build({entryPoints:[path.join(oldRoot,'src/diagnostics/scan.ts'),path.join(oldRoot,'src/codex/compactionRelay.ts')],
  outdir:path.join(temp,'old'),bundle:true,platform:'node',format:'cjs',nodePaths:[path.join(root,'node_modules')],external:['vscode']});
 const snapshot=path.join(temp,'logs');fs.mkdirSync(snapshot);const logs=path.join(os.homedir(),'.codex-chat/logs'),files=[];
 for(const name of fs.readdirSync(logs).filter(n=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort()){
  const source=fs.openSync(path.join(logs,name),'r'),size=fs.fstatSync(source).size,dest=fs.openSync(path.join(snapshot,name),'w'),digest=crypto.createHash('sha256');
  try{let offset=0;const buffer=Buffer.alloc(1024*1024);while(offset<size){const n=fs.readSync(source,buffer,0,Math.min(buffer.length,size-offset),offset);if(!n)throw Error('日志扫描期间截短');fs.writeSync(dest,buffer,0,n);digest.update(buffer.subarray(0,n));offset+=n;}}
  finally{fs.closeSync(source);fs.closeSync(dest);}files.push({name,bytes:size,sha256:digest.digest('hex')});
 }
 const report=fs.readFileSync(reportFile,'utf8'),positions=[...report.matchAll(/^- ((?:src|media)\/[^:]+):(\d+) · ([^\n]+)/gm)].map(m=>({file:m[1],line:+m[2],detail:m[3]}));
 const before=require(path.join(temp,'old/diagnostics/scan.js')).scanPluginLogs,after=require(path.join(root,'dist/test/diagnostics/scan.js')).scanPluginLogs;
 const request={kind:'performance',engine:'rules',hours:24,fromMs:Date.parse('2026-10-27T09:09:05.931Z'),toMs:Date.parse('2026-10-28T09:09:05.931Z')};
 const summarize=r=>({summary:r.summary,general:r.general,coverage:r.coverage});
 const oldScan=summarize(await before(snapshot,()=>{},request)),newScan=summarize(await after(snapshot,()=>{},request));
 assert.deepEqual(oldScan.summary,newScan.summary);assert.equal(oldScan.coverage.records,newScan.coverage.records);
 const allRetained=summarize(await after(snapshot,()=>{},{kind:'performance',hours:0,engine:'rules',toMs:Date.now()}));
 const oldHandshake=await handshake(require(path.join(temp,'old/codex/compactionRelay.js')).CompactionRelay);
 const newHandshake=await handshake(require(path.join(root,'dist/test/codex/compactionRelay.js')).CompactionRelay);
 assert.equal(oldHandshake.prematureOpen,1);assert.equal(newHandshake.prematureOpen,0);assert.equal(newHandshake.httpStatus,403);
 const audit=require('./log-audit.cjs').buildLogAudit(root).manifest;
 const result={diagnosticId:'253b5021-b003-4ad9-9186-f99d6e5559a8',baseline,version:require('../package.json').version,
  report:{bytes:Buffer.byteLength(report),lines:report.split('\n').length,sha256:hash(report),sourcePositions:positions,
   note:'完整报告没有源码位置清单；当前构建另行扫描，候选不等于实际缺口。'},
  logSnapshots:files,before:oldScan,after:newScan,allRetained,handshake:{before:oldHandshake,after:newHandshake},
  sourceAudit:audit,
  limitations:['真实后端 403/502、MCP worker、技能安装、远端遥测恢复均未由本机修复证明解决。',
   '历史失败记录完整保留，分类改变不代表历史事件已恢复；工具失败和轮次耗时统计须保持一致。',
   '80ms 是受控握手拒绝延迟，测量的是消除虚假连接和无效发送，不能外推为真实任务总耗时降低。',
   '源码清单是逐文件静态扫描结果；优先核验了静默/委派边界及变更路径，未对每个候选做动态故障注入。']};
 fs.writeFileSync(path.join(root,'benchmarks/diagnostic-253b-results.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({report:result.report,files:files.length,before:oldScan.general,after:newScan.general,
  allRetained:allRetained.summary,handshake:result.handshake,sourceAudit:{files:audit.files.length,candidates:audit.files.reduce((n,f)=>n+f.candidates.length,0),sourceHash:audit.sourceHash}},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
