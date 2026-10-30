const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { createI18n } = require("./i18n-core.js");
const mainI18n = createI18n(require("./i18n-dictionary.js"));
const t = mainI18n.t;
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const { SidecarClient, PROTOCOL_VERSION } = require("./sidecar");

let mainWindow;
let sidecar;
// 关窗口分两步：先问渲染层"还有没有任务在跑"（识别中弹确认框），再让渲染层把
// 没落盘的编辑回传一次（最多等 1.5 秒）。closePending 防止连点两次弹两个框。
let closeFlushed = false;
let closePending = false;

const PALETTE_IDS = ["neon", "sage", "graphite"];
const DEFAULT_PALETTE = "neon";

function windowIconPath(paletteId) {
  const safe = PALETTE_IDS.includes(paletteId) ? paletteId : DEFAULT_PALETTE;
  return path.join(__dirname, "icons", `icon-${safe}.ico`);
}

// Only one instance may own the sidecar: two windows would fight over the
// queue and two OCR engines would saturate the CPU.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// ------------------------------------------------------------- 日志落盘
// 打包版是 GUI 进程，没有控制台：只写 process.stderr 的日志会全部丢掉。
// 2026-09-21 有人反馈"识别一直卡在模型加载"，事后一点现场都拿不到，就是
// 因为这个。所以下面所有日志都同时写进 <userData>/logs/：
//   sidecar.log  启动命令、sidecar 的 stderr、后端状态、前后端请求与事件
//   error.log    显式错误（错误码 + 详细报错），界面上的错误框读的也是它
// 两个文件各自超过 2MB 就滚成 .1（各留一份，别让日志把磁盘吃满）；写盘失败
// 只打 stderr——记日志这件事本身不能把应用搞崩。
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function logDir() {
  return path.join(app.getPath("userData"), "logs");
}

function sidecarLogPath() {
  return path.join(logDir(), "sidecar.log");
}

function appendLogFile(file, text) {
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fsSync.statSync(file).size > LOG_MAX_BYTES) {
        fsSync.renameSync(file, `${file}.1`);
      }
    } catch (error) {
      /* 还没有这个日志文件 */
    }
    fsSync.appendFileSync(file, text, "utf8");
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error };
  }
}

// 每行都带时间戳：真挂住的时候，最后一行的时间就是现场时刻。
function log(message) {
  process.stderr.write(`${message}\n`);
  const stamp = new Date().toISOString().slice(11, 23);
  const text = String(message).split(/\r?\n/).filter(Boolean)
    .map((line) => `[${stamp}] ${line}`).join("\n");
  if (!text) return;
  const result = appendLogFile(sidecarLogPath(), `${text}\n`);
  if (!result.ok) {
    process.stderr.write(`[log] sidecar.log 写入失败：${result.error.message}\n`);
  }
}

function errorLogPath() {
  return path.join(app.getPath("userData"), "logs", "error.log");
}

// 多行 detail（后端堆栈、批量失败明细）按行缩进，日志才读得下去。
function indentBlock(text, prefix) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function appendErrorLog(entry) {
  const data = entry || {};
  const file = errorLogPath();
  const lines = [
    `[${new Date().toISOString()}] ${data.code || "E_INTERNAL"} · `
      + `${String(data.message || "").replace(/\s+/g, " ").trim()}`,
    data.videoPath ? `  video: ${data.videoPath}` : null,
    data.outputPath ? `  output: ${data.outputPath}` : null,
    data.detail ? indentBlock(data.detail, "  detail: ") : null,
    data.sidecarLog ? indentBlock(data.sidecarLog, "  sidecar: ") : null,
    `  origin: ${data.source || "ui"}`
  ].filter(Boolean);
  const result = appendLogFile(file, `${lines.join("\n")}\n\n`);
  if (!result.ok) {
    log(`[log] 错误日志写入失败：${result.error.message}`);
    return "";
  }
  return result.path;
}

