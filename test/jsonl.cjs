// 假服务也必须按 JSONL 的 LF 分帧，不能让运行测试的 Node 版本改变输入含义。
exports.readJsonl = (stream, onMessage) => {
 let buffer='';
 stream.setEncoding('utf8');
 stream.on('data',chunk=>{
  buffer+=chunk;
  let end;
  while((end=buffer.indexOf('\n'))!==-1){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   onMessage(JSON.parse(line));
  }
 });
};
