'use strict';
/** @file latest-positions.cjs @brief 独立于定位实验的最新真实位置缓存；不推算或修改上报坐标。 */
const UINT32_MAX = 0xffffffff;
const finitePosition = p => Array.isArray(p) && p.length === 3 && Array.from(p).every(Number.isFinite);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const address = value => integer(value, 1, UINT32_MAX - 1);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * @brief 解析一条完整POS消息；非法或缺失字段返回null，不接受USB半包。
 * @param {string} text 完整文本行，坐标单位米、t单位微秒。
 * @param {string} portPath 采集串口路径，作为实验模型兼容的observer。
 * @returns {object|null} 合法事件，保留未声明的source_epoch为undefined。
 */
function parsePosition(text, portPath) {
  if (typeof text !== 'string' || text.length > 2048 || typeof portPath !== 'string' || !portPath || portPath.length > 256) return null;
  const parts = text.trim().split(/\s+/);
  if (parts.shift() !== '@SWARM_POS' || parts.length > 32) return null;
  const f = Object.create(null);
  for (const part of parts) {
    const match = /^([a-z_]+)=(\S+)$/.exec(part);
    if (!match || Object.hasOwn(f, match[1])) return null;
    f[match[1]] = match[2];
  }
  const numeric = key => /^\d+$/.test(f[key] || '') ? Number(f[key]) : NaN;
  if (!['1', '2'].includes(f.v) || !['observer', 'node'].every(key => address(numeric(key))) ||
      !['boot', 'node_boot'].every(key => integer(numeric(key), 1, UINT32_MAX)) ||
      !integer(numeric('t'), 0, Number.MAX_SAFE_INTEGER) || !['receive', 'mapped'].includes(f.quality)) return null;
  const packetMs = f.v === '2';
  if (packetMs && (f.time_basis !== 'packet_ms' || f.quality !== 'receive' || !['0', '1'].includes(f.compat_usable) ||
      f.clock_ready !== undefined || f.error_us !== undefined || f.legacy_frame !== undefined ||
      !integer(numeric('source_epoch'), 0, 65535))) return null;
  if (f.source_epoch !== undefined && !integer(numeric('source_epoch'), 0, 65535)) return null;
  for (const key of ['legacy_frame', 'clock_ready', 'compat_usable']) if (f[key] !== undefined && !['0', '1'].includes(f[key])) return null;
  if (!['x', 'y', 'z'].every(key => decimal.test(f[key] || ''))) return null;
  const position = ['x', 'y', 'z'].map(key => Number(f[key]));
  if (!finitePosition(position)) return null;
  return {observer: portPath, observerId: numeric('observer'), boot: numeric('boot'), node: numeric('node'),
    node_boot: numeric('node_boot'), source_epoch: f.source_epoch === undefined ? undefined : numeric('source_epoch'),
    t_us: numeric('t'), position, quality: f.quality, protocolVersion: Number(f.v),
    ...(packetMs ? {time_basis: 'packet_ms'} : {legacy_frame: f.legacy_frame === '1', clock_ready: f.clock_ready === '1'}),
    compat_usable: f.compat_usable === '1'};
}

/** @brief 有界退休记录；只用于隔离近期延迟旧包，不依据boot数值猜测新旧。 */
function retire(list, value, capacity) {
  if (!list.includes(value)) list.push(value);
  if (list.length > capacity) list.shift();
}
function limit(value, fallback) { return integer(value, 1, 65536) ? value : fallback; }

class LatestPositions {
  /** @brief 容量按采集端口限制；队列采用最近成功接收顺序，不按设备间不可比的时钟排序。 */
  constructor(options = {}) {
    this.maxNodesPerPort = limit(options.maxNodesPerPort, 1024);
    this.maxPorts = limit(options.maxPorts, 64);
    this.retiredSessions = limit(options.retiredSessions, 8);
    this.ports = new Map();
    this.sequence = 0;
  }