// --------------------------------------------------------------- 崩溃兜底
// 主进程一旦抛未捕获异常，Electron 默认是"窗口直接消失"：用户看不到任何提示，日志里也
// 没有现场，事后只能靠猜。这里兜三条路径：
//   1) 主进程自己崩（未捕获异常 / 未处理的 Promise 拒绝）：错误码 + 堆栈写 error.log，
//      弹一个原生错误框（它不依赖窗口，此刻窗口可能已经不可用），停掉后端子进程（否则会
//      留下一个还在吃 CPU 的孤儿进程），然后退出——崩过一次的进程继续跑，状态是否可信
//      没人能保证。
//   2) 渲染进程崩：后端与队列还在，重新加载页面让渲染层用 queue.snapshot 恢复任务列表；
//      连崩两次才放弃，避免"启动即崩"变成死循环。
//   3) Chromium 子进程（GPU / 网络 / 工具进程）非正常退出：只写 sidecar.log。Chromium 会
//      自己重建这些进程，界面通常无感，不值得写进给用户看的 error.log。
let mainCrashHandled = false;
let rendererReloads = 0;

function crashDetail(error) {
  if (!error) return "（没有异常对象）";
  if (error.stack) return String(error.stack);
  if (error.message) return `${error.name || "Error"}: ${error.message}`;
  return String(error);
}

function handleMainCrash(origin, error) {
  // 崩在这里面会再进来一次，只处理第一次。
  if (mainCrashHandled) return;
  mainCrashHandled = true;
  const detail = crashDetail(error);
  const logPath = appendErrorLog({
    code: "E_MAIN_CRASH",
    message: `主进程异常（${origin}）`,
    detail,
    sidecarLog: sidecar && sidecar.stderrTail ? sidecar.stderrTail() : "",
    source: `main.${origin}`
  });
  log(`[crash] ${origin}：${detail.split("\n")[0]}`);
  try {
    sidecar?.stop();
  } catch (stopError) {
    log(`[crash] 停止后端失败：${stopError.message}`);
  }
  try {
    dialog.showErrorBox(
      t("AVL-SubtitleOCR 遇到内部错误"),
      t("主进程异常，程序需要重启。\n\n")
      + t("错误码：E_MAIN_CRASH\n日志：{0}\n\n", [logPath || t("（写入失败）")])
      + t("已经识别完成的结果不受影响，重新打开后可以继续校对与导出。")
    );
  } catch (dialogError) {
    // 连弹窗都失败（比如没有可用的图形会话）：至少把原因留在 stderr 上。
    process.stderr.write(`[crash] 弹窗失败：${dialogError.message}\n`);
  }
  app.exit(1);
}

process.on("uncaughtException", (error) => handleMainCrash("uncaughtException", error));
process.on("unhandledRejection", (reason) => handleMainCrash("unhandledRejection", reason));

app.on("render-process-gone", (_event, webContents, details) => {
  const info = details || {};
  log(`[crash] 渲染进程退出：${info.reason || t("未知原因")} exitCode=${info.exitCode}`);
  if (info.reason === "clean-exit") return;
  appendErrorLog({
    code: "E_RENDERER_GONE",
    message: `界面进程退出（${info.reason || t("未知原因")}）`,
    detail: `reason=${info.reason || ""} exitCode=${info.exitCode}`,
    source: "main.render-process-gone"
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (rendererReloads >= 2) {
    // 连续崩两次说明重载救不回来（例如显卡驱动或某个 DLL 坏了），别再循环下去。
    try {
      dialog.showErrorBox(
        t("界面反复崩溃"),
        t("界面连续两次异常退出，无法自动恢复。\n\n")
        + t("日志：{0}\n\n", [errorLogPath()])
        + t("请重新打开程序；已经识别完成的结果不受影响。")
      );
    } catch (dialogError) {
      process.stderr.write(`[crash] 弹窗失败：${dialogError.message}\n`);
    }
    app.exit(1);
    return;
  }
  rendererReloads += 1;
  log(`[crash] 第 ${rendererReloads} 次重新加载界面`);
  mainWindow.webContents.reload();
  dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: [t("知道了")],
    noLink: true,
    get title() { return t("界面已自动恢复"); },
    get message() { return t("界面进程异常退出，已自动重新加载"); },
    get detail() { return t("识别任务在后端继续跑，列表会用后端状态恢复；崩溃前 1 秒内的编辑可能没有保存。"); }
  }).catch(() => {});
});

