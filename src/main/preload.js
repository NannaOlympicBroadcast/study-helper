'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const EVENTS = ['focus:state', 'data:changed', 'sync:status', 'sync:loginError', 'browse:blocked', 'popup:entry', 'ui:open-start'];

contextBridge.exposeInMainWorld('api', {
  call,
  on(event, fn) {
    if (!EVENTS.includes(event)) throw new Error(`unknown event ${event}`);
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
  platform: process.platform,
});
