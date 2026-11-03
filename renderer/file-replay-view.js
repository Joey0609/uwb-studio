"use strict";
/** @file 文件直接驱动定位的回放控制；不选择或连接串口。 */
(() => {
  const $=id=>document.getElementById(id),api=window.uwb;
  let mounted=false,busy=false,state={},historyKey='',logKey='',showResults=()=>{};
  const labels={idle:'未选择文件',ready:'已就绪',playing:'回放中',paused:'已暂停',stopped:'已停止',ended:'回放完成',error:'回放失败'};
  const errorText=value=>String(value?.message||value||'').replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i,'').replace(/^Error:\s*/i,'');
  const time=value=>{const seconds=Math.max(0,Number(value)||0);return `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;};
  function controls(){
    if(!mounted)return;
    const available=typeof api?.fileReplayAction==='function',playing=state.state==='playing',paused=state.state==='paused',locked=playing||paused,loc=state.localization||{};
    $('file-replay-open').disabled=busy||!available||locked;
    for(const item of $('file-replay-history').querySelectorAll('button'))item.disabled=$('file-replay-open').disabled;
    $('file-replay-toggle').disabled=busy||!available||!state.file;
    $('file-replay-toggle').textContent=playing?'暂停':paused?'继续':'播放';
    $('file-replay-stop').disabled=busy||!available||!locked;
    $('file-replay-close').disabled=busy||!available||!state.active;
    $('file-replay-speed').disabled=busy||!available;
    $('file-replay-automatic').disabled=busy||!available||!state.operationsAvailable||locked;
    $('file-replay-skip-clock').disabled=busy||!available||!state.file||locked;
    $('file-replay-advance').disabled=busy||!available||!state.active||state.automatic||!loc.canAdvance||Number(loc.stage)>=3;
    $('file-replay-advance').textContent=Number(loc.stage)>=2?'进入位置修正':'进入初始位置';
    $('file-replay-results').disabled=!state.active;
  }
  async function action(action,extra={}){
    if(busy)return;busy=true;$('file-replay-error').hidden=true;controls();
    try{if(typeof api?.fileReplayAction!=='function')throw Error('桌面连接不可用');const result=await api.fileReplayAction({action,...extra});if(result)render(result);}
    catch(error){$('file-replay-error').textContent=errorText(error);$('file-replay-error').hidden=false;}
    finally{busy=false;controls();}
  }
  function mount(host,onResults){
    showResults=onResults||showResults;
    host.innerHTML=`<section class="panel serial-replay-panel file-replay-panel"><div class="section-heading"><h2>文件回放</h2><span class="serial-replay-state" id="file-replay-state" role="status">未选择文件</span></div><div class="serial-replay-file"><span id="file-replay-file" class="serial-replay-filename">未选择文件</span><button class="button" id="file-replay-open">选择CSV</button></div><div class="serial-replay-history" id="file-replay-history" aria-label="文件回放历史" hidden></div><div class="serial-replay-actions file-replay-actions"><button class="button primary" id="file-replay-toggle">播放</button><button class="button" id="file-replay-stop">停止</button><label class="serial-replay-speed">倍速<select id="file-replay-speed" aria-label="文件回放倍速"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option><option value="20">20×</option></select></label><span id="file-replay-progress" class="serial-replay-progress">0 / 0 块 · 0:00</span></div><progress id="file-replay-meter" class="serial-replay-meter" value="0" max="1" aria-label="文件回放进度"></progress><div class="file-replay-stage-controls"><label class="serial-replay-follow"><input type="checkbox" id="file-replay-automatic">自动重放操作</label><span class="section-note" id="file-replay-operations"></span><label class="serial-replay-follow"><input type="checkbox" id="file-replay-skip-clock">跳过时钟检查</label><span class="section-note" id="file-replay-clock-status" role="status" hidden>已跳过时钟检查</span><button class="button" id="file-replay-advance">进入初始位置</button><button class="button" id="file-replay-results">定位结果</button><button class="button" id="file-replay-close">关闭文件</button></div><p id="file-replay-error" role="alert" class="serial-replay-error" hidden></p></section><section class="panel serial-replay-output"><div class="section-heading"><h2>回放记录</h2><span class="section-note" id="file-replay-stage"></span></div><div class="serial-replay-log" id="file-replay-log" role="log" aria-label="文件回放记录"><table><thead><tr><th>时间</th><th>类型</th><th>内容</th></tr></thead><tbody id="file-replay-lines"></tbody></table></div></section>`;
    mounted=true;
    $('file-replay-open').addEventListener('click',()=>action('open'));
    $('file-replay-history').addEventListener('click',event=>{const item=event.target.closest('button[data-file]');if(item&&!item.disabled)action('history',{file:item.dataset.file});});
    $('file-replay-toggle').addEventListener('click',()=>action(state.state==='playing'?'pause':state.state==='paused'?'continue':'start'));
    for(const name of ['stop','close','advance'])$('file-replay-'+name).addEventListener('click',()=>action(name));
    $('file-replay-speed').addEventListener('change',()=>action('speed',{speed:Number($('file-replay-speed').value)}));
    $('file-replay-automatic').addEventListener('change',()=>action('automatic',{enabled:$('file-replay-automatic').checked}));
    $('file-replay-skip-clock').addEventListener('change',()=>action('clockCheck',{skip:$('file-replay-skip-clock').checked}));
    $('file-replay-results').addEventListener('click',()=>showResults());
    controls();
  }
  function render(data){
    if(!mounted)return;state=data||{};
    const history=state.history||[],next=JSON.stringify(history.map(item=>item.file));
    if(next!==historyKey){historyKey=next;const fragment=document.createDocumentFragment();
      for(const item of history){const button=document.createElement('button');button.type='button';button.className='button serial-replay-history-item';button.textContent=item.fileName;button.dataset.file=item.file;fragment.append(button);}
      $('file-replay-history').replaceChildren(fragment);$('file-replay-history').hidden=!history.length;
    }
    for(const button of $('file-replay-history').querySelectorAll('button'))button.classList.toggle('selected',button.dataset.file.toLowerCase()===String(state.file||'').toLowerCase());
    $('file-replay-state').textContent=labels[state.state]||labels.idle;$('file-replay-state').classList.toggle('running',state.state==='playing');
    $('file-replay-file').textContent=state.fileName||String(state.file||'').split(/[\\/]/).pop()||'未选择文件';$('file-replay-file').title=state.file||'';
    const index=Number(state.index)||0,total=Number(state.total)||0;
    $('file-replay-progress').textContent=`${index.toLocaleString()} / ${total.toLocaleString()} 块 · ${time(state.position)} / ${time(state.duration)}`;
    $('file-replay-meter').max=Math.max(1,total);$('file-replay-meter').value=index;
    $('file-replay-speed').value=String(state.speed||1);$('file-replay-automatic').checked=state.automatic===true;
    $('file-replay-operations').textContent=state.file?(state.operationsAvailable?(state.assumedOperations?'推定阶段操作':'已记录阶段操作'):'未记录阶段操作'):'';
    $('file-replay-skip-clock').checked=state.skipClockCheck===true;
    $('file-replay-clock-status').hidden=!state.active||state.skipClockCheck!==true;
    const loc=state.localization||{},stage=Number(loc.stage)||0;
    $('file-replay-stage').textContent=state.active?(['等待开始','静止采集','初始位置','位置修正'][stage]||''):'';
    const logs=(state.logs||[]).slice(-500),key=JSON.stringify(logs.map(row=>[row.id,row.time,row.text,row.type]));
    if(key!==logKey){logKey=key;const fragment=document.createDocumentFragment();
      for(const row of logs){const tr=document.createElement('tr'),at=new Date(row.time||0);for(const value of [Number.isFinite(at.getTime())?at.toLocaleTimeString('zh-CN',{hour12:false}):'—',row.type==='error'?'错误':row.type==='operation'?'操作':'状态',row.type==='error'?errorText(row.text):String(row.text||'')]){const td=document.createElement('td');td.textContent=value;tr.append(td);}tr.className=row.type==='error'?'error':'system';fragment.append(tr);}
      $('file-replay-lines').replaceChildren(fragment);$('file-replay-log').scrollTop=$('file-replay-log').scrollHeight;
    }
    if(state.error){$('file-replay-error').textContent=errorText(state.error);$('file-replay-error').hidden=false;}
    controls();window.UwbDropdowns?.refreshAll();
  }
  window.UwbFileReplayView={mount,render};
})();
