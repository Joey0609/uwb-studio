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
  constructor({ttlMs=1000,historyLimit=600,clock=Date.now}={}) {
    this.ttlMs=ttlMs;this.historyLimit=historyLimit;this.clock=clock;
    this.nodes=new Map();this.edges=new Map();this.invalidRecords=0;this.self=null;this.port=null;
    this.slots=new Map();this.mapRevision=null;this.historySerial=0;
  }
  bind(id,port,time=this.clock()) {
    const node=this.nodes.get(id)||{id,port:null,active:null,boot:null,stats:{}};
    if(port)node.port=port;node.lastSeen=time;this.nodes.set(id,node);return node;
  }
  setIdentity(id,port,time=this.clock()) {
    if(this.self!==null&&this.self!==id){this.nodes.clear();this.edges.clear();this.slots.clear();this.mapRevision=null;}
    this.self=id;this.port=port;this.slots.set(0,id);return this.bind(id,port,time);
  }
  setBoot(node,boot) {
    if(node.boot!==null&&node.boot!==boot)this.edges.clear();node.boot=boot;
  }
  reset(){this.edges.clear();this.slots.clear();this.mapRevision=null;this.nodes.clear();if(this.self){this.slots.set(0,this.self);this.bind(this.self,this.port);}}
  loseSync(){this.edges.clear();this.mapRevision=null;}
  observe(a,b,distance,{time=this.clock(),snapshot=false,token=null,ageMs=0}={}) {
    if(a===b||!address(String(a))||!address(String(b))||!Number.isFinite(distance)||(distance<0&&distance!==-1)){this.invalidRecords++;return null;}
    const [source,peer]=[a,b].sort((x,y)=>x-y),key=`${source}/${peer}`,old=this.edges.get(key);
    this.bind(source,null,time);this.bind(peer,null,time);
    // 快照是恢复当前视图，不可把反复查询变成新测量或新历史。
    if(snapshot&&old)return null;
    if(token&&old?.token===token)return null;
    const history=old?.history||[];
    if(!snapshot){history.push({t:time,v:distance,id:++this.historySerial});if(history.length>this.historyLimit)history.splice(0,history.length-this.historyLimit);}
    const edge={source,peer,distance,received:time-ageMs,history,token,snapshot};this.edges.set(key,edge);
    return {type:'observation',record:{node_a:source,node_b:peer,distance_m:distance},fresh:!snapshot&&distance>=0&&ageMs<this.ttlMs,snapshot};
  }
  ingestFrame(frame,time=this.clock()) {
    const {type,revision,payload}=frame;
    if(type===4){this.reset();return [];}
    if(type===1){
      const slots=new Map(this.self?[[0,this.self]]:[]),addresses=new Set(this.self?[this.self]:[]);
      for(let at=0;at<payload.length;at+=5){const slot=payload[at],id=payload.readUInt32LE(at+1);if(slot<1||slot>20||slots.has(slot)||addresses.has(id)||!address(String(id)))throw Error('节点编号表无效');slots.set(slot,id);addresses.add(id);}
      for(const[key,edge]of this.edges)if(!addresses.has(edge.source)||!addresses.has(edge.peer))this.edges.delete(key);
      for(const[id]of this.nodes)if(!addresses.has(id))this.nodes.delete(id);
      this.slots=slots;this.mapRevision=revision;for(const id of addresses)this.bind(id,id===this.self?this.port:null,time);return [];
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
      if(['0','1'].includes(info.active))node.active=info.active==='1';
      if(u32(info.period_ms))node.periodMs=Number(info.period_ms);
      if(['0','1'].includes(info.stream))node.stream=info.stream==='1';
      return {type:'info',node,fields:info};
    }
    const range=fields(line,'@SWARM_RANGE');
    if(range&&address(range.a)&&address(range.b)&&/^-?\d+(\.\d+)?$/.test(range.distance_m||''))return this.observe(Number(range.a),Number(range.b),Number(range.distance_m),{time});
    if(line.startsWith('@SRV2 ')){
      const r=parseObservation(line);if(!r){this.invalidRecords++;return null;}
      // 仅兼容旧协议由 self 明确标注的本机观测，第三方端点不绑定端口。
      const node=this.setIdentity(r.self,port,time);this.setBoot(node,r.boot);node.active=true;
      return this.observe(r.self,r.peer,r.valid?r.distance_m:-1,{time,ageMs:r.age_us/1000,token:`${r.self}/${r.peer}/${r.boot}/${r.peer_boot}/${r.update}`});
    }
    const f=fields(line,'@SRV2_STATUS');
    if(f&&address(f.self)){
      const node=this.setIdentity(Number(f.self),port,time);
      if(u32(f.boot))this.setBoot(node,Number(f.boot));
      if(['0','1'].includes(f.active))node.active=f.active==='1';
      if(node.active===false)for(const edge of this.edges.values())edge.distance=-1;
      if(u32(f.period_ms))node.periodMs=Number(f.period_ms);
      if(['0','1'].includes(f.stream))node.stream=f.stream==='1';
      node.fault=f.fault==='1'||['radio_error','restore_error','radio_fault_stopped'].includes(f.result);node.result=f.result;node.stats={...node.stats,...f};
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
      edges:[...this.edges.values()].map(e=>({...e,valid:e.distance>=0&&time-e.received<this.ttlMs,ageMs:Math.max(0,time-e.received),history:includeHistory?e.history.slice():[]})),invalidRecords:this.invalidRecords};
  }
}
module.exports={Model,fields,parseObservation};