app.on("child-process-gone", (_event, details) => {
  const info = details || {};
  if (info.reason === "clean-exit") return;
  // 只落 sidecar.log：这类崩溃 Chromium 会自己重建进程，写进 error.log 只会淹掉真错误。
  log(`[crash] Chromium 子进程退出：type=${info.type} reason=${info.reason}`
    + ` exitCode=${info.exitCode} serviceName=${info.serviceName || ""}`);
});

// 应用改名（subtitle-proofreader-exe → avl-video-subtitle-extraction → avl-subtitle-ocr）的一次性迁移：
// Electron 的 userData 目录名取自 package.json 的 name，改名后设置（localStorage）和历史
// 错误日志都会留在老目录里。只搬这两样，缓存类目录不搬（体积大且是再生品）。
// 两个旧目录都试一遍（新的在前），谁先有数据就用谁，force:false 不会互相覆盖。
const LEGACY_USER_DATA_NAMES = ["avl-video-subtitle-extraction", "subtitle-proofreader-exe"];

function migrateLegacyUserData() {
  const target = app.getPath("userData");
  // 单实例锁在启动时就会把新目录造出来，所以用它里面的子目录判断"是不是已经跑过"。
  if (fsSync.existsSync(path.join(target, "Local Storage"))) return;
  for (const legacyName of LEGACY_USER_DATA_NAMES) {
    const legacy = path.join(path.dirname(target), legacyName);
    if (legacy === target || !fsSync.existsSync(legacy)) continue;
    for (const name of ["Local Storage", "logs"]) {
      const from = path.join(legacy, name);
      if (!fsSync.existsSync(from)) continue;
      try {
        fsSync.cpSync(from, path.join(target, name), { recursive: true, force: false });
        log(`[userData] 已从旧目录迁移 ${name}：${from} -> ${target}`);
      } catch (error) {
        log(`[userData] 迁移 ${name} 失败（不影响启动）：${error.message}`);
      }
    }
  }
}

// 后端事件也落一行到 sidecar.log：只记"状态性"的，progress 这类每个视频几十条
// 的事件只在阶段变化时记一次——既能看出卡在哪一步，也不会把日志撑爆。
const lastProgressStage = new Map();

function logSidecarEvent(message) {
  const event = message && message.event;
  const payload = (message && message.payload) || {};
  if (event === "task.progress") {
    const stage = `${payload.stage || ""}`;
    if (lastProgressStage.get(payload.taskId) === stage) return;
    lastProgressStage.set(payload.taskId, stage);
    log(`[ev] progress ${payload.taskId} ${payload.percent}% `
      + `${stage || "-"} ${payload.message || ""}`.trim());
    return;
  }
  if (event === "task.started" || event === "task.state") {
    log(`[ev] ${event} ${payload.taskId} state=${payload.state || ""} `
      + `${payload.message || ""}`.trim());
    return;
  }
  if (event === "task.completed") {
    lastProgressStage.delete(payload.taskId);
    log(`[ev] task.completed ${payload.taskId} cues=${payload.cueCount}`);
    return;
  }
  if (event === "task.failed") {
    lastProgressStage.delete(payload.taskId);
    const error = payload.error || {};
    log(`[ev] task.failed ${payload.taskId} ${error.code || ""} ${error.message || ""}`.trim());
    return;
  }
  if (event === "queue.completed") {
    log(`[ev] queue.completed ${JSON.stringify(payload)}`);
  }
}

function createSidecar() {
  const client = new SidecarClient({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: __dirname,
    repoRoot: path.join(__dirname, "..", ".."),
    log
  });
  client.on("event", (message) => {
    logSidecarEvent(message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sidecar:event", message);
    }
  });
  client.on("status", (status) => {
    // detail 在 ready 时是 hello 的对象，直接插值会写成 "[object Object]"：
    // 对象只留类型提示，字符串才原样写。
    const detail = typeof status.detail === "string" ? status.detail : "";
    log(`[sidecar] 状态：${status.state} ${detail}`.trim());
    // 后端进程没了是显式错误（界面上的任务已经被打断）：这段现场只有主进程拿得到。
    if (status.state === "exited") {
      appendErrorLog({
        code: "E_BACKEND_EXITED",
        message: "OCR 后端进程退出（这一轮任务已作废）",
        detail: typeof status.detail === "string" ? status.detail : "",
        source: `sidecar.exit${status.willRetry ? ".retry" : ""}`
      });
    } else if (status.state === "missing") {
      appendErrorLog({
        code: "E_BACKEND_NOT_READY",
        message: String(status.detail || "找不到 SubtitleSidecar.exe"),
        source: "sidecar.missing"
      });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sidecar:status", status);
    }
  });
  return client;
}

