'use strict';

(() => {
  const api = window.uwb;
  const $ = id => document.getElementById(id);
  const COLORS = ['#199b79', '#e49660', '#9985ce', '#5599bd', '#d37b94', '#9aaa52', '#50b7b2', '#a48c73'];
  const state = {
    snapshot: { ports: [], nodes: [], edges: [], control: {}, recording: {}, now: Date.now() },
    selected: null, activePort: null, discovered: [], selectedPorts: new Set(), busyPorts: new Set(),
    settings: { theme: 'system', quickCommands: [] }, terminal: new Map(), commandHistory: new Map(),
    lastRender: 0, dirty: true, chartDirty: true, portKey: '', nodeKey: '', matrixKey: '', detailKey: '',
    terminalKey: '', terminalTabsKey: '', historyOptionsKey: '', quickKey: '', gatewayKey: '', controlKey: '', lineCache: new Map(), historyCache:new Map(),
    portElements: new Map(), matrixCells: new Map(), detailElements: new Map(), modalTheme: null,
    portMatrixKey: '', portMatrixElements: new Map(), portMatrixViews: new Map(),
  };
  let nextSnapshot = null;
  let toastTimer = null;
  let resizeObserver = null;

  function element(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`); svg.append(use); svg.setAttribute('aria-hidden', 'true'); return svg;
  }
  function button(label, className = 'button', iconName, action) {
    const b = element('button', className); b.type = 'button';
    if (iconName) b.append(icon(iconName)); b.append(element('span', '', label));
    if (action) b.addEventListener('click', action); return b;
  }
  function text(e, value) { const next = String(value ?? ''); if (e && e.textContent !== next) e.textContent = next; }
  const nodeId = n => String(n.id ?? n.nodeId ?? '');
  const idOf = value => String(value ?? '');
  const connectedPorts = () => state.snapshot.ports.filter(p => p.connected);
  const currentNode = () => state.snapshot.nodes.find(n => nodeId(n) === state.selected);
  const currentPort = () => state.snapshot.ports.find(p => p.path === state.activePort);
  const modeLabel=mode=>({stopped:'已停止',broadcast:'广播测距',monitor:'纯监听',fault:'故障',unknown:'等待确认'})[mode]||'等待确认';
  const kindLabel = kind => /^stm/i.test(kind || '') ? 'STM32' : /^esp/i.test(kind || '') ? 'ESP32-C6' : kind === 'probe' ? '调试探针' : '设备类型待识别';
  const colorFor = (id, ids = state.snapshot.nodes.map(nodeId)) => COLORS[Math.max(0, ids.indexOf(String(id))) % COLORS.length];
  function ageLabel(ms) { if (!Number.isFinite(ms)) return '尚未更新'; return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms 前` : `${(Math.max(0, ms) / 1000).toFixed(ms < 10000 ? 1 : 0)} s 前`; }
  function formatBytes(n) { const v = Number(n) || 0; return v < 1024 ? `${v} B` : v < 1024 * 1024 ? `${(v / 1024).toFixed(1)} KB` : `${(v / 1048576).toFixed(1)} MB`; }
  function edgeTtlMs(e) { return Number(e?.ttlMs)>0?Number(e.ttlMs):3000; }
  function finiteDistance(e) { return Boolean(e && e.valid === true && Number.isFinite(Number(e.distance)) && Number(e.distance) >= 0 && (e.ageMs === undefined || Number(e.ageMs) + Math.max(0, Date.now() - Number(state.snapshot.now || Date.now())) < edgeTtlMs(e))); }
  function measurement(e) { return finiteDistance(e) ? Number(e.distance).toFixed(3) : '—'; }
  function terminalState(path) {
    if (!state.terminal.has(path)) state.terminal.set(path, { paused: false, frozen: [], cleared: new Set(), historyIndex: -1, draft: '' });
    return state.terminal.get(path);
  }
  function toast(message, error = false) {
    const host = $('toast-region');
    const e = element('div', `toast${error ? ' error' : ''}`, message); host.replaceChildren(e);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => host.replaceChildren(), error ? 7000 : 4000);
  }
  function errorText(error) { return error?.message || String(error || '操作失败'); }
  async function copyText(value) {
    if (api?.copyText) { checkResult(await api.copyText(value)); return; }
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return; } catch (_) { /* 沙箱可能禁用权限，保留用户手势复制回退。 */ }
    }
    const previous = document.activeElement; const area = element('textarea'); area.value = value;
    area.readOnly = true; area.style.position = 'fixed'; area.style.left = '-10000px'; area.style.top = '0';
    document.body.append(area); area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } finally { area.remove(); previous?.focus(); }
    if (!copied) throw new Error('系统未允许复制。可以选中终端文本后使用 Ctrl+C。');
  }
  function requireApi() { if (!api) throw new Error('请在 UWB Studio 桌面应用中连接串口。'); }
  function checkResult(result) {
    if (result && (result.ok === false || result.success === false)) throw new Error(result.error || result.message || '设备操作失败');
    return result;
  }
  async function run(task, control) {
    if (control) control.disabled = true;
    try { return await task(); } catch (error) { toast(errorText(error), true); return null; }
    finally { if (control) control.disabled = false; state.dirty = true; }
  }
  function timeText(value) {
    const d = new Date(value); if (!Number.isFinite(d.getTime())) return '';
    return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }
  function applyTheme(choice) {
    const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('theme-select').value = choice;
    $('theme-toggle').title = `当前：${choice === 'system' ? '跟随系统' : dark ? '深色' : '浅色'}，点击切换`;
    state.chartDirty = true;
    document.querySelectorAll('[data-theme-choice]').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === choice));
    window.UwbDropdowns?.refreshAll();
  }
  async function saveTheme(choice) {
    state.settings.theme = choice; applyTheme(choice);
    if (api) await api.setSettings({ theme: choice });
  }
  function ensurePortSelection() {
    const ports = state.snapshot.ports;
    if (!ports.some(p => p.path === state.activePort)) state.activePort = ports.find(p => p.connected)?.path || ports[0]?.path || null;
    if (state.selected !== null && !state.snapshot.nodes.some(n => nodeId(n) === state.selected)) state.selected = null;
  }

  function renderPorts() {
    const ports = state.snapshot.ports;
    const key = ports.map(p => p.path).join('|');
    if (key !== state.portKey) {
      state.portKey = key; state.portElements.clear();
      const children = [];
      for (const p of ports) {
        const card = element('article', 'port-card');
        const top = element('div', 'port-card-top'); const chip = element('div', 'device-chip');
        const title = element('div'); const name = element('div', 'port-name', p.path); const baud = element('small'); name.append(baud);
        const device = element('div', 'port-device'); title.append(name, device);
        const connect = button('断开', 'button port-connect', null, () => togglePort(p.path)); const remove = button('', 'button icon-button port-remove', 'trash', () => removePort(p.path));
        remove.title = `删除串口 ${p.path}`; remove.setAttribute('aria-label', remove.title);
        top.append(chip, title, connect, remove);
        const status = element('div', 'port-status'); const dot = element('span', 'status-dot');
        const label = element('span'); const counters = element('span', 'port-counters'); status.append(dot, label, counters);
        const error = element('p', 'port-error'); card.append(top, status, error); children.push(card);
        state.portElements.set(p.path, { card, baud, device, connect, remove, label, dot, counters, error });
      }
      const add = button('添加串口', 'add-port', 'plus', () => openPorts()); add.id = 'add-port'; children.push(add);
      $('port-strip').replaceChildren(...children);
    }
    for (const p of ports) {
      const ui = state.portElements.get(p.path); if (!ui) continue;
      text(ui.baud, p.baudRate || $('default-baud').value);
      text(ui.device, `${kindLabel(p.kind)}${p.nodeId ? ` · ${p.nodeId}` : ''}`);
      text(ui.connect.firstChild, p.connected ? '断开' : '连接'); ui.connect.disabled = state.busyPorts.has(p.path); ui.remove.disabled = state.busyPorts.has(p.path);
      text(ui.label,p.connected?`已连接 · ${modeLabel(p.mode)}`:'未连接'); ui.dot.classList.toggle('neutral', !p.connected);
      text(ui.counters, `↓ ${formatBytes(p.rxBytes)}  ↑ ${formatBytes(p.txBytes)}`);
      const losses = [p.dropped ? `原始记录丢弃 ${formatBytes(p.dropped)}` : '', p.droppedUi ? `显示缓冲丢弃 ${p.droppedUi} 条` : ''].filter(Boolean);
      text(ui.error, p.error || losses.join(' · ')); ui.error.hidden = !ui.error.textContent;
    }
    const count = connectedPorts().length;
    text($('port-count'), `${count} / ${ports.length}`);
    text($('capture-status').lastChild, count ? `${count} 个串口采集中` : '等待连接');
    $('capture-status').querySelector('.status-dot').classList.toggle('neutral', count === 0);
    const gatewayKey = ports.filter(p=>p.connected&&!['monitor','fault'].includes(p.mode)).map(p=>`${p.path}:${p.nodeId}:${p.mode}`).join('|');
    if (state.gatewayKey !== gatewayKey) {
      state.gatewayKey = gatewayKey; const old = $('gateway').value || state.settings.gateway || '';
      $('gateway').replaceChildren(new Option('自动选择网关', ''));
      for (const p of connectedPorts().filter(p=>!['monitor','fault'].includes(p.mode))) $('gateway').add(new Option(`${p.path}${p.nodeId ? ` · ${p.nodeId}` : ''}`, p.path));
      if ([...$('gateway').options].some(o => o.value === old)) $('gateway').value = old;
    }
  }

  /** 删除采集会话；下方面板和终端随快照同步清理。 */
  async function removePort(path) {
    if (state.busyPorts.has(path)) return;
    await run(async () => {
      requireApi(); state.busyPorts.add(path); state.dirty = true;
      try { checkResult(await api.removePort(path)); }
      finally { state.busyPorts.delete(path); }
    });
  }

  async function togglePort(path) {
    await run(async () => {
      requireApi(); const port = state.snapshot.ports.find(p => p.path === path); if (!port) return;
      state.busyPorts.add(path); state.dirty = true;
      try {
        if (port.connected) checkResult(await api.disconnect(path));
        else checkResult(await api.connect({ path, baudRate: Number(port.baudRate || $('default-baud').value), encoding: port.encoding || 'auto' }));
      } finally { state.busyPorts.delete(path); }
    });
  }

  function renderNodes() {
    const nodes = state.snapshot.nodes;
    const key = nodes.map(n => `${nodeId(n)}:${n.port || ''}`).join('|');
    if (key !== state.nodeKey) {
      state.nodeKey = key; const children = [];
      children.push(button('全部节点', 'node-tab', null, () => selectNode(null)));
      for (const n of nodes) { const b = button(nodeId(n), 'node-tab', null, () => selectNode(nodeId(n))); b.dataset.node = nodeId(n); children.push(b); }
      $('node-tabs').replaceChildren(...children); state.matrixKey = ''; state.detailKey = ''; state.historyOptionsKey = '';
    }
    $('node-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.node || null) === state.selected));
    // 汇总区按当前选中的观察串口显示，绝不把不同观察者的值合成一格。
    const observed=currentPort()||state.snapshot.ports[0];
    const table=$('distance-matrix');const axes=observed?matrixAxes(observed):[];const ids=axes.map(nodeId);
    const matrixKey=(observed?.path||'')+ids.join('|');
    if(matrixKey!==state.matrixKey){
      state.matrixKey=matrixKey;state.matrixCells.clear();const head=element('thead'),tr=element('tr');tr.append(element('th','','节点 / 对端'));ids.forEach(id=>tr.append(element('th','',id)));head.append(tr);const body=element('tbody');
      ids.forEach((id,i)=>{const row=element('tr');row.append(element('th','',id));ids.forEach((peer,j)=>{const td=element('td'),value=element('div','cell-value'),unit=element('div','cell-unit');td.append(value,unit);row.append(td);state.matrixCells.set(`${id}>${peer}`,{td,value,unit,blocked:j<i,diagonal:j===i});});body.append(row);});table.replaceChildren(head,body);
    }
    table.hidden=!ids.length;$('matrix-empty').hidden=!!ids.length;
    const edges=new Map((observed?.matrixEdges||[]).map(e=>[pairKey(e.source,e.peer),e]));
    for(const[key,ui]of state.matrixCells){const[a,b]=key.split('>'),edge=edges.get(pairKey(a,b));text(ui.value,ui.blocked?'':ui.diagonal?'—':measurement(edge));text(ui.unit,ui.blocked||ui.diagonal?'':'m');ui.td.classList.toggle('masked-cell',ui.blocked);ui.td.classList.toggle('diagonal-cell',ui.diagonal);ui.td.classList.toggle('valid',!ui.blocked&&!ui.diagonal&&finiteDistance(edge));ui.td.classList.toggle('unknown',!ui.blocked&&!ui.diagonal&&!finiteDistance(edge));ui.td.title=ui.blocked?'':`${observed?.path||''} ${a} ↔ ${b}`;}
    renderDetail();
  }
  function matrixAxes(port) {
    const ids = new Map();
    const add = n => { const id = typeof n === 'object' && n !== null ? nodeId(n) : idOf(n); if (id && !ids.has(id)) ids.set(id, typeof n === 'object' ? n : { id }); };
    (Array.isArray(port.matrixNodes) ? port.matrixNodes : []).forEach(add);
    if (port.nodeId) add(port.nodeId);
    for (const edge of Array.isArray(port.matrixEdges) ? port.matrixEdges : []) { add(edge.source); add(edge.peer); }
    return [...ids.values()].sort((a,b)=>Number(nodeId(a))-Number(nodeId(b)));
  }
  function pairKey(a,b){return [String(a),String(b)].sort((x,y)=>Number(x)-Number(y)).join('>');}
  function portView(port) {
    let view = state.portMatrixViews.get(port.path);
    if (!view) { view = { paused: false, frozen: null }; state.portMatrixViews.set(port.path, view); }
    return view;
  }
  function togglePortMatrix(path) {
    const port = state.snapshot.ports.find(p => p.path === path); if (!port) return;
    const view = portView(port); view.paused = !view.paused;
    if (view.paused) view.frozen = { nodes: matrixAxes(port).map(n => ({ id: nodeId(n) })), updatedAt: port.matrixUpdatedAt, at: Number(state.snapshot.now) || Date.now(), edges: (port.matrixEdges || []).map(({ history, ...edge }) => ({ ...edge })) };
    else view.frozen = null;
    state.dirty = true;
  }
  function openPortTerminal(path) {
    state.activePort = path; state.terminalKey = ''; state.dirty = true;
    $('terminal-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
  function openPortNode(path) {
    const port = state.snapshot.ports.find(p => p.path === path); if (!port?.nodeId) return;
    selectNode(idOf(port.nodeId)); $('aggregate-view').open = true;
    $('aggregate-view').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
  /** 每张矩阵只读该串口的matrixEdges；坐标轴和结果均来自本端口，禁止使用其他串口填补。 */
  function renderPortMatrices() {
    const ports = state.snapshot.ports; const key = ports.map(p => p.path).join('|'); const grid = $('port-matrix-grid');
    if (key !== state.portMatrixKey) {
      state.portMatrixKey = key; state.portMatrixElements.clear();
      grid.replaceChildren(); grid.dataset.count = String(Math.min(3, Math.max(1, ports.length)));
      if (!ports.length) { const empty = element('div', 'empty-state port-matrix-empty'); empty.append(icon('radio'), element('h3', '', '连接设备，同时查看各自的距离矩阵'), element('p', '', '每张卡只显示该串口收到的观测，未收到的节点对显示 —。'), button('连接设备', 'button primary', 'plus', () => openPorts())); grid.append(empty); }
      for (const port of ports) {
        const card = element('article', 'port-matrix-card'); card.dataset.port = port.path;
        const heading = element('div', 'port-matrix-heading'); const titles = element('div'); const name = element('h3', '', port.path); const identity = element('p', 'port-matrix-identity'); titles.append(name, identity);
        const pause = button('暂停显示', 'button small port-matrix-pause', 'pause', () => togglePortMatrix(port.path)); pause.setAttribute('aria-label', `${port.path} 暂停或恢复矩阵显示`); heading.append(titles, pause);
        const modeRow=element('div','port-mode-controls');const modeSelect=element('select','port-mode-select');modeSelect.id=`port-mode-${state.portMatrixElements.size}`;modeSelect.setAttribute('aria-label',`${port.path} 目标模式`);modeSelect.add(new Option('广播测距','broadcast'));modeSelect.addEventListener('change',()=>run(()=>api.setMode({path:port.path,mode:modeSelect.value})));const modeStart=button('启动 / 切换','button small primary port-mode-start','play',()=>controlPort(port.path,'start'));const modeStop=button('停止','button small port-mode-stop','stop',()=>controlPort(port.path,'stop'));const modeChoice=element('span','port-mode-choice');modeChoice.append(modeSelect);modeRow.append(modeChoice,modeStart,modeStop);
        const actualMode=element('p','port-actual-mode');const passiveInfo=element('p','port-passive-info');const modeFeedback=element('p','port-mode-feedback');modeFeedback.setAttribute('role','status');
        const timing = element('div', 'port-matrix-timing'); const updated = element('span', 'port-matrix-updated'); const age = element('span', 'port-matrix-age'); timing.append(updated, age);
        const scroll = element('div', 'port-matrix-scroll'); const table = element('table', 'distance-matrix port-distance-matrix'); table.setAttribute('aria-label', `${port.path} 独立距离矩阵`); scroll.append(table);
        const note = element('p', 'port-matrix-note', '无向节点对 · 右上三角显示距离 · 对角线 — · 3秒无有效更新显示 —');
        const footer = element('div', 'port-matrix-footer'); const status = element('span', 'port-matrix-status');
        const actions = element('div'); const node = button('节点控制', 'text-button', 'node', () => openPortNode(port.path)); const terminal = button('终端', 'text-button', 'terminal', () => openPortTerminal(port.path)); actions.append(node, terminal); footer.append(status, actions);
        card.append(heading,modeRow,actualMode,passiveInfo,modeFeedback,timing,scroll,note,footer); grid.append(card);
        state.portMatrixElements.set(port.path, { card, identity, pause,modeChoice,modeSelect,modeStart,modeStop,actualMode,passiveInfo,modeFeedback,updated, age, table, status, node, note, axesKey: '', cells: new Map() });
      }
    }
    const now = Date.now();
    for (const port of ports) {
      const ui = state.portMatrixElements.get(port.path); if (!ui) continue;
      const view = portView(port); const axes = view.paused ? view.frozen.nodes : matrixAxes(port); const axesKey = axes.map(nodeId).join('|');
      const updatedAt = view.paused ? view.frozen.updatedAt : port.matrixUpdatedAt;
      const rawEdges = view.paused ? view.frozen.edges : (Array.isArray(port.matrixEdges) ? port.matrixEdges : []);
      const elapsed = view.paused ? Math.max(0, now - view.frozen.at) : 0;
      const edges = new Map(rawEdges.map(e => {
        const ageMs = (Number.isFinite(Number(e.ageMs)) ? Number(e.ageMs) : updatedAt ? Math.max(0, (view.paused ? view.frozen.at : now) - Number(updatedAt)) : Infinity) + elapsed;
        return [pairKey(e.source,e.peer), { ...e, ageMs, valid: e.valid === true && ageMs < edgeTtlMs(e) }];
      }));
      text(ui.identity, `${kindLabel(port.kind)} · RAC ${port.nodeId || '等待识别'}`);
      text(ui.note,'无向节点对 · 右上三角显示距离 · 对角线 — · 3秒无有效更新显示 —');
      const op=port.operation,target=port.monitorCapable===true?(port.targetMode||'broadcast'):'broadcast';
      if(port.monitorCapable===true&&ui.modeSelect.options.length===1)ui.modeSelect.add(new Option('纯监听','monitor'));
      if(port.monitorCapable!==true&&ui.modeSelect.options.length>1)ui.modeSelect.remove(1);
      ui.modeChoice.hidden=port.monitorCapable!==true;ui.modeSelect.value=target;
      const startLabel=ui.modeStart.querySelector('span');if(startLabel)text(startLabel,port.monitorCapable===true?'启动 / 切换':'启动广播');
      ui.modeSelect.disabled=!port.connected||!port.nodeId||Boolean(op?.pending);ui.modeStart.disabled=!port.connected||!port.nodeId||Boolean(op?.pending)||Boolean(state.snapshot.control?.pending);ui.modeStop.disabled=!port.connected||!port.nodeId||Boolean(state.snapshot.control?.pending);
      text(ui.actualMode,`实际：${modeLabel(port.mode)}${port.mode==='monitor'?' · 只接收，不发送UWB帧':!port.monitorCapable?' · 当前固件仅支持广播':''}`);ui.actualMode.dataset.mode=port.mode||'unknown';
      const passive=port.passive,ownValid=[...edges.values()].filter(e=>finiteDistance(e)&&(String(e.source)===String(port.nodeId)||String(e.peer)===String(port.nodeId))).length;
      const passiveReasons={disabled:'已关闭',insufficient:'数据不足',window:'窗口超限',degenerate:'布局退化',ambiguous:'候选解不唯一',failed:'解算未通过',ok:'已得到结果'};
      ui.passiveInfo.hidden=port.monitorCapable!==true||port.passiveCapable!==true;
      const graph=port.passiveGraph===true;
      const passiveReason=passive?({pending:'等待图数据',budget:'计算预算不足',memory:'内存不足',...passiveReasons}[passive.reason]||'设备状态：'+passive.reason):'';
      const recent=passive?`${passive.enabled?'开启':'关闭'} / ${passive.windowMs}ms / ${passiveReason}（${timeText(passive.receivedAt)}）`:'';
      const graphCounts=passive?.schema==='graph'?`发现 ${passive.nodes}/${port.passiveMaxNodes||20} · 联合 ${passive.usedNodes}节点/${passive.usedEdges}边 · 新鲜证据 ${passive.edges}边 · 分量 ${passive.components} · 回执自身 ${passive.validNodes}条`:'等待图统计';
      text(ui.passiveInfo,port.mode!=='monitor'?`${graph?'自动图定位':'自身定位'}：${port.passiveReady===false?'资源未就绪，请查询设备状态':'进入纯监听后默认开启'}`:!passive?`${graph?'自动图定位':'自身定位'}：等待设备状态回执`:`${graph?'自动图定位':'自身定位（旧版固定四节点）'}：当前自身距离 ${ownValid} 条；${now-passive.receivedAt>3000?'状态待刷新 · ':''}${graph?graphCounts+'；':''}最近回执 ${recent}`);
      ui.passiveInfo.dataset.schema=graph?'graph':'fixed4';
      ui.passiveInfo.title='当前自身距离仅来自本串口有效矩阵；节点、边和分量统计属于带时间的最近设备回执，手动查询更新，不持续轮询。';
      const feedback=op?.pending?`正在请求${modeLabel(op.targetMode)}，等待设备回执…`:op?.ok===false?`未确认：${op.error||'设备未完成操作'}`:op?.ok===true?`设备已确认：${modeLabel(op.targetMode)}`:'';
      text(ui.modeFeedback,feedback);ui.modeFeedback.hidden=!feedback;ui.modeFeedback.classList.toggle('error',op?.ok===false);ui.modeFeedback.classList.toggle('pending',Boolean(op?.pending));
      text(ui.updated, updatedAt ? `更新 ${timeText(updatedAt)}` : '更新 —');
      const ages = [...edges.values()].map(e => e.ageMs).filter(Number.isFinite); const minAge = ages.length ? Math.min(...ages) : null; const maxAge = ages.length ? Math.max(...ages) : null;
      text(ui.age, minAge === null ? '测量年龄 —' : `测量年龄 ${Math.round(minAge)}${Math.round(maxAge) !== Math.round(minAge) ? `–${Math.round(maxAge)}` : ''} ms`);
      ui.card.classList.toggle('is-paused', view.paused); ui.card.classList.toggle('is-disconnected', !port.connected);
      const pauseLabel = view.paused ? '恢复显示' : '暂停显示'; if (ui.pause.dataset.paused !== String(view.paused)) { ui.pause.dataset.paused = String(view.paused); ui.pause.replaceChildren(icon(view.paused ? 'play' : 'pause'), element('span', '', pauseLabel)); }
      text(ui.status, view.paused ? '显示已暂停 · 采集继续' : port.connected ? '● 独立接收中' : '○ 已断开 · 距离按3秒到期'); ui.node.disabled = !port.nodeId;
      if (ui.axesKey !== axesKey || !ui.table.children.length) {
        ui.axesKey = axesKey; ui.cells.clear(); const head = element('thead'); const header = element('tr'); header.append(element('th', '', '节点 / 对端'));
        axes.forEach(n => { const cell = element('th', '', nodeId(n)); cell.scope = 'col'; header.append(cell); }); head.append(header); const body = element('tbody');
        axes.forEach(n => {
          const source = nodeId(n); const row = element('tr'); const label = element('th', '', source); label.scope = 'row'; label.classList.toggle('own-node', source === idOf(port.nodeId)); row.append(label);
          axes.forEach(peerNode => { const peer = nodeId(peerNode); const cell = element('td'); cell.dataset.source = source; cell.dataset.peer = peer; const value = element('div', 'cell-value'); const unit = element('div', 'cell-unit'); cell.append(value, unit); row.append(cell); ui.cells.set(`${source}>${peer}`, { cell, value, unit }); }); body.append(row);
        });
        if (!axes.length) { const row = element('tr'); const cell = element('td', 'port-matrix-waiting', '等待该串口识别节点并接收测量'); row.append(cell); body.append(row); }
        ui.table.replaceChildren(head, body); ui.table.style.minWidth = `${Math.max(320, axes.length * 78 + 100)}px`;
      }
      for (const [cellKey, cell] of ui.cells) {
        const [source,peer]=cellKey.split('>');const blocked=Number(peer)<Number(source),diagonal=source===peer;const edge=edges.get(pairKey(source,peer));const valid=!blocked&&!diagonal&&finiteDistance(edge);
        text(cell.value,blocked?'':valid?Number(edge.distance).toFixed(3):'—');text(cell.unit,blocked||diagonal?'':valid?`m · ${Math.round(edge.ageMs)} ms`:'m');
        cell.cell.classList.toggle('masked-cell',blocked);cell.cell.classList.toggle('diagonal-cell',diagonal);cell.cell.classList.toggle('valid',valid);cell.cell.classList.toggle('unknown',!blocked&&!diagonal&&!valid);cell.cell.classList.remove('diagonal','selected');
        cell.cell.title=blocked?'':`${port.path} 独立观测\n${source} ↔ ${peer}：${valid?Number(edge.distance).toFixed(3)+' m':'未知或已过期'}${edge?.received?'\n接收时间 '+timeText(edge.received):''}`;

      }
    }
  }
  async function controlPort(path,action){await run(async()=>{requireApi();checkResult(await api.nodeControl({path,action}));});}
  function selectNode(id) {
    state.selected = id; state.detailKey = ''; state.historyOptionsKey = ''; state.dirty = true; state.chartDirty = true;
    if (id !== null) { const n = currentNode(); if (n?.port) state.activePort = n.port; }
  }
  function renderDetail() {
    const n = currentNode(); const host = $('node-detail');
    if (!n) {
      if (state.detailKey !== 'empty') { const empty = element('div', 'empty-state detail-empty'); empty.append(icon('node'), element('p', '', '选择节点，查看观测与控制。')); host.replaceChildren(empty); state.detailKey = 'empty'; }
      return;
    }
    const id = nodeId(n); const port = state.snapshot.ports.find(p => p.path === n.port);
    const edges=state.snapshot.edges.filter(e=>e.observer===n.port);
    const detailKey = `${id}|${n.port}|${edges.map(e => pairKey(e.source,e.peer)).join('|')}`;
    if (state.detailKey !== detailKey) {
      state.detailKey = detailKey; state.detailElements.clear(); host.replaceChildren();
      const identity = element('div', 'node-identity'); const chip = element('div', 'device-chip'); const titles = element('div');
      titles.append(element('h3', '', id), element('p', '', `${kindLabel(port?.kind)} · ${n.port || '无线节点'}`));
      const status = element('span', 'node-active-label'); status.id = 'detail-active'; titles.append(status); identity.append(chip, titles); host.append(identity);
      const observations = element('div', 'observation-list');
      if (!edges.length) observations.append(element('p', 'muted', '等待该节点上报到其他节点的距离。'));
      for (const edge of edges) {
        const card = element('div', 'observation'); const title = element('div', 'observation-heading');
        title.append(icon('arrow'),element('span','observation-peer',`${edge.source} ↔ ${edge.peer}`));const badge=element('span');badge.hidden=true;
        const value = element('div', 'observation-value'); const number = element('span'); value.append(number, element('small', '', 'm'));
        const age = element('div', 'observation-age'); card.append(title, value, age); observations.append(card);
        state.detailElements.set(pairKey(edge.source,edge.peer), { number, badge, age });
      }
      host.append(observations); const note = element('p', 'detail-note'); note.append(icon('info'), document.createTextNode('该设备独立重建的节点对距离')); host.append(note);
      const controls = element('div', 'node-controls'); const actions = element('div', 'node-buttons');
      actions.append(button('开始', 'button small primary', 'play', () => sendNode('start')), button('停止', 'button small', 'stop', () => sendNode('stop')), button('状态', 'button small', null, () => sendNode('status'))); controls.append(actions);
      const configuration = element('details', 'node-configuration'); const summary = element('summary', '', '节点配置'); configuration.append(summary);
      const form = element('div', 'node-form'); const label = element('label', '', '广播周期（ms）');
      const period = element('input'); period.id = 'node-period'; period.type = 'number'; period.min = '50'; period.max = '500'; period.step = '10'; period.value = String(n.periodMs ?? port?.periodMs ?? ''); period.placeholder = '未知'; label.append(period);
      const apply = button('应用', 'button', null, () => applyNodePeriod()); apply.id = 'apply-node-period'; form.append(label, apply); configuration.append(form);
      const streamLabel = element('label', 'node-stream'); const stream = element('input'); stream.type = 'checkbox'; stream.id = 'node-stream'; stream.checked = Boolean(n.stream ?? port?.stream); stream.addEventListener('change', () => sendNode(`stream ${stream.checked ? 'on' : 'off'}`)); const streamText = element('span', '', '实时输出测量结果'); streamText.id = 'node-stream-label'; streamLabel.append(stream, streamText); configuration.append(streamLabel);
      const neighbors = button('查询邻居', 'text-button', null, () => sendNode('neighbors')); neighbors.style.marginTop = '6px'; configuration.append(neighbors);
      const meta = element('div', 'node-meta'); meta.id = 'node-meta'; configuration.append(meta); controls.append(configuration); host.append(controls);
    }
    const status = $('detail-active'); text(status,`实际：${modeLabel(port?.mode||n.mode)}`); status.classList.toggle('inactive', !n.active);
    for (const edge of edges) {
      const ui = state.detailElements.get(pairKey(edge.source,edge.peer)); if (!ui) continue;
      text(ui.number,measurement(edge));
      text(ui.age, `${finiteDistance(edge) ? '测量更新' : '观测过期'} ${ageLabel(Number(edge.ageMs))}`);
    }
    text($('apply-node-period'), n.active ? '停止并应用' : '应用');
    const canControl = Boolean(port?.connected);
    host.querySelectorAll('button,input').forEach(e => { e.disabled = !canControl; });
    if ($('node-stream') !== document.activeElement) { const stream = n.stream ?? port?.stream; $('node-stream').checked = Boolean(stream); $('node-stream').indeterminate = stream === undefined || stream === null; text($('node-stream-label'), stream === undefined || stream === null ? '实时输出（状态未知）' : '实时输出测量结果'); }
    const stats = n.stats || {}; const metaValues=[`周期 ${n.periodMs??port?.periodMs??'—'} ms`,`回传 ${port?.telemetry==='binary'?'紧凑二进制':port?.telemetry==='text'?'文本':'识别中'}`];
    const meta = $('node-meta'); if (meta.dataset.key !== metaValues.join('|')) { meta.dataset.key = metaValues.join('|'); meta.replaceChildren(...metaValues.map(v => element('span', '', v))); }
  }
  function randomSession() { const data = new Uint32Array(1); crypto.getRandomValues(data); return data[0] || 1; }
  async function sendNode(subcommand) {
    await run(async () => {
      const n = currentNode(); if (!n?.port) throw new Error('该节点没有可用的本机串口，请选择已连接节点或使用全网控制。');
      if(['start','stop'].includes(subcommand))checkResult(await api.nodeControl({path:n.port,action:subcommand}));else await sendCommands([n.port],`swarm ${subcommand}`,'crlf');
    });
  }
  async function applyNodePeriod() {
    const input = $('node-period'); const value = Number(input?.value);
    if (!Number.isInteger(value) || value < 50 || value > 500) { toast('广播周期应为 50–500 ms 的整数。', true); input?.focus(); return; }
    await run(async () => {
      const n = currentNode(); if (!n?.port) throw new Error('请先连接该节点的串口。');
      if (n.active) await sendCommands([n.port], 'swarm stop', 'crlf');
      await sendCommands([n.port], `swarm period ${value}`, 'crlf');
      toast('已发送周期配置；运行中的节点已先发送停止指令。');
    }, $('apply-node-period'));
  }

  function renderControl() {
    text($('control-mode-hint'),$('control-scope').value==='connected'?'USB逐口执行各自的目标模式；停止逐口确认。':'空中全网仅控制广播测距；纯监听请用USB启动和停止。');
    const c = state.snapshot.control || {}; const key = JSON.stringify(c); if (key === state.controlKey) return; state.controlKey = key;
    $('network-start').disabled = Boolean(c.pending); $('network-stop').disabled = Boolean(c.pending);
    const feedback = $('control-feedback'); const results = Array.isArray(c.results) ? c.results : [];
    if (!c.action && c.error) { feedback.hidden = false; feedback.classList.add('error'); text(feedback, `控制通道异常：${c.error}`); return; }
    if (!c.action && !c.pending && !results.length && !c.error) { feedback.hidden = true; return; }
    const target = c.action === 'start'; const confirmed = results.filter(r => r.active === target && ['ok', 'ack', 'confirmed'].includes(r.result)).length;
    const total = (Array.isArray(c.expected) ? c.expected.length : Number(c.expected)) || Number(c.total) || Math.max(results.length, state.snapshot.nodes.length);
    const unknown = Math.max(0, total - confirmed);
    const messages = [`${c.action === 'start' ? '启动' : '停止'}${c.pending ? '指令已发送，等待设备确认' : '确认结果'}：已确认 ${confirmed}${total ? ` / ${total}` : ''}${unknown ? `，未确认 ${unknown}` : ''}${c.requestId ? ` · 请求 ${c.requestId}` : ''}`];
    if (!c.pending && unknown) messages.push('未确认节点的状态仍未知；请检查设备和网关，不以指令发出代表执行成功。');
    if (c.error) messages.push(String(c.error));
    if (c.timedOut) messages.push('等待设备确认已超时。');
    if ((c.scope || $('control-scope').value) === 'radio') messages.push('空中控制仅启动广播模式；纯监听节点不响应，请使用USB已连接节点控制。');
    if(c.scope==='radio'&&c.excludedMonitors?.length)messages.push(`纯监听不计入空中ACK预期：${c.excludedMonitors.join('、')}`);
    if(c.scope==='connected'&&c.action==='start')messages.push('按各串口选择的目标模式分别启动，以设备回执确认实际状态。');
    if (results.length) messages.push(results.map(r => `${r.node??r.path??'节点'}：${r.result==='ok'?modeLabel(r.mode||(r.active?'broadcast':'stopped')):r.error||r.result||'待确认'}`).join('  '));
    feedback.hidden = false; feedback.classList.toggle('error', !c.pending && unknown > 0); text(feedback, messages.join('\n'));
  }
  async function networkControl(action) {
    await run(async () => {
      requireApi(); if (!connectedPorts().length) throw new Error('请先连接至少一个设备串口。');
      const scope = $('control-scope').value; const gateway = $('gateway').value || null;
      checkResult(await api.control({ action, gateway, scope }));
    }, action === 'start' ? $('network-start') : $('network-stop'));
  }

  function relevantEdges(){const path=$('history-port').value||state.activePort;return state.snapshot.edges.filter(e=>e.observer===path);}
  function renderHistoryOptions(){
    const ports=$('history-port'),oldPort=ports.value;const pk=state.snapshot.ports.map(p=>p.path+':'+p.nodeId).join('|');
    if(ports.dataset.key!==pk){ports.dataset.key=pk;ports.replaceChildren(...state.snapshot.ports.map(p=>new Option(`${p.path} · ${p.nodeId||'等待识别'}`,p.path)));if([...ports.options].some(o=>o.value===oldPort))ports.value=oldPort;else if(state.activePort)ports.value=state.activePort;}
    text($('history-source'),ports.value?`${ports.value} 独立观测`:'等待串口');
    const edges=relevantEdges(),key=ports.value+'|'+edges.map(e=>pairKey(e.source,e.peer)).join('|');if(state.historyOptionsKey===key)return;state.historyOptionsKey=key;
    const select=$('history-peer'),old=select.value;select.replaceChildren(new Option('全部节点对',''));for(const e of edges)select.add(new Option(`${e.source} ↔ ${e.peer}`,pairKey(e.source,e.peer)));if([...select.options].some(o=>o.value===old))select.value=old;
  }
  function renderChart() {
    const canvas = $('history-chart'); const ctx = canvas.getContext('2d'); if (!ctx) return;
    const rect = canvas.getBoundingClientRect(); const ratio = Math.min(devicePixelRatio || 1, 2); const w = Math.max(200, rect.width), h = rect.height || 150;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(document.documentElement); const muted = style.getPropertyValue('--muted').trim(); const line = style.getPropertyValue('--line').trim();
    const now = Date.now(); const range = Number($('history-window').value); const start = now - range;
    const filter = $('history-peer').value; const edges = relevantEdges().filter(e => !filter || pairKey(e.source,e.peer) === filter);
    const series = edges.map((e, i) => ({ edge: e, color: COLORS[i % COLORS.length], points: (Array.isArray(e.history) ? e.history : []).slice(-1800).filter(p => Number(p.t) >= start && Number(p.t) <= now) }));
    let max = 0, min = Infinity, pointCount = 0;
    for (const s of series) for (const p of s.points) if (Number.isFinite(p.v) && p.v >= 0) { min = Math.min(min, p.v); max = Math.max(max, p.v); pointCount++; }
    const floor = Number.isFinite(min) ? Math.max(0, min - Math.max(.05, (max - min) * .25)) : 0;
    const ceil = Math.max(floor + .2, max + Math.max(.05, (max - min) * .25));
    const left = 38, right = w - 10, top = 8, bottom = h - 24, width = right - left, height = bottom - top;
    ctx.font = '10px "Segoe UI", sans-serif'; ctx.lineWidth = 1; ctx.strokeStyle = line; ctx.fillStyle = muted;
    for (let i = 0; i < 3; i++) { const y = top + i * height / 2; ctx.beginPath(); ctx.moveTo(left, y + .5); ctx.lineTo(right, y + .5); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText((ceil - i * (ceil - floor) / 2).toFixed(ceil >= 10 ? 1 : 2), left - 8, y + 3); }
    ctx.textAlign = 'center';
    for (let i = 0; i < 5; i++) { ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; ctx.fillText(new Date(start + i * range / 4).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', ...(range <= 60000 ? { second: '2-digit' } : {}) }), left + i * width / 4, h - 6); }
    for (const s of series) {
      const stride = Math.max(1, Math.ceil(s.points.length / 600)); const period = state.snapshot.nodes.find(n => nodeId(n) === idOf(s.edge.source))?.periodMs || 200;
      const maxGap = edgeTtlMs(s.edge); let previous = null, lastRawTime = null, broken = true; ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = 1.7;
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        if (!Number.isFinite(p.v) || p.v < 0) { previous = null; lastRawTime = null; broken = true; continue; }
        if (lastRawTime !== null && Number(p.t) - lastRawTime > maxGap) broken = true;
        lastRawTime = Number(p.t);
        if (i % stride !== 0 && i !== s.points.length - 1) continue;
        const x = left + (Number(p.t) - start) / range * width; const y = bottom - (p.v - floor) / (ceil - floor) * height;
        if (previous && !broken) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        previous = p; broken = false;
      } ctx.stroke();
    }
    $('chart-empty').hidden = pointCount > 0;
    const legendKey = series.map(s => `${s.edge.source}>${s.edge.peer}:${measurement(s.edge)}`).join('|');
    if ($('chart-legend').dataset.key !== legendKey) {
      $('chart-legend').dataset.key = legendKey;
      $('chart-legend').replaceChildren(...series.map(s => { const item = element('span', 'legend-item'); const dot = element('i', 'legend-dot'); dot.style.background = s.color; item.append(dot, document.createTextNode(`${s.edge.source} ↔ ${s.edge.peer}  ${measurement(s.edge)} m`)); return item; }));
    }
  }

  function visibleTerminalLines() {
    const p = currentPort(); if (!p) return [];
    const local = terminalState(p.path); const source = local.paused ? local.frozen : (p.lines || []).slice(-500);
    const filter = $('terminal-filter').value.trim().toLowerCase(); const direction = $('terminal-direction').value;
    return source.filter(line => !local.cleared.has(String(line.id)) && (direction === 'all' || line.direction === direction) && (!filter || String(line.text || '').toLowerCase().includes(filter))).slice(-500);
  }
  function renderTerminal() {
    const ports = state.snapshot.ports; const tabsKey = `${ports.map(p => `${p.path}:${p.connected}`).join('|')}@${state.activePort}`;
    if (state.terminalTabsKey !== tabsKey) {
      state.terminalTabsKey = tabsKey;
      $('terminal-tabs').replaceChildren(...ports.map(p => { const b = button(p.path, `terminal-tab${p.path === state.activePort ? ' active' : ''}`, null, () => { state.activePort = p.path; state.terminalKey = ''; state.dirty = true; }); b.title = p.connected ? '已连接' : '已断开，保留记录'; return b; }));
    }
    const p = currentPort(); const local = p ? terminalState(p.path) : null;
    const lines = visibleTerminalLines(); const key = `${state.activePort}|${local?.paused}|${$('terminal-filter').value}|${$('terminal-direction').value}|${lines.map(l => l.id).join(',')}`;
    const host = $('terminal-lines');
    if (state.terminalKey !== key) {
      state.terminalKey = key; const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
      if (!lines.length) host.replaceChildren(element('div', 'terminal-empty', p ? $('terminal-filter').value ? '没有符合过滤条件的记录。' : local.paused ? '显示已暂停，后台采集仍在继续。' : '等待设备输出。' : '连接串口后，在这里查看设备的原始输出。'));
      else {
        if (host.dataset.port !== String(state.activePort) || host.querySelector('.terminal-empty')) { host.replaceChildren(); host.dataset.port = String(state.activePort); }
        const wanted = new Set(lines.map(l => String(l.id))); const existing = new Map();
        for (const row of [...host.children]) { if (!wanted.has(row.dataset.lineId)) row.remove(); else existing.set(row.dataset.lineId, row); }
        let cursor = host.firstElementChild;
        for (const line of lines) {
          let row = existing.get(String(line.id));
          if (!row) { row = element('div', `terminal-line ${['rx', 'tx', 'system'].includes(line.direction) ? line.direction : 'system'}`); row.dataset.lineId = String(line.id); row.append(element('span', 'line-time', timeText(line.time)), element('span', 'line-direction', line.direction === 'tx' ? 'TX' : line.direction === 'rx' ? 'RX' : '·'), element('span', 'line-text', line.text || '')); }
          if (row === cursor) cursor = cursor.nextElementSibling; else host.insertBefore(row, cursor);
        }
        if (atBottom && !local?.paused) host.scrollTop = host.scrollHeight;
      }
    }
    text($('terminal-count'), `${lines.length} 条可见记录`);
    const pause = $('pause-terminal'); pause.replaceChildren(icon(local?.paused ? 'play' : 'pause'), element('span', '', local?.paused ? '继续显示' : '暂停显示')); pause.disabled = !p;
    text($('terminal-pause-status'), local?.paused ? '已暂停显示 · 后台采集继续' : '显示最新 500 条 · 原始采集独立运行');
    text($('terminal-port-status'), p ? `${p.path} · ${p.baudRate || 115200} · ${p.encoding || 'auto'}${p.connected ? '' : ' · 已断开'}` : '尚未选择串口');
    $('command-input').disabled = connectedPorts().length === 0; $('command-form').querySelector('button').disabled = connectedPorts().length === 0;
    renderQuickCommands();
  }
  /** 自动图固件的配置始终只发当前USB口；兼容前缀不绕过能力检查。 */
  const commandPolicy=window.UwbCommandPolicy;
  const passiveCommand=commandPolicy.isPassive;
  const obsoleteGraphCommand=commandPolicy.obsolete;
  function renderQuickCommands() {
    const passiveQuick=[{label:'自身定位状态',command:'swarm monitor status'},{label:'开启自身定位',command:'swarm monitor locate on'},{label:'关闭自身定位',command:'swarm monitor locate off'},{label:'定位窗口1000ms',command:'swarm monitor window 1000'},{label:'高度差…',command:'swarm monitor height <米>'},{label:'时间戳证据',command:'swarm monitor evidence'}];
    const saved=state.settings.quickCommands||[];
    const quick=currentPort()?.passiveCapable===true?[...saved,...passiveQuick.filter(q=>!saved.some(s=>s.command===q.command))]:saved;
    const key = `${state.activePort}|${currentPort()?.monitorCapable}|${currentPort()?.passiveCapable}|${currentPort()?.passiveGraph}|${JSON.stringify(quick)}`; if (state.quickKey === key) return; state.quickKey = key;
    const children = quick.map(q => {
      const b = button(q.label || q.command, 'quick-command', null, () => {
        const parameter = /<[^>]+>/.exec(q.command);
        if (parameter) {
          const input = $('command-input'); input.value = q.command; input.focus();
          input.setSelectionRange(parameter.index, parameter.index + parameter[0].length);
          toast('请填写选中的参数，再发送指令。');
        } else run(() => sendCurrent(q.command));
      });
      b.title=q.command;const unsupported=commandPolicy.reason(q.command,currentPort());if(unsupported){b.disabled=true;b.title=unsupported+'（保存的快捷指令仍保留）';}return b;
    });
    children.push(button('编辑快捷指令', 'quick-command quick-edit', 'settings', () => openSettings())); $('quick-commands').replaceChildren(...children);
  }
  async function sendCommands(paths, command, lineEnding) {
    requireApi(); if (!paths.length) throw new Error('请先选择已连接的设备串口。');
    if (/<[^>]+>/.test(command)) throw new Error('请先填写指令中的参数。');
    if (new TextEncoder().encode(command).length > 256 || /[\r\n\0]/.test(command)) throw new Error('单条指令不能超过 256 字节，也不能包含换行或空字符。');
    const response = checkResult(await api.send({ paths, command, lineEnding }));
    const results = Array.isArray(response) ? response : response?.results;
    const failures = Array.isArray(results) ? results.filter(r => r.ok === false || r.success === false || r.error) : [];
    if (failures.length) throw new Error(failures.map(r => `${r.path || '串口'}：${r.error || r.message || '发送失败'}`).join('\n'));
    return response;
  }
  async function sendCurrent(command) {
    const value = String(command || ''); if (!value.trim()) return;
    const passiveOnly=passiveCommand(value);
    if(currentPort()?.passiveGraph===true&&obsoleteGraphCommand(value))throw Error('自动图定位不使用固定节点组或手动布局，请直接启动纯监听');
    const ports = passiveOnly ? (currentPort()?.connected ? [state.activePort] : []) : $('send-all').checked ? connectedPorts().map(p => p.path) : currentPort()?.connected ? [state.activePort] : [];
    for(const path of ports){const unsupported=commandPolicy.reason(value,state.snapshot.ports.find(p=>p.path===path));if(unsupported)throw Error(`${path}：${unsupported}`);}
    await sendCommands(ports, value, $('line-ending').value);
    for (const historyKey of ports) {
      const history = state.commandHistory.get(historyKey) || [];
      if (history[history.length - 1] !== value) history.push(value);
      state.commandHistory.set(historyKey, history.slice(-50)); terminalState(historyKey).historyIndex = -1;
    }
  }

  async function scanPorts(open = false) {
    requireApi(); const data = await api.listPorts(); state.discovered = Array.isArray(data) ? data : data?.ports || [];
    state.selectedPorts = new Set(state.discovered.filter(p => p.suggested && p.kind !== 'probe' && !state.snapshot.ports.some(s => s.path === p.path && s.connected)).map(p => p.path));
    renderAvailablePorts(); if (open && !$('ports-dialog').open) $('ports-dialog').showModal(); return state.discovered;
  }
  function renderAvailablePorts() {
    const host = $('available-ports'); host.replaceChildren();
    if (!state.discovered.length) host.append(element('div', 'empty-state', '未发现串口。连接设备后重新扫描。'));
    for (const p of state.discovered) {
      const connected = state.snapshot.ports.some(s => s.path === p.path && s.connected);
      const label = element('label', 'available-port'); const check = element('input'); check.type = 'checkbox'; check.checked = state.selectedPorts.has(p.path); check.disabled = connected;
      check.addEventListener('change', () => { if (check.checked) state.selectedPorts.add(p.path); else state.selectedPorts.delete(p.path); });
      const body = element('div', 'available-port-body'); body.append(element('strong', '', p.path), element('p', '', [p.manufacturer, p.serialNumber].filter(Boolean).join(' · ') || '未提供设备描述'));
      const badge = element('span', `port-kind-badge${p.kind === 'probe' ? ' probe' : ''}`, connected ? '已连接' : kindLabel(p.kind)); label.append(check, body, badge); host.append(label);
    }
    text($('scan-summary'), `发现 ${state.discovered.length} 个串口`);
  }
  async function openPorts() {
    $('dialog-baud').value = $('default-baud').value;
    if (!$('ports-dialog').open) $('ports-dialog').showModal();
    await run(() => scanPorts(false));
  }
  async function connectSelected(paths, baudRate, encoding) {
    requireApi(); const errors = []; let success = 0;
    for (const path of paths) {
      if (state.snapshot.ports.some(p => p.path === path && p.connected)) continue;
      state.busyPorts.add(path);
      try { checkResult(await api.connect({ path, baudRate, encoding })); success++; state.activePort = path; }
      catch (error) { errors.push(`${path}：${errorText(error)}`); }
      finally { state.busyPorts.delete(path); }
    }
    if (errors.length) toast(`${success} 个串口已连接\n${errors.join('\n')}`, true);
    else if (success) { toast(`已连接 ${success} 个串口，等待设备识别。`); $('ports-dialog').close(); }
    state.dirty = true;
  }
  function openSettings() {
    state.modalTheme = state.settings.theme || 'system'; applyTheme(state.modalTheme); $('quick-command-editor').replaceChildren();
    for (const q of state.settings.quickCommands || []) addQuickRow(q);
    text($('settings-feedback'), ''); if (!$('settings-dialog').open) $('settings-dialog').showModal();
  }
  function addQuickRow(q = { label: '', command: '' }) {
    const row = element('div', 'quick-editor-row'); const label = element('input'); label.placeholder = '按钮名称'; label.value = q.label || ''; label.maxLength = 30; label.setAttribute('aria-label', '快捷指令名称');
    const command = element('input'); command.placeholder = '完整指令（最多256字节）'; command.value = q.command || ''; command.maxLength = 256; command.setAttribute('aria-label', '快捷指令内容');
    const remove = button('', 'button icon-button', 'trash', () => row.remove()); remove.title = '删除快捷指令'; remove.setAttribute('aria-label', '删除快捷指令'); row.append(label, command, remove); $('quick-command-editor').append(row);
  }
  async function saveSettings() {
    await run(async () => {
      const quickCommands = [...$('quick-command-editor').children].map(row => ({ label: row.children[0].value.trim(), command: row.children[1].value })).filter(q => q.command.trim());
      if (quickCommands.length > 30) throw new Error('最多保存 30 个快捷指令。');
      if (quickCommands.some(q => new TextEncoder().encode(q.command).length > 256 || /[\r\n\0]/.test(q.command))) throw new Error('每条快捷指令不能超过 256 字节，也不能包含换行或空字符。');
      for (const q of quickCommands) if (!q.label) q.label = q.command.slice(0, 22);
      const patch = { theme: state.modalTheme || state.settings.theme, quickCommands };
      if (api) checkResult(await api.setSettings(patch)); state.settings = { ...state.settings, ...patch }; applyTheme(state.settings.theme); state.quickKey = ''; state.dirty = true;
      $('settings-dialog').close(); toast('设置已保存。');
    }, $('save-settings'));
  }
  async function exportData(type, port) {
    await run(async () => {
      requireApi();
      const selected = port || state.activePort || connectedPorts()[0]?.path;
      if (type !== 'csv' && !selected) throw new Error('请先选择有记录的串口。');
      const result = checkResult(await api.export({type, ...(type !== 'csv' ? {path:selected} : {})}));
      if (result?.filePath) toast(`已导出到 ${result.filePath}`);
    });
  }

  function render() {
    ensurePortSelection(); renderPorts(); renderPortMatrices(); renderNodes(); renderControl(); renderHistoryOptions(); renderTerminal(); window.UwbDropdowns?.refreshAll();
    const directory = state.snapshot.recording?.directory;
    const recording = state.snapshot.recording || {}; const recordLabel = [directory || '原始记录由桌面应用保存', recording.error ? `记录异常：${recording.error}` : '', recording.csvDropped ? `CSV 丢弃 ${recording.csvDropped} 条` : ''].filter(Boolean).join(' · ');
    text($('recording-directory'), recordLabel); $('recording-directory').title = recordLabel;
    text($('settings-recording-directory'), directory || '连接后由桌面应用持续保存。');
  }
  /** 串口只在主进程采集；此处合并10Hz增量并严格保留每口最新500条。 */
  function acceptSnapshot(snapshot) {
    const ports = Array.isArray(snapshot.ports) ? snapshot.ports : [];
    const livePaths = new Set(ports.map(p => p.path));
    for (const path of state.lineCache.keys()) if (!livePaths.has(path)) state.lineCache.delete(path);
    for (const cache of [state.terminal, state.commandHistory, state.portMatrixViews]) {
      for (const path of cache.keys()) if (!livePaths.has(path)) cache.delete(path);
    }
    for (const path of state.selectedPorts) if (!livePaths.has(path)) state.selectedPorts.delete(path);
    const mergedPorts = ports.map(p => {
      const incoming = Array.isArray(p.lines) ? p.lines : [];
      let lines;
      if (snapshot.terminalDelta) {
        const old = state.lineCache.get(p.path) || []; const ids = new Set(old.map(l => String(l.id)));
        lines = old.concat(incoming.filter(l => !ids.has(String(l.id)))).slice(-500);
      } else lines = incoming.slice(-500);
      state.lineCache.set(p.path, lines); return { ...p, lines };
    });
    const edgeKeys=new Set();const mergedEdges=(snapshot.edges||[]).map(edge=>{
      const key=`${edge.observer}/${pairKey(edge.source,edge.peer)}`;edgeKeys.add(key);
      const old=state.historyCache.get(key)||[];const seen=new Set(old.map(point=>point.id));
      const history=(snapshot.historyDelta?old.concat((edge.history||[]).filter(point=>!seen.has(point.id))):(edge.history||[])).slice(-600);
      state.historyCache.set(key,history);return {...edge,history};
    });
    for(const key of state.historyCache.keys())if(!edgeKeys.has(key))state.historyCache.delete(key);
    nextSnapshot = { ...snapshot, edges:mergedEdges, ports: mergedPorts };
  }
  function frameLoop(t) {
    if (t - state.lastRender >= 100) {
      if (nextSnapshot) { state.snapshot = { ports: [], nodes: [], edges: [], control: {}, recording: {}, ...nextSnapshot }; nextSnapshot = null; state.chartDirty = true; }
      state.lastRender = t; state.dirty = false; render();
      if(Date.now()-Number(state.snapshot.now||0)>=100)state.chartDirty=true;
      if (state.chartDirty) { renderChart(); state.chartDirty = false; }
    }
    requestAnimationFrame(frameLoop);
  }

  $('scan-ports').addEventListener('click', () => openPorts()); $('empty-connect').addEventListener('click', () => openPorts());
  $('port-matrix-connect').addEventListener('click', () => openPorts());
  $('add-port').addEventListener('click', () => openPorts());
  $('dialog-scan').addEventListener('click', e => run(() => scanPorts(false), e.currentTarget));
  $('connect-selected').addEventListener('click', e => run(() => {
    if (!state.selectedPorts.size) throw new Error('请选择至少一个未连接串口。');
    return connectSelected([...state.selectedPorts], Number($('dialog-baud').value), $('dialog-encoding').value);
  }, e.currentTarget));
  $('connect-suggested').addEventListener('click', e => run(async () => {
    await scanPorts(false); const paths = [...state.selectedPorts];
    if (!paths.length) { $('ports-dialog').showModal(); toast('没有可自动连接的设备，请手动选择串口。'); return; }
    await connectSelected(paths, Number($('default-baud').value), 'auto');
  }, e.currentTarget));
  $('network-start').addEventListener('click', () => networkControl('start')); $('network-stop').addEventListener('click', () => networkControl('stop'));
  $('control-scope').addEventListener('change', e => run(async () => { state.settings.scope = e.target.value; if (api) await api.setSettings({ scope: e.target.value }); }));
  $('gateway').addEventListener('change', e => run(async () => { state.settings.gateway = e.target.value || null; if (api) await api.setSettings({ gateway: state.settings.gateway }); }));
  $('history-port').addEventListener('change',()=>{state.historyOptionsKey='';state.chartDirty=true;state.dirty=true;});
  $('history-window').addEventListener('change', () => { state.chartDirty = true; state.dirty = true; }); $('history-peer').addEventListener('change', () => { state.chartDirty = true; state.dirty = true; });
  $('terminal-filter').addEventListener('input', () => { state.dirty = true; }); $('terminal-direction').addEventListener('change', () => { state.dirty = true; });
  $('pause-terminal').addEventListener('click', () => { const p = currentPort(); if (!p) return; const local = terminalState(p.path); local.paused = !local.paused; if (local.paused) local.frozen = (p.lines || []).slice(-500); else local.frozen = []; state.dirty = true; });
  $('clear-terminal').addEventListener('click', () => { const p = currentPort(); if (!p) return; const local = terminalState(p.path); local.cleared = new Set([...(p.lines || []), ...local.frozen].slice(-1000).map(l => String(l.id))); state.terminalKey = ''; state.dirty = true; });
  $('copy-terminal').addEventListener('click', e => run(async () => { const lines = visibleTerminalLines().map(l => `${timeText(l.time)} ${String(l.direction || '').toUpperCase()} ${l.text || ''}`); await copyText(lines.join('\n')); toast(`已复制 ${lines.length} 条记录。`); }, e.currentTarget));
  $('command-form').addEventListener('submit', e => { e.preventDefault(); const value = $('command-input').value; run(async () => { await sendCurrent(value); $('command-input').value = ''; }); });
  $('command-input').addEventListener('keydown', e => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !state.activePort) return;
    const history = state.commandHistory.get(state.activePort) || []; if (!history.length) return;
    const local = terminalState(state.activePort); e.preventDefault();
    if (local.historyIndex === -1) local.draft = e.target.value;
    if (e.key === 'ArrowUp') local.historyIndex = local.historyIndex < 0 ? history.length - 1 : Math.max(0, local.historyIndex - 1);
    else local.historyIndex = local.historyIndex < 0 || local.historyIndex === history.length - 1 ? -1 : local.historyIndex + 1;
    e.target.value = local.historyIndex < 0 ? local.draft : history[local.historyIndex];
  });
  $('open-settings').addEventListener('click', openSettings); $('add-quick-command').addEventListener('click', () => addQuickRow()); $('save-settings').addEventListener('click', saveSettings);
  document.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.addEventListener('click', () => { state.modalTheme = b.dataset.themeChoice; applyTheme(state.modalTheme); }));
  $('settings-dialog').addEventListener('close', () => applyTheme(state.settings.theme || 'system'));
  $('theme-toggle').addEventListener('click', () => run(() => saveTheme(({ system: 'light', light: 'dark', dark: 'system' })[state.settings.theme || 'system'])));
  $('theme-select').addEventListener('change', event => run(() => saveTheme(event.target.value)));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme('system'); });
  $('export-csv').addEventListener('click', () => exportData('csv')); $('export-raw').addEventListener('click', () => exportData('raw')); $('export-terminal').addEventListener('click', () => exportData('terminal', state.activePort));
  document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-nav]').forEach(n => { n.classList.toggle('active', n === b); if (n === b) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); });
    if (b.dataset.nav === 'nodes') { $('aggregate-view').open = true; if (state.selected === null && state.snapshot.nodes.length) selectNode(nodeId(state.snapshot.nodes[0])); $('aggregate-view').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
    else if (b.dataset.nav === 'terminal') $('terminal-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }));
  window.addEventListener('resize', () => { state.chartDirty = true; state.dirty = true; });
  if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(() => { state.chartDirty = true; state.dirty = true; }); resizeObserver.observe($('history-chart')); }
  if (api) {
    api.onSnapshot(snapshot => { if (snapshot && typeof snapshot === 'object') acceptSnapshot(snapshot); });
    run(async () => { const settings = await api.getSettings(); state.settings = { ...state.settings, ...settings }; applyTheme(state.settings.theme || 'system'); $('control-scope').value = state.settings.scope || 'radio'; state.quickKey = ''; state.dirty = true; });
  } else { $('preview-banner').hidden = false; applyTheme('system'); }
  requestAnimationFrame(frameLoop);
})();
