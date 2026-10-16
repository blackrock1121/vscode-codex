const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),esbuild=require(path.join(root,'node_modules/esbuild'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-03eb-bench-'));
const baseline='e99d434';
(async()=>{
 const modules={};
 for(const [key,file]of Object.entries({logging:'src/logging.ts',jobs:'src/diagnostics/jobs.ts',checkpoint:'src/checkpoints.ts'})){
  const output=path.join(temp,key+'.cjs');
  esbuild.buildSync({stdin:{contents:execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8',cwd:root}),resolveDir:path.dirname(path.join(root,file)),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:output});
  modules[key]=require(output);
 }
 const next={...require(path.join(root,'dist/test/logging.js')),...require(path.join(root,'dist/test/checkpoints.js')),...require(path.join(root,'dist/test/diagnostics/jobs.js'))},samples=[];
 for(const [mode,api]of [['before',{...modules.logging,...modules.jobs,...modules.checkpoint}],['after',next]]){
  const dir=path.join(temp,mode);fs.mkdirSync(dir);const logDir=path.join(dir,'logs'),health=[],writer=new api.DailyLogWriter(logDir,undefined,undefined,s=>health.push(s));
  const append=fs.promises.appendFile;fs.promises.appendFile=async()=>{throw Object.assign(new Error('injected'),{code:'EIO'});};
  writer.write('retained-row');await writer.flush();fs.promises.appendFile=append;await writer.flush();await writer.dispose();
  const text=fs.existsSync(logDir)?fs.readdirSync(logDir).map(f=>fs.readFileSync(path.join(logDir,f),'utf8')).join(''):'';
  const jobs=new api.DiagnosticJobs(path.join(dir,'jobs'),{pluginVersion:'bench',windowId:'bench',workspaceId:'bench',workspaceName:'bench'},async()=>{},async()=>({status:'not_configured'}));
  const open=fs.promises.open;let attempts=0;
  fs.promises.open=async()=>{attempts++;throw Object.assign(new Error('injected'),{code:'EACCES'});};
  const started=performance.now();try{await jobs.update('00000000-0000-0000-0000-000000000000',()=>{});}catch(error){if(!['EACCES',undefined].includes(error.code))throw error;}finally{fs.promises.open=open;}
  const elapsedMs=Math.round(performance.now()-started);await jobs.dispose();
  const cp=new api.CheckpointManager(path.join(dir,'checkpoint'));cp.setSession('bench');const id=cp.beginTurn('synthetic',0),file=path.join(dir,'file.txt');fs.writeFileSync(file,'before');
  const read=fs.readFileSync;fs.readFileSync=(...args)=>{if(args[0]===file)throw Object.assign(new Error('injected'),{code:'EACCES'});return read(...args);};
  try{cp.snapshotFile(file);}finally{fs.readFileSync=read;}
  fs.writeFileSync(file,'after');const restored=cp.restore(id);cp.flush();
  samples.push({mode,retainedRows:(text.match(/retained-row/g)||[]).length,independentHealthEvents:health.length,permissionLockAttempts:attempts,permissionFailureMs:elapsedMs,existingFileSurvivesReadFailure:fs.existsSync(file),skippedFiles:restored.skipped.length});
 }
 console.log(JSON.stringify({baseline,scope:'隔离临时目录注入 EIO/EACCES，无真实模型请求；锁竞争等待计时为本机合成场景',samples},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1;});