function createWindow() {
  migrateLegacyUserData();
  mainI18n.setLanguage(readUiLanguagePreference());
  closeFlushed = false;
  closePending = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#eef4fb",
    title: "AVL-SubtitleOCR",
    frame: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    icon: windowIconPath(DEFAULT_PALETTE),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("maximize", () => mainWindow.webContents.send("window:maximized-changed", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window:maximized-changed", false));
  // 最后一次编辑可能还在 500ms 防抖窗口里（或"自动保存"关着）：先把窗口拦住，
  // 让渲染层回传完再关，否则那一下改动会跟着进程一起消失。识别还在跑时还要先
  // 确认一次——退出会把这一轮作废（后端进程跟着退出），旧 Qt 版也是这么做的。
  mainWindow.on("close", async (event) => {
    if (closeFlushed || closePending || mainWindow.webContents.isDestroyed()) return;
    event.preventDefault();
    closePending = true;
    if (await askRendererBusy()) {
      // showMessageBoxSync 阻塞主进程：用户没答完之前，下面那个 1.5 秒兜底定时器
      // 也不会跑，窗口不会自己关掉。
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        // 取消统一放右边（Windows 习惯：左边是"继续做这件事"）。
        buttons: [t("退出"), t("取消")],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        get title() { return t("识别还在进行"); },
        get message() { return t("识别还在进行，现在退出会中断这一轮任务"); },
        get detail() { return t("退出后这一轮不会写盘，需要重新识别。"); }
      });
      if (choice !== 0) {
        closePending = false;
        return;
      }
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      closeFlushed = true;
      mainWindow.close();
    };
    const timer = setTimeout(finish, 1500);
    ipcMain.removeAllListeners("app:flush-done");
    ipcMain.once("app:flush-done", () => {
      clearTimeout(timer);
      finish();
    });
    // 发送失败（渲染进程已经没了）就立刻放行，别让窗口卡在这里。
    try {
      mainWindow.webContents.send("app:flush");
    } catch (error) {
      clearTimeout(timer);
      finish();
    }
  });
}

function normalizeUiLanguage(language) {
  return language === "en" ? "en" : language === "zh-CN" ? "zh-CN" : null;
}

function readUiLanguageFile(file) {
  try {
    const preference = JSON.parse(fsSync.readFileSync(file, "utf8"));
    return normalizeUiLanguage(preference.language);
  } catch (_) {
    return null;
  }
}

function writeUiLanguagePreference(language) {
  const normalized = normalizeUiLanguage(language);
  if (!normalized) return false;
  try {
    const target = path.join(app.getPath("userData"), "ui-language.json");
    fsSync.writeFileSync(target + ".tmp", JSON.stringify({ language: normalized }), "utf8");
    fsSync.renameSync(target + ".tmp", target);
    return true;
  } catch (error) {
    log(`[i18n] Could not save UI language: ${error.message}`);
    return false;
  }
}

// A user choice in userData wins. On the first launch after installation we
// fall back to the marker written next to the app by NSIS, then persist it.
function readUiLanguagePreference() {
  const userPreference = readUiLanguageFile(
    path.join(app.getPath("userData"), "ui-language.json"));
  if (userPreference) return userPreference;

  const installerPreference = app.isPackaged && process.resourcesPath
    ? readUiLanguageFile(path.join(process.resourcesPath, "installer-default-language.json"))
    : null;
  if (installerPreference) {
    writeUiLanguagePreference(installerPreference);
    return installerPreference;
  }
  return "zh-CN";
}

