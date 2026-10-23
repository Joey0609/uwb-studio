'use strict';
/** @brief 采集进程与界面共用的能力门控；完整命令行只移除一个合法路由前缀。 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.UwbCommandPolicy=api;})(typeof window==='object'?window:globalThis,()=>{
  const normalize=value=>String(value||'').trim().replace(/^(?:uwb|stm(?:32)?|esp(?:32)?)\s*[:：]\s*/i,'').trim();
  const isMonitor=value=>/^swarm\s+monitor\b/i.test(normalize(value));
  const isPassive=value=>/^swarm\s+monitor\s+(?:locate|window|status|anchors?|height|layout|evidence)\b/i.test(normalize(value));
  const obsolete=value=>/^swarm\s+monitor\s+(?:anchors?|layout)\b/i.test(normalize(value));
  function reason(value,node={}){
    if(isMonitor(value)&&node.monitorCapable!==true)return '当前固件仅支持广播测距，未声明纯监听能力';
    if(isPassive(value)&&node.passiveCapable!==true)return '当前固件未声明自身被动定位能力';
    if(obsolete(value)&&node.passiveGraph===true)return '自动图定位自动发现节点，固定节点组及手动布局指令已移除';
    return '';
  }
  function operation(value){
    const match=/^swarm(?:\s+(broadcast|monitor))?\s+(start|stop)(?:\s+(\d+))?\s*$/i.exec(normalize(value));
    if(!match)return null;
    const mode=(match[1]||'broadcast').toLowerCase(),action=match[2].toLowerCase();
    if(mode==='monitor'&&(action!=='start'||match[3]))return null;
    const session=match[3]?Number(match[3]):null;
    if(session!==null&&(!Number.isSafeInteger(session)||session<1||session>0xffffffff))return null;
    return {mode,action,session};
  }
  return {normalize,isMonitor,isPassive,obsolete,reason,operation};
});
