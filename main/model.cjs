'use strict';

/** 严格解析机器记录，诊断文本和异常数值不能填充距离矩阵。 */
function fields(line, prefix) {
  if (!line.startsWith(prefix + ' ')) return null;
  const result = {};
  for (const part of line.trim().slice(prefix.length + 1).split(/\s+/)) {
    const at = part.indexOf('=');
    if (at < 1 || Object.hasOwn(result, part.slice(0, at))) return null;
    result[part.slice(0, at)] = part.slice(at + 1);
  }
  return result;
}
const u32 = value => /^\d+$/.test(value || '') && Number(value) <= 0xffffffff;
const address = value => u32(value) && Number(value) > 0 && Number(value) < 0xffffffff;
const micros = value => /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value));

function parseObservation(line) {
  const f = fields(line, '@SRV2');
  if (!f || !address(f.self) || !address(f.peer) || f.self === f.peer ||
      !['boot', 'peer_boot', 'update'].every(k => u32(f[k])) ||
      !['measurement_us', 'computed_us', 'age_us'].every(k => micros(f[k])) ||
      !['regular', 'compensatory', 'none'].includes(f.method) || !['0', '1'].includes(f.valid) ||
      !/^-?\d+(\.\d+)?$/.test(f.distance_m || '')) return null;
  const r = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === 'method' ? v : Number(v)]));
  if (!Number.isFinite(r.distance_m) || r.computed_us < r.measurement_us ||
      r.age_us < r.computed_us - r.measurement_us ||
      (r.valid && (r.distance_m < 0 || r.method === 'none'))) return null;
  return r;
}

