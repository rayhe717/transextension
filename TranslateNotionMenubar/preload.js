const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getSettings: () => ipcRenderer.invoke("getSettings"),
  setSettings: (opts) => ipcRenderer.invoke("setSettings", opts),
  getClipboard: () => ipcRenderer.invoke("getClipboard"),
  translate: (text) => ipcRenderer.invoke("translate", text),
  saveToNotion: (payload) => ipcRenderer.invoke("saveToNotion", payload),
  saveToVault: (payload) => ipcRenderer.invoke("saveToVault", payload),
  checkNotionStatus: (opts) => ipcRenderer.invoke("checkNotionStatus", opts),
  writingSupport: (opts) => ipcRenderer.invoke("writingSupport", opts),
});
