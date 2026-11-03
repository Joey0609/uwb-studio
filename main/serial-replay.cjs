"use strict";
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {SessionReplay}=require('./session-io.cjs');
/** @brief 独立占用发送串口，按CSV记录的原始字节与时间间隔回放。 */
class SerialReplay {
  constructor({SerialPort}){
    this.SerialPort=SerialPort;this.device=null;this.path='';this.state='disconnected';this.speed=1;this.baudRate=115200;
    this.file='';this.total=0;this.index=0;this.bytes=0;this.error='';this.logs=[];this.logId=0;
    this.pending=null;this.replay=null;this.replayTask=null;this.generation=0;
  }
  snapshot(){return {path:this.path,connected:!!this.device?.isOpen,reserved:!!this.device,state:this.state,speed:this.speed,baudRate:this.baudRate,index:this.index,total:this.total,file:this.file,fileName:this.file?path.basename(this.file):'',bytes:this.bytes,error:this.error,logs:this.logs.slice()};}
  log(text,type='system',time=Date.now()){this.logs.push({id:++this.logId,time,text,type});if(this.logs.length>500)this.logs.splice(0,this.logs.length-500);}
  fail(error){this.generation++;this.replay?.stop();this.error=error.message||String(error);this.state='error';this.log(this.error,'error');}
  /** @brief 仅校验并打开ts,len,hexStr三列CSV，不读取旁文件或解析数据协议。 */
  async loadFile(file){
    if(this.state==='connecting')throw Error('正在连接发送串口，请稍后再试');
    if(typeof file!=='string'||!file.trim())throw Error('请选择CSV文件');
    const absolute=path.resolve(file),input=fs.createReadStream(absolute),rows=readline.createInterface({input,crlfDelay:Infinity});
    let count=0;
    try{
      for await(const row of rows){
        if(!row.trim()||/^\uFEFF?ts,/.test(row))continue;
        const m=row.match(/^"?([\d.eE+-]+)"?,"?(\d+)"?,"?([a-fA-F\d ]*)"?$/);
        if(!m)throw Error('回放文件必须是 ts,len,hexStr 三列CSV');
        const ts=Number(m[1]),length=Number(m[2]),hex=m[3].replace(/ /g,'');
        if(!Number.isFinite(ts)||!Number.isSafeInteger(length)||length<0||hex.length!==length*2||Buffer.from(hex,'hex').length!==length)throw Error('回放时间或原始字节长度无效');
        count++;
      }
      if(!count)throw Error('CSV文件没有接收数据');
    }finally{rows.close();input.destroy();}
    await this.quiesce();this.file=absolute;this.total=count;this.index=0;this.bytes=0;this.error='';
    this.state=this.device?.isOpen?'connected':'disconnected';this.log(path.basename(absolute));return this.snapshot();
  }
  /** @brief 阻断新片并等待当前片完成；停止后不补发未完成CSV块的剩余字节。 */
  async quiesce(){
    this.state='stopping';this.generation++;this.replay?.stop();
    await this.pending?.catch(()=>{});await this.replayTask?.catch(()=>{});this.replay=null;this.replayTask=null;
  }
  /** @brief 仅完整发完原始CSV块才计数，日志使用实际发送完成时刻。 */
  recordBytes(bytes){
    const time=Date.now();this.bytes+=bytes.length;this.index++;
    const text=bytes.toString('utf8');
    if(bytes.includes(0)||text.includes('\ufffd'))this.log(bytes.toString('hex').match(/.{2}/g)?.join(' ').toUpperCase()||'','tx',time);
    else for(const line of text.trimEnd().split(/\r?\n/))this.log(line,'tx',time);
  }
  /** @brief 逐片等待write与drain，并按8N1线速让出执行时间，避免虚拟口队列溢出。 */
  startFile(){
    const generation=this.generation,device=this.device;
    const replay=new SessionReplay(this.file,{
      onChunk:async bytes=>{
        for(let offset=0;offset<bytes.length;offset+=512){
          while(generation===this.generation&&this.state==='paused')await new Promise(r=>setTimeout(r,20));
          if(generation!==this.generation||this.state!=='running')return;
          const part=bytes.subarray(offset,offset+512),started=Date.now();
          const task=(async()=>{
            await new Promise((r,j)=>device.write(part,e=>e?j(e):r()));await new Promise((r,j)=>device.drain(e=>e?j(e):r()));
            await new Promise(r=>setTimeout(r,Math.max(1,Math.ceil(part.length*10000/this.baudRate-(Date.now()-started)))));
          })();this.pending=task;try{await task;}finally{if(this.pending===task)this.pending=null;}
          if(generation!==this.generation)return;
        }
        if(generation===this.generation)this.recordBytes(bytes);
      },
      onState:()=>{
        if(generation!==this.generation)return;
        if(replay.state==='error')this.fail(Error(replay.error));
        else if(replay.state==='ended'){this.state='finished';this.log('文件发送完成');}
      }
    });
    this.replay=replay;replay.speed=this.speed;this.replayTask=replay.start();
    this.replayTask.catch(e=>{if(generation===this.generation)this.fail(e);});
  }
  /** @brief 控制独立发送端；不读取或变更定位接收口、定位状态和阶段。 */
  async action(args={}){
    const {action}=args;
    if(action==='snapshot')return this.snapshot();
    if(action==='open')return this.loadFile(args.file);
    if(action==='connect'){
      if(this.device||this.state==='connecting')throw Error('请先断开当前发送串口');
      if(typeof args.path!=='string'||!args.path.trim()||args.path.length>256||!Number.isInteger(args.baudRate)||args.baudRate<1200||args.baudRate>3000000)throw Error('发送串口参数无效');
      this.path=args.path;this.baudRate=args.baudRate;this.state='connecting';this.error='';
      const device=this.device=new this.SerialPort({path:this.path,baudRate:this.baudRate,autoOpen:false});
      device.on('error',e=>{if(this.device===device)this.fail(e);});device.on('data',()=>{});
      device.on('close',()=>{if(this.device===device){this.generation++;this.replay?.stop();this.device=null;this.state='disconnected';this.log('发送串口已断开');}});
      try{await new Promise((r,j)=>device.open(e=>e?j(e):r()));await new Promise(r=>device.set({dtr:false,rts:false},()=>r()));this.state='connected';this.log(`已连接 ${this.path} · ${this.baudRate}`);}
      catch(e){this.device=null;this.fail(e);throw e;}
    }else if(action==='disconnect'){
      if(this.state==='connecting')throw Error('正在连接发送串口，请稍后再试');
      await this.quiesce();const d=this.device;
      if(d?.isOpen)await new Promise((r,j)=>d.close(e=>e?j(e):r()));this.device=null;this.state='disconnected';
    }else if(action==='speed'){
      if(![.25,.5,1,2,4,8,20].includes(Number(args.speed)))throw Error('回放速度无效');
      this.speed=Number(args.speed);if(this.replay)this.replay.speed=this.speed;
    }else if(action==='clear'){this.logs=[];
    }else if(action==='stop'){
      if(this.state==='connecting')throw Error('正在连接发送串口，请稍后再试');
      await this.quiesce();this.index=0;this.bytes=0;this.state=this.device?.isOpen?'connected':'disconnected';this.log('发送已停止');
    }else if(action==='pause'){
      if(this.state!=='running')throw Error('当前没有正在发送的数据');
      this.state='paused';this.replay?.pause();await this.pending?.catch(()=>{});
    }else if(action==='start'||action==='continue'){
      if(!this.device?.isOpen)throw Error('请先连接发送串口');
      if(!this.file)throw Error('请先打开CSV文件');
      if(this.state==='running')return this.snapshot();
      if(action==='start'){
        if(!['connected','finished'].includes(this.state))throw Error('请先停止当前回放');
        this.index=0;this.bytes=0;this.error='';this.state='running';this.log('开始发送文件');this.startFile();
      }else{
        if(this.state!=='paused')throw Error('当前没有暂停的回放');
        this.error='';this.state='running';this.replay?.start();
      }
    }else throw Error('回放操作无效');
    return this.snapshot();
  }
}
module.exports={SerialReplay};
