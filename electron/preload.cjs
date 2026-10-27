'use strict';
if (process.env.ELECTRON_RUN_AS_NODE) delete process.env.ELECTRON_RUN_AS_NODE;
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openImages: () => ipcRenderer.invoke('dialog:openImages'),
  saveFile: (payload) => ipcRenderer.invoke('dialog:save', payload),
  openProject: () => ipcRenderer.invoke('dialog:openProject'),
  readImage: (p) => ipcRenderer.invoke('fs:readImage', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  platform: process.platform,
});