  /**
   * @brief 提交一条合法位置，成功返回true；重复、倒序或退休会话返回false。
   * @param {string} portPath 采集来源。
   * @param {object} event parsePosition返回的事件。
   * @param {number} now 电脑接收时间，毫秒；不使用设备微秒时钟计算新鲜度。
   */
  ingest(portPath, event, now = Date.now()) {
    if (typeof portPath !== 'string' || !portPath || portPath.length > 256 || !event ||
        !address(event.observerId) || !address(event.node) || !integer(event.boot, 1, UINT32_MAX) ||
        !integer(event.node_boot, 1, UINT32_MAX) || !integer(event.t_us, 0, Number.MAX_SAFE_INTEGER) ||
        (event.source_epoch !== undefined && !integer(event.source_epoch, 0, 65535)) ||
        !finitePosition(event.position) || !Number.isFinite(now) || !['receive', 'mapped'].includes(event.quality)) return false;
    /** @brief 新位置时间依据必须随缓存保留；缺失依据不能降级为旧记录。 */
    if (event.protocolVersion !== undefined && ![1, 2].includes(event.protocolVersion)) return false;
    if (event.protocolVersion === 2 && (event.time_basis !== 'packet_ms' || event.quality !== 'receive' ||
        typeof event.compat_usable !== 'boolean' || event.clock_ready !== undefined || event.error_us !== undefined ||
        !integer(event.source_epoch, 0, 65535))) return false;
    let port = this.ports.get(portPath);
    if (!port) {
      if (this.ports.size >= this.maxPorts) this.ports.delete(this.ports.keys().next().value);
      port = {session: null, retired: [], nodes: new Map()};
      this.ports.set(portPath, port);
    }
    const session = `${event.observerId}:${event.boot}`;
    if (port.session !== session) {
      if (port.retired.includes(session)) return false;
      if (port.session !== null) retire(port.retired, port.session, this.retiredSessions);
      port.session = session;
      port.nodes.clear();
    }
    let node = port.nodes.get(event.node);
    if (!node) node = {boot: event.node_boot, epoch: event.source_epoch, retiredBoots: [], retiredEpochs: [], sample: null};
    if (node.boot !== event.node_boot) {
      if (node.retiredBoots.includes(event.node_boot)) return false;
      retire(node.retiredBoots, node.boot, this.retiredSessions);
      node.boot = event.node_boot;
      node.epoch = event.source_epoch;
      node.retiredEpochs = [];
      node.sample = null;
    }
    if (event.source_epoch !== undefined && node.epoch !== event.source_epoch) {
      if (node.retiredEpochs.includes(event.source_epoch)) return false;
      if (node.epoch !== undefined) retire(node.retiredEpochs, node.epoch, this.retiredSessions);
      node.epoch = event.source_epoch;
      node.sample = null;
    }
    if (node.sample && event.t_us <= node.sample.t_us) return false;
    const timing = {quality: event.quality};
    for (const key of ['protocolVersion', 'time_basis', 'legacy_frame', 'clock_ready', 'compat_usable'])
      if (event[key] !== undefined) timing[key] = event[key];
    node.sample = {...timing, node: event.node, position: event.position.slice(), port: portPath,
      observerId: event.observerId, boot: event.boot, node_boot: event.node_boot,
      source_epoch: node.epoch, t_us: event.t_us, receivedAt: now, order: ++this.sequence};
    port.nodes.delete(event.node);
    port.nodes.set(event.node, node);
    if (port.nodes.size > this.maxNodesPerPort) port.nodes.delete(port.nodes.keys().next().value);
    this.ports.delete(portPath);
    this.ports.set(portPath, port);
    return true;
  }

  /** @brief 返回此采集端口实际收到位置的节点地址副本，不混入其他端口节点。 */
  nodesForPort(portPath) { return [...(this.ports.get(portPath)?.nodes.keys() || [])].sort((a, b) => a - b); }
  /** @brief 读取本端口实际收到的最新位置副本，用于阶段原点；不从其他观察端补数。 */
  samplesForPort(portPath) {
    return [...(this.ports.get(portPath)?.nodes.values() || [])].filter(node=>node.sample).map(node=>{
      const {order,...sample}=node.sample;return {...sample,position:sample.position.slice()};
    }).sort((a,b)=>a.node-b.node);
  }

  /** @brief 重连前清理此来源的样本、时序和退休会话；其他采集端口保持独立。 */
  resetPort(portPath) { this.ports.delete(portPath); }
  /** @brief 删除采集端口；下次快照自动回退到其他来源的最后样本。 */
  removePort(portPath) { this.resetPort(portPath); }

  /**
   * @brief 返回按数值节点地址排序的副本；断线优先显示disconnected，满1000ms显示stale。
   * @param {number} now 电脑当前毫秒时间；时钟回拨时年龄下限为0。
   * @param {Map} ports 当前采集端口状态，值包含connected。
   * @returns {object[]} 每节点最近一次合法接收的数据，含原始XYZ和状态。
   */
  snapshot(now = Date.now(), ports = new Map()) {
    if (!Number.isFinite(now)) now = Date.now();
    const merged = new Map();
    for (const port of this.ports.values()) for (const node of port.nodes.values()) {
      const sample = node.sample, old = merged.get(sample.node);
      if (!old || sample.order > old.order) merged.set(sample.node, sample);
    }
    return [...merged.values()].sort((a, b) => a.node - b.node).map(sample => {
      const {order, ...row} = sample;
      row.position = sample.position.slice();
      row.ageMs = Math.max(0, now - sample.receivedAt);
      row.status = ports.get(sample.port)?.connected ? (row.ageMs >= 1000 ? 'stale' : 'fresh') : 'disconnected';
      return row;
    });
  }
}
module.exports = {LatestPositions, parsePosition};