/** 每个采集端口拥有独立的无向结果表；端点地址绝不成为端口身份。 */
class Model {
  constructor({ttlMs=3000,historyLimit=600,clock=Date.now}={}) {
    this.ttlMs=ttlMs;this.historyLimit=historyLimit;this.clock=clock;
    this.nodes=new Map();this.edges=new Map();this.invalidRecords=0;this.self=null;this.port=null;
    this.slots=new Map();this.mapRevision=null;this.historySerial=0;this.archived=new Map();
  }
  bind(id,port,time=this.clock()) {
    const node=this.nodes.get(id)||{id,port:null,active:null,boot:null,stats:{}};
    if(port)node.port=port;node.lastSeen=time;this.nodes.set(id,node);return node;
  }
  setIdentity(id,port,time=this.clock()) {
    if(this.self!==null&&this.self!==id){this.nodes.clear();this.edges.clear();this.archived.clear();this.slots.clear();this.mapRevision=null;}
    this.self=id;this.port=port;this.slots.set(0,id);return this.bind(id,port,time);
  }
  setBoot(node,boot) {
    node.boot=boot;
  }
  archiveEdge(key,edge){this.archived.set(key,{...edge});while(this.archived.size>210)this.archived.delete(this.archived.keys().next().value);}
  archiveResults(){this.invalidate();for(const[key,edge]of this.edges)this.archiveEdge(key,edge);this.edges.clear();}
  invalidate(){for(const edge of this.edges.values()){if(edge.distance>=0){edge.history.push({t:this.clock(),v:-1,id:++this.historySerial});if(edge.history.length>this.historyLimit)edge.history.splice(0,edge.history.length-this.historyLimit);}edge.distance=-1;edge.received=-Infinity;}}
  /** 协议重置只撤销编号解释资格，已收距离继续按原接收时刻到期。 */
  reset(){this.slots.clear();this.mapRevision=null;if(this.self)this.slots.set(0,this.self);}
  loseSync(){this.mapRevision=null;}
  pruneNodes(){const keep=new Set(this.slots.values());if(this.self)keep.add(this.self);for(const e of this.edges.values()){keep.add(e.source);keep.add(e.peer);}for(const id of this.nodes.keys())if(!keep.has(id))this.nodes.delete(id);}
  readMode(node,f){
    if(['0','1'].includes(f.monitor))node.monitorCapable=f.monitor==='1';
    if(['0','1'].includes(f.passive)){
      node.passiveCapable=node.monitorCapable===true&&f.passive==='1'&&f.passive_dim==='2';
      node.passiveGraph=node.passiveCapable&&f.passive_graph==='1';
      node.passiveReady=['0','1'].includes(f.passive_ready)?f.passive_ready==='1':null;
      node.passiveResultTtlMs=f.passive_result_ttl_ms==='3000'?3000:null;
      node.passiveMaxNodes=node.passiveGraph&&/^\d+$/.test(f.passive_max_nodes||'')&&Number(f.passive_max_nodes)>0&&Number(f.passive_max_nodes)<=20?Number(f.passive_max_nodes):null;
    }
    if(['stopped','broadcast','monitor','fault'].includes(f.mode)){
      if(node.mode!==undefined&&node.mode!==f.mode){node.passive=null;}node.mode=f.mode;node.active=['broadcast','monitor'].includes(f.mode);
    }else if(f.active==='0')node.mode='stopped';else if(f.active==='1'&&node.mode!=='monitor')node.mode='broadcast';
    if(['0','1'].includes(f.monitor))node.monitorCapable=f.monitor==='1';
    node.fault=node.mode==='fault'||f.fault==='1'||['radio_error','restore_error','radio_fault_stopped'].includes(f.result);
  }
  /** 所有节点对统一使用电脑接收超时，不依赖固件模式或测量年龄。 */
  edgeTtl() { return this.ttlMs; }
  observe(a,b,distance,{time=this.clock(),snapshot=false,token=null}={}) {
    if(a===b||!address(String(a))||!address(String(b))||!Number.isFinite(distance)||(distance<0&&distance!==-1)){this.invalidRecords++;return null;}
    const [source,peer]=[a,b].sort((x,y)=>x-y),key=`${source}/${peer}`,old=this.edges.get(key);
    // 无效记录照常交给原始/CSV出口，不改矩阵、历史或最后有效接收时刻。
    if(distance===-1)return {type:'observation',record:{node_a:source,node_b:peer,distance_m:-1},fresh:false,snapshot,ignored:true};
    this.bind(source,null,time);this.bind(peer,null,time);
    // 已见节点对的快照不能续期，包括该结果已经过期的情况。
    if(snapshot&&(old||this.archived.has(key)))return null;
    if(token&&old?.token===token)return null;
    const history=old?.history||this.archived.get(key)?.history||[];this.archived.delete(key);
    if(!snapshot){history.push({t:time,v:distance,id:++this.historySerial});if(history.length>this.historyLimit)history.splice(0,history.length-this.historyLimit);}
    if(!old&&this.edges.size>=210){let oldest=null;for(const item of this.edges)if(!oldest||item[1].received<oldest[1].received)oldest=item;this.archiveEdge(oldest[0],oldest[1]);this.edges.delete(oldest[0]);}
    const edge={source,peer,distance,received:time,history,token,snapshot};this.edges.set(key,edge);this.pruneNodes();
    return {type:'observation',record:{node_a:source,node_b:peer,distance_m:distance},fresh:!snapshot&&distance>=0,snapshot};
  }
  ingestFrame(frame,time=this.clock()) {
    const {type,revision,payload}=frame;
    if(type===4){this.reset();return [];}
    if(type===1){
      const slots=new Map(this.self?[[0,this.self]]:[]),addresses=new Set(this.self?[this.self]:[]);
      for(let at=0;at<payload.length;at+=5){const slot=payload[at],id=payload.readUInt32LE(at+1);if(slot<1||slot>20||slots.has(slot)||addresses.has(id)||!address(String(id)))throw Error('节点编号表无效');slots.set(slot,id);addresses.add(id);}
      this.slots=slots;this.mapRevision=revision;for(const id of addresses)this.bind(id,id===this.self?this.port:null,time);this.pruneNodes();return [];
    }
    if(this.mapRevision!==revision||!this.self)throw Error('节点编号表未知');
    const records=[];
    // 批次全量验证后再提交，末尾坏记录不能留下半批数据。
    for(let at=0;at<payload.length;at+=6){const a=this.slots.get(payload[at]),b=this.slots.get(payload[at+1]),d=payload.readFloatLE(at+2);if(!a||!b||a===b||!Number.isFinite(d)||(d<0&&d!==-1))throw Error('距离记录无效');records.push([a,b,d]);}
    return records.map(([a,b,distance])=>this.observe(a,b,distance,{time,snapshot:type===3})).filter(Boolean);
  }
  ingest(line,port,time=this.clock()) {
    const info=fields(line,'@SWARM_INFO');
    if(info&&address(info.self)){
      const node=this.setIdentity(Number(info.self),port,time);
      // INFO是完整能力声明；缺省能力按广播基线处理，不沿用之前连接的监听能力。
      node.monitorCapable=info.monitor==='1';
      node.passiveCapable=node.monitorCapable&&info.passive==='1'&&info.passive_dim==='2';
      if(!node.passiveCapable){node.passiveGraph=false;node.passive=null;}
      if(!node.monitorCapable&&node.mode==='monitor')node.mode='unknown';
      if(['0','1'].includes(info.active))node.active=info.active==='1';
      if(u32(info.period_ms))node.periodMs=Number(info.period_ms);
      if(['0','1'].includes(info.stream))node.stream=info.stream==='1';this.readMode(node,info);
      return {type:'info',node,fields:info};
    }
    // 被动定位状态只归属于当前采集端口已确认的自身设备，不从节点对推断身份。
    const passive=fields(line,'@SWARM_PASSIVE');
    if(passive){
      if(!this.self||Number(passive.self)!==this.self)return null;
      const node=this.nodes.get(this.self);
      if(node?.passiveCapable!==true)return null;
      const graph=node.passiveGraph===true,maxNodes=node.passiveMaxNodes||20;
      const count=(value,max)=>/^\d+$/.test(value||'')&&Number(value)<=max;
      if(!['0','1'].includes(passive.enabled)||!['200','300','500','1000'].includes(passive.window_ms)||
         !/^[a-z_]{1,32}$/.test(passive.reason||'')||
         (graph?!['nodes','used_nodes','edges','used_edges','valid_nodes','components'].every(key=>count(passive[key],key.includes('edges')?190:maxNodes)):
                !count(passive.constraints,6))){this.invalidRecords++;return null;}
      if(passive.result_ttl_ms==='3000')node.passiveResultTtlMs=3000;
      node.passive={schema:graph?'graph':'fixed4',enabled:passive.enabled==='1',windowMs:Number(passive.window_ms),reason:passive.reason,
        constraints:graph?null:Number(passive.constraints),receivedAt:time,result:passive.result||'',
        nodes:graph?Number(passive.nodes):null,usedNodes:graph?Number(passive.used_nodes):null,
        edges:graph?Number(passive.edges):null,usedEdges:graph?Number(passive.used_edges):null,
        validNodes:graph?Number(passive.valid_nodes):null,components:graph?Number(passive.components):null,
        spanUs:micros(passive.span_us)?Number(passive.span_us):null,
        solverCalls:u32(passive.solver_calls)?Number(passive.solver_calls):null,
        solved:u32(passive.solved)?Number(passive.solved):null};
      return {type:'passive',node,fields:passive};
    }
    const range=fields(line,'@SWARM_RANGE');
    if(range&&address(range.a)&&address(range.b)&&/^-?\d+(\.\d+)?$/.test(range.distance_m||''))return this.observe(Number(range.a),Number(range.b),Number(range.distance_m),{time});
    if(line.startsWith('@SRV2 ')){
      const r=parseObservation(line);if(!r){this.invalidRecords++;return null;}
      // 仅兼容旧协议由 self 明确标注的本机观测，第三方端点不绑定端口。
      const node=this.setIdentity(r.self,port,time);this.setBoot(node,r.boot);node.active=true;node.mode='broadcast';
      return this.observe(r.self,r.peer,r.valid?r.distance_m:-1,{time,ageMs:r.age_us/1000,token:`${r.self}/${r.peer}/${r.boot}/${r.peer_boot}/${r.update}`});
    }
    const f=fields(line,'@SRV2_STATUS');
    if(f&&address(f.self)){
      const node=this.setIdentity(Number(f.self),port,time);
      if(u32(f.boot))this.setBoot(node,Number(f.boot));
      if(['0','1'].includes(f.active))node.active=f.active==='1';this.readMode(node,f);
      // 停止回执只更新设备状态，距离仍由电脑3秒接收超时决定。
      if(u32(f.period_ms))node.periodMs=Number(f.period_ms);
      if(['0','1'].includes(f.stream))node.stream=f.stream==='1';
      node.fault=node.mode==='fault'||f.fault==='1'||['radio_error','restore_error','radio_fault_stopped'].includes(f.result);node.result=f.result;node.stats={...node.stats,...f};
      return {type:'status',node,fields:f};
    }
    const ack=fields(line,'@SWARM_ACK');
    if(ack&&address(ack.controller)&&address(ack.node)&&u32(ack.request)&&u32(ack.boot)&&['0','1'].includes(ack.active)&&['ok','busy','fault'].includes(ack.result)){
      const node=this.bind(Number(ack.node),null,time);this.setBoot(node,Number(ack.boot));node.active=ack.active==='1';
      return {type:'ack',ack:{controller:Number(ack.controller),request:Number(ack.request),node:Number(ack.node),active:node.active,boot:Number(ack.boot),result:ack.result}};
    }
    const control=fields(line,'@SWARM_CONTROL');if(control&&address(control.self)&&u32(control.request))return {type:'control',fields:control};
    return null;
  }
  snapshot(time=this.clock(),includeHistory=true) {
    return {nodes:[...this.nodes.values()].map(n=>({...n,stats:{...n.stats}})).sort((a,b)=>a.id-b.id),
      edges:[...this.edges.values(),...(includeHistory?[...this.archived.entries()].filter(([key])=>!this.edges.has(key)).map(([,edge])=>edge):[])].map(e=>({...e,ttlMs:this.edgeTtl(e.source,e.peer),valid:e.distance>=0&&time-e.received<this.edgeTtl(e.source,e.peer),ageMs:Math.max(0,time-e.received),history:includeHistory?e.history.slice():[]})),invalidRecords:this.invalidRecords};
  }
}
module.exports={Model,fields,parseObservation};
