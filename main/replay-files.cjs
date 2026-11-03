"use strict";
const path=require('node:path');
const HISTORY_LIMIT=10;
/** @brief 保存验证成功的CSV绝对路径；Windows路径按大小写无关去重。 */
function normalizeHistory(files,pathApi=path){
  if(!Array.isArray(files))return [];
  const seen=new Set(),result=[];
  for(const file of files){
    if(typeof file!=='string'||!file.trim()||!pathApi.isAbsolute(file)||/[\0\r\n]/.test(file))continue;
    const absolute=pathApi.normalize(file),key=absolute.toLowerCase();
    if(seen.has(key))continue;seen.add(key);result.push(absolute);if(result.length===HISTORY_LIMIT)break;
  }
  return result;
}
/** @brief 对话框与历史选择共用指定回放的校验入口，文件与串口历史彼此独立。 */
class ReplayFiles {
  constructor({call,showOpenDialog,getHistory,saveHistory,getDirectory=()=>null,pathApi=path,method='replayAction'}){
    this.method=method;this.getDirectory=getDirectory;this.call=call;this.showOpenDialog=showOpenDialog;this.getHistory=getHistory;this.saveHistory=saveHistory;this.path=pathApi;this.busy=false;
  }
  history(){return normalizeHistory(this.getHistory(),this.path);}
  decorate(snapshot){return {...snapshot,history:this.history().map(file=>({file,fileName:this.path.basename(file)}))};}
  assertIdle(snapshot){if(['running','playing','paused','connecting','stopping'].includes(snapshot.state))throw Error('请先停止当前回放再选择CSV');}
  async loadFile(file){
    const snapshot=await this.call(this.method,{action:'snapshot'});this.assertIdle(snapshot);
    const loaded=await this.call(this.method,{action:'open',file});
    await this.saveHistory(normalizeHistory([loaded.file,...this.history()],this.path));
    return this.decorate(loaded);
  }
  async action(args={}){
    if(args.action!=='open'&&args.action!=='history')return this.decorate(await this.call(this.method,args));
    if(this.busy)throw Error('正在选择CSV，请稍后再试');this.busy=true;
    try{
      const snapshot=await this.call(this.method,{action:'snapshot'});this.assertIdle(snapshot);
      if(args.action==='history'){
        if(typeof args.file!=='string')throw Error('历史文件无效');
        const selected=this.history().find(file=>file.toLowerCase()===this.path.normalize(args.file).toLowerCase());
        if(!selected)throw Error('历史文件不存在');
        return await this.loadFile(selected);
      }
      const options={title:this.method==='fileReplayAction'?'选择文件回放CSV':'选择回放CSV',properties:['openFile'],filters:[{name:'串口数据CSV',extensions:['csv']}]};
      const directory=this.getDirectory();if(directory)options.defaultPath=directory;
      const picked=await this.showOpenDialog(options);
      if(picked.canceled||!picked.filePaths?.length)return this.decorate(snapshot);
      return await this.loadFile(picked.filePaths[0]);
    }finally{this.busy=false;}
  }
}
module.exports={ReplayFiles,normalizeHistory,HISTORY_LIMIT};