// 关窗口前问一次渲染层"还有任务在跑吗"（队列状态只有渲染层知道）。
//
// 渲染层没答复（老版本 preload / 渲染进程卡死）或已经没了就按"不忙"处理：宁可让
// 用户关掉窗口，也不能把窗口卡住；日志里留一行，方便排查"为什么没弹确认框"。
function askRendererBusy() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (busy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeAllListeners("app:is-busy-reply");
      resolve(Boolean(busy));
    };
    // 渲染层要答的是一个同步判断，给足 1.2 秒（识别中界面还可能在建列表）。
    const timer = setTimeout(() => {
      log("[close] 渲染层没有回答忙碌询问，按不忙处理");
      finish(false);
    }, 1200);
    ipcMain.removeAllListeners("app:is-busy-reply");
    ipcMain.once("app:is-busy-reply", (_event, busy) => finish(busy));
    try {
      mainWindow.webContents.send("app:is-busy");
    } catch (error) {
      finish(false);
    }
  });
}

app.whenReady().then(() => {
  const name = typeof app.getName === "function" ? app.getName() : "AVL-SubtitleOCR";
  const version = typeof app.getVersion === "function" ? app.getVersion() : "0.0.0";
  log(`[app] ${name} ${version} · electron ${process.versions.electron || "?"}`
    + ` · protocol ${PROTOCOL_VERSION} · packaged=${app.isPackaged === true}`);
  log(`[app] userData=${app.getPath("userData")}`);
  sidecar = createSidecar();
  // Warm the backend up in the background; the window must appear instantly
  // even though the frozen exe needs a moment to start.
  sidecar.start().catch((error) => log(`[sidecar] 预启动失败：${error.message}`));
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  sidecar?.stop();
});

ipcMain.on("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.on("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("window:is-maximized", () => Boolean(mainWindow?.isMaximized()));

ipcMain.handle("app:get-version", () => app.getVersion());

ipcMain.handle("app:set-window-icon", (_event, paletteId) => {
  const iconPath = windowIconPath(paletteId);
  fs.stat(iconPath).then(() => mainWindow?.setIcon(iconPath)).catch(() => {});
});

ipcMain.handle("app:open-external", (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url).catch(() => {});
  }
});

ipcMain.handle("app:reveal-path", (_event, targetPath) => {
  if (typeof targetPath === "string" && targetPath) shell.showItemInFolder(targetPath);
});

// 渲染层报上来的错误：错误码 / 消息 / 视频路径由它给，后端 stderr 的尾部由主进程补，
// 这样日志里既有"用户看到了什么"也有"后端最后吐了什么"。返回值是日志文件路径，
// 弹窗会把它显示出来。
//
// 注意：这是唯一一处"从前端写盘"的接口，只写日志——SRT 一律走 srt.write / writeBatch。
ipcMain.handle("app:log-error", (_event, payload) => {
  const data = payload || {};
  const file = appendErrorLog({
    ...data,
    sidecarLog: data.sidecarLog || (sidecar && sidecar.stderrTail ? sidecar.stderrTail() : "")
  });
  return { ok: Boolean(file), path: file };
});

// 「打开日志位置」：一次都没写过日志时退到日志目录，至少让用户能找到那个地方。
ipcMain.handle("app:reveal-error-log", () => {
  const file = errorLogPath();
  let target = file;
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    if (!fsSync.existsSync(file)) target = path.dirname(file);
  } catch (error) {
    log(`[log] 打开日志位置失败：${error.message}`);
  }
  try {
    shell.showItemInFolder(target);
  } catch (error) {
    log(`[log] showItemInFolder 失败：${error.message}`);
  }
  return file;
});

// ------------------------------------------------------------------ session
// 任务列表快照（SESSION_RESTORE_DESIGN.md 方案 A）：数据由渲染层给，写盘由主进程
// 负责。原子替换（.tmp + rename）是这里的关键——渲染层写不了原子文件，而半截
// JSON 会让用户丢掉整个列表。读坏的快照挪到 session.corrupt.json 留现场。
const SESSION_SCHEMA_VERSION = 1;

function sessionFilePath() {
  return path.join(app.getPath("userData"), "session.json");
}

