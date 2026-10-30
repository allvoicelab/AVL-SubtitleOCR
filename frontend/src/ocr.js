"use strict";

// Renderer-side wrapper around the sidecar bridge: request helpers, a single
// event stream, and the small amount of time formatting the UI needs.
// Protocol details live in SIDECAR_API.md; nothing here invents its own
// status vocabulary.

(function () {
  const bridge = window.subtitleApp;
  const ocrBridge = bridge && bridge.ocr;

  const session = {
    ready: false,
    hello: null,
    capabilities: null,
    lastSeq: -1,
    _connecting: null,
    _eventHandlers: [],
    _statusHandlers: [],
    _subscribed: false,

    async connect() {
      if (this.ready) {
        return { ok: true, hello: this.hello, capabilities: this.capabilities };
      }
      if (this._connecting) return this._connecting;
      this._connecting = (async () => {
        if (!ocrBridge) {
          return { ok: false, get error() { return t("当前不在 Electron 环境中运行"); } };
        }
        const started = await ocrBridge.start();
        if (!started || !started.ok) {
          return { ok: false, error: (started && started.error) || t("后端启动失败") };
        }
        this.hello = started.hello;
        this.capabilities = started.capabilities;
        this.ready = true;
        // 每次（重新）握手都重置事件高水位：后端换了进程，它的 seq 从 0
        // 重新开始，留着上一轮的 lastSeq 会把新会话的事件全判成"重放"丢掉，
        // 表现就是连上了、请求也有回，但界面从此收不到任何进度/完成事件。
        this.lastSeq = -1;
        if (!this._subscribed) {
          this._subscribed = true;
          ocrBridge.onEvent((message) => this._dispatch(message));
          ocrBridge.onStatus((status) => {
            if (status.state === "exited" || status.state === "missing") {
              this.ready = false;
              this._connecting = null;
              // 这个进程不会再发事件了；下一个进程的 seq 会从头开始。
              this.lastSeq = -1;
            }
            for (const handler of this._statusHandlers) handler(status);
          });
        }
        return { ok: true, hello: this.hello, capabilities: this.capabilities };
      })();
      try {
        return await this._connecting;
      } finally {
        this._connecting = null;
      }
    },

    onEvent(handler) {
      this._eventHandlers.push(handler);
    },

    onStatus(handler) {
      this._statusHandlers.push(handler);
    },

    _dispatch(message) {
      if (typeof message.seq === "number") {
        if (message.seq <= this.lastSeq) return; // stale or replayed
        this.lastSeq = message.seq;
      }
      for (const handler of this._eventHandlers) {
        try {
          handler(message.event, message.payload || {});
        } catch (error) {
          console.error("事件处理失败", message.event, error);
        }
      }
    },

    async request(method, params, options) {
      if (!ocrBridge) throw new Error(t("当前不在 Electron 环境中运行"));
      const response = await ocrBridge.request(method, params || {});
      if (!response || !response.ok) {
        const info = (response && response.error) || {};
        const error = new Error(info.message || t("后端调用失败"));
        error.code = info.code || "E_INTERNAL";
        error.detail = info.detail;
        throw error;
      }
      return response.result;
    },

    // ------------------------------------------------------------ shortcuts
    enqueue(taskId, videoPath) {
      return this.request("ocr.enqueue", { taskId, videoPath });
    },
    start(taskId, videoPath, options) {
      return this.request("ocr.start", { taskId, videoPath, options });
    },
    runQueue(taskIds, options) {
      return this.request("queue.run", { taskIds, options });
    },
    cancelTask(taskId) {
      return this.request("ocr.cancel", { taskId });
    },
    cancelAll() {
      return this.request("queue.cancel", {});
    },
    requeue(taskId, videoPath) {
      return this.request("task.requeue", { taskId, videoPath });
    },
    removeTask(taskId) {
      return this.request("task.remove", { taskId });
    },
    updateCues(taskId, cues) {
      return this.request("task.updateCues", { taskId, cues });
    },
    restoreTasks(items) {
      return this.request("task.restore", { items });
    },
    snapshot() {
      return this.request("queue.snapshot", {});
    },
    serialize(taskId) {
      return this.request("srt.serialize", { taskId });
    },
    writeSrt(taskId, targetPath) {
      return this.request("srt.write", { taskId, targetPath });
    },
    writeBatch(taskIds, directory) {
      return this.request("srt.writeBatch", { taskIds, dir: directory });
    },
    probe(videoPath) {
      return this.request("video.probe", { videoPath });
    },
    videoFrame(videoPath, timeMs, maxWidth) {
      return this.request("video.frame", { videoPath, timeMs, maxWidth });
    },
    preparePreview(videoPath, force) {
      return this.request("video.preparePreview", { videoPath, force: Boolean(force) });
    },
    cancelPreview(jobId) {
      return this.request("video.previewCancel", { jobId });
    }
  };

  // ------------------------------------------------------------ formatting
  function pad(value, width) {
    return String(value).padStart(width, "0");
  }

  function formatTimestamp(milliseconds) {
    const total = Math.max(0, Math.round(Number(milliseconds) || 0));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
  }

  // 整串匹配：不匹配就报错，别把 "100:00:00,000" 从中间截成 00:00:00,000。
  // 小时最多 3 位（长片/拼接片源够用），分秒 1-2 位，毫秒 1-3 位。
  function parseTimestamp(text) {
    const match = String(text == null ? "" : text).trim()
      .match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})[,. ](\d{1,3})$/);
    if (!match) return null;
    const [, hours, minutes, seconds, millis] = match;
    return (
      Number(hours) * 3600000 +
      Number(minutes) * 60000 +
      Number(seconds) * 1000 +
      Number(millis.padEnd(3, "0"))
    );
  }

  function cueToBackend(cue) {
    return {
      startMs: Math.max(0, Math.round(cue.startMs)),
      endMs: Math.max(0, Math.round(cue.endMs)),
      text: cue.text,
      confidence: cue.confidence,
      fps: cue.fps
    };
  }

  session.formatTimestamp = formatTimestamp;
  session.parseTimestamp = parseTimestamp;
  session.cueToBackend = cueToBackend;

  window.ocrSession = session;
})();
