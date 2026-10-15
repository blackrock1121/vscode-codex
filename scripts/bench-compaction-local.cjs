// 仅本机合成数据，不连接模型、不消耗账号额度。先运行 node scripts/build-test.cjs。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const assert=require('node:assert/strict');
const current=require('../dist/test/codex/compactionInput.js');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'compaction-local-bench-'));
const user=text=>({type:'message',role:'user',content:[{type:'input_text',text}]});
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

function historyCost(api){
 const h=new api.ResponseHistory();let body={type:'response.create',input:[user('测试约束'),{type:'function_call_output',call_id:'large',output:'x'.repeat(2*1024*1024)}]};
 // 首个完整请求不计入重复维护时间，之后只增加小段，符合真实增量传输。
 h.request(body);h.event({type:'response.completed',response:{id:'r0',output:[]}});
 const start=performance.now();
 for(let i=1;i<=80;i++){
  body={type:'response.create',previous_response_id:'r'+(i-1),input:[user('续轮 '+i)]};
  h.request(body);h.event({type:'response.completed',response:{id:'r'+i,output:[{type:'message',role:'assistant',content:[]} ]}});
 }
 assert.equal(h.resolve({previous_response_id:'r80',input:[]}).length,162);
 return performance.now()-start;
}
async function duplicateWrites(api){
 const text='重复工具日志\n'.repeat(2500),input=[user('历史'),...Array.from({length:64},(_,i)=>({type:'function_call_output',call_id:'call-'+i,output:text})),user('最近一'),user('最近二')];
 let writes=0;
 const result=await api.optimizeCompactionInput(input,{save:async()=>{writes++;return '/tmp/fixture-only';}});
 assert.ok(result.savings.optimizedBytes<result.savings.originalBytes);
 return writes;
}
(async()=>{
 try{
  const source=path.join(temporary,'baseline.ts'),compiled=path.join(temporary,'baseline.cjs');
  fs.writeFileSync(source,execFileSync('git',['show','6db0c9e:src/codex/compactionInput.ts']));
  require('esbuild').buildSync({entryPoints:[source],outfile:compiled,platform:'node',format:'cjs',bundle:true});
  const baseline=require(compiled),old=[],next=[];
  historyCost(baseline);historyCost(current);
  for(let i=0;i<3;i++){if(i%2){next.push(historyCost(current));old.push(historyCost(baseline));}else{old.push(historyCost(baseline));next.push(historyCost(current));}}
  console.log(JSON.stringify({scope:'本机合成数据；不包含模型生成、网络和磁盘耗时',baseline:'0.1.130 / 6db0c9e',prefixBytes:2*1024*1024,incrementalRequests:80,samples:3,
   historyMaintenanceMs:{baseline:old,optimized:next,baselineMedian:median(old),optimizedMedian:median(next)},
   duplicateArchiveCalls:{baseline:await duplicateWrites(baseline),optimized:await duplicateWrites(current)},onlineRequests:0},null,2));
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
