"use strict";
(() => {
  const $=id=>document.getElementById(id),api=window.uwb;
  let mounted=false,busy=false,state={},logKey='',historyKey='';
  const labels={disconnected:'未连接',connecting:'连接中',connected:'已连接',running:'发送中',paused:'已暂停',finished:'发送完成',stopping:'停止中',error:'发送失败'};
  const message=error=>String(error?.message||error||'').replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i,'').replace(/^Error:\s*/i,'');
  async function scan(){
    if(!api)throw Error('桌面连接不可用');
    const previous=$('replay-port').value,data=await api.listPorts(),ports=Array.isArray(data)?data:data?.ports||[];
    $('replay-port').replaceChildren(new Option('选择发送串口',''),...ports.map(p=>new Option(`${p.path}${p.manufacturer?' · '+p.manufacturer:''}`,p.path)));
    if(ports.some(p=>p.path===previous))$('replay-port').value=previous;
    if(state.reserved&&state.path){if(!ports.some(p=>p.path===state.path))$('replay-port').append(new Option(state.path,state.path));$('replay-port').value=state.path;}
    window.UwbDropdowns?.refreshAll();
  }
  async function run(fn){
    if(busy)return;busy=true;$('replay-error').hidden=true;controls();
    try{const result=await fn();if(result)render(result);}catch(error){$('replay-error').textContent=message(error);$('replay-error').hidden=false;}
    finally{busy=false;controls();}
  }
  function action(action,extra={}){return run(()=>{if(!api)throw Error('桌面连接不可用');return api.replayAction({action,...extra});});}
  function controls(){
    if(!mounted)return;
    const reserved=state.reserved||state.connected,running=state.state==='running',paused=state.state==='paused',transition=['connecting','stopping'].includes(state.state);
    $('replay-port').disabled=busy||reserved;$('replay-baud').disabled=busy||reserved;
    $('replay-scan').disabled=busy||transition;
    $('replay-connect').disabled=busy||transition||(!reserved&&!$('replay-port').value);$('replay-connect').textContent=reserved?'断开':'连接';
    $('replay-toggle').disabled=busy||transition||!state.connected||!state.file;
    $('replay-toggle').textContent=running?'暂停':paused?'继续':'播放';
    $('replay-open').disabled=busy||transition||running||paused;
    for(const item of $('replay-history').querySelectorAll('button'))item.disabled=$('replay-open').disabled;
    $('replay-stop').disabled=busy||transition||(!running&&!paused&&state.state!=='error');
    $('replay-speed').disabled=busy||transition;$('replay-clear').disabled=busy;
  }
  function mount(host){
    host.innerHTML=`<section class="panel serial-replay-panel"><div class="section-heading"><h2>串口回放</h2><span class="serial-replay-state" id="replay-state" role="status">未连接</span></div><div class="serial-replay-file"><span id="replay-file" class="serial-replay-filename">未选择文件</span><button class="button" id="replay-open">选择CSV</button></div><div class="serial-replay-history" id="replay-history" aria-label="历史选择" hidden></div><div class="serial-replay-connection"><label class="serial-replay-port">发送串口<select id="replay-port" aria-label="发送串口"><option value="">选择发送串口</option></select></label><label>波特率<select id="replay-baud" aria-label="发送波特率"><option>115200</option><option>230400</option><option>460800</option><option>921600</option></select></label><button class="button serial-replay-scan" id="replay-scan" aria-label="扫描串口" title="扫描串口"><svg aria-hidden="true"><use href="#i-refresh"/></svg></button><button class="button" id="replay-connect">连接</button></div><div class="serial-replay-actions"><button class="button primary" id="replay-toggle">播放</button><button class="button" id="replay-stop">停止</button><label class="serial-replay-speed">倍速<select id="replay-speed" aria-label="发送倍速"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option><option value="20">20×</option></select></label><span id="replay-progress" class="serial-replay-progress">0 / 0 块 · 0 B</span></div><progress id="replay-meter" class="serial-replay-meter" value="0" max="1" aria-label="发送进度"></progress><p id="replay-error" role="alert" class="serial-replay-error" hidden></p></section><section class="panel serial-replay-output"><div class="section-heading"><h2>发送记录</h2><div class="section-actions"><label class="serial-replay-follow"><input type="checkbox" id="replay-follow" checked>自动滚动</label><button class="button" id="replay-clear">清空</button></div></div><div class="serial-replay-log" id="replay-log" role="log" aria-label="串口发送记录"><table><thead><tr><th>时间</th><th>类型</th><th>内容</th></tr></thead><tbody id="replay-lines"></tbody></table></div></section>`;
    mounted=true;
    $('replay-history').addEventListener('click',event=>{const item=event.target.closest('button[data-file]');if(item&&!item.disabled)action('history',{file:item.dataset.file});});
    $('replay-port').addEventListener('change',controls);$('replay-scan').addEventListener('click',()=>run(scan));
    $('replay-connect').addEventListener('click',()=>action(state.reserved||state.connected?'disconnect':'connect',{path:$('replay-port').value,baudRate:Number($('replay-baud').value)}));
    $('replay-toggle').addEventListener('click',()=>action(state.state==='running'?'pause':state.state==='paused'?'continue':'start'));
    for(const name of ['open','stop','clear'])$('replay-'+name).addEventListener('click',()=>action(name));
    $('replay-speed').addEventListener('change',()=>action('speed',{speed:Number($('replay-speed').value)}));
    controls();run(scan);
  }
  function render(data){
    if(!mounted)return;state=data||{};
    const history=state.history||[],nextHistoryKey=JSON.stringify(history.map(item=>item.file));
    if(nextHistoryKey!==historyKey){historyKey=nextHistoryKey;const fragment=document.createDocumentFragment();
      for(const item of history){const button=document.createElement('button');button.type='button';button.className='button serial-replay-history-item';button.textContent=item.fileName;button.dataset.file=item.file;fragment.append(button);}
      $('replay-history').replaceChildren(fragment);$('replay-history').hidden=!history.length;
    }
    for(const button of $('replay-history').querySelectorAll('button'))button.classList.toggle('selected',button.dataset.file.toLowerCase()===String(state.file||'').toLowerCase());
    controls();$('replay-state').textContent=labels[state.state]||'未连接';$('replay-state').classList.toggle('running',state.state==='running');
    $('replay-file').textContent=state.fileName||String(state.file||'').split(/[\\/]/).pop()||'未选择文件';$('replay-file').title=state.file||'';
    const index=Number(state.index)||0,total=Number(state.total)||0;
    $('replay-progress').textContent=`${index.toLocaleString()} / ${total.toLocaleString()} 块 · ${(Number(state.bytes)||0).toLocaleString()} B`;
    $('replay-meter').max=Math.max(1,total);$('replay-meter').value=index;
    if(state.reserved&&state.path){if(![...$('replay-port').options].some(o=>o.value===state.path))$('replay-port').append(new Option(state.path,state.path));$('replay-port').value=state.path;}
    if(state.baudRate)$('replay-baud').value=String(state.baudRate);if(state.speed)$('replay-speed').value=String(state.speed);
    if(state.error){$('replay-error').textContent=message(state.error);$('replay-error').hidden=false;}
    const logs=(state.logs||[]).slice(-500),key=`${logs[0]?.id}/${logs.at(-1)?.id}/${logs.length}/${logs.at(-1)?.text}`;
    if(key!==logKey){logKey=key;const fragment=document.createDocumentFragment();
      for(const row of logs){const tr=document.createElement('tr'),date=new Date(row.time),time=`${date.toLocaleTimeString('zh-CN',{hour12:false})}.${String(date.getMilliseconds()).padStart(3,'0')}`;
        for(const value of [time,row.type==='tx'?'发送':row.type==='error'?'错误':'状态',row.type==='error'?message(row.text):row.text]){const td=document.createElement('td');td.textContent=value;tr.append(td);}tr.className=row.type;fragment.append(tr);}
      $('replay-lines').replaceChildren(fragment);if($('replay-follow').checked)$('replay-log').scrollTop=$('replay-log').scrollHeight;
    }
    window.UwbDropdowns?.refreshAll();
  }
  window.UwbReplayView={mount,render};
})();
