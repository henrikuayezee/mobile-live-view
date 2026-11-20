"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Exposed to the renderer as window.mlvWindow — see titlebar.js. Renderer
// runs with contextIsolation on and nodeIntegration off, so this is the
// only surface it has for controlling its own (frameless) window.
contextBridge.exposeInMainWorld("mlvWindow", {
  minimize: () => ipcRenderer.send("mlv:minimize"),
  maximize: () => ipcRenderer.send("mlv:maximize"),
  unmaximize: () => ipcRenderer.send("mlv:unmaximize"),
  close: () => ipcRenderer.send("mlv:close"),
  isMaximized: () => ipcRenderer.invoke("mlv:isMaximized"),
  onMaximizedChange: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on("mlv:maximized-change", listener);
    return () => ipcRenderer.removeListener("mlv:maximized-change", listener);
  },
  // Shrinks the OS window itself to exactly hug the phone's real pixel
  // size (CSS alone can't resize the actual window) — see app.js's
  // compact-view toggle. exitCompact restores whatever the window's
  // bounds were right before entering.
  enterCompact: (phoneWidth, phoneHeight) =>
    ipcRenderer.send("mlv:enter-compact", { phoneWidth, phoneHeight }),
  exitCompact: () => ipcRenderer.send("mlv:exit-compact"),
  openInBrowser: () => ipcRenderer.send("mlv:open-in-browser"),
});
