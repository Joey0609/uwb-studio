"use strict";
/** @file 矩阵对角线的原始位置展示；各观察矩阵共用合并结果，不参与定位运算。 */
(() => {
  const elements=new WeakMap();
  let showZ=false;
  /** @brief 默认只显示平面坐标；显示开关由已保存的工作台设置提供。 */
  function configure(options={}){showZ=options.showZ===true;}
  const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  const put=(e,value)=>{if(e.textContent!==value)e.textContent=value;};
  /** @brief 补入仅有位置的节点；保留调用方元数据并按地址排序。 */
  function axes(nodes=[],ids=[]){
    const known=new Map(nodes.map(n=>[String(n.id),n]));
    for(const id of ids)if(!known.has(String(id)))known.set(String(id),{id});
    return [...known.values()].sort((a,b)=>Number(a.id)-Number(b.id));
  }
  function index(positions=[]){return new Map(positions.map(p=>[String(p.node),p]));}
  /** @brief 固定底色，仅以角标圆点表示新鲜位置；暂停冻结坐标，年龄继续更新。 */
  function render(cell,sample,now=Date.now()){
    let ui=elements.get(cell);
    if(!ui){
      const xyz=make('div','position-xyz');
      const rows=[];
      const values=['x','y','z'].map(axis=>{const row=make('div','position-axis cell-value'),name=make('span','position-axis-name',axis),value=make('span','position-number','—');row.append(name,value);xyz.append(row);rows.push(row);return value;});
      const time=make('div','position-time'),status=make('div','position-status');
      cell.replaceChildren(xyz,time,status);cell.classList.add('diagonal-cell','latest-position-cell');
      cell.classList.remove('unknown','valid','masked-cell');ui={values,rows,time,status};elements.set(cell,ui);
    }
    const valid=sample&&Array.isArray(sample.position)&&sample.position.length===3&&sample.position.every(Number.isFinite);
    ui.rows[2].hidden=!showZ;
    ui.values.forEach((e,i)=>put(e,valid?sample.position[i].toFixed(3):'—'));
    const age=valid?Math.max(0,now-sample.receivedAt):0;
    const status=!valid?'empty':sample.status==='disconnected'?'disconnected':age>=1000?'stale':'fresh';
    cell.dataset.positionStatus=status;
    put(ui.time,valid?new Date(sample.receivedAt).toLocaleTimeString('zh-CN',{hour12:false})+' · '+(age/1000).toFixed(1)+'秒前':'');
    put(ui.status,{empty:'未收到位置',fresh:'',stale:'已过期',disconnected:'来源已断开'}[status]);
    ui.status.hidden=status==='fresh';
    cell.title=valid?`节点 ${sample.node} 原始位置（m）\nX ${sample.position[0].toFixed(3)}\nY ${sample.position[1].toFixed(3)}\nZ ${sample.position[2].toFixed(3)}\n来源 ${sample.port}\n接收 ${new Date(sample.receivedAt).toLocaleString('zh-CN')}\n${ui.status.textContent}`:'未收到位置';
  }
  window.UwbPositionCells={render,axes,index,configure};
})();
