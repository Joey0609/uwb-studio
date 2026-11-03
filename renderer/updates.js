'use strict';
/** @file updates.js @brief 更新状态和下载进度，不直接访问网络。 */
(()=>{
  const api=window.uwb;if(!api?.updateAction)return;
  const $=id=>document.getElementById(id),dialog=$('update-dialog');let current={},busy=false,prompted='';
  const labels={idle:'尚未检查',checking:'正在检查更新',available:'发现新版本',downloading:'正在下载更新',downloaded:'更新已下载',installing:'正在准备安装',latest:'当前已是最新版本',error:'更新失败',development:'开发模式',portable:'便携版',unsupported:'当前平台不支持自动更新'};
  function render(s){
    current=s;for(const e of document.querySelectorAll('[data-app-version]'))e.textContent=s.currentVersion;
    $('update-current').textContent=s.currentVersion||'';
    $('update-status').textContent=s.message||labels[s.state]||'';
    $('update-check').disabled=busy||!s.enabled||['checking','downloading','installing'].includes(s.state);
    $('update-version').textContent=s.version?'v'+s.version:'';
    $('update-title').textContent=labels[s.state]||'软件更新';$('update-notes').textContent=s.notes||'';
    $('update-error').textContent=s.message||'';
    const downloading=s.state==='downloading';$('update-progress').hidden=!downloading;$('update-progress').value=s.percent||0;$('update-percent').textContent=downloading?(s.percent||0)+'%':'';
    $('update-download').hidden=s.state!=='available';$('update-install').hidden=s.state!=='downloaded';
    $('update-download').disabled=busy;$('update-install').disabled=busy;
    const key=s.version+':'+s.state;if(['available','downloaded'].includes(s.state)&&key!==prompted){prompted=key;if(!dialog.open)dialog.showModal();}
  }
  async function act(args){if(busy)return;busy=true;render(current);try{render(await api.updateAction(args));}catch(error){$('update-status').textContent=error.message;$('update-error').textContent=error.message;}finally{busy=false;render({...current,message:$('update-error').textContent||current.message});}}
  $('update-check').addEventListener('click',()=>{prompted='';void act({action:'check'});});
  $('update-download').addEventListener('click',()=>act({action:'download'}));
  $('update-install').addEventListener('click',()=>act({action:'install'}));
  $('update-release').addEventListener('click',()=>act({action:'openRelease'}));
  $('update-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
  api.onUpdateStatus(render);void api.updateAction({action:'snapshot'}).then(render).catch(()=>{});
})();