ipcMain.handle("session:load", async () => {
  const target = sessionFilePath();
  let raw;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    // 首次启动就是这样：没有快照，不是错误。
    return { ok: true, snapshot: null, reason: error.code === "ENOENT" ? "empty" : "unavailable" };
  }
  try {
    const snapshot = JSON.parse(raw);
    if (!snapshot || typeof snapshot !== "object"
      || Number(snapshot.schemaVersion) !== SESSION_SCHEMA_VERSION
      || !Array.isArray(snapshot.items)) {
      throw new Error(`schemaVersion=${snapshot && snapshot.schemaVersion}`);
    }
    return { ok: true, snapshot };
  } catch (error) {
    const backup = path.join(app.getPath("userData"), "session.corrupt.json");
    try {
      await fs.rename(target, backup);
    } catch (renameError) {
      /* 挪不动就留着，下次启动再试 */
    }
    log(`[session] 快照不可用（${error.message}），这次不恢复任务列表`);
    return { ok: true, snapshot: null, reason: "corrupt" };
  }
});

ipcMain.handle("session:save", async (_event, snapshot) => {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.items)) {
    return { ok: false, error: "快照必须是 { items: [...] }" };
  }
  const target = sessionFilePath();
  const temporary = `${target}.tmp`;
  const payload = JSON.stringify({
    ...snapshot,
    schemaVersion: SESSION_SCHEMA_VERSION,
    savedAt: new Date().toISOString()
  });
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, payload, "utf8");
    await fs.rename(temporary, target);
    return { ok: true, path: target, items: snapshot.items.length };
  } catch (error) {
    log(`[session] 写快照失败：${error.message}`);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("video:fileUrl", (_event, filePath) => {
  if (typeof filePath !== "string" || !filePath) return "";
  return pathToFileURL(filePath).href;
});

// 只认这些容器：其余（.lnk、文件夹、图片、压缩包…）必须在进队列之前挡掉，
// 否则会一路跑到解码器，最后只丢给用户一句"识别过程中出错"。
const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];

function videoExtension(filePath) {
  return path.extname(String(filePath || "")).slice(1).toLowerCase();
}

function isSupportedVideo(filePath) {
  return VIDEO_EXTENSIONS.includes(videoExtension(filePath));
}

// Windows 快捷方式本身是个 .lnk 文件：双击能打开目标，但把路径交给解码器只会失败。
// 桌面快捷方式很容易被拖进窗口，所以这里顺手解析出它指向的文件。
function resolveShortcutTarget(filePath) {
  if (videoExtension(filePath) !== "lnk") return filePath;
  try {
    return shell.readShortcutLink(filePath)?.target || "";
  } catch (error) {
    log(`[video] 读取快捷方式失败：${filePath}：${error.message}`);
    return "";
  }
}

function judgeVideoPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return { path: "", get reason() { return t("路径为空"); } };
  const target = resolveShortcutTarget(filePath);
  if (!target) return { path: "", get reason() { return t("快捷方式已损坏，读不出它指向哪个文件"); } };
  if (!isSupportedVideo(target)) {
    return {
      path: "",
      reason: videoExtension(filePath) === "lnk"
        ? t("这是快捷方式，它指向的不是视频文件（{0}）", [path.basename(target)])
        : t("只支持 {0}，收到的是 {1}", [VIDEO_EXTENSIONS.join(" / "), videoExtension(target) || t("无扩展名")])
    };
  }
  let stats = null;
  try {
    stats = fsSync.statSync(target);
  } catch (error) {
    stats = null;
  }
  if (!stats) return { path: "", get reason() { return t("文件不存在或已经被移动"); } };
  if (stats.isDirectory()) return { path: "", get reason() { return t("这是文件夹，不是视频文件"); } };
  return { path: target, reason: "" };
}

function toVideoEntry(filePath) {
  return { path: filePath, name: path.basename(filePath), url: pathToFileURL(filePath).href };
}

function splitVideoPaths(filePaths) {
  const videos = [];
  const rejected = [];
  const list = Array.isArray(filePaths) ? filePaths : [];
  for (const filePath of list) {
    const verdict = judgeVideoPath(filePath);
    if (verdict.path) videos.push(toVideoEntry(verdict.path));
    else rejected.push({
      name: path.basename(String(filePath || "")) || t("未命名文件"),
      reason: verdict.reason
    });
  }
  return { videos, rejected };
}

// 拖进来的路径也要走同一套判定（渲染层只能拿到 File 对象，路径由 preload 转过来）。
ipcMain.handle("video:resolvePaths", (_event, filePaths) => splitVideoPaths(filePaths));

