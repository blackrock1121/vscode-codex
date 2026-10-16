// 对同一批保留日志回放旧/新诊断器，仅输出计数；不上传、不改写日志。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),logDir=process.argv[2];
if(!logDir)throw new Error('请提供日志目录');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-03eb-replay-'));
(async()=>{
 const archive=execFileSync('git',['archive','e99d434','src','native','scripts/log-audit.cjs','package.json'],{cwd:root,maxBuffer:12*1024*1024});
 execFileSync('tar',['-x','-C',temp],{input:archive});fs.symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');
 const output=path.join(temp,'scan.cjs');await require('esbuild').build({entryPoints:[path.join(temp,'src/diagnostics/scan.ts')],outfile:output,bundle:true,platform:'node',format:'cjs',plugins:[require(path.join(temp,'scripts/log-audit.cjs')).logAuditPlugin(temp)]});
 const before=require(output),after=require(path.join(root,'dist/test/diagnostics/scan.js'));
 const request={kind:'general',hours:24,engine:'rules',fromMs:Date.parse('2026-10-15T06:49:23.509Z'),toMs:Date.parse('2026-10-16T06:49:23.509Z')};
 const summary=r=>({coverage:r.coverage,summary:r.summary,general:r.general,loggingAudit:r.loggingAudit,resizeGroups:r.findings.filter(f=>f.category==='页面脚本'&&f.evidence.includes('ResizeObserver')).length});
 const results={diagnosticId:'03eb2976-1da2-4589-92eb-f22bd08f9217',scope:'同一历史时间区间与全部保留日志独立回放；旧错误不应因修复被删除，诊断分组变化不等于故障数下降',before:summary(await before.scanPluginLogs(logDir,()=>{},request)),after:summary(await after.scanPluginLogs(logDir,()=>{},request)),allRetained:summary(await after.scanPluginLogs(logDir,()=>{},{...request,hours:0,fromMs:undefined,toMs:Date.now()}))};
 console.log(JSON.stringify(results,null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
