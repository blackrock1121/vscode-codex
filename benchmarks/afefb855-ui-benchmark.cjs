// 对同一可控输入比较诊断版本与工作树；不调用真实网络，不改变用户配置。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {execFileSync}=require('node:child_process'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),baseline='2eeb5e57bec2955656b5a31de7a52362af452689';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-afef-bench-'));
async function run(before){
 const file=path.join(temp,before?'before.cjs':'after.cjs');
 await esbuild.build({stdin:{contents:`export * from './src/panel/chatViewProvider'; export * from './src/operations';`,resolveDir:root},outfile:file,bundle:true,platform:'node',external:['vscode'],logLevel:'silent',plugins:before?[{name:'diagnosis-version',setup(build){build.onLoad({filter:/src\/(?:panel\/chatViewProvider|notifications)\.ts$/},args=>({contents:execFileSync('git',['show',baseline+':'+path.relative(root,args.path)],{cwd:root,encoding:'utf8'}),loader:'ts',resolveDir:path.dirname(args.path)}));}}]:[]});
 const load=Module._load;let api;try{Module._load=function(id,...args){return id==='vscode'?{}:load.call(this,id,...args);};api=require(file);}finally{Module._load=load;}
 const rows=[],p=Object.create(api.ChatViewProvider.prototype);api.setOperationLogSink(line=>rows.push(JSON.parse(line.slice(12))));p.output={appendLine(){}};p.post=()=>{};let rejected=0;
 for(const invalid of [null,undefined,123,[],{}, {type:12}])for(const handler of ['onPanelMessage','onSidebarMessage'])try{await(handler==='onPanelMessage'?p[handler]({},invalid):p[handler](invalid));}catch{rejected++;}
 const invalidRecords=rows.length;rows.length=0;const fetch=global.fetch;
 try{global.fetch=async()=>({ok:true,status:200,json:async()=>({code:9499})});await p.sendWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/private','private');global.fetch=async()=>({ok:true,status:200,json:async()=>({code:0})});await p.sendWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/private','private');}finally{global.fetch=fetch;}
 return{invalidMessages:12,unhandledHandlerRejections:rejected,invalidDataRecords:invalidRecords,webhookRequests:2,webhookTerminalRecords:rows.filter(row=>row.stage!=='start').length,webhookBusinessCodes:rows.filter(row=>row.businessCode!==undefined).map(row=>row.businessCode)};
}
(async()=>{try{const result={baseline,scenario:'隔离消息入口及通知响应故障注入；不是线上整轮速度基准',before:await run(true),after:await run(false)};fs.writeFileSync(path.join(__dirname,'afefb855-ui-metrics.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
