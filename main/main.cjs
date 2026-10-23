'use strict';
const {app,BrowserWindow,ipcMain,dialog,Menu,utilityProcess,clipboard} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createAcquisitionLog} = require('./acquisition-log.cjs');
if(process.env.UWB_USER_DATA_DIR){fs.mkdirSync(process.env.UWB_USER_DATA_DIR,{recursive:true});app.setPath('userData',process.env.UWB_USER_DATA_DIR);}
let window, worker, settingsPath, settings, closing=false, rpcId=1, recordingWarning='';
const calls=new Map();
const defaults={theme:'system',scope:'radio',gateway:null,quickVersion:4,quickCommands:[
  {label:'节点信息',command:'swarm info'},{label:'矩阵快照',command:'swarm snapshot'},{label:'节点状态',command:'swarm status'},{label:'邻居观测',command:'swarm neighbors'},
  {label:'本机地址',command:'racaddr'},
  {label:'开启数据',command:'swarm stream on'},{label:'关闭数据',command:'swarm stream off'},
  {label:'广播测距启动',command:'swarm broadcast start'},{label:'纯监听启动',command:'swarm monitor start'},{label:'停止本机测距',command:'swarm stop'},
  {label:'邻居发现（旧模式）',command:'neighbordiscover'},
  {label:'邻居列表（旧模式）',command:'neighborlist'},
  {label:'UWB芯片（旧模式）',command:'readreg 0'},
  {label:'单次测距…',command:'range <目标地址>'},
  {label:'广播消息…',command:'broadcastsend <消息内容>'},
  {label:'全部命令',command:'help'}
]};
function call(method,args){
  return new Promise((resolve,reject)=>{
    const id=rpcId++,timer=setTimeout(()=>{calls.delete(id);reject(Error('操作超时，请检查串口及设备状态'));},15000);
    calls.set(id,{resolve,reject,timer});worker.postMessage({id,method,args});
  });
}
function updateSettings(patch){
  if(!patch||typeof patch!=='object')throw Error('设置格式无效');
  if(patch.theme!==undefined){if(!['light','dark','system'].includes(patch.theme))throw Error('主题无效');settings.theme=patch.theme;}
  if(patch.scope!==undefined){if(!['radio','connected'].includes(patch.scope))throw Error('控制范围无效');settings.scope=patch.scope;}
  if(patch.gateway!==undefined)settings.gateway=typeof patch.gateway==='string'?patch.gateway.slice(0,256):null;
  if(patch.quickCommands!==undefined){
    if(!Array.isArray(patch.quickCommands)||patch.quickCommands.length>40)throw Error('最多40个快捷指令');
    settings.quickCommands=patch.quickCommands.map(c=>{
      if(typeof c.label!=='string'||typeof c.command!=='string'||!c.label.trim()||c.label.length>40||Buffer.byteLength(c.command)>256||/[\r\n\0]/.test(c.command))throw Error('快捷指令格式无效');
      return {label:c.label,command:c.command};
    });
  }
  fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2),'utf8');return settings;
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.whenReady().then(()=>{
    settingsPath=path.join(app.getPath('userData'),'settings.json');
    try{settings={...defaults,...JSON.parse(fs.readFileSync(settingsPath,'utf8'))};}catch{settings={...defaults};}
    // 只升级完整匹配旧默认的列表；用户增删改过的快捷指令不追加、不覆盖。
    const priorDefault=[
      ['节点信息','swarm info'],['矩阵快照','swarm snapshot'],['节点状态','swarm status'],['邻居观测','swarm neighbors'],['本机地址','racaddr'],
      ['开启数据','swarm stream on'],['关闭数据','swarm stream off'],['停止本机测距','swarm stop'],['邻居发现（旧模式）','neighbordiscover'],
      ['邻居列表（旧模式）','neighborlist'],['UWB芯片（旧模式）','readreg 0'],['单次测距…','range <目标地址>'],['广播消息…','broadcastsend <消息内容>'],['全部命令','help']
    ];
    if(Array.isArray(settings.quickCommands)&&priorDefault.length===settings.quickCommands.length&&priorDefault.every(([label,command],i)=>settings.quickCommands[i].label===label&&settings.quickCommands[i].command===command))settings.quickCommands=defaults.quickCommands.map(q=>({...q}));
    settings.quickVersion=4;
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const directory=process.env.UWB_RECORDINGS_DIR||path.join(app.getPath('documents'),'UWB Studio','recordings',stamp);
    // 主进程先完成建目录，不能依赖子进程异步启动时抢先创建。
    const acquisitionLog=createAcquisitionLog(directory,message=>{recordingWarning=message;});
    worker=utilityProcess.fork(path.join(__dirname,'serial-worker.cjs'),[directory],{serviceName:'UWB串口采集',stdio:'pipe'});
    worker.stdout?.pipe(acquisitionLog,{end:false});worker.stderr?.pipe(acquisitionLog,{end:false});
    acquisitionLog.on('error',()=>{worker.stdout?.resume();worker.stderr?.resume();});
    worker.on('message',message=>{
      if(message.event==='snapshot'){
        if(recordingWarning)message.data.recording={...message.data.recording,error:[message.data.recording?.error,recordingWarning].filter(Boolean).join('；')};
        if(window&&!window.isDestroyed())window.webContents.send('uwb:snapshot',message.data);return;
      }
      const pending=calls.get(message.id);if(!pending)return;calls.delete(message.id);clearTimeout(pending.timer);
      if(message.error)pending.reject(Error(message.error));else pending.resolve(message.result);
    });
    worker.on('error',error=>{
      for(const c of calls.values()){clearTimeout(c.timer);c.reject(error);}calls.clear();
      if(window&&!window.isDestroyed())dialog.showErrorBox('串口采集进程异常',error.message);
    });
    worker.on('exit',code=>{
      acquisitionLog.end();
      if(closing)return;
      const error=Error(`串口采集进程退出（${code}），界面仍可使用；请重新启动应用后连接`);
      for(const c of calls.values()){clearTimeout(c.timer);c.reject(error);}calls.clear();
      if(window&&!window.isDestroyed())window.webContents.send('uwb:snapshot',{ports:[],nodes:[],edges:[],control:{error:error.message},recording:{error:error.message},now:Date.now()});
    });
    window=new BrowserWindow({width:1480,height:1000,minWidth:960,minHeight:720,icon:path.join(__dirname,'../assets/icon.png'),
      title:'UWB Studio',backgroundColor:'#f5f5f0',show:false,autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    const page=pathToFileURL(path.join(__dirname,'../renderer/index.html')).href;
    for(const name of ['listPorts','connect','disconnect','removePort','send','control','setMode','nodeControl','getSnapshot']){
      ipcMain.handle('uwb:'+name,(event,args)=>{
        if(event.sender.id!==window.webContents.id||event.senderFrame!==window.webContents.mainFrame)throw Error('无效操作来源');
        if(['setMode','nodeControl'].includes(name)){
          if(!args||typeof args!=='object'||Array.isArray(args)||typeof args.path!=='string'||!args.path||args.path.length>256)throw Error('节点操作参数无效');
          if(name==='setMode'&&!['broadcast','monitor'].includes(args.mode)||name==='nodeControl'&&!['start','stop'].includes(args.action))throw Error('节点模式或操作无效');
          const safe=name==='setMode'?{path:args.path,mode:args.mode}:{path:args.path,action:args.action};return call(name,safe);
        }
        return call(name,args);
      });
    }
    ipcMain.handle('uwb:getSettings',()=>settings);
    ipcMain.handle('uwb:copyText',(event,value)=>{
      if(event.sender.id!==window.webContents.id||event.senderFrame!==window.webContents.mainFrame)throw Error('无效复制来源');
      if(typeof value!=='string'||Buffer.byteLength(value)>4*1024*1024)throw Error('复制内容过长或格式无效');
      clipboard.writeText(value);return {ok:true};
    });
    ipcMain.handle('uwb:setSettings',(_event,patch)=>updateSettings(patch));
    ipcMain.handle('uwb:export',async(_event,args)=>{
      if(!args||!['csv','raw','terminal'].includes(args.type))throw Error('导出类型无效');
      const extension={csv:'csv',raw:'raw',terminal:'txt'}[args.type];
      const result=await dialog.showSaveDialog(window,{title:'导出记录',defaultPath:`UWB-${args.type}-${Date.now()}.${extension}`,filters:[{name:'记录文件',extensions:[extension]}]});
      if(result.canceled)return {canceled:true};
      return call('export',{type:args.type,path:args.path,destination:result.filePath});
    });
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(url!==page)event.preventDefault();});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'文件',submenu:[{role:'quit',label:'退出'}]},
      {label:'编辑',submenu:[{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},
      {label:'视图',submenu:[{role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'togglefullscreen',label:'全屏'}]}
    ]));
    window.once('ready-to-show',()=>window.show());
    window.loadURL(page);
    window.on('closed',()=>{window=null;});
  }).catch(error=>{dialog.showErrorBox('启动失败',error.message);app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(closing||!worker)return;
    event.preventDefault();closing=true;
    call('close').catch(()=>{}).finally(()=>{worker.kill();app.quit();});
  });
}
