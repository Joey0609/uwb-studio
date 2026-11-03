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
const {Localization}=require('./localization.cjs');
const {SessionRecorder}=require('./session-io.cjs');
const {ExperimentSession}=require('./experiment-session.cjs');
const {FileReplay,parseLocation}=require('./localization-replay.cjs');
const fileReplay=new FileReplay();
let fileReplayChanging=false;
const localization=new Localization({lightIngest:true});
const locationTimes=new Map();
/** @brief 本轮静止采集中，已由所选端口生产距离接管均值的无向节点对。 */
const modelDistancePairs=new Set();
const distancePair=(a,b)=>[a,b].sort((x,y)=>x-y).join('/');
const {LatestPositions,parsePosition}=require('./latest-positions.cjs');
const latestPositions=new LatestPositions();
const model = new Model();
const ports = new Map();
const {SerialReplay}=require('./serial-replay.cjs');
const serialReplay=new SerialReplay({SerialPort});
let available = [], nextId = 1, operationId=1, control = {pending:false, results:[], expected:[]};
const directory = process.argv[2];
const experiment=new ExperimentSession(localization,directory);
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
  const positions=latestPositions.snapshot(now,ports);
  const fileState=fileReplay.snapshot();
  const loc=fileState.active?fileState.localization:experiment.snapshot(),ageNow=now;
  if(!fileState.active)loc.edges=loc.edges.map(e=>{const stamp=locationTimes.get(`${loc.source}/${[e.a,e.b].sort((a,b)=>a-b).join('/')}`);const ageMs=stamp?Math.max(0,ageNow-stamp.receivedAt):null;return {...e,receivedAt:stamp?.receivedAt||null,ageMs,valid:ageMs!==null&&ageMs<3000};});
  state.edges=[...ports.values()].flatMap(p=>p.model.snapshot(now).edges.map(edge=>{
    const key=`${edge.source}/${edge.peer}`;p.historySent??=new Map();const last=p.historySent.get(key)||0;
    const history=drain?edge.history.filter(point=>point.id>last):edge.history;
    if(drain&&history.length)p.historySent.set(key,history[history.length-1].id);
    return {...edge,history,observer:p.path};
  }));
  const known=new Map(state.nodes.map(n=>[n.id,n]));for(const p of ports.values())for(const n of p.model.nodes.values()){if(!known.has(n.id)||n.id===p.nodeId)known.set(n.id,n);}
  for(const position of positions)if(!known.has(position.node))known.set(position.node,{id:position.node,port:null,active:null,stats:{}});
  state.nodes=[...known.values()].sort((a,b)=>a.id-b.id);
  return {...state, latestPositions:positions, now, historyDelta:drain, terminalDelta:drain, ports:[...ports.values()].map(p => {
    const n = p.model.nodes.get(p.nodeId);
    const lines = drain ? p.delta.splice(0) : p.lines.slice(-200);
    const local=p.model.snapshot(now,false);
    return {path:p.path,connected:p.connected,kind:p.kind,baudRate:p.baudRate,encoding:p.encoding,
      nodeId:p.nodeId,active:n?.active,mode:n?.mode||'unknown',monitorCapable:n?.monitorCapable===true,passiveCapable:n?.passiveCapable===true,passiveGraph:n?.passiveGraph===true,passiveMaxNodes:n?.passiveMaxNodes||null,passiveReady:n?.passiveReady??null,passiveResultTtlMs:n?.passiveResultTtlMs||null,passive:n?.passive?{...n.passive}:null,targetMode:p.targetMode||'broadcast',operation:p.operation?{...p.operation}:null,periodMs:n?.periodMs,stream:n?.stream,
      rxBytes:p.rxBytes,txBytes:p.txBytes,dropped:p.rawDropped,droppedUi:p.droppedUi,
      lines,error:p.error,recording:p.rawPath,comdata:p.recorder?.file||null,recordingIncomplete:!!p.recorder?.incomplete,recordingDroppedBytes:p.recorder?.droppedBytes||0,
      positionNodeIds:latestPositions.nodesForPort(p.path),matrixNodes:local.nodes,matrixEdges:local.edges.map(({history,...edge})=>edge),matrixUpdatedAt:p.matrixUpdatedAt||null,telemetry:p.telemetry||'detecting',protocolErrors:p.protocolErrors||0};
  }),localization:loc,fileReplay:fileState,replay:serialReplay.snapshot(),control:{...control,results:control.results.slice()},recording:{directory,csvPath,csvDropped,error:[recordingError,...[...ports.values()].filter(p=>p.recorder?.incomplete).map(p=>`${p.path}记录不完整：${p.recorder.error}，丢弃${p.recorder.droppedBytes}字节`)].filter(Boolean).join('；')}};
}
/** @brief 生产距离只在本轮静止阶段累计；首次接管时移除同一节点对的LOC回退均值。 */
function collectModelDistance(port,a,b,distance,time=Date.now()) {
  if(!experiment.active||experiment.finalized||localization.source!==port.path||localization.stage!==1)return;
  const pair=distancePair(a,b);
  localization.ingestDistance({observer:port.path,a,b,distance},time,!modelDistancePairs.has(pair));
  modelDistancePairs.add(pair);
}
function record(port,result,time=Date.now()) {
  if(!result)return;
  if(result.fresh)port.matrixUpdatedAt=time;
  const r=result.record;
  if(result.fresh&&!result.snapshot)collectModelDistance(port,r.node_a,r.node_b,r.distance_m,time);
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
/** @brief 新建实时分帧器，显式文件重播不继承上次半包。 */
function createLiveFramer(port){return new TelemetryFramer({onLine:bytes=>receiveLine(port,bytes),onFrame:frame=>{
  if(frame.gap&&frame.type!==1&&frame.type!==4)return;
  try{for(const result of port.model.ingestFrame(frame))record(port,result);}catch(error){recover(port,error.message);}
},onError:reason=>recover(port,reason)});}
function receiveLine(port,bytes) {
  if(ports.get(port.path)!==port||port.accepting===false)return;
  const text=port.decoder.decode(bytes).replace(/\r$/,'');if(!text)return;line(port,text);
  if(text.startsWith('@SWARM_POS ')){
    const event=parsePosition(text,port.path);
    if(event){
      const now=Date.now();latestPositions.ingest(port.path,event,now);
      if(experiment.active&&!experiment.finalized&&localization.source===port.path)localization.ingestPosition(event,now);
    }
    return;
  }
  if(text.startsWith('@SWARM_LOC ')){
    if(!experiment.active||experiment.finalized||localization.source!==port.path)return;
    const event=parseLocation(text,port.path);
    if(event){
      const pair=distancePair(event.a,event.b),key=`${port.path}/${pair}`,old=locationTimes.get(key),now=Date.now();
      if(!old||event.boot!==old.boot||event.t_us>old.t_us)locationTimes.set(key,{t_us:event.t_us,boot:event.boot,receivedAt:now});
      /** @brief 同一测距由生产Model累计后，LOC只提供位置时序；旧日志仍可用LOC回退。 */
      const countDistance=localization.stage!==1||!modelDistancePairs.has(pair);
      localization.ingest(event,now,{countDistance});
    }else line(port,'定位消息无效','system');
    return;
  }
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
  if(ports.get(port.path)!==port||port.accepting===false)return;
  port.rxBytes+=chunk.length;
  experiment.capture(port.path,chunk);
  // 原始字节先提交文件流，再分帧；二进制测量不进入文本终端。
  {port.recorder?.write(chunk);if(port.rawIncomplete||port.raw.destroyed){port.rawDropped+=chunk.length;}else if(port.raw.writableLength+chunk.length>64*1024*1024){port.rawIncomplete=true;port.rawDropped+=chunk.length;port.error='RAW积压超过64MB，文件不完整；ComData录制状态另行显示';}else if(!port.raw.write(chunk))port.rawBlocked=true;}
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
  if(serialReplay.path===portPath&&serialReplay.snapshot().reserved)throw Error('该串口正用于回放发送');
  const existing=ports.get(portPath);
  if(existing?.connected)return {connected:true,path:portPath};
  const info=available.find(p=>p.path===portPath) || {};
  const actual=encoding==='auto' ? (info.kind==='stm'?'gbk':'utf8') : encoding;
  const p=existing || {path:portPath,lines:[],delta:[],rxBytes:0,txBytes:0,rawDropped:0,droppedUi:0,model:new Model()};
  if(ports.size>=32&&!existing)throw Error('最多同时管理32个串口');
  p.model.reset();const previousIdentity=p.model.nodes.get(p.model.self);if(previousIdentity){previousIdentity.monitorCapable=false;previousIdentity.passiveCapable=false;previousIdentity.passiveGraph=false;previousIdentity.passiveMaxNodes=null;previousIdentity.passiveReady=null;previousIdentity.passive=null;previousIdentity.mode='unknown';previousIdentity.active=null;}
  Object.assign(p,{nodeId:null,operation:null,targetMode:p.targetMode||'broadcast',negotiated:false,telemetry:'detecting',kind:info.kind || 'unknown',baudRate,encoding,connected:false,accepting:true,error:'',wantReconnect:true,partial:Buffer.alloc(0),decoder:new TextDecoder(actual==='gbk'?'gb18030':'utf-8')});
  latestPositions.resetPort(portPath);
  p.framer=createLiveFramer(p);
  const device = new SerialPort({path:portPath,baudRate,autoOpen:false,highWaterMark:65536});
  p.device=device;
  ports.set(portPath,p);
  p.rawPath=path.join(directory,`${portPath.replace(/[^\w.-]/g,'_')}-${Date.now()}.raw`);
  p.raw=fs.createWriteStream(p.rawPath,{highWaterMark:1024*1024});p.rawBlocked=false;
  p.recorder=new SessionRecorder(directory,portPath,error=>{p.error='ComData录制失败：'+error;});
  p.raw.on('drain',()=>{p.rawBlocked=false;});p.raw.on('error',e=>{p.error='原始记录写入失败：'+e.message;p.rawIncomplete=true;p.rawBlocked=true;});
  device.on('data',chunk=>{if(p.device===device)receive(p,chunk);});
  device.on('error',e=>{p.error=e.message;line(p,e.message,'system');});
  device.on('close',()=>{
    p.connected=false;if(p.operation?.pending)finishOperation(p,false,'设备已断开，未确认模式');p.raw?.end();void p.recorder?.close();line(p,'串口已断开','system');
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
/** 清除来源时效；删除或更换会话后不得复用旧测距的接收时刻。 */
function clearLocationTimes(portPath){for(const key of locationTimes.keys())if(key.startsWith(portPath+'/'))locationTimes.delete(key);}
/** 撤销选中来源后重置定位，其他仍连接的来源不受影响。 */
function clearSelectedSource(portPath){clearLocationTimes(portPath);if(localization.source===portPath&&!experiment.active){modelDistancePairs.clear();localization.selectSource(null);}}
async function disconnect(portPath) {
  const p=ports.get(portPath);if(!p)return {};
  p.accepting=false;p.wantReconnect=false;clearTimeout(p.probeTimer);clearTimeout(p.passiveQueryTimer);
  if(p.connected&&['binary','negotiating'].includes(p.telemetry)){try{await write(p,'swarm format text');await new Promise(resolve=>p.device.drain(()=>resolve()));}catch{}}
  if(p.device.isOpen)await new Promise(resolve=>p.device.close(()=>resolve()));
  p.connected=false;p.raw?.end();await p.recorder?.close();return {connected:false,path:portPath};
}
/** 关闭串口并移除会话；保留已写入磁盘的采集记录。 */
async function removePort(portPath) {
  if(typeof portPath!=='string'||!portPath||portPath.length>256)throw Error('串口路径无效');
  const p=ports.get(portPath);if(!p)return {removed:true,path:portPath};
  if(p.reconnecting)throw Error('串口正在重新连接，请稍后重试删除');
  await disconnect(portPath);
  if(p.device?.isOpen)throw Error('串口关闭失败，请重试删除');
  clearSelectedSource(portPath);latestPositions.removePort(portPath);ports.delete(portPath);
  if(control.paths?.includes(portPath)){
    control.pending=false;control.error='控制使用的串口已删除';
    control.paths=control.paths.filter(path=>path!==portPath);
    control.results=control.results.filter(result=>result.path!==portPath);
  }
  return {removed:true,path:portPath};
}
async function write(p,command,lineEnding='crlf') {
  if(/^\s*(?:(?:uwb|stm32?|esp32?)[:：]\s*)?swarm\s+correction(?:\s|$)/i.test(command))throw Error('修正坐标仅在电脑计算和显示，不回传设备');
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
/** @brief 开始才采集；重置成功保存原始CSV后回到等待阶段。 */
async function localizationAction({action,path:source,destination}={}){
  if(fileReplayChanging)throw Error('文件回放操作进行中，请稍后再试');
  if(fileReplay.snapshot().active){
    if(action==='advance')return fileReplayAction({action:'advance'});
    if(action==='reset')return fileReplayAction({action:'close'});
    if(action==='start')return fileReplayAction({action:'start'});
    if(action==='source')throw Error('请先关闭文件回放，再切换实时来源');
    throw Error('文件回放操作无效');
  }
  if(experiment.starting||experiment.saving)throw Error('实验操作进行中，请稍后再试');
  if(action==='source'){
    if(experiment.active&&localization.source!==source)throw Error('请先重置并保存当前实验，再切换来源');
    if(!ports.get(source)?.connected)throw Error('请选择已连接的观察串口');
    if(localization.source!==source){clearLocationTimes(source);modelDistancePairs.clear();}
    localization.selectSource(source);
  }else if(action==='start'){
    if(fileReplay.snapshot().active)throw Error('请先关闭文件回放，再开始实时实验');
    if(!ports.get(localization.source)?.connected)throw Error('请选择已连接的观察串口');
    await experiment.start();modelDistancePairs.clear();clearLocationTimes(localization.source);
    const port=ports.get(localization.source),now=Date.now(),initialModel=port.model.snapshot(now,false);
    port.framer=createLiveFramer(port);
    /** @brief 初始状态与start边界在同一事件循环固定；不把开始前的数据伪造成CSV接收块。 */
    experiment.beginJournal({model:{self:port.model.self,telemetry:port.telemetry,mapRevision:port.model.mapRevision,slots:[...port.model.slots.entries()],
      nodes:initialModel.nodes,edges:initialModel.edges.filter(edge=>edge.valid&&!edge.snapshot).map(({history,...edge})=>edge)},
      positions:latestPositions.samplesForPort(localization.source)});
    for(const edge of initialModel.edges)if(edge.valid&&!edge.snapshot)
      collectModelDistance(port,edge.source,edge.peer,edge.distance,now);
    await experiment.flushJournal();
  }else if(action==='advance'){
    if(!experiment.active||experiment.finalized)throw Error('请先开始实验');
    const boundary={afterChunks:experiment.recorder.chunks,at_ms:Date.now(),stageBefore:localization.stage};
    let failure;
    try{
      if(localization.stage===1){
        const ids=new Set(localization.snapshot().nodes.map(node=>node.id));
        for(const sample of latestPositions.samplesForPort(localization.source))if(ids.has(sample.node))
          localization.ingestPosition({...sample,observer:localization.source,quality:'receive'},sample.receivedAt);
      }
      localization.advance(boundary.at_ms);
    }catch(error){failure=error;}
    const success=!failure&&localization.stage>boundary.stageBefore;
    await experiment.recordOperation('advance',{...boundary,success,stageAfter:localization.stage,
      ...(!success?{error:failure?.message||localization.snapshot().diagnostics.lastError||'当前阶段尚不能推进'}:{})});
    if(failure)throw failure;
  }else if(action==='reset'){
    const result=await experiment.reset(destination);modelDistancePairs.clear();clearLocationTimes(localization.source);return result;
  }else throw Error('定位操作无效');
  return experiment.snapshot();
}
/** @brief 文件回放仅向独立软件模型送入字节，不创建串口、不执行设备命令。 */
async function fileReplayAction(args={}){
  if((experiment.active||experiment.starting||experiment.saving)&&args.action!=='close')throw Error('请先重置并保存实时实验，再使用文件回放');
  if(fileReplayChanging)throw Error('文件回放操作进行中，请稍后再试');
  fileReplayChanging=true;
  try{return await fileReplay.action(args);}finally{fileReplayChanging=false;}
}
/** @brief 串口回放只发送文件字节，不选择、重置或推进定位来源。 */
async function replayAction(args={}){
  if(args.action==='connect'){
    const receiver=ports.get(args.path);
    if(receiver&&(receiver.connected||receiver.wantReconnect||receiver.device?.isOpen))throw Error('该串口已用于接收');
  }
  return serialReplay.action(args);
}
parentPort.on('message',async ({id,method,args})=>{
  try{
    const fn={listPorts,connect,disconnect,removePort,send,control:runControl,setMode,nodeControl,export:saveExport,
      localizationAction,fileReplayAction,replayAction,getSnapshot:()=>snapshot(false),close:async()=>{await fileReplay.close();await experiment.close();await serialReplay.action({action:'disconnect'});for(const p of ports.values())await disconnect(p.path);await new Promise(resolve=>csv.end(resolve));}}[method];
    if(!fn)throw Error('未知操作');
    const audit=['send','control','setMode','nodeControl'].includes(method)&&experiment.active&&!experiment.finalized
      ?{journal:experiment.journal,afterChunks:experiment.recorder.chunks,at_ms:Date.now(),stageBefore:localization.stage}:null;
    let result,failure;
    try{result=await fn(args);}catch(error){failure=error;}
    if(audit&&audit.journal===experiment.journal){
      const partialFailure=Array.isArray(result)&&result.some(item=>item?.ok===false);
      await experiment.recordOperation('audit',{afterChunks:audit.afterChunks,at_ms:audit.at_ms,stageBefore:audit.stageBefore,
        stageAfter:localization.stage,args:{method,parameters:args||{}},success:!failure&&!partialFailure,
        ...(failure?{error:failure.message}:partialFailure?{error:'部分设备操作失败'}:{})});
    }
    if(failure)throw failure;
    parentPort.postMessage({id,result});
  }catch(e){parentPort.postMessage({id,error:e.message});}
});
setInterval(()=>{if(experiment.active&&!experiment.finalized)localization.tick();parentPort.postMessage({event:'snapshot',data:snapshot()});},100).unref();
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