ipcMain.on("app:set-ui-language", (_event, language) => {
  const normalized = normalizeUiLanguage(language);
  if (!normalized) return;
  mainI18n.setLanguage(normalized);
  writeUiLanguagePreference(normalized);
});

// Synchronous on purpose: i18n.js runs before app.js and needs the installer's
// default before the first paint, otherwise an English install flashes Chinese.
ipcMain.on("app:get-ui-language", (event) => {
  event.returnValue = readUiLanguagePreference();
});

ipcMain.handle("dialog:chooseVideos", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    get title() { return t("选择视频文件"); },
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Videos", extensions: VIDEO_EXTENSIONS },
      { name: "All Files", extensions: ["*"] }
    ]
  });

  if (result.canceled) return { videos: [], rejected: [] };
  return splitVideoPaths(result.filePaths);
});

// 删除是不可逆的（后端任务会被摘掉），用一个原生确认框兜一下。
ipcMain.handle("dialog:confirm", async (_event, payload) => {
  const data = payload || {};
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    // 取消统一放右边；Esc / 直接回车都落在取消上。
    buttons: [t("删除"), t("取消")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: String(data.message || t("确定删除？")),
    detail: String(data.detail || "")
  });
  return result.response === 0;
});

ipcMain.handle("dialog:chooseDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    get title() { return t("选择输出目录"); },
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// 只负责问路径，不写文件：SRT 一律由后端写，避免两份格式不一致。
ipcMain.handle("dialog:chooseSrtPath", async (_event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    get title() { return t("导出 SRT"); },
    defaultPath: defaultName || "subtitle.srt",
    filters: [{ name: "SubRip Subtitle", extensions: ["srt"] }]
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// ------------------------------------------------------------------ sidecar
ipcMain.handle("sidecar:start", async () => {
  try {
    const hello = await sidecar.start();
    const capabilities = await sidecar.request("system.capabilities", {});
    return { ok: true, hello, capabilities, protocolVersion: PROTOCOL_VERSION };
  } catch (error) {
    appendErrorLog({
      code: error.code || "E_BACKEND_NOT_READY",
      message: `OCR 后端启动失败：${error.message}`,
      source: "sidecar.start"
    });
    return { ok: false, error: error.message, code: error.code || "E_BACKEND_NOT_READY" };
  }
});

// 渲染层能调哪些方法：sidecar/service.py 的 _dispatch 表是权威清单，这里逐条抄下来。
// sidecar:request 是唯一一条「前端直通后端」的路——不设白名单的话，页面里任何一段脚本
// （或一个拼错的方法名）都能把任意字符串丢给后端，事后只能在后端日志里看到一句"未知方法"。
// 加方法时三处同步：service.py 的 _dispatch、这里、SIDECAR_API.md 第 5 节的方法表。
const SIDECAR_METHODS = new Set([
  "system.ping",
  "system.capabilities",
  "system.shutdown",
  "video.probe",
  "video.preparePreview",
  "video.previewCancel",
  "video.frame",
  "ocr.enqueue",
  "ocr.start",
  "ocr.cancel",
  "queue.run",
  "queue.cancel",
  "queue.snapshot",
  "task.requeue",
  "task.remove",
  "task.updateCues",
  "task.restore",
  "srt.serialize",
  "srt.write",
  "srt.writeBatch"
]);

ipcMain.handle("sidecar:request", async (_event, payload) => {
  const method = payload && payload.method;
  if (typeof method !== "string" || !method) {
    return { ok: false, error: { code: "E_INVALID_OPTIONS", message: "缺少 method" } };
  }
  if (!SIDECAR_METHODS.has(method)) {
    log(`[req] 拒绝白名单外的方法：${method}`);
    return {
      ok: false,
      error: { code: "E_INVALID_OPTIONS", message: `不支持的方法：${method}` }
    };
  }
  const startedAt = Date.now();
  try {
    const result = await sidecar.request(method, payload.params || {});
    log(`[req] ${method} ok ${Date.now() - startedAt}ms`);
    return { ok: true, result };
  } catch (error) {
    log(`[req] ${method} 失败 ${Date.now() - startedAt}ms · `
      + `${error.code || "E_INTERNAL"} · ${error.message}`);
    // 显式错误：即使界面只弹了一句 toast，日志里也要留下错误码和完整报错。
    if (error.code !== "E_CANCELLED") {
      appendErrorLog({
        code: error.code || "E_INTERNAL",
        message: `${method} 失败：${error.message}`,
        detail: error.detail,
        source: `sidecar.request:${method}`
      });
    }
    return {
      ok: false,
      error: { code: error.code || "E_INTERNAL", message: error.message, detail: error.detail }
    };
  }
});

// Opens the file in an external player positioned at the subtitle start: the
// fallback for containers the built-in player cannot show.
// Players land wherever the user let the installer put them, so probe the usual
// per-machine, per-user and scoop roots instead of hard-coding C:\ only.
const PLAYER_DIRS = [
  process.env["ProgramFiles"],
  process.env["ProgramFiles(x86)"],
  process.env["ProgramW6432"],
  process.env["LOCALAPPDATA"] ? path.join(process.env["LOCALAPPDATA"], "Programs") : null,
  process.env["USERPROFILE"] ? path.join(process.env["USERPROFILE"], "scoop", "apps") : null
].filter(Boolean);

const underPlayerDirs = (...segments) =>
  PLAYER_DIRS.map((dir) => path.join(dir, ...segments));

const PLAYERS = [
  {
    name: "VLC",
    candidates: [
      ...underPlayerDirs("VideoLAN", "VLC", "vlc.exe"),
      "vlc.exe"
    ],
    args: (file, seconds) => [`--start-time=${seconds}`, file]
  },
  {
    name: "mpv",
    candidates: [
      ...underPlayerDirs("mpv", "mpv.exe"),
      ...underPlayerDirs("mpv", "current", "mpv.exe"),
      "mpv.exe"
    ],
    args: (file, seconds) => [`--start=${seconds}`, file]
  },
  {
    name: "PotPlayer",
    candidates: [
      ...underPlayerDirs("DAUM", "PotPlayer", "PotPlayerMini64.exe"),
      ...underPlayerDirs("DAUM", "PotPlayer", "PotPlayerMini.exe")
    ],
    args: (file, seconds) => [file, `/seek=${seconds}`]
  }
];

// A bare name is resolved through PATH + PATHEXT here, before spawn: spawn
// reports a missing executable asynchronously, and an 'error' event with no
// listener throws in the main process.
function resolveExecutable(candidate) {
  if (candidate.includes("\\") || candidate.includes("/")) {
    try {
      return fsSync.existsSync(candidate) ? candidate : null;
    } catch (error) {
      return null;
    }
  }
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? ["", ...String(process.env.PATHEXT || ".EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, candidate + ext);
      try {
        if (fsSync.existsSync(full)) return full;
      } catch (error) {
        /* keep looking */
      }
    }
  }
  return null;
}

function findPlayer() {
  for (const player of PLAYERS) {
    for (const candidate of player.candidates) {
      const command = resolveExecutable(candidate);
      if (command) return { name: player.name, command, args: player.args };
    }
  }
  return null;
}

// Resolve once the process really spawned; a failure is reported instead of
// thrown, so the caller can still fall back to the system default player.
function launchPlayer(player, file, seconds) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(player.command, player.args(file, seconds),
        { detached: true, stdio: "ignore", windowsHide: false });
    } catch (error) {
      log(`[player] 启动失败：${error.message}`);
      resolve(false);
      return;
    }
    child.once("error", (error) => {
      log(`[player] 启动失败：${error.message}`);
      resolve(false);
    });
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

ipcMain.handle("video:openInPlayer", async (_event, payload) => {
  const file = payload && payload.videoPath;
  if (typeof file !== "string" || !file) return { ok: false, get error() { return t("缺少视频路径"); } };
  const seconds = Math.max(0, Math.floor(Number(payload.seconds) || 0));
  const player = findPlayer();
  if (player && await launchPlayer(player, file, seconds)) {
    return { ok: true, player: player.name };
  }
  const error = await shell.openPath(file);
  if (error) return { ok: false, error };
  return { ok: true, get player() { return t("系统默认播放器"); } };
});
