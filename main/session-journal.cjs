'use strict';
const fs=require('node:fs/promises');
/** @brief 与原始CSV配套的有界用户操作日志；只保存数据，不保存可执行代码。 */
class SessionJournal {
  constructor(csvFile,{source,startedAt_ms=Date.now(),initial={},onError=()=>{}}={}){
    this.file=csvFile+'.session.json';this.onError=onError;this.revision=0;this.written=0;this.pending=null;this.error='';
    this.data={schema:'uwb-studio-localization-session',version:1,source:source||null,startedAt_ms,
      initial:JSON.parse(JSON.stringify({model:{self:null,mapRevision:null,slots:[],nodes:[],edges:[]},positions:[],...initial})),operations:[]};
    if(Buffer.byteLength(JSON.stringify(this.data.initial))>2*1024*1024)throw Error('实验初始状态超过2MB，操作记录未启动');
    this.record('start',{afterChunks:0,at_ms:startedAt_ms,success:true,stageBefore:0,stageAfter:1});
  }
  /** @brief 同步冻结操作边界；最多4096项，写盘仅有一个运行任务和一份待更新状态。 */
  record(action,{afterChunks=0,at_ms=Date.now(),args,success=true,stageBefore=0,stageAfter=stageBefore,error}={}){
    if(!['start','advance','reset','end','audit'].includes(action))throw Error('实验操作类型无效');
    if(this.data.operations.length>=4096)this.fail('实验操作记录超过4096项，请结束并保存当前实验');
    if(!Number.isSafeInteger(afterChunks)||afterChunks<0||!Number.isFinite(at_ms))throw Error('实验操作时间或数据边界无效');
    const item={afterChunks,at_ms,action,success:success===true,stageBefore,stageAfter};
    if(args!==undefined){const raw=JSON.stringify(args);if(Buffer.byteLength(raw)>16384)this.fail('实验操作参数超过16KB');item.args=JSON.parse(raw);}
    if(error)item.error=String(error).slice(0,2048);
    let at=this.data.operations.length;
    while(at>0){const prior=this.data.operations[at-1];if(prior.afterChunks<item.afterChunks||(prior.afterChunks===item.afterChunks&&prior.at_ms<=item.at_ms))break;at--;}
    this.data.operations.splice(at,0,item);this.dirty();return item;
  }
  fail(message){this.incomplete=true;this.error=message;this.data.complete=false;this.data.error=message;this.dirty();this.onError(message);throw Error(message);}
  /** @brief 保存失败时修正本次reset结果；不得把失败导出标成成功。 */
  revise(item,changes){if(!this.data.operations.includes(item))throw Error('实验操作记录不存在');Object.assign(item,changes);this.dirty();}
  end(at_ms=Date.now()){if(this.data.endedAt_ms===undefined){this.data.endedAt_ms=at_ms;this.dirty();}}
  dirty(){this.revision++;if(!this.pending){this.pending=this.writeDirty().finally(()=>{this.pending=null;});this.pending.catch(error=>{this.error=error.message;this.onError(error.message);});}}
  async writeDirty(){
    while(this.written<this.revision){
      const revision=this.revision,bytes=JSON.stringify(this.data,null,2);
      await fs.writeFile(this.file+'.tmp',bytes,'utf8');
      await fs.rename(this.file+'.tmp',this.file);this.written=revision;this.error='';
    }
  }
  /** @brief 等待当前版本落盘；失败后保留内存与原文件，下次允许重试。 */
  async flush(){
    if(this.pending){try{await this.pending;}catch{/** @brief 允许本次显式flush重试一次，不积压多个写盘任务。 */}}
    if(this.written<this.revision){this.dirty();if(this.pending)await this.pending;}
  }
}
module.exports={SessionJournal};
