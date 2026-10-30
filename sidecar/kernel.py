"""Recognition queue.

Semantics (see SIDECAR_API.md §8):

* one sequential worker, so a batch never saturates the CPU;
* cancelling a single video aborts only that video and the queue moves on;
* cancelling the batch clears everything that is still waiting;
* restarting a batch skips the videos that already finished with the same
  settings and resumes at the first unfinished one.

The recognition callable is injected so the whole thing is testable without
OpenCV, ONNX Runtime or model files.
"""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Callable, Optional

from . import srt_io
from .errors import (
    E_CANCELLED,
    E_INTERNAL,
    E_OCR_RUNTIME,
    E_OCR_STALLED,
    E_TASK_BUSY,
    E_VIDEO_DECODE,
    E_VIDEO_NOT_FOUND,
    E_VIDEO_UNSUPPORTED,
    SidecarError,
    TaskNotFound,
)
from .models import (
    RECOGNIZER,
    STAGE_LOADING_MODEL,
    STAGE_PREPARING,
    STAGE_RECOGNIZING,
    STAGE_SCANNING,
    STATE_CANCELLED,
    STATE_COMPLETED,
    STATE_FAILED,
    STATE_IDLE,
    STATE_MODIFIED,
    STATE_RUNNING,
    STATE_WAITING,
    Cue,
    RecognitionOptions,
    TaskRecord,
    roi_interval_for_fps,
)
from .protocol import log

PROGRESS_MIN_INTERVAL = 0.1  # seconds; also emit on every 1% step
IDLE_POLL_SECONDS = 0.5

# 静音看门狗：加载模型 / 探测视频时线程可能永远不返回（Windows loader lock、
# 安全软件拦住 DLL、网络盘…），界面只能干等。加载阶段给 2 分钟，真跑起来之后
# 只在整整 10 分钟没有任何百分比变化时才判定，免得给慢机器误报。
STALL_TIMEOUT_SECONDS = 120.0
STALL_PROGRESS_TIMEOUT_SECONDS = 600.0
WATCHDOG_TICK_SECONDS = 5.0

# 看门狗判定卡死之后用这个退出码收场：worker 卡在原生调用里（GPU 设备挂起、
# 安全软件拦住 DLL）不会再回来，进程留着只会占着显存和句柄，队列也永远动不了。
# 主动退出之后前端会自动重连一个干净的后端，用户点「重新识别」就能接着跑。
STALLED_EXIT_CODE = 70

# 与前端 main.js 的 VIDEO_EXTENSIONS 保持一致。前端已经挡了一道，这里是兜底：
# 路径本来就不该走到这里，真走到了也要给一个能指导行动的错，而不是"识别过程中出错"。
SUPPORTED_VIDEO_SUFFIXES = (".mp4", ".mov", ".mkv", ".avi", ".webm")


def reject_non_video(video_path: str) -> None:
    """快捷方式 / 文件夹 / 不认识的扩展名：登记阶段就挡掉。"""
    raw = str(video_path or "")
    path = Path(raw)
    suffix = path.suffix.lower()
    if suffix == ".lnk":
        raise SidecarError(
            E_VIDEO_UNSUPPORTED, "这是一个快捷方式，不是视频文件",
            f"{raw}；请选中它指向的视频文件，或者直接把视频拖进来")
    if path.is_dir():
        raise SidecarError(
            E_VIDEO_UNSUPPORTED, "这是一个文件夹，不是视频文件", raw)
    if suffix not in SUPPORTED_VIDEO_SUFFIXES:
        raise SidecarError(
            E_VIDEO_UNSUPPORTED, "不是可识别的视频文件",
            f"{raw}；只支持 {', '.join(SUPPORTED_VIDEO_SUFFIXES)}")


# ``task.restore`` 一次可以收到整个任务列表：给一个上限，别让一份损坏的快照
# （或者一个超大列表）把队列锁占住。
RESTORE_LIMIT = 500


def _restore_failure(task_id: str, reason: str, message: str,
                     error: Optional[dict] = None) -> dict:
    """One item of a ``task.restore`` response that could not be restored."""
    return {
        "taskId": task_id,
        "ok": False,
        "reason": reason,
        "state": STATE_IDLE,
        "error": error or {
            "code": E_INTERNAL, "message": message, "detail": ""},
    }


def _env_seconds(name: str, explicit: Optional[float], default: float) -> float:
    if explicit is not None:
        return max(0.05, float(explicit))
    try:
        return max(0.05, float(os.environ.get(name, "") or default))
    except (TypeError, ValueError):
        return default


