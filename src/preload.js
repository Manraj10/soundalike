"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Narrow, explicit surface. The renderer gets these five calls and two event
// streams -- no ipcRenderer, no require, no fs.
contextBridge.exposeInMainWorld("vb", {
  status: () => ipcRenderer.invoke("engine:status"),
  load: (opts) => ipcRenderer.invoke("engine:load", opts),
  languages: () => ipcRenderer.invoke("engine:languages"),

  setupNeeded: () => ipcRenderer.invoke("setup:needed"),
  runSetup: () => ipcRenderer.invoke("setup:run"),
  onSetupProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("setup:progress", h);
    return () => ipcRenderer.removeListener("setup:progress", h);
  },

  synth: (opts) => ipcRenderer.invoke("engine:synth", opts),
  pickVoice: () => ipcRenderer.invoke("pick:voice"),
  reveal: (p) => ipcRenderer.invoke("reveal", p),

  // Electron 32+ removed File.path; webUtils is the supported way to resolve a
  // dropped file to a real path, and it must be called from the preload.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  onEvent: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on("engine:event", h);
    return () => ipcRenderer.removeListener("engine:event", h);
  },
  onLog: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on("engine:log", h);
    return () => ipcRenderer.removeListener("engine:log", h);
  },
});
