'use strict';

/** USB 混合流：零边界内是 COBS，边界外按完整行交给文字解码器。 */
function crc16(bytes) {
  let crc=0xffff;
  for(const byte of bytes){crc^=byte<<8;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}
  return crc;
}
function decodeCobs(bytes) {
  const out=[];
  for(let at=0;at<bytes.length;){const code=bytes[at++];if(!code||at+code-1>bytes.length)throw Error('COBS长度错误');for(let n=1;n<code;n++)out.push(bytes[at++]);if(code<255&&at<bytes.length)out.push(0);}
  return Buffer.from(out);
}
function encodeCobs(bytes) {
  const out=[0];let codeAt=0,code=1;
  for(const byte of bytes){if(byte===0){out[codeAt]=code;codeAt=out.length;out.push(0);code=1;}else{out.push(byte);if(++code===255){out[codeAt]=code;codeAt=out.length;out.push(0);code=1;}}}out[codeAt]=code;return Buffer.from(out);
}
function encodeFrame(type,sequence,revision,payload=Buffer.alloc(0)) {
  const raw=Buffer.alloc(8+payload.length);raw[0]=1;raw[1]=type;raw.writeUInt16LE(sequence,2);raw.writeUInt16LE(revision,4);payload.copy(raw,6);raw.writeUInt16LE(crc16(raw.subarray(0,-2)),raw.length-2);return Buffer.concat([Buffer.from([0]),encodeCobs(raw),Buffer.from([0])]);
}
class TelemetryFramer {
  constructor({onLine,onFrame,onError}){this.onLine=onLine;this.onFrame=onFrame;this.onError=onError;this.binary=false;this.bytes=[];this.text=[];this.lastSequence=null;this.overflow=false;this.textNul=false;this.textNulCRs=0;}
  push(chunk){
    for(const byte of chunk){
      // 旧 STM printf 会把字符串终止 NUL 连同一个或两个 CR 和 LF 发出。
      // 仅有未结束文字且完整匹配该尾缀才结束文字行；其余仍进入严格二进制校验。
      // 延迟判断可正确保留首 COBS code=13/10、下一字节为版本 1 的合法帧。
      if(this.textNul){
        if(byte===13&&this.textNulCRs<2){this.textNulCRs++;continue;}
        if(byte===10&&this.textNulCRs>0){this.onLine(Buffer.from(this.text));this.text=[];this.textNul=false;this.textNulCRs=0;continue;}
        this.onLine(Buffer.from(this.text));this.text=[];this.binary=true;this.textNul=false;
        for(let n=0;n<this.textNulCRs;n++)this.bytes.push(13);this.textNulCRs=0;
      }
      if(byte===0){
        if(this.binary){if(!this.bytes.length&&!this.overflow)continue;if(!this.overflow)this.decode(Buffer.from(this.bytes));this.binary=false;this.bytes=[];this.overflow=false;}
        else{if(this.text.length){this.textNul=true;this.textNulCRs=0;continue;}this.binary=true;}
      }else if(this.binary){if(this.bytes.length<510)this.bytes.push(byte);else if(!this.overflow){this.overflow=true;this.onError('二进制帧超过512字节');}}
      else if(byte===10){this.onLine(Buffer.from(this.text));this.text=[];}
      else if(this.text.length<16384)this.text.push(byte);
      else{this.text=[];this.onError('文字记录超过16KB');}
    }
  }
  decode(encoded){
    try{
      const bytes=decodeCobs(encoded);
      if(bytes.length<8||bytes[0]!==1||crc16(bytes.subarray(0,-2))!==bytes.readUInt16LE(bytes.length-2))throw Error('二进制版本或CRC错误');
      const type=bytes[1],sequence=bytes.readUInt16LE(2),revision=bytes.readUInt16LE(4),payload=bytes.subarray(6,-2);
      if(![1,2,3,4].includes(type)||(type===1&&payload.length%5)||(type===2||type===3)&&(payload.length%6||payload.length>480)||type===4&&payload.length)throw Error('二进制消息类型或长度错误');
      const gap=this.lastSequence!==null&&sequence!==((this.lastSequence+1)&0xffff);this.lastSequence=sequence;
      if(gap&&type!==4)this.onError('二进制批次缺失');
      this.onFrame({type,sequence,revision,payload,gap});
    }catch(error){this.onError(error.message);}
  }
}
module.exports={TelemetryFramer,crc16,decodeCobs,encodeCobs,encodeFrame};
