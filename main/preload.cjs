'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const invoke=(name,args)=>ipcRenderer.invoke('uwb:'+name,args);
contextBridge.exposeInMainWorld('uwb',Object.freeze({
  listPorts:()=>invoke('listPorts'),connect:args=>invoke('connect',args),
  disconnect:path=>invoke('disconnect',path),removePort:path=>invoke('removePort',path),send:args=>invoke('send',args),
  control:args=>invoke('control',args),
  setMode:args=>invoke('setMode',args),nodeControl:args=>invoke('nodeControl',args),export:args=>invoke('export',args),
  chooseExperimentDirectory:()=>invoke('chooseExperimentDirectory'),getSettings:()=>invoke('getSettings'),setSettings:patch=>invoke('setSettings',patch),
  getSnapshot:()=>invoke('getSnapshot'),
  localizationAction:args=>invoke('localizationAction',args),replayAction:args=>invoke('replayAction',args),fileReplayAction:args=>invoke('fileReplayAction',args),
  copyText:value=>invoke('copyText',value),
  onSnapshot:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('uwb:snapshot',listener);return()=>ipcRenderer.removeListener('uwb:snapshot',listener);}
}));
