'use strict';
// 使用独立Electron utility进程，原生串口异常不得带崩主窗口。
const parentPort={on:(_name,callback)=>process.parentPort.on('message',event=>callback(event.data)),
  postMessage:message=>process.parentPort.postMessage(message)};
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {SerialPort} = require('serialport');
const {Model, fields} = require('./model.cjs');
const {TelemetryFramer}=require('./telemetry.cjs');
const commandPolicy=require('../renderer/command-policy.js');
const model = new Model();
const ports = new Map();
let available = [], nextId = 1, operationId=1, control = {pending:false, results:[], expected:[]};
const directory = process.argv[2];
fs.mkdirSync(directory, {recursive:true});
const csvPath = path.join(directory, 'observations.csv');
const csv = fs.createWriteStream(csvPath, {flags:'a', highWaterMark:1024*1024});
csv.write('\uFEFFhost_time,port,node_a,node_b,distance_m,record_type\r\n');
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
  for(const p of ports.values())if(p.operation?.pending&&now>p.operation.deadline)finishOperation(p,false,'等待设备模式确认超时'+(p.operation.failureCandidate?'（'+p.operation.failureCandidate+'）':''));
  const state=model.snapshot(now);
  state.edges=[...ports.values()].flatMap(p=>p.model.snapshot(now).edges.map(edge=>{
    const key=`${edge.source}/${edge.peer}`;p.historySent??=new Map();const last=p.historySent.get(key)||0;
    const history=drain?edge.history.filter(point=>point.id>last):edge.history;
    if(drain&&history.length)p.historySent.set(key,history[history.length-1].id);
    return {...edge,history,observer:p.path};
  }));
  const known=new Map(state.nodes.map(n=>[n.id,n]));for(const p of ports.values())for(const n of p.model.nodes.values()){if(!known.has(n.id)||n.id===p.nodeId)known.set(n.id,n);}
  state.nodes=[...known.values()].sort((a,b)=>a.id-b.id);
  return {...state, now, historyDelta:drain, terminalDelta:drain, ports:[...ports.values()].map(p => {
    const n = p.model.nodes.get(p.nodeId);
    const lines = drain ? p.delta.splice(0) : p.lines.slice(-200);
    const local=p.model.snapshot(now,false);
    return {path:p.path,connected:p.connected,kind:p.kind,baudRate:p.baudRate,encoding:p.encoding,
      nodeId:p.nodeId,active:n?.active,mode:n?.mode||'unknown',monitorCapable:n?.monitorCapable===true,passiveCapable:n?.passiveCapable===true,passiveGraph:n?.passiveGraph===true,passiveMaxNodes:n?.passiveMaxNodes||null,passiveReady:n?.passiveReady??null,passiveResultTtlMs:n?.passiveResultTtlMs||null,passive:n?.passive?{...n.passive}:null,targetMode:p.targetMode||'broadcast',operation:p.operation?{...p.operation}:null,periodMs:n?.periodMs,stream:n?.stream,
      rxBytes:p.rxBytes,txBytes:p.txBytes,dropped:p.rawDropped,droppedUi:p.droppedUi,
      lines,error:p.error,recording:p.rawPath,
      matrixNodes:local.nodes,matrixEdges:local.edges.map(({history,...edge})=>edge),matrixUpdatedAt:p.matrixUpdatedAt||null,telemetry:p.telemetry||'detecting',protocolErrors:p.protocolErrors||0};
  }),control:{...control,results:control.results.slice()},recording:{directory,csvPath,csvDropped,error:recordingError}};
}
function record(port,result,time=Date.now()) {
  if(!result)return;
  if(result.fresh)port.matrixUpdatedAt=time;
  const r=result.record;
  if(csvBlocked)csvDropped++;
  else if(!csv.write([time,port.path,r.node_a,r.node_b,r.distance_m,result.snapshot?'snapshot':'measurement'].join(',')+'\r\n'))csvBlocked=true;
}
function recover(port,reason) {
  port.protocolErrors=(port.protocolErrors||0)+1;port.model.loseSync();
  const now=Date.now();
  if(now-(port.lastRecovery||0)<1000)return;port.lastRecovery=now;
  line(port,reason+'，重新获取编号表与快照','system');
  if(port.connected)write(port,'swarm snapshot').catch(()=>{});
}
/** 仅连接或命令回执后查询一次；不创建周期状态轮询。 */
function queryPassive(port){
  if(!port.connected||port.model.nodes.get(port.nodeId)?.monitorCapable!==true||port.model.nodes.get(port.nodeId)?.passiveCapable!==true)return;
  clearTimeout(port.passiveQueryTimer);port.passiveQueryTimer=setTimeout(()=>{
    if(port.connected)write(port,'swarm monitor status').catch(()=>{});
  },250);
}
function receiveLine(port,bytes) {
  const text=port.decoder.decode(bytes).replace(/\r$/,'');if(!text)return;line(port,text);
  const isMeasurement=/^@(SRV2 |SWARM_RANGE )/.test(text);
  const result=isMeasurement&&['binary','negotiating'].includes(port.telemetry)?null:port.model.ingest(text,port.path);
  if(result?.type==='observation'){record(port,result);return;}
  // 汇总模型只维护明确身份及控制结果，距离必须保留各采集端口来源。
  // 各端口模型独立维护元数据；汇总时附加 observer，不互相覆盖。
  if(result?.type==='info'){
    port.nodeId=result.node.id;
    if(result.node.monitorCapable!==true&&port.targetMode==='monitor')port.targetMode='broadcast';
    confirmOperation(port,result);queryPassive(port);
    if(result.fields.telemetry==='1'&&!port.negotiated){
      port.negotiated=true;port.telemetry='negotiating';clearTimeout(port.probeTimer);write(port,'swarm format binary').catch(()=>{});
    }
  }else if(fields(text,'@SWARM_FORMAT')?.mode==='binary'){
    port.telemetry='binary';
    // format binary 已由固件依序发送 RESET/MAP/SNAPSHOT，不重复请求造成队列冲突。
  }else if(fields(text,'@SWARM_FORMAT')?.mode==='text'){port.telemetry='text';
  }else if(result?.type==='status'){
    port.nodeId=result.node.id;if(result.node.monitorCapable!==true&&port.targetMode==='monitor')port.targetMode='broadcast';
    confirmOperation(port,result);queryPassive(port);
  }else if(result?.type==='ack'&&control.pending&&control.scope==='radio'&&result.ack.request===control.requestId&&result.ack.controller===control.controller&&!control.excludedMonitors?.includes(result.ack.node))noteResult({...result.ack,via:'radio'});
  else if(result?.type==='control'&&control.pending&&Number(result.fields.request)===control.requestId&&result.fields.stage==='failed'){control.error=result.fields.reason||'设备拒绝或发射失败';control.pending=false;}
}
function receive(port,chunk) {
  port.rxBytes+=chunk.length;
  // 原始字节先提交文件流，再分帧；二进制测量不进入文本终端。
  if(port.rawBlocked)port.rawDropped+=chunk.length;else if(!port.raw.write(chunk))port.rawBlocked=true;
  port.framer.push(chunk);
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
  p.model.reset();const previousIdentity=p.model.nodes.get(p.model.self);if(previousIdentity){previousIdentity.monitorCapable=false;previousIdentity.passiveCapable=false;previousIdentity.passiveGraph=false;previousIdentity.passiveMaxNodes=null;previousIdentity.passiveReady=null;previousIdentity.passive=null;previousIdentity.mode='unknown';previousIdentity.active=null;}
  Object.assign(p,{nodeId:null,operation:null,targetMode:p.targetMode||'broadcast',negotiated:false,telemetry:'detecting',kind:info.kind || 'unknown',baudRate,encoding,connected:false,error:'',wantReconnect:true,partial:Buffer.alloc(0),decoder:new TextDecoder(actual==='gbk'?'gb18030':'utf-8')});
  p.framer=new TelemetryFramer({onLine:bytes=>receiveLine(p,bytes),onFrame:frame=>{
    if(frame.gap&&frame.type!==1&&frame.type!==4)return;
    try{for(const result of p.model.ingestFrame(frame))record(p,result);}catch(error){recover(p,error.message);}
  },onError:reason=>recover(p,reason)});
  const device = new SerialPort({path:portPath,baudRate,autoOpen:false,highWaterMark:65536});
  p.device=device;
  ports.set(portPath,p);
  p.rawPath=path.join(directory,`${portPath.replace(/[^\w.-]/g,'_')}-${Date.now()}.raw`);
  p.raw=fs.createWriteStream(p.rawPath,{highWaterMark:1024*1024});p.rawBlocked=false;
  p.raw.on('drain',()=>{p.rawBlocked=false;});p.raw.on('error',e=>{p.error='原始记录写入失败：'+e.message;p.rawBlocked=true;});
  device.on('data',chunk=>receive(p,chunk));
  device.on('error',e=>{p.error=e.message;line(p,e.message,'system');});
  device.on('close',()=>{
    p.connected=false;if(p.operation?.pending)finishOperation(p,false,'设备已断开，未确认模式');p.raw?.end();line(p,'串口已断开','system');
    if(p.wantReconnect){p.reconnectAt=Date.now()+2000;line(p,'设备移除，等待端口重新出现','system');}
  });
  try { await new Promise((resolve,reject)=>device.open(e=>e?reject(e):resolve())); }
  catch(error){p.error=error.message;p.raw.end();line(p,error.message,'system');throw error;}
  // 明确释放控制线，应用数据口不负责重启设备。
  await new Promise(resolve=>device.set({dtr:false,rts:false},()=>resolve()));
  p.connected=true;p.connectedAt=Date.now();
  line(p,`已连接 ${portPath} · ${baudRate} · ${actual}`,'system');
  setTimeout(()=>{if(p.connected)write(p,'swarm info').catch(()=>{});},200);
  clearTimeout(p.probeTimer);p.probeTimer=setTimeout(()=>{if(p.connected&&p.telemetry==='detecting'){p.telemetry='text';write(p,'swarm status').catch(()=>{});}},1800);
  return {connected:true,path:portPath};
}
async function disconnect(portPath) {
  const p=ports.get(portPath);if(!p)return {};
  p.wantReconnect=false;clearTimeout(p.probeTimer);clearTimeout(p.passiveQueryTimer);
  if(p.connected&&['binary','negotiating'].includes(p.telemetry)){try{await write(p,'swarm format text');await new Promise(resolve=>p.device.drain(()=>resolve()));}catch{}}
  if(p.device.isOpen)await new Promise(resolve=>p.device.close(()=>resolve()));
  p.connected=false;p.raw?.end();return {connected:false,path:portPath};
}
/** 关闭串口并移除会话；保留已写入磁盘的采集记录。 */
async function removePort(portPath) {
  if(typeof portPath!=='string'||!portPath||portPath.length>256)throw Error('串口路径无效');
  const p=ports.get(portPath);if(!p)return {removed:true,path:portPath};
  if(p.reconnecting)throw Error('串口正在重新连接，请稍后重试删除');
  await disconnect(portPath);
  if(p.device.isOpen)throw Error('串口关闭失败，请重试删除');
  ports.delete(portPath);
  if(control.paths?.includes(portPath)){
    control.pending=false;control.error='控制使用的串口已删除';
    control.paths=control.paths.filter(path=>path!==portPath);
    control.results=control.results.filter(result=>result.path!==portPath);
  }
  return {removed:true,path:portPath};
}
async function write(p,command,lineEnding='crlf') {
  if(!p?.connected)throw Error('串口未连接');
  const unsupported=commandPolicy.reason(command,p.model.nodes.get(p.nodeId));
  if(unsupported)throw Error(unsupported);
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
      const p=ports.get(portPath);const unsupported=commandPolicy.reason(command,p?.model.nodes.get(p.nodeId));if(unsupported)throw Error(unsupported);
      const operation=lineEnding!=='none'?commandPolicy.operation(command):null;
      if(operation){if(operation.action==='start')setMode({path:portPath,mode:operation.mode});const result=await nodeControl({path:portPath,action:operation.action,session:operation.session});return {ok:true,...result};}
      await write(p,command,lineEnding);
      if(lineEnding!=='none'&&/^swarm\s+(period|stream|start|stop|broadcast|monitor)\b/i.test(commandPolicy.normalize(command))){
        clearTimeout(p.statusTimer);p.statusTimer=setTimeout(()=>{if(p.connected)write(p,'swarm status').catch(()=>{});},250);
      }
      return {path:portPath,ok:true};
    }
    catch(e){return {path:portPath,ok:false,error:e.message};}
  }));
}
/** 目标选择独立于设备实际模式，只在按启动/切换后发送命令。 */
function setMode({path:portPath,mode}){
  if(typeof portPath!=='string'||!['broadcast','monitor'].includes(mode))throw Error('节点模式参数无效');
  const p=ports.get(portPath);if(!p)throw Error('串口不存在');
  if(mode==='monitor'&&p.model.nodes.get(p.nodeId)?.monitorCapable!==true)throw Error('当前固件未声明纯监听能力');
  p.targetMode=mode;return {path:portPath,targetMode:mode};
}
function finishOperation(p,ok,error=''){
  const op=p.operation;if(!op?.pending)return;op.pending=false;op.ok=ok;op.error=error;op.finishedAt=Date.now();
  clearTimeout(p.modeQuery);clearTimeout(p.modeRetry);
  if(op.groupId&&control.pending&&control.requestId===op.groupId){
    const actual=p.model.nodes.get(p.nodeId)?.mode||'unknown';
    noteResult({node:p.nodeId,path:p.path,mode:actual,targetMode:op.targetMode,active:['broadcast','monitor'].includes(actual),result:ok?'ok':'fault',error,via:'usb'});
    if(control.paths.every(portPath=>control.results.some(r=>r.path===portPath)))control.pending=false;
  }
  line(p,ok?`设备已确认：${op.targetMode==='monitor'?'纯监听':op.targetMode==='broadcast'?'广播测距':'已停止'}`:`模式操作未完成：${error}`,'system');
}
function confirmOperation(p,result){
  const op=p.operation;if(!op?.pending||op.phase==='sending')return;
  const f=result.fields,node=result.node;
  if(/busy|fault|fail|error|unsupported|invalid|no_memory/i.test(f.result||'')||node.mode==='fault')op.failureCandidate=`设备返回 ${f.result||node.mode}`;
  // 模式命令没有通用请求号：等待本次有界 status 查询的状态回包（ESP ok，旧 STM 无 result/action），避免旧排队回执误判。
  // 查询后暂时不匹配仍继续等；有明确失败候选时，第二次复查才收敛为失败。
  const queryStatus=f.result==='ok'||(!Object.hasOwn(f,'result')&&!Object.hasOwn(f,'action'));
  if(result.type!=='status'||!op.queried||!queryStatus)return;
  const sessionMatches=!op.requireSession||Number(f.boot)===op.session;
  if(node.mode===op.targetMode&&sessionMatches&&!node.fault){finishOperation(p,true);return;}
  if(op.failureCandidate&&op.confirmationQueries>=2)finishOperation(p,false,op.failureCandidate);
}
async function nodeControl({path:portPath,action,groupId=null,session:requestedSession=null}){
  if(typeof portPath!=='string'||!['start','stop'].includes(action))throw Error('节点控制参数无效');
  const p=ports.get(portPath);if(!p?.connected)throw Error('串口未连接');if(control.pending&&!groupId)throw Error('全局控制正在等待回执，请完成后再操作单个节点');if(!p.nodeId)throw Error('设备地址尚未确认，请先查询节点信息');
  if(p.operation?.pending){if(action!=='stop')throw Error('该节点仍在等待上一条控制回执');finishOperation(p,false,'已被停止指令替代');}
  const targetMode=action==='stop'?'stopped':p.targetMode||'broadcast',node=p.model.nodes.get(p.nodeId);
  if(targetMode==='monitor'&&node?.monitorCapable!==true)throw Error('当前固件不支持纯监听');
  const session=requestedSession??(crypto.randomBytes(4).readUInt32LE()||1);
  if(!Number.isSafeInteger(session)||session<1||session>0xffffffff)throw Error('启动会话必须是1至4294967295');
  const command=action==='stop'?'swarm stop':targetMode==='monitor'?'swarm monitor start':node?.monitorCapable===true?`swarm broadcast start ${session}`:`swarm start ${session}`;
  const op=p.operation={id:operationId++,groupId,action,targetMode,pending:true,phase:'sending',startedAt:Date.now(),deadline:Date.now()+6500,error:'',ok:null,queried:false,confirmationQueries:0,session,requireSession:targetMode==='broadcast'&&node?.mode!=='broadcast'};
  try{
    await write(p,command);op.phase='waiting';
    const query=()=>{if(p.connected&&p.operation===op&&op.pending){op.queried=true;op.confirmationQueries++;write(p,'swarm status').catch(error=>finishOperation(p,false,error.message));}};
    p.modeQuery=setTimeout(query,250);p.modeRetry=setTimeout(query,1200);
  }catch(error){finishOperation(p,false,error.message);throw error;}
  return {path:portPath,operationId:op.id,pending:true,targetMode};
}
async function runControl({action,gateway,scope='radio'}) {
  if(!['start','stop'].includes(action)||!['radio','connected'].includes(scope))throw Error('控制参数无效');
  if(control.pending)throw Error('上一条全网控制仍在等待回执');
  const connected=[...ports.values()].filter(p=>p.connected);
  const eligible=connected.filter(p=>!['monitor','fault'].includes(p.model.nodes.get(p.nodeId)?.mode));
  const requestId=crypto.randomBytes(4).readUInt32LE()||1;
  const targets=scope==='radio'?[gateway?ports.get(gateway):eligible[0]]:connected;
  if(!targets.length||targets.some(p=>!p?.connected))throw Error('请选择已连接的网关串口');
  if(scope==='radio'&&['monitor','fault'].includes(targets[0].model.nodes.get(targets[0].nodeId)?.mode))throw Error('纯监听节点不能作为空中控制网关，请使用USB已连接节点控制');
  if(targets.some(p=>!p.nodeId))throw Error('设备尚未报告RAC地址，请先查询节点信息');
  const known=new Map();for(const p of connected)for(const n of p.model.nodes.values())if(!known.has(n.id)||n.id===p.nodeId)known.set(n.id,n);
  control={pending:true,action,scope,requestId,controller:targets[0].nodeId,deadline:Date.now()+6800,
    expected:scope==='radio'?[...known.values()].filter(n=>n.mode!=='monitor').map(n=>n.id):targets.map(p=>p.nodeId),paths:targets.map(p=>p.path),results:[],timedOut:false,error:'',excludedMonitors:scope==='radio'?[...known.values()].filter(n=>n.mode==='monitor').map(n=>n.id):[]};
  for(const p of targets){
    try{if(scope==='connected')await nodeControl({path:p.path,action,groupId:requestId});else await write(p,`broadcastsend swarm ${action} ${requestId}`);}
    catch(error){if(scope==='connected')noteResult({node:p.nodeId,path:p.path,active:p.model.nodes.get(p.nodeId)?.active,result:'fault',error:error.message,via:'usb'});else{control.error=error.message;control.pending=false;throw error;}}
  }
  if(scope==='connected'&&control.paths.every(portPath=>control.results.some(r=>r.path===portPath)))control.pending=false;
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
    const fn={listPorts,connect,disconnect,removePort,send,control:runControl,setMode,nodeControl,export:saveExport,
      getSnapshot:()=>snapshot(false),close:async()=>{for(const p of ports.values())await disconnect(p.path);await new Promise(resolve=>csv.end(resolve));}}[method];
    if(!fn)throw Error('未知操作');
    const result=await fn(args);parentPort.postMessage({id,result});
  }catch(e){parentPort.postMessage({id,error:e.message});}
});
setInterval(()=>parentPort.postMessage({event:'snapshot',data:snapshot()}),100).unref();
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
