"use strict";
/** @file 总览与定位实时矩阵共用的串口数据选择、节点轴及距离有效性规则。 */
((root,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.UwbDistanceMatrix=api;})(globalThis,()=>{
  /** @brief 距离有效期沿用采集模型；旧记录缺少配置时使用三秒。 */
  function ttlMs(edge){return Number(edge?.ttlMs)>0?Number(edge.ttlMs):3000;}
  /** @brief 在快照年龄上累加渲染等待时间；没有新快照时距离仍会按时过期。 */
  function valid(edge,snapshotNow,now=Date.now()){
    return Boolean(edge&&edge.valid===true&&Number.isFinite(Number(edge.distance))&&Number(edge.distance)>=0&&
      (edge.ageMs===undefined||Number(edge.ageMs)+Math.max(0,now-Number(snapshotNow||now))<ttlMs(edge)));
  }
  /** @brief 只从本串口建立节点轴，不以其他观察者或定位历史补齐距离拓扑。 */
  function axes(port){
    if(!port)return [];
    const ids=new Map();
    const add=node=>{const object=typeof node==='object'&&node!==null,id=String(object?(node.id??node.nodeId??''):(node??''));if(id&&!ids.has(id))ids.set(id,object?node:{id});};
    (Array.isArray(port.matrixNodes)?port.matrixNodes:[]).forEach(add);
    (port.positionNodeIds||[]).forEach(add);
    if(port.nodeId)add(port.nodeId);
    for(const edge of Array.isArray(port.matrixEdges)?port.matrixEdges:[]){add(edge.source);add(edge.peer);}
    return [...ids.values()].sort((a,b)=>Number(a.id??a.nodeId)-Number(b.id??b.nodeId));
  }
  /** @brief 实时视图只选指定串口的同一快照；来源缺失时返回空数据，不回退到LOC缓存。 */
  function live(snapshot,source){
    const port=source?(snapshot.ports||[]).find(port=>port.path===source):(snapshot.ports||[]).find(port=>port.connected);
    return {source:port?.path||source||null,nodes:axes(port),edges:(port?.matrixEdges||[]).map(edge=>({...edge,a:edge.source,b:edge.peer}))};
  }
  return {ttlMs,valid,axes,live};
});
