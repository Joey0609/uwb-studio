"use strict";
(() => {
  const $=id=>document.getElementById(id),api=window.uwb,positionCells=window.UwbPositionCells,distanceMatrix=window.UwbDistanceMatrix;
  const make=(tag,cls,txt)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;};
  const main=$('main-content'),overview=$('overview-section'),aggregate=$('aggregate-view'),history=document.querySelector('.history-panel'),terminal=$('terminal-section');
  const pageContainer=make('div','workspace-pages');main.insertBefore(pageContainer,document.querySelector('.app-footer'));
  const pages={};for(const key of ['overview','nodes','terminal','localization','file-replay','replay']){const e=make('div','workspace-page');e.dataset.page=key;e.hidden=key!=='overview';pages[key]=e;pageContainer.append(e);}
  pages.overview.append(overview,history);aggregate.remove();const nodes=make('section','panel summary-panel');
  const heading=make('div','workspace-toolbar');heading.append(make('div','', '汇总查看'));
  nodes.append(heading);while(aggregate.children.length>1)nodes.append(aggregate.children[1]);nodes.id='aggregate-view';pages.nodes.append(nodes);pages.terminal.append(terminal);
  window.UwbReplayView.mount(pages.replay);
  window.UwbFileReplayView?.mount(pages['file-replay'],()=>selectPage('localization'));
  const host=pages.localization;
  host.innerHTML=`<section class="panel localization-header"><div class="workspace-toolbar"><div><h2>协同定位</h2><span class="section-note" id="location-clock-status" role="status" hidden>跳过时钟检查</span></div><div class="phase-track" id="location-phases"><div data-phase="0"><span>等待开始</span></div><div data-phase="1"><b>01</b><span>静止采集</span></div><div data-phase="2"><b>02</b><span>初始位置</span></div><div data-phase="3"><b>03</b><span>位置修正</span></div></div><div class="section-actions"><select id="location-source" aria-label="定位数据来源"><option value="">选择一个观察串口</option></select><button class="button" id="location-reset" disabled>重置</button><button class="button primary" id="location-start" disabled>开始</button><button class="button primary" id="location-advance">进入移动初始化</button></div></div><p class="location-status" id="location-status" role="alert" hidden></p></section>
  <div class="location-workspace"><section class="panel location-plot-panel"><div class="section-heading"><div class="heading-inline"><h2>坐标与轨迹</h2><span class="section-note">m · 相对坐标系</span></div><div class="section-actions"><label class="compact-label"><input type="checkbox" id="show-edges" checked>测距连线</label><label class="compact-label"><input type="checkbox" id="show-trail" checked>UKF轨迹</label><label class="compact-label"><input type="checkbox" id="show-raw" checked>原始INS轨迹</label><button class="button small" id="location-fit">适应画面</button></div></div><div class="location-chart-wrap"><canvas id="location-chart" aria-label="节点相对位置及原始和修正轨迹" role="img"></canvas><div class="location-chart-empty" id="location-empty">等待完整距离拓扑</div></div><div class="location-legend" id="location-legend"></div><div class="location-local-wrap" id="location-local-wrap" hidden><h3>原始局部位移</h3><canvas id="location-local-chart" aria-label="各节点未经旋转的原始局部位移轨迹" role="img"></canvas></div></section><section class="panel location-matrix-panel"><div class="section-heading"><div><h2 id="location-matrix-title">静止距离均值</h2></div><span id="location-node-count" class="section-note"></span></div><div class="location-matrix-scroll"><table class="distance-matrix location-matrix" id="location-matrix" aria-label="定位使用的距离矩阵"></table></div><details class="location-technical"><summary>技术详情</summary><pre id="location-technical"></pre></details></section></div>`;
  let current='overview',snapshot={},manualView=false,view=null,drag=null,sourceKey='',matrixKey='';
  const palette=['#199b79','#e49660','#9985ce','#5599bd','#d37b94','#9aaa52','#50b7b2'];
  const point=v=>Array.isArray(v)?v:(v&&typeof v==='object'?[v.x,v.y,v.z]:null);
  const good=p=>p&&Number.isFinite(p[0])&&Number.isFinite(p[1]);
  const showError=e=>{$('location-status').textContent=e?.message||String(e);$('location-status').classList.add('error');$('location-status').hidden=false;};
  async function operation(fn){$('location-status').hidden=true;try{const r=await fn();if(r?.error)throw Error(r.error);return r;}catch(e){showError(e);}}
  let transitionId=0;
  const pageAnimations=new Set();
  /** 页面交叉淡化使用无超调曲线；快速切换时取消旧动画，避免回弹与动作排队。 */
  function selectPage(page){
    if(!pages[page]||page===current)return;
    const outgoing=pages[current],incoming=pages[page],id=++transitionId;
    for(const animation of pageAnimations)animation.cancel();pageAnimations.clear();
    pageContainer.classList.remove('is-transitioning');
    const oldHeight=outgoing.getBoundingClientRect().height;
    window.UwbDropdowns?.closeAll();current=page;main.classList.toggle('replay-active',page==='replay'||page==='file-replay');
    for(const [key,e]of Object.entries(pages)){e.hidden=key!==page;e.inert=key!==page;e.setAttribute('aria-hidden',String(key!==page));}
    for(const b of document.querySelectorAll('[data-nav]')){const active=b.dataset.nav===page;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
    window.scrollTo({top:0});if(page==='localization')draw();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const newHeight=incoming.getBoundingClientRect().height,easing='cubic-bezier(.16,1,.3,1)';
    outgoing.hidden=false;pageContainer.classList.add('is-transitioning');
    const exit=outgoing.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-3px)'}],{duration:140,easing,fill:'both'});
    const enter=incoming.animate([{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing});
    const height=pageContainer.animate([{height:oldHeight+'px'},{height:newHeight+'px'}],{duration:220,easing});
    for(const animation of [exit,enter,height])pageAnimations.add(animation);
    exit.onfinish=()=>{if(id===transitionId)outgoing.hidden=true;};
    enter.onfinish=()=>{if(id!==transitionId)return;outgoing.hidden=true;pageContainer.classList.remove('is-transitioning');for(const animation of pageAnimations)animation.cancel();pageAnimations.clear();};
  }
  $('location-source').addEventListener('change',()=>operation(async()=>{await api.localizationAction({action:'source',path:$('location-source').value});view=null;matrixKey='';}));
  let actionBusy=false;
  for(const [id,action]of [['location-start','start'],['location-reset','reset'],['location-advance','advance']])$(id).addEventListener('click',async()=>{if(actionBusy)return;actionBusy=true;render(snapshot);try{await operation(async()=>{if(action==='start'&&!snapshot.fileReplay?.active&&!snapshot.localization?.source)await api.localizationAction({action:'source',path:$('location-source').value});const result=await api.localizationAction({action});view=null;matrixKey='';if(result?.filePath){$('location-status').textContent='已保存：'+result.filePath;$('location-status').classList.remove('error');$('location-status').hidden=false;}});}finally{actionBusy=false;if(api)try{render(await api.getSnapshot());}catch(e){showError(e);}else render(snapshot);}});
  $('location-fit').addEventListener('click',()=>{manualView=false;view=null;draw();});$('show-raw').addEventListener('change',draw);$('show-edges').addEventListener('change',draw);$('show-trail').addEventListener('change',draw);
  const canvas=$('location-chart');canvas.addEventListener('wheel',e=>{if(!view)return;e.preventDefault();const factor=e.deltaY>0?1.15:1/1.15;manualView=true;view.span=Math.max(.1,Math.min(1e5,view.span*factor));draw();},{passive:false});
  canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,cx:view?.cx,cy:view?.cy};canvas.setPointerCapture(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(!drag||!view)return;manualView=true;view.cx=drag.cx-(e.clientX-drag.x)*view.span/Math.max(1,canvas.clientWidth-70);view.cy=drag.cy+(e.clientY-drag.y)*view.span/Math.max(1,canvas.clientWidth-70);draw();});canvas.addEventListener('pointerup',()=>drag=null);
  new ResizeObserver(()=>{if(current==='localization')draw();}).observe(canvas);
  function render(data){window.UwbReplayView.render(data.replay);window.UwbFileReplayView?.render(data.fileReplay);snapshot=data;
    const fileState=data.fileReplay||{},fileMode=fileState.active===true,loc=data.localization||fileState.localization||{},stage=Number(loc.stage)||0;
    $('location-clock-status').hidden=!fileMode||fileState.skipClockCheck!==true;
    const viewNow=fileMode&&Number.isFinite(fileState.now)?fileState.now:Date.now();
    const live=distanceMatrix.live(fileMode?{ports:fileState.port?[fileState.port]:[]}:data,fileMode?fileState.port?.path:loc.source);
    const ports=(data.ports||[]).filter(p=>p.connected||p.path===loc.source),key=fileMode?'file:'+String(live.source):ports.map(p=>p.path).join('|');
    if(key!==sourceKey){sourceKey=key;$('location-source').replaceChildren(...(fileMode?[new Option('文件回放',live.source||'FILE')]:[new Option('选择一个观察串口',''),...ports.map(p=>new Option(`${p.path}${p.nodeId?' · '+p.nodeId:''}`,p.path))]));}
    if($('location-source').value!==(live.source||''))$('location-source').value=live.source||'';
    for(const e of $('location-phases').children){e.classList.toggle('active',Number(e.dataset.phase)===stage);e.classList.toggle('completed',Number(e.dataset.phase)<stage);}
    const busy=actionBusy||loc.saving;
    $('location-source').disabled=fileMode||!!loc.experimentActive||busy;
    $('location-start').hidden=stage!==0;$('location-start').disabled=!api||busy||(fileMode?!fileState.file:!(data.ports||[]).some(p=>p.path===live.source&&p.connected));
    $('location-advance').hidden=stage===0;$('location-advance').disabled=!api||busy||!loc.canAdvance||stage>=3||(fileMode&&fileState.automatic);$('location-reset').disabled=!api||busy||(!fileMode&&!loc.experimentActive);
    $('location-empty').textContent=fileMode?'等待回放数据':stage===0?'等待开始':'等待完整距离拓扑';
    $('location-advance').textContent=stage===1?'进入移动初始化':stage===2?'进入位置修正':'正在位置修正';
    /** @brief 所有阶段实时矩阵共用总览端口数据；实验均值只用于MDS，不替代实时展示。 */
    const nodes=loc.nodes||[],edges=live.edges;
    $('location-matrix-title').textContent='实时距离矩阵';
    const matrixNodes=live.nodes;
    const positions=positionCells.index(fileMode?fileState.latestPositions:data.latestPositions);
    $('location-node-count').textContent=`${matrixNodes.length} 节点 · ${edges.length} 条边`;
    // 距离或年龄变化仅更新内容，保留对角线元素及其坐标更新动画。
    const table=$('location-matrix'),next=JSON.stringify(matrixNodes.map(n=>n.id));
    if(next!==matrixKey){
      matrixKey=next;const head=make('thead'),hr=make('tr'),body=make('tbody');
      hr.append(make('th','','m'));for(const n of matrixNodes)hr.append(make('th','',n.id));head.append(hr);
      for(const [i,a]of matrixNodes.entries()){
        const tr=make('tr');tr.append(make('th','',a.id));
        for(const [j,b]of matrixNodes.entries()){
          const td=make('td');
          if(j<i)td.className='masked-cell';
          else if(i===j){td.className='diagonal-cell';td.dataset.positionNode=String(a.id);}
          else{td.dataset.edgeA=String(a.id);td.dataset.edgeB=String(b.id);td.append(make('div','cell-value'),make('div','cell-unit'));}
          tr.append(td);
        }
        body.append(tr);
      }
      table.replaceChildren(head,body);table.style.minWidth=`${Math.max(320,matrixNodes.length*138+105)}px`;
    }
    for(const cell of table.querySelectorAll('[data-edge-a]')){
      const edge=edges.find(e=>String(e.a)===cell.dataset.edgeA&&String(e.b)===cell.dataset.edgeB||String(e.a)===cell.dataset.edgeB&&String(e.b)===cell.dataset.edgeA);
      const valid=fileMode?distanceMatrix.valid(edge,viewNow,viewNow):distanceMatrix.valid(edge,data.now);
      const d=valid?Number(edge.distance):null;
      cell.classList.toggle('stale-measurement',Boolean(edge&&!valid));
      cell.classList.toggle('valid',valid);cell.classList.toggle('unknown',!valid);
      cell.querySelector('.cell-value').textContent=Number.isFinite(d)?d.toFixed(3):'—';
      cell.querySelector('.cell-unit').textContent='m';
    }
    for(const cell of table.querySelectorAll('[data-position-node]'))positionCells.render(cell,positions.get(cell.dataset.positionNode),viewNow);
    const diagnostics=loc.diagnostics||{};$('location-technical').textContent=JSON.stringify(diagnostics,null,2);$('location-advance').title=stage===2&&!loc.canAdvance?(diagnostics.lastError||'等待有效移动观测') : '';
    if(current==='localization')draw();
  }
  /** @brief 只使用共同坐标系中的可见图层；局部INS原始值不能回退成共同系位置。 */
  function visibleLayers(nodes){
    const raw=$('show-raw').checked,ukf=$('show-trail').checked,initial=snapshot.localization?.stage===1;
    return nodes.map((node,index)=>({node,color:palette[index%palette.length],
      raw:raw?point(node.alignedRaw):null,ukf:initial||ukf?point(node.position):null,
      rawTrail:raw?(node.alignedRawTrail||node.rawTrail||[]).map(point).filter(good):[],
      ukfTrail:!initial&&ukf?(node.trail||[]).map(point).filter(good):[]}));
  }
  /** @brief 对照MATLAB独立原始INS图：只减局部原点，不借用尚未求出的旋转或共同坐标。 */
  function drawLocalDisplacements(loc){
    const wrap=$('location-local-wrap');wrap.hidden=loc.stage!==2||!$('show-raw').checked;if(wrap.hidden)return;
    const target=$('location-local-chart'),w=target.clientWidth,h=target.clientHeight,ratio=devicePixelRatio||1;if(!w||!h)return;
    target.width=Math.round(w*ratio);target.height=Math.round(h*ratio);
    const c=target.getContext('2d');c.setTransform(ratio,0,0,ratio,0,0);c.clearRect(0,0,w,h);
    const rows=(loc.nodes||[]).map((node,i)=>{const origin=point(node.localOrigin);return {color:palette[i%palette.length],points:good(origin)?(node.localRawTrail||[]).map(point).filter(good).map(p=>[p[0]-origin[0],p[1]-origin[1]]):[]};});
    const all=rows.flatMap(row=>row.points);if(!all.length)return;
    let xmin=0,xmax=0,ymin=0,ymax=0;for(const p of all){xmin=Math.min(xmin,p[0]);xmax=Math.max(xmax,p[0]);ymin=Math.min(ymin,p[1]);ymax=Math.max(ymax,p[1]);}
    const pad=24,scale=Math.min((w-2*pad)/Math.max(1,xmax-xmin),(h-2*pad)/Math.max(1,ymax-ymin))*.85,cx=(xmin+xmax)/2,cy=(ymin+ymax)/2,to=p=>[w/2+(p[0]-cx)*scale,h/2-(p[1]-cy)*scale];
    const style=getComputedStyle(document.documentElement),muted=style.getPropertyValue('--muted').trim();c.strokeStyle=style.getPropertyValue('--line').trim();c.lineWidth=1;
    const zero=to([0,0]);c.beginPath();c.moveTo(pad,zero[1]);c.lineTo(w-pad,zero[1]);c.moveTo(zero[0],pad);c.lineTo(zero[0],h-pad);c.stroke();
    c.fillStyle=muted;c.font='11px Segoe UI';c.fillText('X / m',w-40,h-7);c.fillText('Y / m',6,13);c.fillText('0',zero[0]+4,zero[1]+13);
    c.lineJoin='round';c.lineCap='round';
    for(const row of rows){if(!row.points.length)continue;c.strokeStyle=row.color;c.lineWidth=1.5;c.beginPath();row.points.forEach((p,i)=>i?c.lineTo(...to(p)):c.moveTo(...to(p)));c.stroke();c.fillStyle=row.color;c.beginPath();c.arc(...to(row.points.at(-1)),3,0,Math.PI*2);c.fill();}
  }
  function draw(){
    if(current!=='localization')return;
    const loc=snapshot.localization||{},nodes=loc.nodes||[],ratio=window.devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;
    if(!w||!h)return;
    if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
    const c=canvas.getContext('2d');c.setTransform(ratio,0,0,ratio,0,0);c.clearRect(0,0,w,h);
    const style=getComputedStyle(document.documentElement),muted=style.getPropertyValue('--muted').trim(),line=style.getPropertyValue('--line').trim(),ink=style.getPropertyValue('--text').trim(),surface=style.getPropertyValue('--surface-soft').trim();
    drawLocalDisplacements(loc);
    const layers=visibleLayers(nodes),all=layers.flatMap(n=>[n.raw,n.ukf,...n.rawTrail,...n.ukfTrail]).filter(good);
    $('location-empty').hidden=all.length>0;
    if(!all.length){$('location-legend').replaceChildren();return;}
    const pad={left:46,right:24,top:24,bottom:38},pw=Math.max(1,w-pad.left-pad.right),ph=Math.max(1,h-pad.top-pad.bottom);
    if(!view||!manualView){
      let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
      for(const p of all){xmin=Math.min(xmin,p[0]);xmax=Math.max(xmax,p[0]);ymin=Math.min(ymin,p[1]);ymax=Math.max(ymax,p[1]);}
      view={cx:(xmin+xmax)/2,cy:(ymin+ymax)/2,span:Math.max(4,(xmax-xmin)*1.42,(ymax-ymin)*pw/ph*1.42)};
    }
    const scale=pw/view.span,centerX=pad.left+pw/2,centerY=pad.top+ph/2,to=p=>[centerX+(p[0]-view.cx)*scale,centerY-(p[1]-view.cy)*scale];
    const desired=view.span/7,unit=10**Math.floor(Math.log10(desired)),norm=desired/unit,step=(norm>5?10:norm>2?5:norm>1?2:1)*unit;
    const decimals=Math.max(0,-Math.floor(Math.log10(step))),xmin=view.cx-pw/scale/2,xmax=view.cx+pw/scale/2,ymin=view.cy-ph/scale/2,ymax=view.cy+ph/scale/2;
    c.font='11px Segoe UI';c.fillStyle=muted;c.strokeStyle=line;c.lineWidth=1;
    for(let x=Math.ceil(xmin/step)*step;x<=xmax;x+=step){const px=to([x,0])[0];c.beginPath();c.moveTo(px,pad.top);c.lineTo(px,h-pad.bottom);c.stroke();c.fillText((Math.abs(x)<step*1e-8?0:x).toFixed(decimals),px+3,h-pad.bottom+15);}
    for(let y=Math.ceil(ymin/step)*step;y<=ymax;y+=step){const py=to([0,y])[1];c.beginPath();c.moveTo(pad.left,py);c.lineTo(w-pad.right,py);c.stroke();c.fillText((Math.abs(y)<step*1e-8?0:y).toFixed(decimals),4,py+3);}
    c.strokeStyle=muted;c.globalAlpha=.55;c.beginPath();c.moveTo(pad.left,pad.top);c.lineTo(pad.left,h-pad.bottom);c.lineTo(w-pad.right,h-pad.bottom);c.stroke();c.globalAlpha=1;
    c.fillStyle=muted;c.fillText('X / m',w-48,h-7);c.fillText('Y / m',6,13);
    c.save();c.beginPath();c.rect(pad.left,pad.top,pw,ph);c.clip();
    if($('show-edges').checked&&(loc.stage===1||$('show-trail').checked)){
      c.setLineDash([3,5]);c.strokeStyle=muted;c.lineWidth=.8;c.globalAlpha=.22;
      for(const e of loc.edges||[]){
        const a=point(nodes.find(n=>String(n.id)===String(e.a))?.position),b=point(nodes.find(n=>String(n.id)===String(e.b))?.position);
        if(!good(a)||!good(b))continue;
        c.beginPath();c.moveTo(...to(a));c.lineTo(...to(b));c.stroke();
      }
      c.setLineDash([]);c.globalAlpha=1;
    }
    /** @brief 急转或近反向采样采用圆角拼接与圆头端点，避免尖角拼接产生突出尖刺。 */
    c.lineJoin='round';c.lineCap='round';
    /** @brief 同节点同颜色，原始INS细虚线、UKF粗实线；初始化预览不由绘图层连接成历史。 */
    for(const n of layers){
      c.strokeStyle=n.color;
      for(const [pts,raw] of [[n.rawTrail,true],[n.ukfTrail,false]]){
        if(!pts.length)continue;
        c.globalAlpha=raw?.65:.95;c.lineWidth=raw?1.25:2.6;c.setLineDash(raw?[5,4]:[]);
        c.beginPath();pts.forEach((p,j)=>j?c.lineTo(...to(p)):c.moveTo(...to(p)));c.stroke();
        c.setLineDash([]);c.globalAlpha=1;
        // 原始轨迹起点只标一次；UKF启用位置属于轨迹中途，不另画起点。
        if(raw){const [x,y]=to(pts[0]);c.beginPath();c.fillStyle=surface;c.lineWidth=1.5;c.moveTo(x,y-5);c.lineTo(x-4.3,y+3);c.lineTo(x+4.3,y+3);c.closePath();c.fill();c.stroke();}
      }
      if(good(n.ukf)){const [x,y]=to(n.ukf);c.beginPath();if(loc.stage===3){c.fillStyle=surface;c.strokeStyle=n.color;c.lineWidth=1.8;c.arc(x,y,6,0,Math.PI*2);c.fill();c.stroke();}else{c.fillStyle=n.color;c.arc(x,y,3.8,0,Math.PI*2);c.fill();}}
      if(good(n.raw)){const [x,y]=to(n.raw);c.fillStyle=n.color;c.beginPath();c.arc(x,y,3.8,0,Math.PI*2);c.fill();}
    }
    c.restore();
    /** @brief RAC与当前两类坐标共同标注；靠近边缘时向内放置，避免自动适配后文字被裁掉。 */
    for(const n of layers){
      const anchor=good(n.ukf)?n.ukf:n.raw;if(!good(anchor))continue;
      const [x,y]=to(anchor);if(x<pad.left||x>w-pad.right||y<pad.top||y>h-pad.bottom)continue;
      const labels=[{text:String(n.node.id),strong:true},
        ...(good(n.raw)?[{text:`INS (${n.raw[0].toFixed(2)}, ${n.raw[1].toFixed(2)})`}]:[]),
        ...(good(n.ukf)?[{text:`${loc.stage===1?'MDS':loc.stage===2?'初始化':'UKF'} (${n.ukf[0].toFixed(2)}, ${n.ukf[1].toFixed(2)})`}]:[])];
      c.font='11px Segoe UI';const width=Math.max(...labels.map(l=>c.measureText(l.text).width))+8;
      const tx=Math.max(pad.left+3,x+12+width>w-pad.right?x-width-11:x+12),ty=Math.max(pad.top+12,Math.min(h-pad.bottom-12*(labels.length-1),y-9));
      c.fillStyle=surface;c.globalAlpha=.82;c.fillRect(tx-3,ty-11,width+3,labels.length*12+3);c.globalAlpha=1;
      labels.forEach((label,i)=>{c.font=label.strong?'600 11px Segoe UI':'11px Segoe UI';c.fillStyle=label.strong?n.color:ink;c.fillText(label.text,tx,ty+12*i);});
    }
    const legend=[];
    for(const [cls,text] of (loc.stage===1?[['initial','初始位置 · 实心点']]:[['raw','原始 INS · 实心点'],[loc.stage===2?'initial':'ukf',loc.stage===2?'初始化 · 实心点':'UKF · 空心点'],['start','起点 △']])){
      const item=make('span','location-series-key');item.append(make('i','location-series-'+cls),document.createTextNode(text));legend.push(item);
    }
    for(const n of layers){const item=make('span','location-node-key'),swatch=make('i');swatch.style.background=n.color;item.append(swatch,document.createTextNode(String(n.node.id)));legend.push(item);}
    $('location-legend').replaceChildren(...legend);
  }
  window.UwbLocalizationView={render,selectPage};
})();
