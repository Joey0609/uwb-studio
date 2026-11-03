/** @file 一秒UKF接收窗口：每条无向边常量内存累计，保留对应双端位置与观测时刻。 */
'use strict';
class UkfWindow {
  constructor(){this.reset();}
  /** @brief 阶段、来源或会话重置时清除所有未融合观测；nowMs为电脑接收时钟毫秒。 */
  reset(nowMs=Date.now()){this.startedAt=nowMs;this.edges=new Map();this.positions=new Map();this.samples=0;}
  /** @brief 仅保留尚未消费的最新有效位置，无测距窗口也保留累计位移基准。 */
  position(index,position,t_us){const old=this.positions.get(index);if(!old||t_us>old.t_us)this.positions.set(index,{position:position.slice(),t_us});}
  /** @brief 每个新样本等权累计；交换端点时同时交换双端位置与时间。 */
  add(i,j,event){
    this.position(i,event.pa,event.ta_us);this.position(j,event.pb,event.tb_us);
    let pa=event.pa,pb=event.pb,ta=event.ta_us,tb=event.tb_us;
    if(i>j){[i,j]=[j,i];[pa,pb]=[pb,pa];[ta,tb]=[tb,ta];}
    const key=`${i}:${j}`,e=this.edges.get(key)||{i,j,count:0,distance:0,pa:[0,0,0],pb:[0,0,0],t_us:0,ta_us:0,tb_us:0};
    e.count++;const k=1/e.count;
    e.distance+=(event.distance-e.distance)*k;e.t_us+=(event.t_us-e.t_us)*k;e.ta_us+=(ta-e.ta_us)*k;e.tb_us+=(tb-e.tb_us)*k;
    for(let axis=0;axis<3;axis++){e.pa[axis]+=(pa[axis]-e.pa[axis])*k;e.pb[axis]+=(pb[axis]-e.pb[axis])*k;}
    this.edges.set(key,e);this.samples++;
  }
  /** @brief 取满一秒的窗口；数据在边界到达前先结算。长时间无数据只跳过空窗，不补算。 */
  take(nowMs=Date.now()){
    const windows=Math.floor((nowMs-this.startedAt)/1000);if(windows<1)return null;
    const startMs=this.startedAt;this.startedAt+=windows*1000;
    const result={startMs,endMs:startMs+1000,windows,edges:[...this.edges.values()],positions:new Map(this.positions)};
    this.edges.clear();this.samples=0;return result;
  }
}
module.exports={UkfWindow};
