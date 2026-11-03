'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {Model,fields}=require('./model.cjs');
const {TelemetryFramer}=require('./telemetry.cjs');
const {Localization}=require('./localization.cjs');
const {LatestPositions,parsePosition}=require('./latest-positions.cjs');
const {SessionReplay}=require('./session-io.cjs');
const SOURCE='FILE';
const pair=(a,b)=>[a,b].sort((x,y)=>x-y).join('/');
/** @brief 实时采集和离线定位共用LOC校验；不改变固件的质量或时钟就绪标志。 */
function parseLocation(text,observer){
  const f=fields(text,'@SWARM_LOC');if(!f)return null;
  const number=k=>Number(f[k]),address=k=>/^\d+$/.test(f[k]||'')&&number(k)>0&&number(k)<0xffffffff;
  const integer=k=>/^\d+$/.test(f[k]||'')&&Number.isSafeInteger(number(k));
  const packetMs=f.v==='2';
  if(!['1','2'].includes(f.v)||!['observer','a','b'].every(address)||f.a===f.b||!['boot','id','t','ta','tb'].every(integer)||!Number.isFinite(number('d'))||number('d')<0||!['aligned','receive'].includes(f.quality))return null;
  if(packetMs){
    /** @brief v2不接收精确时钟旗标，合法但缺端点的LOC仅供距离/状态展示。 */
    const tokens=text.trim().split(/\s+/).slice(1),names=tokens.map(token=>token.split('=')[0]);
    if(new Set(names).size!==names.length||f.time_basis!=='packet_ms'||f.quality!=='receive'||!['0','1'].includes(f.compat_usable)||f.clock_ready!==undefined||f.error_us!==undefined||f.legacy_frame!==undefined||
       !['a_boot','b_boot'].every(k=>integer(k)&&number(k)<=0xffffffff)||(f.compat_usable==='1'&&['a_boot','b_boot'].some(k=>number(k)===0))||
       !['a_epoch','b_epoch'].every(k=>integer(k)&&number(k)<=65535)||
       number('boot')<1||number('boot')>0xffffffff||!['ax','ay','az','bx','by','bz'].every(k=>/^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|nan)$/.test(f[k]||'')))return null;
  }else if(!integer('error_us'))return null;
  const position=keys=>{const a=keys.map(number);return a.every(Number.isFinite)?a:null;};
  const pa=position(['ax','ay','az']),pb=position(['bx','by','bz']);
  /** @brief 缺端点时固件的boot/epoch占位零不能注册为真实会话；合法时间零仍保留。 */
  const endpointBoot=k=>packetMs&&number(k)===0?undefined:Number(f[k]);
  const endpointEpoch=(k,p,b)=>packetMs&&(!p||number(b)===0)?undefined:f[k]===undefined?undefined:Number(f[k]);
  return {observer,a:number('a'),b:number('b'),distance:number('d'),t_us:number('t'),boot:number('boot'),id:number('id'),pa,pb,ta_us:number('ta'),tb_us:number('tb'),quality:f.quality,protocolVersion:Number(f.v),
    ...(packetMs?{time_basis:'packet_ms'}:{error_us:number('error_us'),legacy_frame:f.legacy_frame==='1',clock_ready:f.clock_ready==='1'}),
    compat_usable:f.compat_usable==='1',a_boot:endpointBoot('a_boot'),b_boot:endpointBoot('b_boot'),a_epoch:endpointEpoch('a_epoch',pa,'a_boot'),b_epoch:endpointEpoch('b_epoch',pb,'b_boot')};
}
/** @brief 在改变当前回放前，流式校验原始CSV和时间顺序。 */
async function inspectCsv(file){
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error('请选择有效的CSV文件');
  let first=null,last=null,total=0,bytes=0;
  const input=fs.createReadStream(file),rows=readline.createInterface({input,crlfDelay:Infinity});
  try{for await(const row of rows){
    if(!row.trim()||/^\uFEFF?ts,/.test(row))continue;
    const m=row.match(/^"?([\d.eE+-]+)"?,"?(\d+)"?,"?([a-fA-F\d ]*)"?$/);
    if(!m)throw Error('文件必须是ts,len,hexStr三列CSV');
    const ts=Number(m[1])*1000,len=Number(m[2]),hex=m[3].replace(/ /g,'');
    if(!Number.isFinite(ts)||!Number.isSafeInteger(len)||len<0||len>16*1024*1024||hex.length!==len*2)throw Error('CSV时间或原始字节长度无效');
    if(last!==null&&ts<last)throw Error('CSV接收时间倒序，无法重放定位时间线');
    first??=ts;last=ts;total++;bytes+=len;
  }}finally{rows.close();input.destroy();}
  if(!total)throw Error('CSV没有可回放数据');
  return {first,last,total,bytes,duration:(last-first)/1000};
}
/** @brief 仅识别本软件明确版本的操作记录，旧串口回放旁文件不作为可执行操作。 */
function readJournal(file,info){
  const sidecar=file+'.session.json';if(!fs.existsSync(sidecar))return null;
  if(fs.statSync(sidecar).size>32*1024*1024)throw Error('操作记录过大');
  let journal;try{journal=JSON.parse(fs.readFileSync(sidecar,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('操作记录JSON损坏');}
  if(journal?.schema!=='uwb-studio-localization-session'||journal.version!==1||typeof journal.source!=='string'||!journal.initial||!Array.isArray(journal.operations)||journal.operations.length>100000)throw Error('操作记录格式或版本无效');
  if(journal.complete===false)throw Error('操作记录不完整，不能自动重放定位');
  if(journal.assumedOperations!==undefined&&typeof journal.assumedOperations!=='boolean')throw Error('推定操作标记无效');
  if(!Number.isFinite(journal.startedAt_ms)||(journal.endedAt_ms!==undefined&&!Number.isFinite(journal.endedAt_ms)))throw Error('操作记录时钟无效');
  let previous=0;
  for(const op of journal.operations){
    if(!Number.isInteger(op.afterChunks)||op.afterChunks<previous||op.afterChunks>info.total||!Number.isFinite(op.at_ms)||typeof op.action!=='string'||typeof op.success!=='boolean')throw Error('操作记录的接收块边界或时间无效');
    if(op.success&&op.action==='advance'&&![1,2,3].includes(op.stageAfter))throw Error('操作记录的定位阶段无效');
    previous=op.afterChunks;
  }
  const model=journal.initial.model||{};
  if(!Array.isArray(model.slots)||model.slots.length>21||!Array.isArray(model.nodes)||model.nodes.length>21||!Array.isArray(model.edges)||model.edges.length>210||!Array.isArray(journal.initial.positions)||journal.initial.positions.length>21)throw Error('初始采集状态无效');
  for(const [slot,id]of model.slots){if(!Number.isInteger(slot)||slot<0||slot>20||!Number.isInteger(id)||id<=0||id>=0xffffffff)throw Error('初始节点编号表无效');}
  if(new Set(model.slots.map(row=>row[0])).size!==model.slots.length||new Set(model.slots.map(row=>row[1])).size!==model.slots.length)throw Error('初始节点编号表重复');
  const address=id=>Number.isInteger(id)&&id>0&&id<0xffffffff;
  if(model.self!==null&&!address(model.self))throw Error('初始观察节点无效');
  if(model.mapRevision!==null&&(!Number.isInteger(model.mapRevision)||model.mapRevision<0||model.mapRevision>0xffffffff))throw Error('初始编号表版本无效');
  if(model.nodes.some(node=>!node||!address(node.id))||new Set(model.nodes.map(node=>node.id)).size!==model.nodes.length)throw Error('初始节点表无效');
  if(model.edges.some(edge=>!edge||!address(edge.source)||!address(edge.peer)||edge.source===edge.peer||!Number.isFinite(edge.distance)||edge.distance<0||(edge.received!==undefined&&!Number.isFinite(edge.received))))throw Error('初始距离表无效');
  if(journal.initial.positions.some(sample=>!sample||!address(sample.node)||!address(sample.observerId)||!Number.isSafeInteger(sample.boot)||sample.boot<1||sample.boot>0xffffffff||!Number.isSafeInteger(sample.node_boot)||sample.node_boot<1||sample.node_boot>0xffffffff||!Number.isSafeInteger(sample.t_us)||sample.t_us<0||!Array.isArray(sample.position)||sample.position.length!==3||!sample.position.every(Number.isFinite)))throw Error('初始位置表无效');
  if(journal.initial.positions.some(sample=>
    (sample.protocolVersion!==undefined&&![1,2].includes(sample.protocolVersion))||
    (sample.protocolVersion===2&&(sample.time_basis!=='packet_ms'||sample.quality!=='receive'||typeof sample.compat_usable!=='boolean'||
      sample.clock_ready!==undefined||sample.error_us!==undefined||sample.legacy_frame!==undefined||!Number.isInteger(sample.source_epoch)||sample.source_epoch<0||sample.source_epoch>65535))))throw Error('初始位置时间依据无效');
  return journal;
}
/** @brief 独立文件定位实例：共用生产模型和算法，从不创建、连接或写入物理串口。 */
class FileReplay {
  constructor(){this.state='idle';this.active=false;this.file='';this.speed=1;this.index=0;this.bytes=0;this.position=0;this.total=0;this.duration=0;this.error='';this.logs=[];this.logId=0;this.generation=0;this.automatic=false;this.skipClockCheck=false;this.engine=null;}
  log(text,type='system'){this.logs.push({id:++this.logId,time:this.now||Date.now(),text,type});if(this.logs.length>200)this.logs.shift();}
  snapshot(){
    const engine=this.engine,now=this.now||Date.now();
    const local=engine?.localization.snapshot(),model=engine?.model.snapshot(now,false);
    const localization=local?{...local,source:SOURCE,experimentActive:true,fileMode:true,canAdvance:local.canAdvance&&!this.automatic&&['playing','paused','ended'].includes(this.state)}:null;
    const port=model?{path:SOURCE,label:'文件回放',connected:true,nodeId:engine.model.self,matrixNodes:model.nodes,matrixEdges:model.edges.map(({history,...edge})=>edge),positionNodeIds:engine.positions.nodesForPort(SOURCE)}:null;
    return {active:this.active,state:this.state,file:this.file,fileName:this.file?path.basename(this.file):'',speed:this.speed,index:this.index,total:this.total,bytes:this.bytes,position:this.position,duration:this.duration,now,operationsAvailable:!!this.journal,assumedOperations:this.journal?.assumedOperations===true,automatic:this.automatic,skipClockCheck:this.skipClockCheck,localization,port,latestPositions:engine?engine.positions.snapshot(now,new Map([[SOURCE,{connected:true}]])):[],error:this.error,logs:this.logs.slice(),diagnostics:{unmappedFrames:engine?.unmappedFrames||0}};
  }
  /** @brief 校验成功后才替换当前文件；失败保持既有回放及结果。 */
  async loadFile(file){
    if(['playing','paused'].includes(this.state))throw Error('请先停止当前文件回放');
    if(typeof file!=='string'||!file.trim())throw Error('请选择有效的CSV文件');
    const absolute=path.resolve(file),info=await inspectCsv(absolute),journal=readJournal(absolute,info);
    await this.quiesce();const previous={...this};
    try{
      this.file=absolute;this.info=info;this.journal=journal;this.total=info.total;this.duration=info.duration;this.automatic=!!journal;this.skipClockCheck=false;this.error='';this.logs=[];this.active=true;
      this.initialize();this.state='ready';this.log(journal?'已载入数据及操作记录':'未记录阶段操作');return this.snapshot();
    }catch(error){Object.assign(this,previous);throw error;}
  }
  initialize(){
    this.index=0;this.bytes=0;this.position=0;this.opIndex=0;this.error='';this.now=this.journal?.startedAt_ms||this.info.first;
    const model=new Model({clock:()=>this.now}),localization=new Localization({lightIngest:true,allowUnmappedReceiveTime:this.skipClockCheck}),positions=new LatestPositions();
    localization.selectSource(SOURCE);const engine=this.engine={model,localization,positions,pairs:new Set(),unmappedFrames:0,telemetry:this.journal?.initial?.model?.telemetry||'detecting'};
    const initial=this.journal?.initial;
    if(initial){
      const saved=initial.model;
      if(saved.self)model.setIdentity(saved.self,SOURCE,this.now);
      model.nodes=new Map(saved.nodes.map(node=>[node.id,{...node,port:node.id===saved.self?SOURCE:null,stats:{...node.stats}}]));
      model.slots=new Map(saved.slots);model.mapRevision=saved.mapRevision??null;
      for(const edge of saved.edges){
        if(!Number.isFinite(edge.distance)||edge.distance<0||edge.snapshot)continue;
        const received=Number.isFinite(edge.received)?edge.received:this.now;
        model.observe(edge.source,edge.peer,edge.distance,{time:received,token:edge.token??null});
        this.collect(edge.source,edge.peer,edge.distance);
      }
      for(const sample of initial.positions)positions.ingest(SOURCE,{...sample,observer:SOURCE,quality:'receive'},sample.receivedAt??this.now);
    }
    engine.framer=new TelemetryFramer({onLine:bytes=>this.receiveLine(bytes),onFrame:frame=>{
      if(frame.gap&&frame.type!==1&&frame.type!==4)return;
      engine.telemetry='binary';
      try{for(const result of model.ingestFrame(frame,this.now))if(result.fresh&&!result.snapshot)this.collect(result.record.node_a,result.record.node_b,result.record.distance_m);}
      catch(error){model.loseSync();engine.unmappedFrames++;if(engine.unmappedFrames===1)this.log('记录缺少节点编号表，使用可解析的定位观测','system');}
    },onError:reason=>{model.loseSync();this.log('数据分帧：'+reason,'error');}});
    if(this.automatic)this.operationsThrough(0);
  }
  collect(a,b,distance){
    const e=this.engine;if(!e)return;
    const key=pair(a,b);if(e.localization.stage===1)e.localization.ingestDistance({observer:SOURCE,a,b,distance},this.now,!e.pairs.has(key));e.pairs.add(key);
  }
  receiveLine(bytes){
    const text=bytes.toString('utf8').replace(/\r$/,'');if(!text)return;
    const e=this.engine;
    if(text.startsWith('@SWARM_POS ')){
      const event=parsePosition(text,SOURCE);if(!event)return;
      if(!e.model.self)e.model.setIdentity(event.observerId,SOURCE,this.now);
      e.positions.ingest(SOURCE,event,this.now);e.localization.ingestPosition(event,this.now);return;
    }
    if(text.startsWith('@SWARM_LOC ')){
      const event=parseLocation(text,SOURCE);if(!event)return;
      if(!e.model.self)e.model.setIdentity(Number(fields(text,'@SWARM_LOC').observer),SOURCE,this.now);
      const countDistance=e.localization.stage!==1||!e.pairs.has(pair(event.a,event.b));
      if(!e.pairs.has(pair(event.a,event.b)))e.model.observe(event.a,event.b,event.distance,{time:this.now,token:`LOC/${event.boot}/${event.id}`});
      e.localization.ingest(event,this.now,{countDistance});return;
    }
    const format=fields(text,'@SWARM_FORMAT');if(['binary','text'].includes(format?.mode))e.telemetry=format.mode;
    const measurement=/^@(SRV2 |SWARM_RANGE )/.test(text);
    if(measurement&&['binary','negotiating'].includes(e.telemetry))return;
    try{const result=e.model.ingest(text,SOURCE,this.now);if(result?.type==='observation'&&result.fresh&&!result.snapshot)this.collect(result.record.node_a,result.record.node_b,result.record.distance_m);}catch(error){this.log(error.message,'error');}
  }
  /** @brief 回放使用记录时钟结算UKF，播放倍速与暂停不会改变计算时基。 */
  advanceClock(time){if(Number.isFinite(time)&&time>=this.now){this.engine.localization.tick(time);this.now=time;}}
  advance(){
    const e=this.engine;if(!e)throw Error('请先选择文件');
    if(e.localization.stage===1){const ids=new Set(e.localization.snapshot().nodes.map(node=>node.id));for(const sample of e.positions.samplesForPort(SOURCE))if(ids.has(sample.node))e.localization.ingestPosition({...sample,observer:SOURCE,quality:'receive'},sample.receivedAt);}
    return e.localization.advance(this.now);
  }
  /** @brief 仅重放成功的定位阶段操作；串口控制、失败操作及结束动作只作为审计记录。 */
  operationsThrough(count){
    const operations=this.journal?.operations||[];
    while(this.opIndex<operations.length&&operations[this.opIndex].afterChunks<=count){
      const op=operations[this.opIndex++];if(!op.success)continue;
      this.advanceClock(op.at_ms);
      if(op.action==='advance'){
        const result=this.advance();
        if(result.stage!==op.stageAfter)throw Error(`回放阶段未达到记录状态：期望${op.stageAfter}，实际${result.stage}`);
        this.log('定位阶段：'+result.stage);
      }
    }
  }
  async quiesce(){this.generation++;const task=this.task;this.player?.stop();this.player=null;await task?.catch(()=>{});if(this.task===task)this.task=null;}
  async close(){await this.quiesce();this.active=false;this.state='idle';this.engine=null;this.file='';this.total=0;this.duration=0;this.index=0;this.bytes=0;this.position=0;this.error='';this.journal=null;this.skipClockCheck=false;return this.snapshot();}
  async action(args={}){
    const action=args.action;
    if(action==='snapshot')return this.snapshot();
    if(action==='open')return this.loadFile(args.file);
    if(action==='close')return this.close();
    if(action==='speed'){
      const speed=Number(args.speed);if(![.25,.5,1,2,4,8,20,50,100].includes(speed))throw Error('回放速度无效');this.speed=speed;if(this.player)this.player.speed=speed;return this.snapshot();
    }
    if(action==='clockCheck'){
      if(['playing','paused'].includes(this.state))throw Error('请先停止回放再切换时钟检查');
      if(typeof args.skip!=='boolean')throw Error('时钟检查配置无效');
      if(args.skip===this.skipClockCheck)return this.snapshot();
      await this.quiesce();const previous={...this};
      try{
        this.skipClockCheck=args.skip;
        if(this.file){this.initialize();this.state='ready';}
        this.log(args.skip?'已跳过时钟检查，回放结果已重置':'已恢复时钟检查，回放结果已重置');return this.snapshot();
      }catch(error){Object.assign(this,previous);throw error;}
    }
    if(action==='automatic'){
      if(['playing','paused'].includes(this.state))throw Error('请先停止回放再切换操作重放模式');
      if(typeof args.enabled!=='boolean'||(args.enabled&&!this.journal))throw Error('此文件没有有效操作记录');this.automatic=args.enabled;return this.snapshot();
    }
    if(action==='advance'){
      if(this.automatic)throw Error('自动重放操作时不能手动切换阶段');if(!['playing','paused','ended'].includes(this.state))throw Error('请先开始文件回放');this.advance();return this.snapshot();
    }
    if(action==='pause'){
      if(this.state!=='playing')throw Error('当前没有正在播放的数据');this.player.pause();this.state='paused';return this.snapshot();
    }
    if(action==='stop'){await this.quiesce();if(this.file)this.state='stopped';return this.snapshot();}
    if(action==='start'||action==='continue'){
      if(!this.file)throw Error('请先选择CSV');
      if(this.state==='playing')return this.snapshot();
      if(this.state==='paused'&&this.task){this.state='playing';void this.player.start();return this.snapshot();}
      await this.quiesce();this.initialize();this.active=true;this.state='playing';const generation=this.generation;
      this.player=new SessionReplay(this.file,{onChunk:(chunk,time)=>{
        if(generation!==this.generation)return;
        this.advanceClock(time);this.engine.framer.push(chunk);this.index++;this.bytes+=chunk.length;this.position=Math.max(0,(time-this.info.first)/1000);
        if(this.automatic)this.operationsThrough(this.index);
      }});this.player.speed=this.speed;
      this.task=this.player.start().then(()=>{
        if(generation!==this.generation)return;
        if(this.player?.state==='error'){this.state='error';this.error=this.player.error||'文件回放失败';this.log(this.error,'error');}
        else if(this.player?.state==='ended'){if(this.automatic)this.operationsThrough(this.total);this.advanceClock(this.journal?.endedAt_ms||this.info.last);this.state='ended';this.log('文件回放完成');}
      }).catch(error=>{if(generation===this.generation){this.state='error';this.error=error.message;this.log(this.error,'error');}});
      return this.snapshot();
    }
    throw Error('文件回放操作无效');
  }
}
module.exports={FileReplay,parseLocation,inspectCsv,readJournal};