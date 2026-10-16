// 只读本机历史；不发起模型请求，不输出历史正文、工具输出或命令。
// 先运行 node scripts/build-test.cjs，再传入要比较的会话 UUID。
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {CodexRpc,resolveCodex}=require('../dist/test/codex/rpc.js');
const {SessionStore}=require('../dist/test/codex/session.js');
const root=path.resolve(__dirname,'..'),baseline='ce02ed8';
const ids=process.argv.slice(2);
if(!ids.length||ids.some(id=>!/^\w{8}(?:-\w{4}){3}-\w{12}$/.test(id)))throw Error('请传入会话 UUID。');
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
 return sorted.length?sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2:null;};
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-history-bench-'));
 const rpc=new CodexRpc(resolveCodex('codex'),root);
 try {
  const compiled=path.join(temp,'baseline.cjs');
  require('esbuild').buildSync({stdin:{contents:execFileSync('git',['show',`${baseline}:src/codex/session.ts`],{cwd:root,encoding:'utf8'}),
   resolveDir:path.join(root,'src/codex'),loader:'ts'},outfile:compiled,platform:'node',format:'cjs',bundle:true});
  const OldStore=require(compiled).SessionStore;
  await rpc.start();
  const old=new OldStore(root,()=> 'codex'),current=new SessionStore(root,()=> 'codex');
  old.connection=current.connection=async()=>rpc;
  const samples=[];
  for(const [index,id] of ids.entries())for(let repeat=0;repeat<3;repeat++){
   const pair=[];
   for(const mode of repeat%2?['after','before']:['before','after']){
    const request=rpc.request.bind(rpc);let bytes=0,calls=0;
    rpc.request=async(...args)=>{const response=await request(...args);bytes+=Buffer.byteLength(JSON.stringify(response));calls++;return response;};
    const at=performance.now();let count;
    try {count=mode==='before'?(await old.hydrate(id),old.countLines(id)):await current.readTurnCount(id);}
    finally {rpc.request=request;}
    pair.push({mode,count,elapsedMs:Math.round(performance.now()-at),responseBytes:bytes,rpcCalls:calls});
   }
   samples.push({session:index+1,repeat:repeat+1,equalCount:pair[0].count===pair[1].count,measurements:pair});
  }
  const valid=samples.filter(s=>s.equalCount),before=valid.flatMap(s=>s.measurements.filter(m=>m.mode==='before')),
   after=valid.flatMap(s=>s.measurements.filter(m=>m.mode==='after'));
  const summarize=rows=>({medianMs:median(rows.map(r=>r.elapsedMs)),medianBytes:median(rows.map(r=>r.responseBytes))});
  console.log(JSON.stringify({baseline,scope:'同机同一管理连接只读真实历史；交替顺序各三次；仅等轮数样本纳入中位数；不含模型生成及连接握手',
   samples,validPairs:valid.length,before:summarize(before),after:summarize(after),modelRequests:0},null,2));
 } finally {await rpc.disposeAndWait();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
