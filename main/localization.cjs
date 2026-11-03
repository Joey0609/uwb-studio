'use strict';

/** 二维协同定位：静止距离均值、移动旋转初始化与有效边 UKF。坐标和距离使用米。 */
const eye = (n, scale = 1) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? scale : 0));
const zeros = (n, m) => Array.from({ length: n }, () => Array(m).fill(0));
const transpose = a => a[0].map((_, j) => a.map(r => r[j]));
const mul = (a, b) => a.map(r => b[0].map((_, j) => r.reduce((s, v, k) => s + v * b[k][j], 0)));
const sym = a => a.map((r, i) => r.map((v, j) => (v + a[j][i]) / 2));
const finitePosition = p => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(Number.isFinite);
const pairKey = (a, b) => Number(a) < Number(b) ? `${a}:${b}` : `${b}:${a}`;
const {UkfWindow}=require('./ukf-window.cjs');
/** @brief 初始化方向估计的默认运动阈值，单位米；不滤除原始坐标或累计位移。 */
const DEFAULT_MOTION_EPSILON_M=1e-3;
/** @brief 设置初始化原点时，最新真实位置允许的最长电脑接收年龄，单位毫秒。 */
const ORIGIN_POSITION_MAX_AGE_MS=1000;

/** 对称特征分解；返回按特征值递减排列的列特征向量。 */
function eigen(a) {
  const n = a.length, d = a.map(r => r.slice()), v = eye(n);
  for (let k = 0; k < 100 * n * n; k++) {
    let p = 0, q = 1, best = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(d[i][j]) > best) { best = Math.abs(d[i][j]); p = i; q = j; }
    if (best < 1e-12) break;
    const angle = .5 * Math.atan2(2 * d[p][q], d[q][q] - d[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const app = d[p][p], aqq = d[q][q], apq = d[p][q];
    for (let i = 0; i < n; i++) if (i !== p && i !== q) {
      const x = d[i][p], y = d[i][q];
      d[i][p] = d[p][i] = c * x - s * y; d[i][q] = d[q][i] = s * x + c * y;
    }
    d[p][p] = c*c*app - 2*s*c*apq + s*s*aqq; d[q][q] = s*s*app + 2*s*c*apq + c*c*aqq; d[p][q] = d[q][p] = 0;
    for (let i = 0; i < n; i++) { const x = v[i][p], y = v[i][q]; v[i][p] = c*x-s*y; v[i][q] = s*x+c*y; }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => d[j][j] - d[i][i]);
  return { values: order.map(i => d[i][i]), vectors: v.map(r => order.map(i => r[i])) };
}

/** 经典二维 MDS；负特征值截零，随后固定初始坐标规范以保持可重复性。 */
function mds(distances) {
  const n = distances.length;
  if (n < 3 || distances.some(r => r.length !== n || r.some(v => !Number.isFinite(v) || v < 0))) throw new Error('初始定位需要至少三个节点的完整距离矩阵');
  const squared = distances.map(r => r.map(v => v*v)), row = squared.map(r => r.reduce((a,b)=>a+b,0)/n), mean = row.reduce((a,b)=>a+b,0)/n;
  const e = eigen(squared.map((r, i) => r.map((v, j) => -.5*(v-row[i]-row[j]+mean))));
  if (!(e.values[1] > 1e-8)) throw new Error('节点共线或几何退化，无法初始化二维拓扑');
  let p = e.vectors.map(r => [r[0]*Math.sqrt(Math.max(0,e.values[0])),r[1]*Math.sqrt(Math.max(0,e.values[1]))]);
  const origin = p[0].slice(), angle = -Math.atan2(p[1][1]-origin[1],p[1][0]-origin[0]);
  p = p.map(r => rotate([r[0]-origin[0],r[1]-origin[1]],angle));
  const third = p.find((r,i) => i > 1 && Math.abs(r[1]) > 1e-8);
  if (third && third[1] < 0) p = p.map(r => [r[0],-r[1]]);
  return { positions: p, eigenvalues: e.values, thirdDimension: Math.sqrt(Math.max(0,e.values[2] || 0)) };
}
function rotate(p,a) { const c=Math.cos(a),s=Math.sin(a); return [p[0]*c-p[1]*s,p[0]*s+p[1]*c]; }

/** 原 MATLAB 目标：最小化所有移动时刻平方距离矩阵的 Frobenius 残差。 */
function initializeMoving(base, frames, options = {}) {
  const n=base.length, first=frames[0].raw;
  if (frames.length < 2) throw new Error('尚无移动时间组');
  const objective = (angles,flip, wantPositions=false) => {
    // MATLAB 的行向量 P*Q 对应先全局反向旋转、后镜像；局部位移为正向旋转。
    const p=base.map(r=>{const v=rotate(r,-angles[0]);return [v[0],v[1]*flip];}); let cost=0; const history=[];
    for (let f=0;f<frames.length;f++) {
      const at=p.map((r,i)=>{const delta=rotate([frames[f].raw[i][0]-first[i][0],frames[f].raw[i][1]-first[i][1]],i===0?0:angles[i]);return [r[0]+delta[0],r[1]+delta[1]];});
      if (f>0) for(let i=0;i<n;i++) for(let j=0;j<i;j++) {const q=(at[i][0]-at[j][0])**2+(at[i][1]-at[j][1])**2-frames[f].distances[i][j]**2;cost+=2*q*q;}
      if(wantPositions)history.push(at);
    }
    return wantPositions?history:cost;
  };
  let best={cost:Infinity}; const starts=options.starts || 20;
  for(const flip of [1,-1]) for(let trial=0;trial<starts;trial++) {
    let x=Array.from({length:n},(_,i)=>trial===0?0:2*Math.PI*((((trial+1)*(i+3)*.61803398875)%1)-.5));
    let value=objective(x,flip), step=Math.PI/2;
    for(let it=0;it<160 && step>1e-5;it++) {
      let changed=false;
      for(let i=0;i<n;i++) {
        let chosen=x[i], score=value;
        for(const sign of [-1,1]) {const y=x.slice();y[i]+=sign*step;const cost=objective(y,flip);if(cost<score){chosen=y[i];score=cost;}}
        if(score<value){x[i]=chosen;value=score;changed=true;}
      }
      if(!changed)step*=.55;
    }
    if(value<best.cost)best={angles:x,flip,cost:value};
  }
  return {...best,history:objective(best.angles,best.flip,true)};
}

/** 异步测距目标直接使用每条边采样时刻的两端位置，禁止把窗口末位置当同步快照。 */
function initializeAsync(base, origins, samples, options={}) {
  const n=base.length,motionEpsilon_m=options.motionEpsilon_m??DEFAULT_MOTION_EPSILON_M;
  // 相对初始化原点的最大位移超过1毫米才估计该节点方向，避免静止抖动引入不可观测参数。
  const maxDisplacement=Array(n).fill(0);
  for(const e of samples)for(const [i,p]of [[e.i,e.pa],[e.j,e.pb]])maxDisplacement[i]=Math.max(maxDisplacement[i],Math.hypot(p[0]-origins[i][0],p[1]-origins[i][1]));
  const moving=maxDisplacement.map(d=>d>motionEpsilon_m);
  // index0静止时，它的局部坐标不提供方向基准。固定全局MDS方向，去掉规约自由度。
  const active=Array.from({length:n},(_,i)=>i).filter(i=>moving[i]);
  const canonical=x=>x.map((v,i)=>active.includes(i)?v:0);
  function residuals(x,flip){const initial=base.map(p=>{const q=rotate(p,-x[0]);return [q[0],q[1]*flip];});return samples.map(e=>{const pa=rotate([e.pa[0]-origins[e.i][0],e.pa[1]-origins[e.i][1]],e.i===0?0:x[e.i]),pb=rotate([e.pb[0]-origins[e.j][0],e.pb[1]-origins[e.j][1]],e.j===0?0:x[e.j]);return (initial[e.i][0]+pa[0]-initial[e.j][0]-pb[0])**2+(initial[e.i][1]+pa[1]-initial[e.j][1]-pb[1])**2-e.distance**2;});}
  const cost=(x,f)=>residuals(x,f).reduce((s,v)=>s+v*v,0);
  if(!active.length){const angles=Array(n).fill(0);return {angles,flip:1,cost:cost(angles,1),initial:base.map(p=>p.slice()),observable:false,spectrum:[],activeParameters:[],orientationKnown:moving,gaugeFixed:true,motionEpsilon_m};}
  function jacobian(x,f){const r=residuals(x,f),j=zeros(r.length,active.length),h=1e-5;for(let k=0;k<active.length;k++){const y=x.slice();y[active[k]]+=h;const r2=residuals(y,f);for(let i=0;i<r.length;i++)j[i][k]=(r2[i]-r[i])/h;}return {r,j};}
  let best=options.previous?{angles:canonical(options.previous.angles),flip:options.previous.flip,cost:cost(canonical(options.previous.angles),options.previous.flip)}:{cost:Infinity};
  for(const flip of [1,-1])for(let trial=0;trial<(options.starts||16);trial++){
    if(Number.isFinite(best.cost)&&options.deadline&&Date.now()>options.deadline)break;
    let x=canonical(trial===0&&options.previous?.flip===flip?options.previous.angles.slice():Array.from({length:n},(_,i)=>trial===0?0:2*Math.PI*((((trial+1)*(i+3)*.61803398875)%1)-.5)));
    let score=cost(x,flip),lambda=.001;
    for(let iter=0;iter<65;iter++){
      if(iter>0&&options.deadline&&Date.now()>options.deadline)break;
      const {r,j}=jacobian(x,flip),jt=transpose(j),normal=mul(jt,j),gradient=mul(jt,r.map(v=>[-v]));for(let k=0;k<active.length;k++)normal[k][k]+=lambda;
      let step;try{step=solve(normal,gradient).map(v=>v[0]);}catch{break;}
      const y=x.slice();active.forEach((index,k)=>y[index]+=step[k]);const next=cost(y,flip);
      if(next<score){x=y;score=next;lambda=Math.max(1e-10,lambda/3);if(Math.hypot(...step)<1e-7)break;}else lambda*=8;
      if(lambda>1e12)break;
    }
    if(score<best.cost)best={angles:x,flip,cost:score};
  }
  const {j}=jacobian(best.angles,best.flip),spectrum=eigen(mul(transpose(j),j)).values;
  best.observable=spectrum.at(-1)>Math.max(1e-8,spectrum[0]*1e-7);best.spectrum=spectrum;
  best.initial=base.map(p=>{const q=rotate(p,-best.angles[0]);return [q[0],q[1]*best.flip];});
  return {...best,activeParameters:active,orientationKnown:moving,gaugeFixed:!moving[0],motionEpsilon_m};
}

function cholesky(a) {
  const n=a.length,l=zeros(n,n);
  for(let i=0;i<n;i++)for(let j=0;j<=i;j++){let s=a[i][j];for(let k=0;k<j;k++)s-=l[i][k]*l[j][k];if(i===j){if(!(s>0))throw new Error('协方差非正定');l[i][j]=Math.sqrt(s);}else l[i][j]=s/l[j][j];}
  return l;
}
function solve(a,b) {
  const n=a.length,m=b[0].length,aug=a.map((r,i)=>r.concat(b[i]));
  for(let k=0;k<n;k++) {let p=k;for(let i=k+1;i<n;i++)if(Math.abs(aug[i][k])>Math.abs(aug[p][k]))p=i;
    if(Math.abs(aug[p][k])<1e-18)throw new Error('量测协方差奇异'); [aug[k],aug[p]]=[aug[p],aug[k]];
    const pivot=aug[k][k];for(let j=k;j<n+m;j++)aug[k][j]/=pivot;
    for(let i=0;i<n;i++)if(i!==k){const f=aug[i][k];for(let j=k;j<n+m;j++)aug[i][j]-=f*aug[k][j];}
  }return aug.map(r=>r.slice(n));
}
/** 与 MDR_calc_ukf.m 相同的 sigma 点、过程模型和有效边量测更新。 */
function ukf(previous, covariance, displacement, edges, e1=.10,e2=.20,params={alpha:1e-3,beta:2,kappa:0}) {
  const n=previous.length,l=2*n,x=previous.flat(),u=displacement.flat(),p=covariance? sym(covariance):eye(l,e1*e1),q=e1*e1;
  const grouped=new Map();for(const [a,b,d,offsetA=[0,0],offsetB=[0,0]] of edges)if(a!==b&&a>=0&&b>=0&&a<n&&b<n&&Number.isFinite(d)&&d>0){
    const oa=a<b?offsetA:offsetB,ob=a<b?offsetB:offsetA;
    if(!Array.isArray(oa)||!Array.isArray(ob)||oa.length!==2||ob.length!==2||!oa.concat(ob).every(Number.isFinite))continue;
    const key=`${pairKey(a,b)}:${oa.join(',')}:${ob.join(',')}`,old=grouped.get(key)||{a:Math.min(a,b),b:Math.max(a,b),oa,ob,sum:0,count:0};old.sum+=d;old.count++;grouped.set(key,old);
  }
  const es=[...grouped.values()].map(e=>[e.a,e.b,e.sum/e.count,e.oa,e.ob]);
  if(!es.length)return {positions:previous.map((r,i)=>r.map((v,j)=>v+displacement[i][j])),covariance:p.map((r,i)=>r.map((v,j)=>v+(i===j?q:0)))};
  const alpha=params.alpha??1e-3,beta=params.beta??2,kappa=params.kappa??0,c=alpha*alpha*(l+kappa),lambda=c-l;
  let root,jitter=0;for(let attempt=0;attempt<6;attempt++){try{root=cholesky(p.map((r,i)=>r.map((v,j)=>c*(v+(i===j?jitter:0)))));break;}catch{jitter=jitter?jitter*10:1e-10*Math.max(1,p.reduce((s,r,i)=>s+r[i],0)/l);}}
  if(!root){const min=Math.min(...eigen(p).values);root=cholesky(p.map((r,i)=>r.map((v,j)=>c*(v+(i===j?Math.abs(min)+1e-9:0)))));}
  const sig=[x.map((v,i)=>v+u[i])];for(let k=0;k<l;k++)sig.push(x.map((v,i)=>v+u[i]+root[i][k]));for(let k=0;k<l;k++)sig.push(x.map((v,i)=>v+u[i]-root[i][k]));
  const wm=Array(2*l+1).fill(1/(2*c)),wc=wm.slice();wm[0]=lambda/c;wc[0]=wm[0]+1-alpha*alpha+beta;
  const xp=Array(l).fill(0),zs=sig.map(s=>es.map(([a,b,,oa,ob])=>Math.hypot(s[2*a]+oa[0]-s[2*b]-ob[0],s[2*a+1]+oa[1]-s[2*b+1]-ob[1]))),m=es.length,zp=Array(m).fill(0);
  for(let k=0;k<sig.length;k++){for(let i=0;i<l;i++)xp[i]+=wm[k]*sig[k][i];for(let i=0;i<m;i++)zp[i]+=wm[k]*zs[k][i];}
  let pp=eye(l,q),ss=eye(m,e2*e2+1e-12),pxz=zeros(l,m);
  for(let k=0;k<sig.length;k++){const dx=sig[k].map((v,i)=>v-xp[i]),dz=zs[k].map((v,i)=>v-zp[i]);for(let i=0;i<l;i++){for(let j=0;j<l;j++)pp[i][j]+=wc[k]*dx[i]*dx[j];for(let j=0;j<m;j++)pxz[i][j]+=wc[k]*dx[i]*dz[j];}for(let i=0;i<m;i++)for(let j=0;j<m;j++)ss[i][j]+=wc[k]*dz[i]*dz[j];}
  ss=sym(ss);const gain=transpose(solve(ss,transpose(pxz))),correction=mul(mul(gain,ss),transpose(gain));
  const updated=xp.map((v,i)=>v+gain[i].reduce((s,k,j)=>s+k*(es[j][2]-zp[j]),0));
  return {positions:Array.from({length:n},(_,i)=>updated.slice(2*i,2*i+2)),covariance:sym(pp.map((r,i)=>r.map((v,j)=>v-correction[i][j])))};
}

class Localization {
  constructor(options={}) {this.options={alignment_us:250000,maxAlignmentError_us:1000,fitInterval_us:250000,fitBudget_ms:40,maxSamples:1500,maxTrail:2000,maxNodes:21,motionEpsilon_m:DEFAULT_MOTION_EPSILON_M,strictAlignment:false,allowUnmappedReceiveTime:false,lightIngest:false,...options};this.source=null;this.reset();}
  reset() {this.stage=1;this.nodeMap=new Map();this.edgeMap=new Map();this.last=new Map();this.endpointBoots=new Map();this.endpointEpochs=new Map();this.observerBoot=null;this.blocked=false;this.samples=[];this.preview=null;this.baseline=null;this.fit=null;this.lastFitTime=-Infinity;this.P=null;this.previousRaw=null;this.previousRawTimes=null;this.clock=null;this.ukfWindow=new UkfWindow();this.diagnostics={ukfUpdates:0,skippedUkfWindows:0,ukfPendingEdges:0,ukfPendingSamples:0,lastUkfEdges:[],accepted:0,stale:0,invalid:0,unaligned:0,initialPositionReady:false,previewUpdates:0,approximateUpdates:0,legacyFrameUpdates:0,positionUpdates:0,alignment:'尚未定位',strictAlignment:this.options.strictAlignment,initializationSamples:0,retainedSamples:0,discardedSamples:0,observable:false,model:'等待有效位置输入',alignment_us:this.options.alignment_us,lastError:null};return this.snapshot();}
  selectSource(path) {const source=path==null?null:String(path);if(source!==this.source){this.source=source;this.reset();}return this.snapshot();}
  _node(id) {id=Number(id)>>>0;if(!this.nodeMap.has(id))this.nodeMap.set(id,{id,raw:null,rawTime:null,rawReceivedAt:null,position:null,rawTrail:[],trail:[]});return this.nodeMap.get(id);}
  _ids(){return [...this.nodeMap.keys()].sort((a,b)=>a-b);}
  _matrix(ids,means=false,map=this.edgeMap) {const d=zeros(ids.length,ids.length);for(let i=0;i<ids.length;i++)for(let j=0;j<i;j++){const e=map.get(pairKey(ids[i],ids[j]));const v=e&&(means?e.sum/e.count:e.distance);if(!e||!(v>=0&&Number.isFinite(v)))return null;d[i][j]=d[j][i]=v;}return d;}
  _complete(){const ids=this._ids();return ids.length>=3&&this._matrix(ids,true)!==null;}
  _push(node,key,p){node[key].push(p.slice());if(node[key].length>this.options.maxTrail)node[key].shift();}
  _result(){return this.options.lightIngest?{stage:this.stage,canAdvance:!this.blocked&&(this.stage===1?!!this.preview:this.stage===2&&!!this.fit?.observable)}:this.snapshot();}
  /** @brief 拓扑不完整或退化时撤销预览；不把旧节点集合的坐标当作当前结果。 */
  _clearStaticPreview(){
    this.preview=null;this.diagnostics.initialPositionReady=false;
    for(const node of this.nodeMap.values())node.position=null;
  }
  /** @brief 每条有效新距离累计均值后重算完整MDS，仅更新初始位置，不推进阶段或写入UKF轨迹。 */
  _refreshStaticPreview(){
    if(this.stage!==1)return;
    this._clearStaticPreview();
    const ids=this._ids(),distances=ids.length>=3?this._matrix(ids,true):null;
    if(!distances){this.diagnostics.model='等待完整距离矩阵';this.diagnostics.lastError=null;return;}
    try{
      const base=mds(distances);this.preview={ids,distances,...base};
      ids.forEach((id,i)=>{this.nodeMap.get(id).position=[...base.positions[i],0];});
      this.diagnostics.initialPositionReady=true;this.diagnostics.previewUpdates++;
      this.diagnostics.model='累计平均距离矩阵MDS';this.diagnostics.lastError=null;
    }catch(error){this.diagnostics.lastError=error.message;this.diagnostics.model='等待有效距离几何';}
  }
  /** @brief 区分新版广播毫秒依据与旧记录近似，不伪造精确时钟证据。 */
  _markApproximation(legacy,packetMs=false){this.diagnostics.approximateUpdates++;if(legacy)this.diagnostics.legacyFrameUpdates++;this.diagnostics.alignment=packetMs?'广播包毫秒级近似对齐':this.options.allowUnmappedReceiveTime===true?'接收时刻近似（跳过时钟检查）':this.diagnostics.legacyFrameUpdates?'旧记录同帧近似':'接收时刻近似对齐';}
  /** @brief 新版显式依据默认可用；旧版时钟跳过仅由文件回放选项启用。 */
  _receiveClockUsable(event){
    if(event.protocolVersion===2)return event.time_basis==='packet_ms'&&event.quality==='receive'&&event.compat_usable===true;
    if(event.protocolVersion!==undefined&&event.protocolVersion!==1)return false;
    return (event.clock_ready===true&&event.compat_usable===true)||this.options.allowUnmappedReceiveTime===true;
  }
  _alignment(event){
    const timesValid=Number.isFinite(event.ta_us)&&Number.isFinite(event.tb_us)&&event.ta_us>=0&&event.tb_us>=0&&Math.abs(event.ta_us-event.t_us)<=this.options.alignment_us&&Math.abs(event.tb_us-event.t_us)<=this.options.alignment_us;
    if(event.protocolVersion===2){
      const approximate=!this.options.strictAlignment&&timesValid&&this._receiveClockUsable(event)&&finitePosition(event.pa)&&finitePosition(event.pb);
      if(approximate)this._markApproximation(false,true);return approximate;
    }
    if(event.protocolVersion!==undefined&&event.protocolVersion!==1)return false;
    const aligned=event.quality==='aligned'&&timesValid&&Number.isFinite(event.error_us)&&event.error_us>=0&&event.error_us<=this.options.maxAlignmentError_us;
    const approximate=!this.options.strictAlignment&&timesValid&&this._receiveClockUsable(event)&&['receive','mapped'].includes(event.quality);
    const legacy=!this.options.strictAlignment&&timesValid&&event.legacy_frame===true&&event.quality==='receive';
    if(approximate||legacy)this._markApproximation(legacy);else if(aligned&&this.diagnostics.approximateUpdates===0)this.diagnostics.alignment='测距采样时刻对齐';
    return aligned||approximate||legacy;
  }
  _bootCheck(event,pairs,epochs=[]){
    if(this.source&&event.observer!==this.source)return false;if(!this.source)this.source=event.observer||null;
    if(this.blocked)return false;
    if(this.observerBoot===null)this.observerBoot=event.boot||0;
    else if(this.observerBoot!==(event.boot||0)){this.blocked=true;this.diagnostics.lastError='观察节点已重启，请重置定位';return false;}
    for(const [id,boot]of pairs)if(Number.isFinite(boot)){if(this.endpointBoots.has(id)&&this.endpointBoots.get(id)!==boot){this.blocked=true;this.diagnostics.lastError='端点节点已重启，位置零点变化，请重置定位';return false;}this.endpointBoots.set(id,boot);}
    // 外部位置源可独立于 ESP 重启或换源，必须单独检查其零点代次；旧协议缺失字段保持未知。
    for(const [id,epoch]of epochs)if(Number.isInteger(epoch)&&epoch>=0&&epoch<=65535){
      if(this.endpointEpochs.has(id)&&this.endpointEpochs.get(id)!==epoch){this.blocked=true;this.diagnostics.sourceEpochChanges=(this.diagnostics.sourceEpochChanges||0)+1;this.diagnostics.lastError='外部位置来源代次已变化，坐标零点可能重置，请重置定位';return false;}
      this.endpointEpochs.set(id,epoch);
    }
    return true;
  }
  /** @brief 静止采集直接消费总览的有效新距离；接收时钟不伪装为固件微秒时钟。 */
  ingestDistance(event,nowMs=Date.now(),replaceFallback=false){
    if(this.stage!==1||this.blocked||!event||(this.source&&event.observer!==this.source))return this._result();
    const {a,b,distance}=event;
    if(!Number.isInteger(a)||!Number.isInteger(b)||a<=0||b<=0||a>=0xffffffff||b>=0xffffffff||a===b||!Number.isFinite(distance)||distance<0){this.diagnostics.invalid++;return this._result();}
    const extra=[a,b].filter(id=>!this.nodeMap.has(id)).length;if(this.nodeMap.size+extra>this.options.maxNodes){this.diagnostics.invalid++;return this._result();}
    if(!this.source)this.source=event.observer||null;
    this._node(a);this._node(b);const key=pairKey(a,b);
    let edge=this.edgeMap.get(key);
    if(!edge){edge={a:Math.min(a,b),b:Math.max(a,b),distance,sum:0,count:0,t_us:0};this.edgeMap.set(key,edge);}
    if(replaceFallback){edge.sum=0;edge.count=0;}
    edge.distance=distance;edge.sum+=distance;edge.count++;edge.receivedAt=nowMs;
    this.diagnostics.distanceUpdates=(this.diagnostics.distanceUpdates||0)+1;
    this._refreshStaticPreview();return this._result();
  }
  ingest(event,nowMs=Date.now(),{countDistance=true}={}) {
    if(!event||!Number.isInteger(event.a)||!Number.isInteger(event.b)||event.a<0||event.b<0||event.a>0xffffffff||event.b>0xffffffff||event.a===event.b||!(event.distance>=0)||!Number.isFinite(event.distance)||!Number.isFinite(event.t_us)||event.t_us<0){this.diagnostics.invalid++;return this._result();}
    const extra=[event.a,event.b].filter(id=>!this.nodeMap.has(id)).length;if(this.nodeMap.size+extra>this.options.maxNodes){this.diagnostics.invalid++;this.diagnostics.lastError=`超过节点容量 ${this.options.maxNodes}`;return this._result();}
    if(!this._bootCheck(event,[[event.a,event.a_boot],[event.b,event.b_boot]],[[event.a,event.a_epoch],[event.b,event.b_epoch]]))return this._result();
    if(this.stage===3)this.tick(nowMs);
    const key=pairKey(event.a,event.b),clock=`${event.observer||''}:${event.boot||0}:${key}`,last=this.last.get(clock);
    if(last!==undefined&&event.t_us<=last){this.diagnostics.stale++;return this._result();}this.last.set(clock,event.t_us);if(this.last.size>4096)this.last.delete(this.last.keys().next().value);this.diagnostics.accepted++;
    const a=this._node(event.a),b=this._node(event.b);let edge=this.edgeMap.get(key);
    if(!edge){edge={a:Math.min(event.a,event.b),b:Math.max(event.a,event.b),distance:event.distance,sum:0,count:0,t_us:event.t_us};this.edgeMap.set(key,edge);}
    edge.distance=event.distance;edge.t_us=event.t_us;if(this.stage===1&&countDistance){edge.sum+=event.distance;edge.count++;}
    const afterOrigin=!this.baseline||[event.t_us,event.ta_us,event.tb_us].every(t=>t>this.baseline.startTime_us);
    const aligned=this._alignment(event);
    if(!aligned)this.diagnostics.unaligned++;
    for(const [node,p,t] of [[a,event.pa,event.ta_us],[b,event.pb,event.tb_us]])if(afterOrigin&&finitePosition(p)&&Number.isFinite(t)&& (node.rawTime===null||t>node.rawTime)){node.raw=p.slice(0,3);node.rawTime=t;node.rawReceivedAt=nowMs;this._push(node,'rawTrail',node.raw);}
    if(this.stage===1)this._refreshStaticPreview();
    if(this.stage===2){
      if(!afterOrigin)this.diagnostics.preOriginSamples=(this.diagnostics.preOriginSamples||0)+1;
      else if(aligned&&finitePosition(event.pa)&&finitePosition(event.pb))this._collect(event);
      else this.diagnostics.lastError=aligned?'缺少有效双端位置':'位置与测距时刻未满足当前对齐条件';
      this._updateMovingPreview();
    }
    if(this.stage===3&&afterOrigin&&aligned&&finitePosition(event.pa)&&finitePosition(event.pb))this._queueCorrection(event);
    return this._result();
  }
  /** @brief 位置只进入原始历史和窗口缓存；第三阶段由一秒窗口统一执行UKF。 */
  ingestPosition(event,nowMs=Date.now()){
    const p=event?.position||event?.p||(event&&[event.x,event.y,event.z]),id=event?.node,t=event?.t_us;
    if(!Number.isInteger(id)||id<0||id>0xffffffff||!finitePosition(p)||!Number.isFinite(t)||t<0){this.diagnostics.invalid++;return this._result();}
    if(!this.nodeMap.has(id)&&this.nodeMap.size>=this.options.maxNodes){this.diagnostics.invalid++;return this._result();}
    if(!this._bootCheck(event,[[id,event.node_boot]],[[id,event.source_epoch]]))return this._result();
    if(this.stage===3)this.tick(nowMs);
    const key=`pos:${event.observer||''}:${event.boot||0}:${id}`,last=this.last.get(key);
    if(last&&last.node_boot!==(event.node_boot||0)){this.diagnostics.lastError='节点位置输入已重新启动，请重置定位';return this._result();}
    if(last&&t<=last.t){this.diagnostics.stale++;return this._result();}
    this.last.set(key,{t,node_boot:event.node_boot||0});if(this.last.size>4096)this.last.delete(this.last.keys().next().value);this.diagnostics.positionUpdates++;
    /** @brief 阶段切换前的延迟位置只完成去重，不回填进入初始位置后的位移与轨迹。 */
    if(this.baseline&&t<=this.baseline.startTime_us){this.diagnostics.preOriginSamples=(this.diagnostics.preOriginSamples||0)+1;return this._result();}
    const node=this._node(id);if(node.rawTime===null||t>node.rawTime){node.raw=p.slice();node.rawTime=t;node.rawReceivedAt=nowMs;this._push(node,'rawTrail',p);}
    if(this.stage===1&&this.preview&&!this.preview.ids.includes(id))this._refreshStaticPreview();
    if(this.stage===2)this._updateMovingPreview();
    if(this.stage!==3)return this._result();
    const packetMs=event.protocolVersion===2,oldProtocol=event.protocolVersion===undefined||event.protocolVersion===1;
    const approximate=!this.options.strictAlignment&&this._receiveClockUsable(event)&&['receive','mapped'].includes(event.quality),strict=oldProtocol&&event.quality==='aligned';
    const legacy=oldProtocol&&!this.options.strictAlignment&&event.legacy_frame===true&&event.quality==='receive';
    if(!strict&&!approximate&&!legacy){this.diagnostics.unaligned++;return this._result();}if(approximate||legacy)this._markApproximation(legacy,packetMs);
    const ids=this.baseline.ids,index=ids.indexOf(id),clock=`${event.observer||''}:${event.boot||0}`;
    if(index<0||clock!==this.clock){this.diagnostics.lastError='位置源或节点集合已变化，请重置定位';return this._result();}
    this.ukfWindow.position(index,p,t);
    return this._result();
  }
  _collect(event) {
    const clock=`${event.observer||''}:${event.boot||0}`;
    if(this.clock&&this.clock!==clock)return;this.clock=clock;
    const ids=this.baseline.ids,i=ids.indexOf(event.a),j=ids.indexOf(event.b);if(i<0||j<0){this.diagnostics.lastError='发现新节点，需重置后重新建立拓扑';return;}
    if(this.baseline.origins.some(p=>!p)){this.diagnostics.lastError='缺少有效节点位置基准';return;}
    if(event.ta_us<this.baseline.originTimes[i]||event.tb_us<this.baseline.originTimes[j]){this.diagnostics.preOriginSamples=(this.diagnostics.preOriginSamples||0)+1;return;}
    this.samples.push({i,j,distance:event.distance,pa:event.pa.slice(),pb:event.pb.slice(),t_us:event.t_us,ta_us:event.ta_us,tb_us:event.tb_us});this.diagnostics.initializationSamples++;
    if(this.samples.length>this.options.maxSamples){this.samples.shift();this.diagnostics.discardedSamples++;}this.diagnostics.retainedSamples=this.samples.length;
    // 残差少于未知角度时必然欠定；此处是数学维数条件，不是任意帧门槛。
    if(this.samples.length<ids.length)return;
    if(event.t_us-this.lastFitTime<this.options.fitInterval_us)return;this.lastFitTime=event.t_us;this._fit();
  }
  /** @brief 初始化期间按最新旋转候选映射当前原始位置；新POS无需等待下一次测距拟合即可显示运动。 */
  _updateMovingPreview(){
    if(this.stage!==2||!this.fit||!this.baseline)return;
    this.baseline.ids.forEach((id,k)=>{
      const node=this.nodeMap.get(id),origin=this.baseline.origins[k];if(!node?.raw||!origin)return;
      const d=rotate([node.raw[0]-origin[0],node.raw[1]-origin[1]],k===0?0:this.fit.angles[k]);
      node.position=[this.fit.initial[k][0]+d[0],this.fit.initial[k][1]+d[1],0];
    });
  }
  /** 初始化拟合只更新预览位置；不同拟合坐标解不串入UKF运动轨迹，原始历史独立保留。 */
  _fit(){const ids=this.baseline.ids;if(this.samples.length<ids.length)return;
    try{const started=Date.now();this.fit=initializeAsync(this.baseline.positions,this.baseline.origins,this.samples,{previous:this.fit,starts:this.fit?3:16,deadline:started+this.options.fitBudget_ms,motionEpsilon_m:this.options.motionEpsilon_m});this.diagnostics.fitDuration_ms=Date.now()-started;this.diagnostics.fitCost=this.fit.cost;this.diagnostics.observable=this.fit.observable;this.diagnostics.spectrum=this.fit.spectrum;this.diagnostics.activeParameters=this.fit.activeParameters.length;this.diagnostics.orientationUnknown=ids.filter((_,i)=>!this.fit.orientationKnown[i]);this.diagnostics.referenceGauge=this.fit.gaugeFixed?'参考节点静止，采用MDS方向规范':'参考节点局部坐标方向';this.diagnostics.model='MDS + 异步移动旋转初始化 + UKF';this.diagnostics.lastError=this.fit.observable?null:'移动激励不足，旋转参数尚不可观测';
      this.previousRaw=ids.map(id=>this.nodeMap.get(id).raw.slice());this.previousRawTimes=ids.map(id=>this.nodeMap.get(id).rawTime);
      this._updateMovingPreview();
    }catch(error){this.diagnostics.lastError=error.message;}
  }
  /** @brief 同一秒内只汇总有效新距离；反向节点对归一，距离及双端位置按同一样本求均值。 */
  _queueCorrection(event) {
    const ids=this.baseline.ids,i=ids.indexOf(event.a),j=ids.indexOf(event.b);
    if(i<0||j<0){this.diagnostics.lastError='发现新节点，需重置后重新建立拓扑';return;}
    if(`${event.observer||''}:${event.boot||0}`!==this.clock){this.diagnostics.lastError='观察端时钟域已变化，需重置定位';return;}
    this.ukfWindow.position(i,event.pa,event.ta_us);this.ukfWindow.position(j,event.pb,event.tb_us);
    if(event.distance===0){this.diagnostics.zeroRangesNotFused=(this.diagnostics.zeroRangesNotFused||0)+1;return;}
    this.ukfWindow.add(i,j,event);
    this.diagnostics.ukfPendingEdges=this.ukfWindow.edges.size;
    this.diagnostics.ukfPendingSamples=this.ukfWindow.samples;
  }
  /** @brief 由采集任务时钟调用；每满一秒至多联合更新一次，无距离窗口完全跳过UKF。 */
  tick(nowMs=Date.now()) {
    if(this.stage!==3||this.blocked)return this._result();
    const batch=this.ukfWindow.take(nowMs);if(!batch)return this._result();
    this.diagnostics.ukfPendingEdges=0;this.diagnostics.ukfPendingSamples=0;
    this.diagnostics.skippedUkfWindows+=batch.windows-(batch.edges.length?1:0);
    if(!batch.edges.length)return this._result();
    const ids=this.baseline.ids,positions=ids.map(id=>this.nodeMap.get(id).position?.slice(0,2));
    if(positions.some(p=>!p))return this._result();
    const raw=this.previousRaw.map(p=>p.slice()),times=this.previousRawTimes.slice();
    for(const [i,value]of batch.positions)if(value.t_us>times[i]){raw[i]=value.position.slice();times[i]=value.t_us;}
    const displacement=raw.map((p,i)=>rotate([p[0]-this.previousRaw[i][0],p[1]-this.previousRaw[i][1]],i===0?0:this.fit.angles[i]));
    const edges=batch.edges.map(e=>[e.i,e.j,e.distance,
      rotate([e.pa[0]-raw[e.i][0],e.pa[1]-raw[e.i][1]],e.i===0?0:this.fit.angles[e.i]),
      rotate([e.pb[0]-raw[e.j][0],e.pb[1]-raw[e.j][1]],e.j===0?0:this.fit.angles[e.j])]);
    try{
      const result=ukf(positions,this.P,displacement,edges);
      this.P=result.covariance;this.previousRaw=raw;this.previousRawTimes=times;this.ukfWindow.positions.clear();
      ids.forEach((id,i)=>{const node=this.nodeMap.get(id);node.position=[...result.positions[i],0];this._push(node,'trail',node.position);});
      this.diagnostics.ukfUpdates++;this.diagnostics.lastError=null;
      this.diagnostics.lastUkfWindow_ms=[batch.startMs,batch.endMs];
      this.diagnostics.lastUkfEdges=batch.edges.map(e=>({a:ids[e.i],b:ids[e.j],distance:e.distance,count:e.count,t_us:e.t_us,ta_us:e.ta_us,tb_us:e.tb_us}));
      this.diagnostics.lateRangeUpdates=(this.diagnostics.lateRangeUpdates||0)+batch.edges.filter(e=>e.ta_us<times[e.i]||e.tb_us<times[e.j]).length;
    }catch(error){this.diagnostics.lastError=`UKF 未更新：${error.message}`;}
    return this._result();
  }
  advance(nowMs=Date.now()){
    if(this.blocked)return this.snapshot();
    if(this.stage===1&&this.preview){
      const base=this.preview,ids=base.ids.slice(),nodes=ids.map(id=>this.nodeMap.get(id));
      const missing=nodes.filter(node=>!finitePosition(node.raw)||!Number.isFinite(node.rawTime));
      if(missing.length)throw Error(`节点 ${missing.map(node=>node.id).join('、')} 尚未收到有效位置，无法设置惯导原点`);
      /** @brief 电脑接收年龄独立于固件时钟；重复或同时间端点不得刷新原点有效期。 */
      const expired=nodes.filter(node=>!Number.isFinite(nowMs)||!Number.isFinite(node.rawReceivedAt)||nowMs<node.rawReceivedAt||nowMs-node.rawReceivedAt>ORIGIN_POSITION_MAX_AGE_MS);
      if(expired.length)throw Error(`节点 ${expired.map(node=>node.id).join('、')} 位置已过期或接收时间无效，请等待新位置后设置惯导原点`);
      /** @brief 此刻最新惯导坐标仅作为各节点局部零点；静止采集期间的位移不进入初始化。 */
      this.baseline={ids,distances:base.distances.map(row=>row.slice()),positions:base.positions.map(p=>p.slice()),eigenvalues:base.eigenvalues.slice(),thirdDimension:base.thirdDimension,
        origins:nodes.map(node=>node.raw.slice()),originTimes:nodes.map(node=>node.rawTime),
        startTime_us:Math.max(...nodes.map(node=>node.rawTime),...[...this.edgeMap.values()].map(edge=>edge.t_us))};
      this.samples=[];this.fit=null;this.lastFitTime=-Infinity;this.previousRaw=null;this.previousRawTimes=null;this.P=null;this.ukfWindow.reset(nowMs);
      for(const node of nodes){node.rawTrail=[node.raw.slice()];node.trail=[];}
      this.stage=2;this.preview=null;this.diagnostics.lastError=null;this.diagnostics.model='等待有效位置与移动激励';
    }
    else if(this.stage===2){this._fit();if(this.fit?.observable){this.stage=3;this.P=null;this.ukfWindow.reset(nowMs);for(const node of this.nodeMap.values())node.trail=[node.position.slice()];}}
    return this.snapshot();
  }
  /** 原始局部坐标仅作输入；显示轨迹统一映射到初始化的共同坐标系。 */
  _snapshotNode(id) {
    const node=this.nodeMap.get(id),index=this.baseline?.ids.indexOf(id);
    const valid=this.fit&&index>=0&&this.baseline.origins[index];
    const transform=p=>{
      const origin=this.baseline.origins[index];
      const delta=rotate([p[0]-origin[0],p[1]-origin[1]],index===0?0:this.fit.angles[index]);
      return [this.fit.initial[index][0]+delta[0],this.fit.initial[index][1]+delta[1],p[2]];
    };
    const alignedRaw=valid&&node.raw?transform(node.raw):null;
    const rawTrail=valid?node.rawTrail.map(transform):[];
    return {id,raw:node.raw?.slice()||null,position:node.position?.slice()||null,
      localOrigin:(index>=0?this.baseline.origins[index]:null)?.slice()||node.rawTrail[0]?.slice()||null,
      localRawTrail:node.rawTrail.map(p=>p.slice()),rawTrail,trail:node.trail.map(p=>p.slice()),
      alignedRaw,displayRaw:alignedRaw,alignedRawTrail:rawTrail};
  }
  snapshot() {
    const canAdvance=!this.blocked&&(this.stage===1?!!this.preview:this.stage===2&&!!this.fit?.observable);
    const stageText=this.stage===1?'静止采集：全体保持不动，累计所有有效距离均值':this.stage===2?
      (this.fit?.observable?'持续更新初始化，可手动进入位置修正':`移动初始化：${this.samples.length} 条异步测距，等待数学可解`):'移动位置修正';
    const status=(this.diagnostics.lastError||stageText)+(this.diagnostics.approximateUpdates?' · '+this.diagnostics.alignment:'');
    return {stage:this.stage,status,canAdvance,source:this.source,nodes:this._ids().map(id=>this._snapshotNode(id)),
      edges:[...this.edgeMap.values()].map(e=>({a:e.a,b:e.b,distance:e.distance,mean:e.count?e.sum/e.count:null,count:e.count,t_us:e.t_us})),
      diagnostics:{...this.diagnostics,blocked:this.blocked,angles:this.fit?.angles?.slice()||null,flip:this.fit?.flip||null}};
  }
}
module.exports={Localization,mds,initializeMoving,initializeAsync,ukf};
