const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("subtitleApp", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getUiLanguage: () => ipcRenderer.sendSync("app:get-ui-language"),
  setUiLanguage: (language) => ipcRenderer.send("app:set-ui-language", language),
  chooseVideos: () => ipcRenderer.invoke("dialog:chooseVideos"),
  chooseDirectory: () => ipcRenderer.invoke("dialog:chooseDirectory"),
  chooseSrtPath: (defaultName) => ipcRenderer.invoke("dialog:chooseSrtPath", defaultName),
  confirmAction: (payload) => ipcRenderer.invoke("dialog:confirm", payload),
  setWindowIcon: (paletteId) => ipcRenderer.send("app:set-window-icon", paletteId),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  revealPath: (targetPath) => ipcRenderer.invoke("app:reveal-path", targetPath),
  // 出错时把错误码 + 详细报错落盘（主进程写 <userData>/logs/error.log）。
  logError: (payload) => ipcRenderer.invoke("app:log-error", payload),
  revealErrorLog: () => ipcRenderer.invoke("app:reveal-error-log"),
  toFileUrl: (filePath) => ipcRenderer.invoke("video:fileUrl", filePath),
  // 拖进来的路径先交给主进程判定：解析 .lnk、挡掉非视频。
  resolveVideoPaths: (filePaths) => ipcRenderer.invoke("video:resolvePaths", filePaths),
  openInPlayer: (payload) => ipcRenderer.invoke("video:openInPlayer", payload),
  // Dropped files arrive as File objects; only the preload can turn one into a
  // real path, which is what the OCR backend needs.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch (error) {
      return "";
    }
  },
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  // 主进程关窗口前会发一次 app:flush：回传完（或没有要回传的）立刻 flushDone()。
  onFlushRequest: (callback) => {
    ipcRenderer.on("app:flush", () => callback());
  },
  flushDone: () => ipcRenderer.send("app:flush-done"),
  // 关窗口前还会问一次"是不是还有任务在跑"：队列状态只有渲染层知道。
  onBusyQuery: (callback) => {
    ipcRenderer.on("app:is-busy", () => {
      let busy = false;
      try {
        busy = Boolean(callback());
      } catch (error) {
        busy = false;
      }
      ipcRenderer.send("app:is-busy-reply", busy);
    });
  },
  // 任务列表快照：读/写都走主进程（原子替换），见 SESSION_RESTORE_DESIGN.md 方案 A。
  session: {
    load: () => ipcRenderer.invoke("session:load"),
    save: (snapshot) => ipcRenderer.invoke("session:save", snapshot)
  },
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onWindowMaximizedChange: (callback) => {
    ipcRenderer.on("window:maximized-changed", (_event, isMaximized) => callback(isMaximized));
  },
  ocr: {
    start: () => ipcRenderer.invoke("sidecar:start"),
    request: (method, params) => ipcRenderer.invoke("sidecar:request", { method, params }),
    onEvent: (callback) => {
      ipcRenderer.on("sidecar:event", (_event, message) => callback(message));
    },
    onStatus: (callback) => {
      ipcRenderer.on("sidecar:status", (_event, status) => callback(status));
    }
  }
});
