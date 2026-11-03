"use strict";
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
/** 原样保存每个接收块，兼容 MATLAB ComDataSave / ComDataReplay 的三列格式。 */
class SessionRecorder {
  constructor(directory,port,report){
    const now=new Date(),pad=n=>String(n).padStart(2,'0');
    const stamp=`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
    const folder=path.join(directory,'DataSavings',port.replace(/[^\w.-]/g,'_'),String(Date.now()));
    fs.mkdirSync(folder,{recursive:true});this.file=path.join(folder,`ComRecvData_${stamp}.csv`);
    this.chunks=0;this.incomplete=false;this.droppedBytes=0;this.droppedChunks=0;this.maxBufferedBytes=64*1024*1024;this.report=report;this.stream=fs.createWriteStream(this.file,{highWaterMark:1024*1024});
    this.error='';this.stream.on('error',e=>{this.fail(e.message);});
    this.stream.write('ts,len,hexStr\r\n');
  }
  fail(message){if(!this.incomplete){this.incomplete=true;this.error=message;this.report(message);}}
  write(chunk,time=Date.now()){
    if(this.incomplete){this.droppedChunks++;this.droppedBytes+=chunk.length;return false;}
    const hex=chunk.toString('hex').match(/.{2}/g)?.join(' ').toUpperCase()||'';
    const row=`${(time/1000).toFixed(6)},${chunk.length},"${hex}"\r\n`;if(this.stream.writableLength+Buffer.byteLength(row)>this.maxBufferedBytes){this.fail('录制积压超过64MB，已停止该文件录制，文件不完整');this.droppedChunks++;this.droppedBytes+=chunk.length;return false;}this.stream.write(row);this.chunks++;return true;
  }
  close(){if(this.closing)return this.closing;this.closing=(async()=>{await new Promise(resolve=>{const s=this.stream;if(s.destroyed)return resolve();s.once('error',resolve);s.once('close',resolve);s.end(resolve);});try{fs.writeFileSync(this.file+'.meta.json',JSON.stringify({complete:!this.incomplete,error:this.error,droppedBytes:this.droppedBytes,droppedChunks:this.droppedChunks},null,2));}catch(e){this.fail(e.message);}})();return this.closing;}
}
/** @brief 仅按CSV记录的时间逐块读回字节，由调用者决定数据去向。 */
class SessionReplay {
  constructor(file,{onChunk,onState=()=>{}}){this.file=file;this.onChunk=onChunk;this.onState=onState;this.state='paused';this.speed=1;this.position=0;this.count=0;this.token=0;}
  snapshot(){return {file:this.file,state:this.state,speed:this.speed,position:this.position,count:this.count,error:this.error||''};}
  async start(){
    if(this.state==='playing')return;
    if(this.state==='paused'&&this.running){this.state='playing';this.onState();return;}
    const token=++this.token;this.state='playing';this.position=0;this.count=0;this.error='';this.running=true;
    let input,rows;
    const current=()=>token===this.token;
    /** @brief 等待与回调均可被暂停或停止打断；异步写盘/串口回调返回后再次核对本次会话。 */
    const wait=async(remaining=0)=>{
      while(current()&&(remaining>0||this.state==='paused')){
        const before=Date.now();await new Promise(r=>setTimeout(r,Math.min(25,Math.max(1,remaining/this.speed))));
        if(this.state==='playing')remaining-=Math.max(0,Date.now()-before)*this.speed;
      }
      return current();
    };
    try{
      input=fs.createReadStream(this.file);rows=readline.createInterface({input,crlfDelay:Infinity});this.input=input;this.rows=rows;
      let first=null,last=null;
      for await(const row of rows){
        if(!current())break;if(!row.trim()||/^\uFEFF?ts,/.test(row))continue;
        const m=row.match(/^"?([\d.eE+-]+)"?,"?(\d+)"?,"?([a-fA-F\d ]*)"?$/);if(!m)throw Error('回放文件必须是 ts,len,hexStr 三列CSV');
        const ts=Number(m[1]),declared=Number(m[2]),compactHex=m[3].replace(/ /g,'');if(!Number.isSafeInteger(declared)||declared<0||compactHex.length!==declared*2)throw Error('回放十六进制字节数与声明长度不符');const chunk=Buffer.from(compactHex,'hex');if(!Number.isFinite(ts)||chunk.length!==declared)throw Error('回放时间或原始字节长度无效');
        if(first===null)first=ts;
        if(!await wait(last===null?0:Math.max(0,ts-last)*1000))break;
        if(!current())break;
        await this.onChunk(chunk,ts*1000);
        if(!current())break;
        this.position=ts-first;this.count++;last=ts;
      }
      if(current()&&await wait())this.state='ended';
    }catch(e){if(current()){this.state='error';this.error=e.message;}}
    finally{
      rows?.close();input?.destroy();if(this.rows===rows)this.rows=null;if(this.input===input)this.input=null;
      if(current()){this.running=false;this.onState();}
    }
  }
  pause(){if(this.state==='playing')this.state='paused';}
  stop(){this.token++;this.state='stopped';this.running=false;const rows=this.rows,input=this.input;this.rows=null;this.input=null;rows?.close();input?.destroy();}
}
module.exports={SessionRecorder,SessionReplay};
