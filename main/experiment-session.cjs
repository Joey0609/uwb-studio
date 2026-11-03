"use strict";
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {SessionRecorder}=require('./session-io.cjs');
const {SessionJournal}=require('./session-journal.cjs');
/** @brief 实验从显式开始起按观察串口原样录制；CSV和阶段操作日志共同保存，失败可重试。 */
class ExperimentSession {
  constructor(localization,directory){this.localization=localization;this.directory=directory;this.active=false;this.saving=false;this.finalized=false;this.error='';this.journal=null;}
  snapshot(){const s=this.localization.snapshot();return {...s,stage:this.active?s.stage:0,canAdvance:this.active&&!this.finalized&&s.canAdvance,experimentActive:this.active,saving:this.saving,recordingError:this.error};}
  async start(){
    if(this.starting||this.active)throw Error('实验已经开始，请先重置并保存');
    if(!this.localization.source)throw Error('请选择已连接的观察串口');
    this.starting=true;this.error='';this.finalized=false;this.journal=null;
    try{
      this.recorder=new SessionRecorder(path.join(this.directory,'experiments',randomUUID()),this.localization.source,error=>{this.error=error;});
      await new Promise((resolve,reject)=>{this.recorder.stream.once('open',resolve);this.recorder.stream.once('error',reject);});
      this.localization.reset();this.startedAt_ms=Date.now();this.active=true;return this.snapshot();
    }finally{this.starting=false;}
  }
  /** @brief 开始完成后在同一事件循环创建初始状态；首项始终为afterChunks=0的start。 */
  beginJournal(context={}){
    if(!this.active||!this.recorder)throw Error('实验尚未开始，不能创建操作记录');
    if(this.journal)throw Error('实验操作记录已经创建');
    this.journal=new SessionJournal(this.recorder.file,{source:this.localization.source,startedAt_ms:this.startedAt_ms,initial:context,onError:message=>{this.error='实验操作记录写入失败：'+message;}});
    return this.journal;
  }
  /** @brief 在调用时同步取块数及阶段，持久化任务不改变原始CSV或块边界。 */
  recordOperation(action,details={}){
    if(!this.journal)this.beginJournal();
    const stage=this.localization.stage;
    this.journal.record(action,{afterChunks:this.recorder.chunks,at_ms:Date.now(),stageBefore:stage,stageAfter:stage,...details});
    return this.flushJournal();
  }
  async flushJournal(){if(this.journal)await this.journal.flush();}
  capture(port,chunk,time){if(this.active&&!this.finalized&&port===this.localization.source)this.recorder.write(chunk,time);}
  /** @brief 首次结束时冻结原始流；保存失败保留本轮，两份目标文件必须全部复制成功。 */
  async reset(destination){
    if(!this.active)throw Error('请先开始实验');
    if(this.saving)throw Error('正在保存本轮实验');
    const boundary={afterChunks:this.recorder.chunks,at_ms:Date.now(),stageBefore:this.localization.stage};
    if(typeof destination!=='string'||!path.isAbsolute(destination)){
      await this.recordOperation('reset',{...boundary,success:false,error:'实验保存路径必须是绝对路径'});
      throw Error('实验保存路径必须是绝对路径');
    }
    this.saving=true;this.error='';const created=[];let resetOperation;
    try{
      if(!this.journal)this.beginJournal();
      if(!this.finalized){this.finalized=true;this.journal.record('end',{...boundary,success:true,stageAfter:boundary.stageBefore});this.journal.end(boundary.at_ms);}
      await this.recorder.close();
      if(this.recorder.incomplete)throw Error('本轮记录不完整：'+this.recorder.error);
      if(this.journal.incomplete)throw Error('操作记录不完整：'+this.journal.error);
      await fs.mkdir(destination,{recursive:true});
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      const filePath=path.join(destination,`Experiment-${stamp}-${randomUUID().slice(0,8)}.csv`),sessionFilePath=filePath+'.session.json';
      resetOperation=this.journal.record('reset',{...boundary,success:true,stageAfter:0});
      await this.flushJournal();
      await fs.copyFile(this.recorder.file,filePath,require('node:fs').constants.COPYFILE_EXCL);created.push(filePath);
      await fs.copyFile(this.journal.file,sessionFilePath,require('node:fs').constants.COPYFILE_EXCL);created.push(sessionFilePath);
      this.active=false;this.error='';this.localization.reset();return {...this.snapshot(),filePath,sessionFilePath};
    }catch(error){
      for(const file of created)try{await fs.unlink(file);}catch{}
      const message=error.message;this.error=message;
      try{
        if(resetOperation)this.journal.revise(resetOperation,{success:false,stageAfter:boundary.stageBefore,error:message});
        else if(this.journal)this.journal.record('reset',{...boundary,success:false,stageAfter:boundary.stageBefore,error:message});
        await this.flushJournal();
      }catch(journalError){this.error=message+'；操作记录未保存：'+journalError.message;}
      throw Error('实验保存失败，记录已保留：'+this.error);
    }finally{this.saving=false;}
  }
  async close(){
    let failure;
    try{
      if(this.active&&!this.finalized){
        if(!this.journal)this.beginJournal();
        this.finalized=true;const at_ms=Date.now(),stage=this.localization.stage;
        this.journal.record('end',{afterChunks:this.recorder.chunks,at_ms,success:true,stageBefore:stage,stageAfter:stage});this.journal.end(at_ms);
      }
    }catch(error){failure=error;}
    await this.recorder?.close();await this.flushJournal();if(failure)throw failure;
  }
}
module.exports={ExperimentSession};
