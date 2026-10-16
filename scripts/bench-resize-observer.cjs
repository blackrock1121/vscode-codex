// 同一 DOM、同一组尺寸通知，对比基线和当前构建；不调用模型、不读取会话内容。
// 前置：npm run build。输出仅是本地合并开销，不代表整轮任务提速。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..'),baseline='83a725a';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-resize-bench-'));
try {
 const before=path.join(temp,'before.js');
 require('esbuild').buildSync({stdin:{contents:execFileSync('git',['show',`${baseline}:src/webview/main.ts`],{cwd:root,encoding:'utf8'}),
  resolveDir:path.join(root,'src/webview'),loader:'ts'},bundle:true,platform:'browser',format:'iife',target:'es2020',minify:true,outfile:before});
 const source=fs.readFileSync(path.join(root,'src/panel/chatViewProvider.ts'),'utf8');
 const raw=source.slice(source.indexOf('    private html(')).match(/return `([\s\S]*?)`;\s*\n\s+}/)[1];
 const html=raw.replace(/\$\{[^}]+\}/g,'').replace(/<script[^>]*><\/script>/g,'');
 const samples=[];
 for(const [mode,bundle] of [['before',before],['after',path.join(root,'media/webview.js')]]){
  const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://webview.test/'}),w=dom.window,observers=[];
  try {
   w.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:()=>{}});
   w.ResizeObserver=class{constructor(fn){this.fn=fn;this.targets=[];observers.push(this);}observe(t){this.targets.push(t);}disconnect(){}};
   w.IntersectionObserver=class{observe(){}disconnect(){}};
   w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLElement.prototype.scrollTo=function(){};
   w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.document.queryCommandSupported=()=>false;
   w.eval(fs.readFileSync(bundle,'utf8'));
   let serial=0;const frames=new Map();w.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};w.cancelAnimationFrame=id=>frames.delete(id);
   const composer=w.document.getElementById('composer'),messages=w.document.getElementById('messages');
   let heightReads=0,scrollWrites=0,top=0;
   Object.defineProperty(composer,'offsetHeight',{get:()=>{heightReads++;return 300;}});
   Object.defineProperties(messages,{scrollHeight:{get:()=>2000},clientHeight:{get:()=>600},scrollTop:{get:()=>top,set:v=>{scrollWrites++;top=v;}}});
   const changes=new w.MutationObserver(()=>{});changes.observe(messages,{attributes:true,attributeFilter:['style']});
   const at=performance.now();
   for(let i=0;i<100;i++)for(const target of [composer,messages])for(const observer of observers)if(observer.targets.includes(target))observer.fn();
   const synchronous={heightReads,scrollWrites},scheduledFrames=frames.size;
   for(const fn of frames.values())fn(performance.now());
   samples.push({mode,notifications:200,synchronous,scheduledFrames,heightReads,scrollWrites,paddingStyleWrites:changes.takeRecords().length,elapsedMs:Number((performance.now()-at).toFixed(3))});
   changes.disconnect();
  } finally {w.close();}
 }
 console.log(JSON.stringify({baseline,scope:'JSDOM 合成突发尺寸通知；读取与写入次数可复现，耗时不代表真实浏览器布局或模型任务时间',samples},null,2));
} finally {fs.rmSync(temp,{recursive:true,force:true});}
