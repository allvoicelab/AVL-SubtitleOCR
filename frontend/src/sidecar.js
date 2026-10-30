"use strict";

// Spawns and talks to SubtitleSidecar.exe (SIDECAR_API.md): one JSON object
// per line over stdin/stdout, with responses correlated by request id and
// events pushed to the renderer.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 60000;
// 后端崩溃后的自动重连：1s / 3s / 10s 三次机会。只有进程活过 10 秒才算"稳定"
// 并重置退避计数，否则"启动即崩"会被无限重试。
const RECONNECT_DELAYS_MS = [1000, 3000, 10000];
const RECONNECT_STABLE_MS = 10000;

class SidecarClient {
  constructor(options = {}) {
    this._isPackaged = Boolean(options.isPackaged);
    this._resourcesPath = options.resourcesPath || "";
    this._appRoot = options.appRoot || path.join(__dirname, "..");
    this._repoRoot = options.repoRoot || path.join(__dirname, "..", "..");
    this._log = options.log || (() => {});

    this._child = null;
    this._reader = null;
    this._pending = new Map();
    this._nextId = 1;
    this._hello = null;
    this._handlers = { event: [], status: [] };
    this._startPromise = null;
    this._stopping = false;
    this._stderrTail = [];
    this._startedAt = 0;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._helloOnce = false;
    // 重连退避间隔可注入，便于测试用短间隔跑完整条重试链。
    this._reconnectDelays = Array.isArray(options.reconnectDelays)
      && options.reconnectDelays.length
      ? options.reconnectDelays.slice()
      : RECONNECT_DELAYS_MS;
  }

  on(event, handler) {
    if (this._handlers[event]) this._handlers[event].push(handler);
    return this;
  }

  _emit(event, payload) {
    for (const handler of this._handlers[event] || []) {
      try {
        handler(payload);
      } catch (error) {
        this._log(`[sidecar] ${event} 处理失败：${error && error.stack}`);
      }
    }
  }

  get hello() {
    return this._hello;
  }

  get running() {
    return Boolean(this._child && !this._child.killed);
  }

  // ---------------------------------------------------------------- locating
  // Packaged builds run the bundled exe; a checkout runs it from dist/ when it
  // has been built, and otherwise falls back to `python -m sidecar` so the UI
  // is usable before Windows packaging.
  candidates() {
    const exeName = process.platform === "win32" ? "SubtitleSidecar.exe" : "SubtitleSidecar";
    const list = [];
    if (process.env.SUBTITLE_SIDECAR) {
      list.push({ command: process.env.SUBTITLE_SIDECAR, args: [], cwd: this._repoRoot });
    }
    if (this._isPackaged) {
      list.push({
        command: path.join(this._resourcesPath, "sidecar", exeName),
        args: [],
        cwd: path.join(this._resourcesPath, "sidecar")
      });
    }
    list.push({
      command: path.join(this._repoRoot, "dist", "SubtitleSidecar", exeName),
      args: [],
      cwd: this._repoRoot
    });
    // 打包后绝不能静默退回系统 Python：那会让"安装包缺文件"伪装成"能跑"。
    if (!this._isPackaged) {
      list.push({
        command: process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
        args: ["-m", "sidecar", "--protocol-version", String(PROTOCOL_VERSION)],
        cwd: this._repoRoot,
        optional: true
      });
    }
    return list;
  }

  resolveTarget() {
    for (const candidate of this.candidates()) {
      if (candidate.optional) return candidate;
      try {
        if (fs.existsSync(candidate.command)) return candidate;
      } catch (error) {
        /* keep looking */
      }
    }
    return null;
  }

