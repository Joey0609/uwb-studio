/** @file 用户从固件help逐项选定的快捷指令；参数占位符只预填，不自动执行。 */
'use strict';
const QUICK_COMMANDS_VERSION=5;
const SELECTED_QUICK_COMMANDS=[
 {label:'全部命令',command:'help'},
 {label:'本机标识',command:'id'},
 {label:'ESP状态',command:'espstatus'},
 {label:'电池电压',command:'battery'},
 {label:'气压温度',command:'baro'},
 {label:'热点配置…',command:'ap <操作>'},
 {label:'Wi-Fi位置',command:'position show'},
 {label:'重启本节点',command:'reset'},
 {label:'系统状态',command:'systemstatus'},
 {label:'UWB状态',command:'status'},
 {label:'RAC地址',command:'racaddr'},
 {label:'UWB配置…',command:'config <操作>'},
 {label:'拓扑遍历',command:'networktopologytraversalstart'},
 {label:'邻居列表',command:'neighborlist'},
 {label:'邻居发现',command:'neighbordiscover'},
 {label:'单次测距…',command:'range <目标地址>'},
 {label:'连续测距…',command:'rangetest <目标地址>'},
 {label:'重启周围节点',command:'resetneighborhoods'},
 {label:'Sink节点',command:'sinknode'},
 {label:'单次接收',command:'basicrecv'},
 {label:'广播发送…',command:'broadcastsend <消息内容>'},
 {label:'拓扑命令…',command:'networktopologycmdsend <目标地址>'},
 {label:'节点命令…',command:'cmdsend <目标地址> <命令>'},
 {label:'设置本机位置…',command:'setlocation <X> <Y> <Z>'},
 {label:'开启调试打印',command:'enableprintf'},
 {label:'关闭调试打印',command:'disableprintf'},
 {label:'读取寄存器…',command:'readreg <地址>'},
];
/** @brief 应用本次明确选择；版本升级后保留用户后续自定义，不在每次启动重置。 */
function migrateQuickCommands(saved={}){
 if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
 if(Number(saved.quickVersion)>=QUICK_COMMANDS_VERSION&&Array.isArray(saved.quickCommands))return saved;
 return {...saved,quickVersion:QUICK_COMMANDS_VERSION,quickCommands:SELECTED_QUICK_COMMANDS.map(item=>({...item}))};
}
module.exports={QUICK_COMMANDS_VERSION,SELECTED_QUICK_COMMANDS,migrateQuickCommands};
