'use strict';
/** @file updates.cjs @brief 公开GitHub更新；安装前关闭采集，不处理访问令牌。 */
const FEED=Object.freeze({provider:'github',owner:'Joey0609',repo:'uwb-studio'});
const RELEASE_URL='https://github.com/Joey0609/uwb-studio/releases/latest';
function notesText(notes){if(Array.isArray(notes))return notes.map(n=>String(n?.note||'')).join('\n').slice(0,12000);return typeof notes==='string'?notes.slice(0,12000):'';}
function createUpdateService({app,autoUpdater,send=()=>{},prepareInstall=async()=>{},openExternal=()=>{},portable=false,platform=process.platform}){
  const enabled=app.isPackaged&&platform==='win32'&&!portable;
  let state={state:!app.isPackaged?'development':portable?'portable':enabled?'idle':'unsupported',currentVersion:app.getVersion(),version:'',percent:0,notes:'',enabled,message:''};
  let checking=null,downloading=null,installing=false,timer;
  const snapshot=()=>({...state});
  function update(patch){state={...state,...patch};send(snapshot());return snapshot();}
  function failure(error){
    const auth=/401|403|404|unauthorized|forbidden|not found/i.test(String(error?.message||''));
    return update({state:'error',message:auth?'当前发布版本暂不可用，请稍后重试':'更新失败，请检查网络后重试'});
  }
  if(enabled){
    autoUpdater.autoDownload=false;autoUpdater.autoInstallOnAppQuit=false;autoUpdater.allowPrerelease=false;autoUpdater.allowDowngrade=false;
    autoUpdater.logger={info(){},warn(){},error(){},debug(){}};
    autoUpdater.on('checking-for-update',()=>update({state:'checking',message:''}));
    autoUpdater.on('update-available',info=>update({state:'available',version:String(info.version||''),notes:notesText(info.releaseNotes),percent:0,message:''}));
    autoUpdater.on('update-not-available',()=>update({state:'latest',message:'当前已是最新版本'}));
    autoUpdater.on('download-progress',p=>update({state:'downloading',percent:Math.max(0,Math.min(100,Math.round(Number(p.percent)||0)))}));
    autoUpdater.on('update-downloaded',info=>update({state:'downloaded',version:String(info.version||state.version),percent:100,message:''}));
    autoUpdater.on('error',failure);
  }
  async function action(args={}){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('更新操作无效');
    if(args.action==='snapshot')return snapshot();
    if(args.action==='openRelease'){await openExternal(RELEASE_URL);return snapshot();}
    if(!enabled)throw Error(portable?'便携版请从发布页下载安装版':'当前运行方式不支持自动更新');
    if(args.action==='check'){
      if(checking)return checking;
      if(downloading||installing||state.state==='downloaded')return snapshot();
      autoUpdater.setFeedURL({...FEED});update({state:'checking',message:''});
      checking=Promise.resolve().then(()=>autoUpdater.checkForUpdates()).then(snapshot,failure).finally(()=>{checking=null;});
      return checking;
    }
    if(args.action==='download'){
      if(downloading)return downloading;
      if(state.state!=='available')throw Error('没有可下载的新版本，请先检查更新');
      update({state:'downloading',percent:0,message:''});
      downloading=Promise.resolve().then(()=>autoUpdater.downloadUpdate()).then(snapshot,failure).finally(()=>{downloading=null;});return downloading;
    }
    if(args.action==='install'){
      if(installing)throw Error('正在准备安装');
      if(state.state!=='downloaded')throw Error('请先下载更新');
      installing=true;
      try{await prepareInstall();update({state:'installing',message:''});autoUpdater.quitAndInstall(false,true);return snapshot();}
      catch(error){update({state:'downloaded',message:error.message||'请先结束并保存当前实验'});throw error;}
      finally{installing=false;}
    }
    throw Error('更新操作无效');
  }
  function start(){if(enabled&&!timer){timer=setTimeout(()=>{void action({action:'check'}).catch(()=>{});},5000);timer.unref?.();}}
  function dispose(){clearTimeout(timer);timer=null;}
  return {snapshot,action,start,dispose};
}
module.exports={createUpdateService,FEED,RELEASE_URL};
