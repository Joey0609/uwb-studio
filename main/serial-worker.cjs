'use strict';
// 使用独立Electron utility进程，原生串口异常不得带崩主窗口。
const parentPort={on:(_name,callback)=>process.parentPort.on('message',event=>callback(event.data)),
  postMessage:message=>process.parentPort.postMessage(message)};
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {SerialPort} = require('serialport');
const {Model, fields} = require('./model.cjs');
const model = new Model();
const ports = new Map();
let available = [], nextId = 1, control = {pending:false, results:[], expected:[]};
const directory = process.argv[2];
fs.mkdirSync(directory, {recursive:true});
const csvPath = path.join(directory, 'observations.csv');
const csv = fs.createWriteStream(csvPath, {flags:'a', highWaterMark:1024*1024});
csv.write('\uFEFFhost_time,port,self,boot,peer,peer_boot,update,distance_m,method,measurement_us,computed_us,age_us,valid\r\n');
let csvBlocked = false, csvDropped = 0, recordingError = '';
csv.on('drain', () => { csvBlocked = false; });
csv.on('error', e => { recordingError = e.message; csvBlocked = true; });

function identify(info) {
  const vid = (info.vendorId || '').toLowerCase(), pid = (info.productId || '').toLowerCase();
  const probe = /cmsis|dap|pwlink|j.link|st.link/i.test(info.manufacturer || '') || (vid === '0d28' && pid === '0204');
  const kind = probe ? 'probe' : vid === '303a' ? 'esp' : vid === '0483' && pid === '5740' ? 'stm' : 'unknown';
  return {...info,kind,suggested:kind === 'esp' || kind === 'stm'};
}
function line(port, text, direction = 'rx', time = Date.now()) {
  const item = {id:nextId++,time,direction,text:text.slice(0,8192)};
  port.lines.push(item); port.delta.push(item);
  if (port.lines.length > 2000) port.lines.splice(0, port.lines.length - 2000);
  if (port.delta.length > 200) { port.droppedUi += port.delta.length - 200; port.delta.splice(0,port.delta.length-200); }
}
function snapshot(drain = true) {
  const now = Date.now();
  if (control.pending && now > control.deadline) {
    control.pending = false;
    control.timedOut = control.expected.some(id => !control.results.some(r => r.node === id && r.result === 'ok' && r.active === (control.action === 'start')));
  }
  const state = model.snapshot(now);
  return {...state, now, terminalDelta:drain, ports:[...ports.values()].map(p => {
    const n = model.nodes.get(p.nodeId);
    const lines = drain ? p.delta.splice(0) : p.lines.slice(-200);
    const local=p.model.snapshot(now);
    return {path:p.path,connected:p.connected,kind:p.kind,baudRate:p.baudRate,encoding:p.encoding,
      nodeId:p.nodeId,active:n?.active,periodMs:n?.periodMs,stream:n?.stream,
      rxBytes:p.rxBytes,txBytes:p.txBytes,dropped:p.rawDropped,droppedUi:p.droppedUi,
      lines,error:p.error,recording:p.rawPath,
      matrixNodes:local.nodes,matrixEdges:local.edges.map(({history,...edge})=>edge),matrixUpdatedAt:p.matrixUpdatedAt||null};
  }),control:{...control,results:control.results.slice()},recording:{directory,csvPath,csvDropped,error:recordingError}};
}
function receive(port, chunk) {
  port.rxBytes += chunk.length;
  // 原始字节先提交文件流，再解码；磁盘堵塞时显式计数，不拖住串口采集或渲染。
  if (port.rawBlocked) port.rawDropped += chunk.length;
  else if (!port.raw.write(chunk)) port.rawBlocked = true;
  port.partial = Buffer.concat([port.partial, chunk]);
  let at;
  while ((at = port.partial.indexOf(10)) >= 0) {
    const bytes = port.partial.subarray(0,at);
    port.partial = port.partial.subarray(at+1);
    const text = port.decoder.decode(bytes).replace(/\r$/,'');
    line(port,text);
    const result = model.ingest(text, port.path);
    const localResult = port.model.ingest(text, port.path);
    if(localResult?.type==='observation'&&localResult.fresh)port.matrixUpdatedAt=Date.now();
    if (result?.type === 'observation') {
      const r = result.record; port.nodeId = r.self;
      if (csvBlocked) csvDropped++;
      else if (!csv.write([Date.now(),port.path,r.self,r.boot,r.peer,r.peer_boot,r.update,r.distance_m,r.method,r.measurement_us,r.computed_us,r.age_us,r.valid].join(',')+'\r\n')) csvBlocked=true;
    } else if (result?.type === 'status') {
      port.nodeId = result.node.id;
      if (control.pending && control.scope === 'connected' && control.paths.includes(port.path)) {
        const f = result.fields, right = result.node.active === (control.action === 'start');
        const explicit = control.action === 'start' ? ['started','already_running'].includes(f.result) || f.action === 'start' : f.result === 'stopped' || f.action === 'stop';
        if (explicit) noteResult({node:result.node.id,active:result.node.active,result:right && !result.node.fault ? 'ok' : 'fault',via:'usb'});
      }
    } else if (result?.type === 'ack' && control.pending && control.scope === 'radio' &&
               result.ack.request === control.requestId && result.ack.controller === control.controller) {
      noteResult({...result.ack,via:'radio'});
    } else if (result?.type === 'control' && control.pending && Number(result.fields.request) === control.requestId) {
      if (result.fields.stage === 'failed') {control.error = result.fields.reason || '设备拒绝或发射失败';control.pending=false;}
    }
  }
  // 无换行的旧日志也有上限；不可让畸形串口无限占内存。
  if (port.partial.length > 16384) {line(port,'无换行输入超过16KB，显示缓冲已清空','system');port.partial=Buffer.alloc(0);port.droppedUi++;}
}
function noteResult(result) {
  const at=control.results.findIndex(r=>r.node===result.node);
  if(at>=0)control.results[at]=result;else control.results.push(result);
  // 未知无线节点总数：不因看到了几个ACK就提前声称全网完成。
  if(control.scope==='connected' && control.expected.length && control.expected.every(id=>control.results.some(r=>r.node===id)))control.pending=false;
}
async function listPorts() { available=(await SerialPort.list()).map(identify);return available; }
async function connect({path:portPath,baudRate=115200,encoding='auto'}) {
  if(typeof portPath!=='string'||portPath.length>256||!Number.isInteger(baudRate)||baudRate<1200||baudRate>3000000||!['auto','utf8','gbk'].includes(encoding))throw Error('串口参数无效');
  const existing=ports.get(portPath);
  if(existing?.connected)return {connected:true,path:portPath};
  const info=available.find(p=>p.path===portPath) || {};
  const actual=encoding==='auto' ? (info.kind==='stm'?'gbk':'utf8') : encoding;
  const p=existing || {path:portPath,lines:[],delta:[],rxBytes:0,txBytes:0,rawDropped:0,droppedUi:0,model:new Model()};
  if(ports.size>=32&&!existing)throw Error('最多同时管理32个串口');
  Object.assign(p,{kind:info.kind || 'unknown',baudRate,encoding,connected:false,error:'',wantReconnect:true,partial:Buffer.alloc(0),decoder:new TextDecoder(actual==='gbk'?'gb18030':'utf-8')});
  const device = new SerialPort({path:portPath,baudRate,autoOpen:false,highWaterMark:65536});
  p.device=device;
  ports.set(portPath,p);
  p.rawPath=path.join(directory,`${portPath.replace(/[^\w.-]/g,'_')}-${Date.now()}.raw`);
  p.raw=fs.createWriteStream(p.rawPath,{highWaterMark:1024*1024});p.rawBlocked=false;
  p.raw.on('drain',()=>{p.rawBlocked=false;});p.raw.on('error',e=>{p.error='原始记录写入失败：'+e.message;p.rawBlocked=true;});
  device.on('data',chunk=>receive(p,chunk));
  device.on('error',e=>{p.error=e.message;line(p,e.message,'system');});
  device.on('close',()=>{
    p.connected=false;p.raw?.end();line(p,'串口已断开','system');
    if(p.wantReconnect){p.reconnectAt=Date.now()+2000;line(p,'设备移除，等待端口重新出现','system');}
  });
  try { await new Promise((resolve,reject)=>device.open(e=>e?reject(e):resolve())); }
  catch(error){p.error=error.message;p.raw.end();line(p,error.message,'system');throw error;}
  // 明确释放控制线，应用数据口不负责重启设备。
  await new Promise(resolve=>device.set({dtr:false,rts:false},()=>resolve()));
  p.connected=true;p.connectedAt=Date.now();
  line(p,`已连接 ${portPath} · ${baudRate} · ${actual}`,'system');
  setTimeout(()=>{if(p.connected)write(p,'swarm status','crlf').catch(()=>{});},1600);
  return {connected:true,path:portPath};
}
async function disconnect(portPath) {
  const p=ports.get(portPath);if(!p)return {};
  p.wantReconnect=false;
  if(p.device.isOpen)await new Promise(resolve=>p.device.close(()=>resolve()));
  p.connected=false;p.raw?.end();return {connected:false,path:portPath};
}
async function write(p,command,lineEnding='crlf') {
  if(!p?.connected)throw Error('串口未连接');
  if(typeof command!=='string'||Buffer.byteLength(command,'utf8')>256||command.includes('\0'))throw Error('命令最多256字节，不能包含NUL');
  const ending={crlf:'\r\n',lf:'\n',none:''}[lineEnding];
  if(ending===undefined)throw Error('换行格式无效');
  const bytes=Buffer.from(command+ending);
  if((p.pendingWrites||0)>=64)throw Error('命令队列已满，请等待设备处理');
  p.pendingWrites=(p.pendingWrites||0)+1;
  // 串行写队列保证配置流程及手动命令不互相穿插。
  p.writes=(p.writes||Promise.resolve()).catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
    p.device.write(bytes,e=>{if(e)reject(e);else{p.txBytes+=bytes.length;line(p,command,'tx');resolve();}});
  })).finally(()=>{p.pendingWrites--;});
  return p.writes;
}
async function send({paths,command,lineEnding='crlf'}) {
  if(!Array.isArray(paths)||paths.length>32)throw Error('请选择发送串口');
  return Promise.all([...new Set(paths)].map(async portPath=>{
    try{
      const p=ports.get(portPath);await write(p,command,lineEnding);
      if(lineEnding!=='none'&&/^swarm\s+(period|stream|start|stop)\b/i.test(command)){
        clearTimeout(p.statusTimer);p.statusTimer=setTimeout(()=>{if(p.connected)write(p,'swarm status').catch(()=>{});},250);
      }
      return {path:portPath,ok:true};
    }
    catch(e){return {path:portPath,ok:false,error:e.message};}
  }));
}
async function runControl({action,gateway,scope='radio'}) {
  if(!['start','stop'].includes(action)||!['radio','connected'].includes(scope))throw Error('控制参数无效');
  if(control.pending)throw Error('上一条全网控制仍在等待回执');
  const connected=[...ports.values()].filter(p=>p.connected);
  const requestId=crypto.randomBytes(4).readUInt32LE()||1;
  const targets=scope==='radio' ? [ports.get(gateway)||connected[0]] : connected;
  if(!targets.length||targets.some(p=>!p?.connected))throw Error('请选择已连接的网关串口');
  if(scope==='radio'&&!targets[0].nodeId)throw Error('网关尚未报告RAC地址，请先查询节点状态');
  control={pending:true,action,scope,requestId,controller:targets[0].nodeId,deadline:Date.now()+6500,
    expected:scope==='radio'?[...model.nodes.keys()]:targets.map(p=>p.nodeId).filter(Boolean),paths:targets.map(p=>p.path),results:[],timedOut:false,error:''};
  for(const p of targets){
    const command=scope==='radio'?`broadcastsend swarm ${action} ${requestId}`:
      action==='start'?`swarm start ${(requestId^(p.nodeId||1))>>>0||1}`:'swarm stop';
    try{await write(p,command);}catch(e){control.error=e.message;control.pending=false;throw e;}
  }
  return {requestId,scope,paths:control.paths};
}
async function saveExport({type,path:portPath,destination}) {
  if(typeof destination!=='string')throw Error('导出路径无效');
  if(type==='csv'){
    await new Promise(resolve=>csv.write('',resolve));fs.copyFileSync(csvPath,destination);
  }else if(type==='raw'){
    const p=ports.get(portPath);if(!p?.rawPath)throw Error('该串口尚无记录');
    await new Promise(resolve=>p.raw.write('',resolve));fs.copyFileSync(p.rawPath,destination);
  }else if(type==='terminal'){
    const selected=portPath?[ports.get(portPath)]:[...ports.values()];
    fs.writeFileSync(destination,selected.filter(Boolean).flatMap(p=>p.lines.map(l=>`${new Date(l.time).toISOString()} [${p.path}] [${l.direction}] ${l.text}`)).join('\r\n'),'utf8');
  }else throw Error('不支持的导出类型');
  return {filePath:destination};
}
parentPort.on('message',async ({id,method,args})=>{
  try{
    const fn={listPorts,connect,disconnect,send,control:runControl,export:saveExport,
      getSnapshot:()=>snapshot(false),close:async()=>{for(const p of ports.values())await disconnect(p.path);await new Promise(resolve=>csv.end(resolve));}}[method];
    if(!fn)throw Error('未知操作');
    const result=await fn(args);parentPort.postMessage({id,result});
  }catch(e){parentPort.postMessage({id,error:e.message});}
});
setInterval(()=>parentPort.postMessage({event:'snapshot',data:snapshot()}),100).unref();
setInterval(()=>{
  for(const p of ports.values()){
    if(p.connected&&Date.now()-p.connectedAt>1800&&(p.pendingWrites||0)<4)
      write(p,'swarm status').catch(()=>{});
  }
},2000).unref();
setInterval(async()=>{
  for(const p of ports.values()){
    if(!p.wantReconnect||p.connected||p.reconnecting||!p.reconnectAt||Date.now()<p.reconnectAt)continue;
    p.reconnecting=true;
    try{
      const found=await SerialPort.list();
      if(found.some(info=>info.path===p.path))await connect({path:p.path,baudRate:p.baudRate,encoding:p.encoding});
    }catch(error){p.error=error.message;}
    finally{p.reconnecting=false;p.reconnectAt=Date.now()+2000;}
  }
},1000).unref();