class QueueKernel:
    def __init__(self, recognizer=None, probe=None, emit=None,
                 clock: Callable[[], float] = time.monotonic,
                 auto_start_worker: bool = True,
                 stall_timeout: Optional[float] = None,
                 progress_stall_timeout: Optional[float] = None,
                 watchdog_tick: Optional[float] = None,
                 exit_process: Optional[Callable[[int], None]] = None):
        self._recognizer = recognizer or default_recognizer
        self._probe = probe or default_probe
        self._emit_callback = emit or (lambda event, payload: None)
        self._clock = clock

        self._lock = threading.RLock()
        self._cv = threading.Condition(self._lock)
        self._tasks: dict[str, TaskRecord] = {}
        self._pending: list[str] = []
        self._current: Optional[str] = None
        self._run_order: list[str] = []
        # True = 这一轮还有任务在跑/在排队；排空时发一次 queue.completed。
        # 不能用 ``_run_order`` 是否为空来判断：``remove()`` 会把 id 从
        # ``_run_order`` 里摘掉，删掉最后一个正在跑的视频时队列其实已经排空，
        # 但按"队列非空"判定就永远不发 queue.completed（前端弹窗卡住）。
        self._batch_open = False
        self._weights: dict[str, float] = {}
        self._shutdown = False
        self._counters = {"completed": 0, "failed": 0, "cancelled": 0}
        self._order_counter = 0
        self._last_progress_emit: dict[str, tuple[float, int]] = {}
        self._worker: Optional[threading.Thread] = None
        self._stall_timeout = _env_seconds(
            "VIDEO_SUBTITLE_STALL_SECONDS", stall_timeout, STALL_TIMEOUT_SECONDS)
        self._progress_stall_timeout = _env_seconds(
            "VIDEO_SUBTITLE_STALL_PROGRESS_SECONDS", progress_stall_timeout,
            STALL_PROGRESS_TIMEOUT_SECONDS)
        self._watchdog_tick = max(
            0.01, float(watchdog_tick if watchdog_tick is not None
                        else WATCHDOG_TICK_SECONDS))
        self._watchdog: Optional[threading.Thread] = None
        # 卡死之后怎么收场：默认只报错不退出（测试与嵌入方保持安静），
        # 真正的进程入口 sidecar/__main__.py 传 os._exit。
        self._exit_process = exit_process

        if auto_start_worker:
            self.start()

    # ------------------------------------------------------------------ setup
    def start(self) -> None:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(
                target=self._worker_loop, name="ocr-queue", daemon=True)
            self._worker.start()
            if self._watchdog is None or not self._watchdog.is_alive():
                self._watchdog = threading.Thread(
                    target=self._watchdog_loop, name="ocr-watchdog",
                    daemon=True)
                self._watchdog.start()

    def shutdown(self, timeout: float = 5.0) -> None:
        with self._lock:
            self._shutdown = True
            for record in self._tasks.values():
                record.abort = True
            self._pending.clear()
            self._cv.notify_all()
        worker = self._worker
        if worker is not None and worker.is_alive():
            worker.join(timeout)
        watchdog = self._watchdog
        if watchdog is not None and watchdog.is_alive():
            watchdog.join(timeout)

    # ------------------------------------------------------------- task list
    def add_task(self, task_id: str, video_path: str) -> TaskRecord:
        """``ocr.enqueue``：只登记，不排队。

        但**运行中加入**的视频必须接在本次队列的队尾：以前它会停在 ``idle``，
        当前视频跑完后队列直接空转，界面上也只显示"等待处理"、没有任何开始入口
        （用户 2026-09-20 报的 bug）。``ocr.enqueue`` 自身不带参数，所以新视频
        沿用这次运行已有的设置，不会静默退回 ``RecognitionOptions`` 的默认值。
        """
        events: list = []
        with self._lock:
            record = self._register_locked(str(task_id), str(video_path))
            if record.state == STATE_IDLE and self._live_run_locked():
                record.options = self._live_options_locked() or record.options
                self._enqueue_locked(record, events)
        self._flush(events)
        return record

    def _register_locked(self, task_id: str, video_path: str) -> TaskRecord:
        """首次见到就建记录；探测失败不影响登记。调用方需持有 ``_lock``。"""
        reject_non_video(video_path)
        if not Path(video_path).is_file():
            raise SidecarError(
                E_VIDEO_NOT_FOUND, "找不到视频文件", video_path)
        record = self._tasks.get(task_id)
        if record is None:
            self._order_counter += 1
            record = TaskRecord(
                task_id=task_id, video_path=video_path,
                order=self._order_counter, message="等待处理")
            self._tasks[task_id] = record
            self._probe_task(record)
        record.touch()
        return record

    def _live_run_locked(self) -> bool:
        """本次运行是否还活着（有视频在跑或还有排队中的）。"""
        return self._current is not None or bool(self._pending)

    def _live_options_locked(self) -> Optional[RecognitionOptions]:
        """运行中加入的视频沿用这次运行的设置（正在跑的那个优先）。"""
        for task_id in [self._current, *self._pending]:
            if task_id is None:
                continue
            record = self._tasks.get(task_id)
            if record is not None and record.options is not None:
                return record.options
        return None

    def probe_video(self, video_path: str) -> dict:
        """Container/codec/fps facts (cached by path + mtime)."""
        return self._probe(str(video_path))

    def _probe_task(self, record: TaskRecord) -> None:
        """Fill duration/fps so weighting and frame math work; never fatal."""
        try:
            info = self._probe(record.video_path)
        except Exception as exc:  # noqa: BLE001
            log(f"探测视频失败（{record.video_path}）：{exc!r}")
            return
        record.duration_ms = int(info.get("durationMs") or 0)
        record.fps = float(info.get("fps") or 0.0)

    def task(self, task_id: str) -> TaskRecord:
        record = self._tasks.get(str(task_id))
        if record is None:
            raise TaskNotFound(task_id)
        return record

    def tasks(self) -> list[TaskRecord]:
        with self._lock:
            return sorted(self._tasks.values(), key=lambda item: item.order)

    # -------------------------------------------------------------- commands
    def start_single(self, task_id: str, video_path: str,
                     options: RecognitionOptions) -> dict:
        """``ocr.start``: queue one video and let the worker pick it up."""
        events = []
        with self._lock:
            record = self._register_locked(str(task_id), str(video_path))
            # 设置先于入队写入：排队中的记录随时可能被 worker 取走，
            # 慢一步的话这个视频就会用默认参数跑。
            record.options = options
            self._enqueue_locked(record, events)
        self._flush(events)
        return {"taskId": record.task_id, "state": record.state}

    def run_queue(self, task_ids: Optional[list[str]],
                  options: RecognitionOptions) -> dict:
        """``queue.run``: queue everything that still needs a run."""
        events = []
        started = 0
        skipped = 0
        stopping = 0
        with self._lock:
            records = [self.task(task_id) for task_id in task_ids] \
                if task_ids else self.tasks()
            runnable = []
            for record in records:
                if record.state == STATE_RUNNING:
                    skipped += 1
                    # 已经点了停止、但 worker 还没收尾的那个单独报出来：这时点开始
                    # 什么都启动不了，前端要提示"稍等一下"，而不是"都已经有结果了"。
                    if record.abort:
                        stopping += 1
                    continue
                # ``modified`` 也算做完了：手改内容已经写回 SRT，只有语言或专家
                # 参数变了（config_key 不同）才值得重跑。
                if (record.state in (STATE_COMPLETED, STATE_MODIFIED)
                        and record.completed_config == options.config_key()):
                    skipped += 1
                    self._relocate_output_locked(record, options, events)
                    continue
                runnable.append(record)
            for record in runnable:
                record.options = options
                self._reset_locked(record)
                self._enqueue_locked(record, events)
                started += 1
            if runnable:
                events.append(("queue.started", {
                    "total": started,
                    "taskIds": [record.task_id for record in runnable],
                }))
                # 计数只在队列真正排空时（``_maybe_finish_queue``）清零：这一轮被
                # "停止全部"打断、用户在收尾前又点了开始的话，上一轮的完成/取消数
                # 要累积进下一次汇总，在这里重置会让汇总只剩最后一轮。
        self._flush(events)
        return {"started": started, "skipped": skipped, "stopping": stopping}

    def cancel_task(self, task_id: str) -> dict:
        """``ocr.cancel``: abort one video, keep the rest of the queue alive."""
        events = []
        with self._lock:
            record = self.task(task_id)
            if record.state == STATE_RUNNING:
                record.abort = True
                record.cancel_scope = "single"
            elif record.state in (STATE_WAITING, STATE_IDLE):
                # 本来就在队列里的才算这一轮的取消数（idle 的那条没参与这一轮）。
                queued = record.task_id in self._pending
                self._pending[:] = [item for item in self._pending
                                    if item != record.task_id]
                record.state = STATE_CANCELLED
                record.stage = None
                record.message = "已取消"
                record.cancel_scope = "single"
                record.touch()
                if queued:
                    self._counters["cancelled"] += 1
                events.append(("task.cancelled", {
                    "taskId": record.task_id, "scope": "single"}))
            result = {"taskId": record.task_id, "state": record.state}
        self._flush(events)
        # 取消的可能正是队列里最后一个：队列这就排空了，收尾事件不能等下一个任务
        # （已经没有下一个了），否则前端进度窗口永远挂着（SIDECAR_API.md §7）。
        self._maybe_finish_queue()
        return result

    def cancel_all(self) -> dict:
        """``queue.cancel``: stop the running video and drop the queue."""
        events = []
        with self._lock:
            cancelled = 0
            for record in self._pending:
                item = self._tasks.get(record)
                if item is None or item.state != STATE_WAITING:
                    continue
                item.state = STATE_CANCELLED
                item.stage = None
                item.message = "已取消"
                item.cancel_scope = "all"
                item.touch()
                cancelled += 1
                self._counters["cancelled"] += 1
                events.append(("task.cancelled", {
                    "taskId": item.task_id, "scope": "all"}))
            self._pending.clear()
            if self._current is not None:
                running = self._tasks.get(self._current)
                if running is not None and running.state == STATE_RUNNING:
                    running.abort = True
                    running.cancel_scope = "all"
                    cancelled += 1
            idle = self._current is None
        self._flush(events)
        if idle:
            self._maybe_finish_queue()
        return {"cancelled": cancelled}

    def requeue(self, task_id: str, path: Optional[str] = None) -> dict:
        """``task.requeue``: put a cancelled/failed/edited video at the tail."""
        events = []
        with self._lock:
            record = self.task(task_id)
            if path:
                record.video_path = str(path)
            record.abort = False
            record.error = None
            self._reset_locked(record)
            self._enqueue_locked(record, events)
            state = record.state
        self._flush(events)
        return {"taskId": record.task_id, "state": state}

    def remove(self, task_id: str) -> dict:
        """``task.remove``: drop the video (aborting it if it is running)."""
        events = []
        with self._lock:
            record = self._tasks.get(str(task_id))
            if record is None:
                return {"removed": False}
            record.abort = True
            record.removed = True
            self._pending[:] = [item for item in self._pending
                                if item != record.task_id]
            self._run_order = [item for item in self._run_order
                               if item != record.task_id]
            self._weights.pop(record.task_id, None)
            self._tasks.pop(record.task_id, None)
            events.append(("task.removed", {"taskId": record.task_id}))
        self._flush(events)
        # 删掉的是队列里最后一个时同样已经排空，收尾理由见 cancel_task。
        self._maybe_finish_queue()
        return {"removed": True}

    def update_cues(self, task_id: str, cues: list[dict]) -> dict:
        """``task.updateCues``: store hand edits and rewrite the SRT on disk.

        Times are taken verbatim: the OCR runtime clamps ``endMs`` to a
        computed duration, so normalising here would mark every cue as edited
        and trigger pointless rewrites (SIDECAR_API.md §4.3).
        """
        events = []
        with self._lock:
            record = self.task(task_id)
            # 排队/识别中的记录马上会被 OCR 结果整体替换（``_reset_locked`` 已经
            # 清过 cues）。这时候收下手改内容，界面会先显示"已修改"、磁盘还会先写
            # 一遍旧内容，跑完又整体被新结果盖掉（SIDECAR_API.md §5）。宁可明确
            # 拒绝，让用户等这一遍跑完再改。
            if record.state in (STATE_WAITING, STATE_RUNNING):
                raise SidecarError(
                    E_TASK_BUSY, "该视频正在识别，这次字幕改动没有保存",
                    f"taskId={record.task_id} state={record.state}")
            fps = record.fps
            parsed = []
            for index, payload in enumerate(cues, start=1):
                cue = Cue.from_dict(payload, index=index, fps=fps)
                start_frame, end_frame = cue.frames_for(cue.fps or fps)
                cue.start_frame = cue.start_frame if cue.start_frame is not None \
                    else start_frame
                cue.end_frame = cue.end_frame if cue.end_frame is not None \
                    else end_frame
                parsed.append(cue)
            # 传进来的顺序就是写盘顺序：手改/合并后前端可能发来未排序的列表，
            # 这里排一次，保证 SRT 和界面上的时间轴一致。
            record.cues = sorted(
                parsed, key=lambda item: (item.start_ms, item.end_ms))
            for position, cue in enumerate(record.cues, start=1):
                cue.index = position
            # 保留 completed_config：手改的结果已经写回 SRT，同一套参数下批次
            # 必须跳过它，否则重跑会拿 OCR 结果覆盖手改内容；语言/专家参数变了
            # config_key 自然对不上，那时才重跑。
            record.state = STATE_MODIFIED
            record.error = None
            record.empty_result = not record.cues
            record.touch()
            output_path = record.output_path
            write_srt = bool(record.options.write_srt) if record.options else True
            target = output_path or self._default_output_locked(record)
            write_error = None
            # 空列表也要写盘：用户把字幕全删了，磁盘上不能留着旧内容。
            if write_srt and target:
                try:
                    srt_io.write(record.cues, target)
                    record.output_path = target
                except SidecarError as exc:
                    # 改动只在内存里、磁盘还是旧内容：必须回给前端，否则界面显示
                    # "已修改 · 已写入 SRT"而磁盘没变（SIDECAR_API.md §5）。
                    write_error = exc.to_dict()
                    log(f"重写字幕失败：{json.dumps(write_error, ensure_ascii=False)}")
            output_path = record.output_path
            events.append(("task.state", self._state_payload(record)))
        self._flush(events)
        result = {
            "taskId": record.task_id,
            "state": record.state,
            "outputPath": output_path,
        }
        if write_error is not None:
            result["writeError"] = write_error
        return result

    # ---------------------------------------------------------------- restore
    def restore_tasks(self, items: list) -> dict:
        """``task.restore``: rebuild the task list from a session snapshot.

        **只读**：不排队、不写盘、不发事件。逐条回结果，因为「视频被挪走了」
        这种事不能把整个列表判失败，更不能把那一行变成 ``failed``（前端就是
        按这些结果决定行的状态，见 SESSION_RESTORE_DESIGN.md §3.4）。
        """
        results = []
        with self._lock:
            for raw in items[:RESTORE_LIMIT]:
                try:
                    results.append(self._restore_locked(
                        raw if isinstance(raw, dict) else {}))
                except Exception as exc:  # noqa: BLE001 - 一条坏数据不能毁掉整个列表
                    log(f"恢复任务失败：{exc!r}")
                    results.append(_restore_failure(
                        "", "bad-request", "这一条快照读不出来", {
                            "code": E_INTERNAL, "message": "快照条目无法恢复",
                            "detail": repr(exc)}))
        return {"items": results}

    def _restore_locked(self, payload: dict) -> dict:
        """Rebuild one record, or explain why it could not be rebuilt."""
        task_id = str(payload.get("taskId") or "").strip()
        video_path = str(payload.get("videoPath") or "").strip()
        if not task_id or not video_path:
            return _restore_failure(
                task_id, "bad-request", "缺少 taskId / videoPath",
                SidecarError(E_INVALID_OPTIONS, "缺少 taskId / videoPath",
                             "").to_dict())

        existing = self._tasks.get(task_id)
        if existing is not None:
            # 已经恢复过（或者这一轮本来就在手里）：原样回报，不覆盖内存里
            # 现有的内容——重复恢复不该把用户刚才的编辑冲掉。
            return self._restore_payload(existing)

        # 参数只影响「重跑时写哪儿、要不要写盘」，不是字幕的真相：一份带不认识
        # 语言的快照不该让整行恢复不了，忽略它继续。
        options = None
        options_ignored = False
        raw_options = payload.get("options")
        if isinstance(raw_options, dict):
            try:
                options = RecognitionOptions.from_dict(raw_options)
            except SidecarError as exc:
                options_ignored = True
                log(f"恢复任务时忽略识别参数（{task_id}）：{exc.message}")

        try:
            record = self._register_locked(task_id, video_path)
        except SidecarError as exc:
            reason = "missing" if exc.code == E_VIDEO_NOT_FOUND else "unsupported"
            return _restore_failure(task_id, reason, exc.message, exc.to_dict())

        record.options = options
        wanted = str(payload.get("state") or STATE_COMPLETED)
        if wanted not in (STATE_COMPLETED, STATE_MODIFIED):
            wanted = STATE_COMPLETED

        target = self._restore_output_path(record, payload.get("outputPath"))
        if target is None or not Path(target).is_file():
            return _restore_failure(
                task_id, "no-output", "这个视频对应的字幕文件不在原来的位置")

        parsed = srt_io.read(target, fps=record.fps)
        if parsed is None:
            return _restore_failure(task_id, "unreadable-srt", "字幕文件读不出来")
        cues, unparsed = parsed
        if unparsed and not cues:
            return _restore_failure(
                task_id, "unreadable-srt", "字幕文件里没有能解析的字幕块")

        config = RecognitionOptions.config_key_from(payload.get("completedConfig"))
        if config is None:
            log(f"恢复任务时没有可用的 completed_config（{task_id}）："
                "这一条在下次同参数批量里会重新识别")
        record.cues = cues
        record.output_path = str(target)
        record.completed_config = config
        record.empty_result = not cues
        record.state = wanted
        record.progress = 100
        record.stage = None
        record.error = None
        record.message = ("未识别到字幕" if record.empty_result
                          else "已修改" if wanted == STATE_MODIFIED else "已完成")
        record.touch()

        result = self._restore_payload(record)
        result.update({
            "partial": unparsed > 0,
            "unparsedBlocks": unparsed,
            "configMissing": config is None,
        })
        if options_ignored:
            result["optionsIgnored"] = True
        return result

    def _restore_payload(self, record: TaskRecord) -> dict:
        return {
            "taskId": record.task_id,
            "ok": True,
            "reason": "",
            "state": record.state,
            "cueCount": len(record.cues),
            "cues": [cue.to_dict() for cue in record.cues],
            "outputPath": record.output_path,
            "durationMs": record.duration_ms,
            "fps": record.fps,
            # 回给前端是为了让它把这份权威值存进会话快照，下次启动再播回来。
            "completedConfig": list(record.completed_config)
            if record.completed_config else None,
            "partial": False,
            "unparsedBlocks": 0,
            "configMissing": record.completed_config is None,
        }

    @staticmethod
    def _restore_output_path(record: TaskRecord, raw) -> Optional[str]:
        """快照里记的路径优先；没记就按识别时的规则推一遍。"""
        explicit = str(raw or "").strip()
        if explicit:
            return explicit
        options = record.options
        root = Path(options.output_dir) if options and options.output_dir \
            else Path(record.video_path).parent
        return str(root / f"{Path(record.video_path).stem}.srt")

    # ---------------------------------------------------------------- reading
    def snapshot(self) -> dict:
        with self._lock:
            queue_total = len(self._run_order)
            payload = []
            for record in sorted(self._tasks.values(),
                                 key=lambda item: item.order):
                payload.append(record.to_dict())
                payload[-1]["cues"] = [cue.to_dict() for cue in record.cues]
            return {
                "tasks": payload,
                "running": self._current,
                "queueTotal": queue_total,
            }

    def serialize_srt(self, task_id: str) -> dict:
        with self._lock:
            record = self.task(task_id)
            content = srt_io.serialize(record.cues)
        return {"content": content}

    def write_srt(self, task_id: str, target_path: Optional[str]) -> dict:
        with self._lock:
            record = self.task(task_id)
            if not record.cues:
                # 后端手里没有字幕（例如后端崩溃重连后重新登记的任务）：
                # 直接写会把用户选中的 SRT 清成空文件，宁可报错让他重新识别。
                raise SidecarError(
                    E_INTERNAL, "后端没有这份字幕内容，请重新识别后再导出",
                    record.video_path)
            target = target_path or record.output_path \
                or self._default_output_locked(record)
            if not target:
                raise SidecarError(
                    E_INTERNAL, "没有可用的输出路径", record.video_path)
            try:
                srt_io.write(record.cues, target)
            except SidecarError:
                raise
            record.output_path = str(target)
            record.touch()
        return {"path": str(target)}

    @staticmethod
    def _claimed_target(root: Path, stem: str, claimed: set) -> Path:
        """``<stem>.srt``，覆盖同名旧文件；同一次调用里撞名才退到 ``(2)``。

        识别阶段已经把 SRT 写在同一个位置，所以批量导出必须覆盖它——用
        ``unique_path()`` 会每次都多产出一份 ``xxx (2).srt``。
        """
        candidate = root / f"{stem}.srt"
        if str(candidate).lower() not in claimed:
            claimed.add(str(candidate).lower())
            return candidate
        return srt_io.unique_path(root, stem, claimed)

    def write_batch(self, task_ids: Optional[list[str]],
                    directory: Optional[str]) -> dict:
        """``srt.writeBatch``: one SRT per video, never a merged file."""
        written = []
        failed = []
        claimed: set = set()
        with self._lock:
            records = [self.task(task_id) for task_id in task_ids] \
                if task_ids else self.tasks()
            for record in records:
                if not record.cues:
                    failed.append({
                        "taskId": record.task_id,
                        "error": {
                            "code": E_INTERNAL,
                            "message": "后端没有这份字幕内容，请重新识别后再导出",
                            "detail": record.video_path,
                        },
                    })
                    continue
                root = Path(directory) if directory \
                    else Path(record.video_path).parent
                try:
                    target = self._claimed_target(
                        root, Path(record.video_path).stem, claimed)
                    srt_io.write(record.cues, str(target))
                except SidecarError as exc:
                    failed.append({
                        "taskId": record.task_id, "error": exc.to_dict()})
                    continue
                except OSError as exc:
                    failed.append({
                        "taskId": record.task_id,
                        "error": {
                            "code": E_INTERNAL,
                            "message": "无法写入字幕文件",
                            "detail": f"{target}：{exc}",
                        },
                    })
                    continue
                record.output_path = str(target)
                record.touch()
                written.append({"taskId": record.task_id, "path": str(target)})
        return {"written": written, "failed": failed}

    # ----------------------------------------------------------- queue internals
    def _enqueue_locked(self, record: TaskRecord, events: list) -> None:
        if record.task_id in self._pending or record.state == STATE_RUNNING:
            return
        self._batch_open = True
        record.state = STATE_WAITING
        record.error = None
        record.touch()
        self._pending.append(record.task_id)
        # A requeued video goes to the tail of the run as well: its old
        # position belongs to the run that was cancelled.
        if record.task_id in self._run_order:
            self._run_order.remove(record.task_id)
        self._run_order.append(record.task_id)
        self._weights[record.task_id] = self._weight(record)
        events.append(("task.queued", {
            "taskId": record.task_id,
            "queueIndex": len(self._run_order),
            "queueTotal": len(self._run_order),
        }))
        self._cv.notify_all()

    def _reset_locked(self, record: TaskRecord) -> None:
        record.state = STATE_WAITING
        record.progress = 0
        record.stage = None
        record.message = "等待处理"
        record.error = None
        record.cues = []
        record.abort = False
        record.cancel_scope = None
        record.completed_config = None
        record.empty_result = False

    def _relocate_output_locked(self, record: TaskRecord,
                                options: RecognitionOptions,
                                events: list) -> None:
        """Finished video + new output folder: rewrite, do not re-recognise."""
        if not options.output_dir or not record.cues or not options.write_srt:
            return
        target = Path(options.output_dir) / f"{Path(record.video_path).stem}.srt"
        if record.output_path and Path(record.output_path) == target:
            return
        try:
            srt_io.write(record.cues, str(target))
            record.output_path = str(target)
        except SidecarError as exc:
            log(f"迁移字幕到新目录失败：{exc.message}")
            return
        record.touch()
        events.append(("task.state", self._state_payload(record)))

    def _default_output_locked(self, record: TaskRecord,
                               cues: Optional[list] = None) -> Optional[str]:
        if not (record.cues if cues is None else cues):
            return None
        options = record.options
        root = Path(options.output_dir) if options and options.output_dir \
            else Path(record.video_path).parent
        return str(root / f"{Path(record.video_path).stem}.srt")

    def _weight(self, record: TaskRecord) -> float:
        return max(1.0, record.duration_ms / 1000.0)

    def _overall_progress(self, task_id: str, percent: int) -> int:
        total = sum(self._weights.values()) or 1.0
        before = 0.0
        for item in self._run_order:
            if item == task_id:
                break
            before += self._weights.get(item, 1.0)
        current = self._weights.get(task_id, 1.0)
        value = (before + current * percent / 100.0) / total * 100.0
        return max(0, min(100, int(round(value))))

    def _queue_position(self, task_id: str) -> tuple[int, int]:
        total = len(self._run_order) or 1
        try:
            index = self._run_order.index(task_id) + 1
        except ValueError:
            index = total
        return index, total

    def _state_payload(self, record: TaskRecord, include_cues: bool = False) -> dict:
        index, total = self._queue_position(record.task_id)
        payload = record.to_dict(queue_index=index, queue_total=total)
        if include_cues:
            payload["cues"] = [cue.to_dict() for cue in record.cues]
        return payload

    # ------------------------------------------------------------ worker loop
    def _worker_loop(self) -> None:
        while True:
            with self._lock:
                while not self._shutdown and not self._pending:
                    self._cv.wait(IDLE_POLL_SECONDS)
                if self._shutdown:
                    return
                task_id = self._pending.pop(0)
                record = self._tasks.get(task_id)
                if record is None or record.state != STATE_WAITING:
                    continue
                self._current = task_id
                record.state = STATE_RUNNING
                record.progress = 0
                # ONNX 会话在启动时就预热好了（app/ocr_engine.py 的 warm），
                # 但"正在加载模型"这个阶段还包含探测视频（_probe_task）。所以
                # 一开始就把阶段标好并立刻上报一条进度：卡住的时候界面能看到卡
                # 在哪一步，日志里也有一个明确的最后现场。
                record.stage = STAGE_LOADING_MODEL
                record.message = "正在加载模型"
                record.abort = False
                record.cancel_scope = None
                record.error = None
                record.touch()
                index, total = self._queue_position(task_id)
                self._last_progress_emit[task_id] = (self._clock(), 0)
                started = ("task.started", {
                    "taskId": task_id, "queueIndex": index, "queueTotal": total})
                state_event = ("task.state", self._state_payload(record))
                progress_event = ("task.progress", {
                    "taskId": task_id,
                    "percent": 0,
                    "stage": record.stage,
                    "message": record.message,
                    "overallPercent": self._overall_progress(task_id, 0),
                    "queueIndex": index,
                    "queueTotal": total,
                })
            self._emit_callback(*started)
            self._emit_callback(*state_event)
            self._emit_callback(*progress_event)
            self._run_task(record)

    # --------------------------------------------------------------- watchdog
    def _watchdog_loop(self) -> None:
        """把"卡住不动"变成一条看得见的错误。

        worker 停在 C 调用里时 Python 没法打断它，所以这里只能收尾 + 报错；
        真正的恢复手段是前端「重新连接」重启后端。
        """
        while True:
            with self._lock:
                if self._shutdown:
                    return
                self._cv.wait(self._watchdog_tick)
                if self._shutdown:
                    return
                stalled = self._stalled_locked()
            if stalled is not None:
                self._finish_stalled(*stalled)

    def _stalled_locked(self) -> Optional[tuple[TaskRecord, float]]:
        """Return ``(record, idle_seconds)`` when the running task went quiet."""
        task_id = self._current
        if task_id is None:
            return None
        record = self._tasks.get(task_id)
        if record is None or record.state != STATE_RUNNING or record.stalled:
            return None
        last = self._last_progress_emit.get(task_id)
        if last is None:
            return None
        idle = self._clock() - last[0]
        limit = (self._stall_timeout
                 if record.stage in (None, STAGE_LOADING_MODEL, STAGE_PREPARING)
                 else self._progress_stall_timeout)
        if idle < limit:
            return None
        return record, idle

    def _finish_stalled(self, record: TaskRecord, idle: float) -> None:
        stage = record.stage or STAGE_PREPARING
        detail = (f"阶段={stage} 进度={record.progress}% 已等待 {idle:.0f} 秒；"
                  f"视频={record.video_path}")
        log(f"识别卡住（{detail}）")
        with self._lock:
            if record.state != STATE_RUNNING or record.stalled:
                return
            record.stalled = True
            # worker 多半还阻塞在那个调用里；它一旦回来就立刻收手。
            record.abort = True
        self._finish_failed(record, {
            "code": E_OCR_STALLED,
            "message": f"识别卡在「{record.message or '准备中'}」，已等待 {idle:.0f} 秒",
            "detail": detail + "；后端线程没有返回，正在重启后端，重新识别即可",
        })
        if self._exit_process is not None:
            # 队列已经救不回来了：主动退出，前端重连后就是一个干净的后端。
            log(f"看门狗收尾后主动退出（code={STALLED_EXIT_CODE}）")
            self._exit_process(STALLED_EXIT_CODE)

    def _run_task(self, record: TaskRecord) -> None:
        options = record.options or RecognitionOptions()
        try:
            self._probe_task(record)
            # 预扫描间隔按 fps 推导（fps 只有探测之后才知道），用户调的
            # frameInterval 是正式识别的抽帧步长，两者互不影响。
            options = replace(
                options, roi_interval=roi_interval_for_fps(record.fps))
            cues = self._recognizer(
                options=options,
                video_path=record.video_path,
                duration=record.duration_ms / 1000.0,
                on_progress=self._progress_reporter(record),
                should_stop=lambda: bool(record.abort) or self._is_shutdown(),
            )
        except SidecarError as exc:
            if exc.code == E_CANCELLED:
                self._finish_cancelled(record)
                return
            self._finish_failed(record, exc.to_dict())
            return
        except Exception as exc:  # noqa: BLE001
            log(f"识别失败（{record.video_path}）：{exc!r}")
            # 打不开 / 解不开的文件给个更贴切的码：说"运行时出错"用户没法行动。
            if isinstance(exc, FileNotFoundError) or "unable to open video" in str(exc).lower():
                self._finish_failed(record, {
                    "code": E_VIDEO_DECODE,
                    "message": "这个文件打不开，可能不是视频",
                    "detail": str(exc),
                })
                return
            self._finish_failed(record, {
                "code": E_OCR_RUNTIME,
                "message": "识别过程中出错",
                "detail": str(exc),
            })
            return

        with self._lock:
            if record.stalled:
                # 看门狗已经按 E_OCR_STALLED 收过尾了：这里只把 worker 还给
                # 队列，否则会再报一条"已取消"把失败状态覆盖掉。
                return
            if record.abort or record.removed or self._is_shutdown():
                aborted = True
            else:
                aborted = False
        if aborted:
            self._finish_cancelled(record)
            return

        try:
            record.cues = self._finalize(record, cues)
        except SidecarError as exc:
            self._finish_failed(record, exc.to_dict())
            return

        with self._lock:
            record.state = STATE_COMPLETED
            record.progress = 100
            record.stage = None
            # 0 条不再静默：状态仍是 completed，但文案说清楚是没识别到，
            # 前端据此提示用户（SIDECAR_API.md §4.4）。
            record.message = "未识别到字幕" if record.empty_result else "识别完成"
            record.error = None
            record.completed_config = options.config_key()
            record.touch()
            self._current = None
            self._counters["completed"] += 1
            output_path = record.output_path
            duration_ms = record.duration_ms
            cue_count = len(record.cues)
            state_event = ("task.state", self._state_payload(record))
            self._cv.notify_all()
            payload = ("task.completed", {
                "taskId": record.task_id,
                "cueCount": cue_count,
                "emptyResult": record.empty_result,
                "outputPath": output_path,
                "durationMs": duration_ms,
            })
            cues_event = ("task.cues", {
                "taskId": record.task_id,
                "cues": [cue.to_dict() for cue in record.cues],
                "state": STATE_COMPLETED,
            })
            index, total = self._queue_position(record.task_id)
            progress_event = ("task.progress", {
                "taskId": record.task_id,
                "percent": 100,
                "stage": None,
                "message": record.message,
                "overallPercent": self._overall_progress(record.task_id, 100),
                "queueIndex": index,
                "queueTotal": total,
            })
        self._emit_callback(*payload)
        self._emit_callback(*progress_event)
        self._emit_callback(*cues_event)
        self._emit_callback(*state_event)
        self._maybe_finish_queue()

    def _finalize(self, record: TaskRecord, cues: list) -> list:
        """Sort, write the SRT, and return the stored cues."""
        options = record.options or RecognitionOptions()
        fps = record.fps
        prepared = []
        for cue in cues:
            item = Cue.from_source(cue, fps)
            if item.end_ms <= item.start_ms or not item.text.strip():
                continue
            item.fps = item.fps or fps
            start_frame, end_frame = item.frames_for(item.fps)
            if item.start_frame is None:
                item.start_frame = start_frame
            if item.end_frame is None:
                item.end_frame = end_frame
            prepared.append(item)
        if cues and not prepared:
            # The recognizer produced lines but none survived; otherwise the
            # task just reports "completed" with 0 cues and no SRT, which looks
            # identical to "this video has no subtitles".
            log(f"识别返回 {len(cues)} 条字幕，但都因为时间为空或文本为空被丢弃"
                f"（{record.video_path}）")
        prepared.sort(key=lambda cue: (cue.start_ms, cue.end_ms))
        for index, cue in enumerate(prepared, start=1):
            cue.index = index
        target = None
        if options.write_srt:
            # 0 条也要写回（空文件）：重跑过的视频如果磁盘上还留着上一遍的字幕，
            # 界面和文件就会互相矛盾。从没写过 SRT 的任务不新建空文件。
            target = self._default_output_locked(record, prepared) \
                if prepared else record.output_path
            if target:
                srt_io.write(prepared, target)
        record.output_path = target
        record.empty_result = not prepared
        if record.duration_ms <= 0 and prepared:
            record.duration_ms = prepared[-1].end_ms
        return prepared

    def _finish_cancelled(self, record: TaskRecord) -> None:
        with self._lock:
            scope = record.cancel_scope or "single"
            requeued = record.removed or record.state == STATE_WAITING
            if not requeued:
                record.state = STATE_CANCELLED
                record.stage = None
                record.message = "已取消"
                record.progress = 0
                record.abort = False
                record.cues = []
                record.output_path = None
                record.completed_config = None
                record.touch()
                self._counters["cancelled"] += 1
            self._current = None
            state_event = ("task.state", self._state_payload(record))
            payload = ("task.cancelled", {
                "taskId": record.task_id, "scope": scope})
            self._cv.notify_all()
        self._emit_callback(*payload)
        self._emit_callback(*state_event)
        self._maybe_finish_queue()

    def _finish_failed(self, record: TaskRecord, error: dict) -> None:
        with self._lock:
            if not (record.removed or record.state == STATE_WAITING):
                record.state = STATE_FAILED
                record.stage = None
                record.message = error.get("message", "失败")
                record.error = error
                record.progress = 0
                record.abort = False
                record.completed_config = None
                record.touch()
                self._counters["failed"] += 1
            self._current = None
            state_event = ("task.state", self._state_payload(record))
            payload = ("task.failed", {"taskId": record.task_id, "error": error})
            self._cv.notify_all()
        self._emit_callback(*payload)
        self._emit_callback(*state_event)
        self._maybe_finish_queue()

    def _maybe_finish_queue(self) -> None:
        """Emit ``queue.completed`` once the queue drains."""
        with self._lock:
            if self._pending or self._current is not None:
                return
            if not self._batch_open:
                return
            counters = dict(self._counters)
            self._batch_open = False
            self._run_order.clear()
            self._weights.clear()
            self._counters = {"completed": 0, "failed": 0, "cancelled": 0}
        self._emit_callback("queue.completed", counters)

    def _is_shutdown(self) -> bool:
        return bool(self._shutdown)

    def _progress_reporter(self, record: TaskRecord):
        def report(value, message=None, stage=None):
            try:
                percent = max(0, min(100, int(value)))
            except (TypeError, ValueError):
                return
            now = self._clock()
            with self._lock:
                if record.stalled:
                    return
                previous = self._last_progress_emit.get(record.task_id)
                percent = max(record.progress, percent)
                if previous is not None:
                    last_time, last_percent = previous
                    if percent < 100 and (now - last_time) < PROGRESS_MIN_INTERVAL \
                            and percent == last_percent:
                        return
                self._last_progress_emit[record.task_id] = (now, percent)
                record.progress = percent
                record.message = str(message or record.message or "正在识别")
                record.stage = stage or self._stage_for(percent)
                overall = self._overall_progress(record.task_id, percent)
                index, total = self._queue_position(record.task_id)
                payload = ("task.progress", {
                    "taskId": record.task_id,
                    "percent": percent,
                    "stage": record.stage,
                    "message": record.message,
                    "overallPercent": overall,
                    "queueIndex": index,
                    "queueTotal": total,
                })
            self._emit_callback(*payload)
        return report

    @staticmethod
    def _stage_for(percent: int) -> str:
        if percent <= 3:
            return STAGE_LOADING_MODEL
        if percent <= 10:
            return STAGE_PREPARING
        if percent <= 20:
            return STAGE_SCANNING
        return STAGE_RECOGNIZING

    def _flush(self, events: list) -> None:
        for event, payload in events:
            self._emit_callback(event, payload)


def default_probe(video_path: str) -> dict:
    from .preview import probe

    return probe(video_path)


def default_recognizer(options: RecognitionOptions, video_path: str,
                       duration: float, on_progress, should_stop) -> list:
    """Bridge to the shared OCR adapter in :mod:`app.ocr_engine`."""
    from app.ocr_engine import RealOcrEngine

    engine = RealOcrEngine()
    return engine.recognize(
        video_path,
        duration,
        options.frame_interval,
        language=options.language,
        on_progress=on_progress,
        should_stop=should_stop,
        auto_roi=options.roi_mode == "auto",
        threshold=options.threshold,
        max_gap_ms=options.max_gap_ms,
        det_workers=options.det_workers,
        recognizer=RECOGNIZER,
        cpu_threads=options.cpu_threads,
        device=options.device,
        roi_interval=options.roi_interval,
    )
