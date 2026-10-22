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

/** 有向观测模型：只有上报节点本身才能写入该行；会话变化清除相关旧结果。 */
class Model {
  constructor({ttlMs = 3000, historyLimit = 600, clock = Date.now} = {}) {
    this.ttlMs = ttlMs;
    this.historyLimit = historyLimit;
    this.clock = clock;
    this.nodes = new Map();
    this.edges = new Map();
    this.offsets = new Map();
    this.invalidRecords = 0;
    this.nextLineId = 1;
  }
  bind(id, port, time) {
    const node = this.nodes.get(id) || {id, port: null, active: null, boot: null, stats: {}};
    if (port) node.port = port;
    node.lastSeen = time;
    this.nodes.set(id, node);
    return node;
  }
  setBoot(node, boot) {
    if (node.boot !== null && node.boot !== boot) {
      for (const [key, edge] of this.edges) {
        if (edge.source === node.id || edge.peer === node.id) this.edges.delete(key);
      }
    }
    node.boot = boot;
  }
  ingest(line, port, time = this.clock()) {
    if (line.startsWith('@SRV2 ')) {
      const r = parseObservation(line);
      if (!r) { this.invalidRecords++; return null; }
      const node = this.bind(r.self, port, time);
      this.setBoot(node, r.boot);
      node.active = true;
      // 邻居出现只证明被本机接收过，不能假定邻居有USB或已确认运行状态。
      if (!this.nodes.has(r.peer)) this.nodes.set(r.peer, {id:r.peer, port:null, active:null, boot:null, lastSeen:time, stats:{}});
      const offsetKey = `${r.self}/${r.boot}`;
      const offset = time - (r.measurement_us + r.age_us) / 1000;
      this.offsets.set(offsetKey, Math.min(this.offsets.get(offsetKey) ?? offset, offset));
      const key = `${r.self}/${r.peer}`;
      const old = this.edges.get(key);
      const token = `${r.boot}/${r.peer_boot}/${r.update}`;
      const history = old?.history || [];
      const fresh = r.valid === 1 && r.age_us / 1000 < this.ttlMs &&
        time - (r.measurement_us / 1000 + this.offsets.get(offsetKey)) < this.ttlMs;
      if (fresh && old?.token !== token) {
        history.push({t: time, v: r.distance_m});
        if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
      }
      this.edges.set(key, {source:r.self, peer:r.peer, distance:r.distance_m,
        valid:!!r.valid, method:r.method, update:r.update, received:time,
        ageAtReceive:r.age_us / 1000, measured:r.measurement_us / 1000,
        boot:r.boot, peerBoot:r.peer_boot, token, history});
      return {type:'observation', record:r, fresh};
    }
    const f = fields(line, '@SRV2_STATUS');
    if (f && address(f.self)) {
      const node = this.bind(Number(f.self), port, time);
      if (u32(f.boot)) this.setBoot(node, Number(f.boot));
      if (f.active === '0' || f.active === '1') node.active = f.active === '1';
      if (u32(f.period_ms)) node.periodMs = Number(f.period_ms);
      if (['0','1'].includes(f.stream)) node.stream = f.stream === '1';
      node.fault = f.fault === '1' || ['radio_error','restore_error','radio_fault_stopped'].includes(f.result);
      node.result = f.result;
      node.stats = {...node.stats, ...f};
      return {type:'status', node, fields:f};
    }
    const ack = fields(line, '@SWARM_ACK');
    if (ack && address(ack.controller) && address(ack.node) && u32(ack.request) &&
        u32(ack.boot) && ['0','1'].includes(ack.active) && ['ok','busy','fault'].includes(ack.result)) {
      const node = this.nodes.get(Number(ack.node)) || this.bind(Number(ack.node), null, time);
      this.setBoot(node, Number(ack.boot));
      node.active = ack.active === '1'; node.lastSeen = time;
      return {type:'ack', ack:{controller:Number(ack.controller),request:Number(ack.request),
        node:Number(ack.node),active:ack.active === '1',boot:Number(ack.boot),result:ack.result}};
    }
    const control = fields(line, '@SWARM_CONTROL');
    if (control && address(control.self) && u32(control.request)) return {type:'control', fields:control};
    return null;
  }
  snapshot(time = this.clock()) {
    const nodes = [...this.nodes.values()].map(n => ({...n, stats:{...n.stats}}));
    const edges = [...this.edges.values()].map(e => {
      const ageMs = Math.max(e.ageAtReceive + time - e.received,
        time - (e.measured + this.offsets.get(`${e.source}/${e.boot}`)));
      const source = this.nodes.get(e.source), peer = this.nodes.get(e.peer);
      const valid = e.valid && ageMs < this.ttlMs && source?.active !== false &&
        source?.boot === e.boot && (peer?.boot === null || peer?.boot === e.peerBoot) && peer?.active !== false;
      return {source:e.source,peer:e.peer,distance:e.distance,valid,ageMs,method:e.method,
        update:e.update,history:e.history.slice(), received:e.received};
    });
    return {nodes, edges, invalidRecords:this.invalidRecords};
  }
}

module.exports = {Model, fields, parseObservation};