  // -------------------------------------------------------------- lifecycle
  start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._start().catch((error) => {
      this._startPromise = null;
      throw error;
    });
    return this._startPromise;
  }

  async _start() {
    const target = this.resolveTarget();
    if (!target) {
      const message = "找不到 SubtitleSidecar.exe，请先运行 build_sidecar_windows.bat";
      this._emit("status", { state: "missing", detail: message });
      throw new Error(message);
    }

    this._emit("status", { state: "starting", detail: target.command });
    this._log(`[sidecar] 启动：${target.command} ${target.args.join(" ")}`.trim());

    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this._child = child;
    this._stopping = false;
    this._startedAt = Date.now();

    child.stdout.setEncoding("utf8");
    this._reader = readline.createInterface({ input: child.stdout });
    this._reader.on("line", (line) => this._handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this._handleStderr(chunk));

    const hello = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时的那份进程必须收掉：它可能只是很慢但还活着，会一直占着 CPU；
        // 而 start() 的缓存 promise 已经在这里被清掉，用户重试就会再 spawn 一份，
        // 两份 OCR 后端抢同一个队列，界面只会看到状态来回跳。
        this.stop();
        reject(new Error("后端启动超时（30 秒内没有收到 system.hello）"));
      }, START_TIMEOUT_MS);
      const onHello = (payload) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this._helloWaiters = this._helloWaiters || [];
      this._helloWaiters.push(onHello);
      child.once("error", (error) => {
        clearTimeout(timer);
        // spawn 失败时不会有 exit 事件：这里必须自己把进程引用放掉，
        // 否则自动重连会以为"还有子进程"而不再尝试。
        if (this._child === child) this._child = null;
        reject(new Error(`无法启动后端进程：${error.message}`));
      });
      // 握手期间进程就退出：让 start() 立刻失败，调用方不必干等 30 秒超时。
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("后端进程在握手前退出"));
      });
    });

    child.on("exit", (code, signal) => {
      this._log(`[sidecar] 退出 code=${code} signal=${signal}`);
      this._failPending(new Error("后端进程已退出"));
      const wasCurrent = this._child === child;
      this._child = null;
      this._hello = null;
      // 必须清掉缓存的启动 promise：否则之后的 start() 只会拿回这个已经
      // resolve 的旧结果，再也不会重新 spawn（崩溃后无法恢复的根因）。
      this._startPromise = null;
      if (this._stopping) {
        this._emit("status", { state: "stopped", detail: "" });
        return;
      }
      const detail = this.stderrTail();
      const willRetry = wasCurrent && this._scheduleReconnect();
      this._emit("status", { state: "exited", detail, willRetry });
    });

    const payload = await hello;
    if (this._child !== child) {
      // 握手刚回来进程就没了：不能对外报 ready。
      throw new Error("后端进程在握手后立即退出");
    }
    this._hello = payload;
    this._helloOnce = true;
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      this.stop();
      throw new Error(
        `前后端协议版本不一致（前端 ${PROTOCOL_VERSION}，后端 ${payload.protocolVersion}）`
      );
    }
    this._emit("status", { state: "ready", detail: payload });
    return payload;
  }

  // 崩溃后按退避间隔重连；返回是否真的安排了重试（前端据此决定要不要给
  // "重新连接"入口）。成功重连走正常 ready 事件。
  _scheduleReconnect() {
    if (this._stopping || this._reconnectTimer || this._child) return false;
    // 第一次就握不上手（安装包不全、exe 起不来）不后台重试，
    // 直接把错误暴露给用户，避免反复拉起再失败。
    if (!this._helloOnce) return false;
    const uptime = this._startedAt ? Date.now() - this._startedAt : 0;
    if (uptime >= RECONNECT_STABLE_MS) this._reconnectAttempts = 0;
    if (this._reconnectAttempts >= this._reconnectDelays.length) {
      this._log("[sidecar] 自动重连次数用尽，等待手动重连");
      return false;
    }
    const delay = this._reconnectDelays[this._reconnectAttempts];
    this._reconnectAttempts += 1;
    const attempt = this._reconnectAttempts;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._stopping || this._child) return;
      this._emit("status", { state: "reconnecting", attempt, delayMs: delay });
      this._log(`[sidecar] 自动重连（第 ${attempt} 次）`);
      this.start().catch((error) => {
        this._log(`[sidecar] 自动重连失败：${error.message}`);
        // exit 处理器一般已经排好了下一次重试，这里别抢着报"不再重连"。
        if (this._stopping || this._reconnectTimer || this._child) return;
        if (!this._scheduleReconnect()) {
          this._emit("status", {
            state: "exited", detail: error.message, willRetry: false
          });
        }
      });
    }, delay);
    return true;
  }

  stop() {
    this._stopping = true;
    this._reconnectAttempts = 0;
    this._helloOnce = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (!this._child) return;
    const child = this._child;
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    } catch (error) {
      /* ignore */
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (error) {
        /* ignore */
      }
    }, 2000);
    child.once("exit", () => clearTimeout(timer));
  }

  // --------------------------------------------------------------- protocol
  request(method, params, options = {}) {
    const id = this._nextId++;
    const message = { id, method, params: params || {} };
    const timeoutMs = options.timeout || REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`后端响应超时：${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      if (!this._write(message)) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error("后端未在运行"));
      }
    });
  }

  _write(message) {
    if (!this._child || !this._child.stdin || this._child.stdin.destroyed) return false;
    try {
      this._child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      this._log(`[sidecar] 写入失败：${error.message}`);
      return false;
    }
  }

  _handleLine(line) {
    const text = String(line).trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      this._log(`[sidecar] 忽略无法解析的输出：${text.slice(0, 200)}`);
      return;
    }
    if (message.event) {
      if (message.event === "system.hello") {
        for (const waiter of this._helloWaiters || []) waiter(message.payload);
        this._helloWaiters = [];
      }
      this._emit("event", message);
      return;
    }
    const entry = this._pending.get(message.id);
    if (!entry) return;
    this._pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      const error = new Error((message.error && message.error.message) || "后端返回错误");
      error.code = message.error && message.error.code;
      error.detail = message.error && message.error.detail;
      entry.reject(error);
    }
  }

  _handleStderr(chunk) {
    const text = String(chunk);
    this._stderrTail.push(text);
    while (this._stderrTail.length > 20) this._stderrTail.shift();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) this._log(`[sidecar] ${line.trim()}`);
    }
  }

  stderrTail() {
    return this._stderrTail.join("").split(/\r?\n/).filter(Boolean).slice(-5).join("\n");
  }

  _failPending(error) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }
}

module.exports = { SidecarClient, PROTOCOL_VERSION };
