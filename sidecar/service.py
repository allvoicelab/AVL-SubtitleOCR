"""Method dispatch for the line protocol (SIDECAR_API.md §5–§6).

Requests are executed in arrival order on the protocol thread.  Anything that
can take longer than a few milliseconds (recognition, re-wrapping a video for
preview) hands off to a worker thread and answers immediately, so the UI keeps
getting responses while a two-hour movie is being processed.
"""
from __future__ import annotations

import importlib.util
import threading
import time
from pathlib import Path
from typing import Optional

from . import BACKEND_VERSION, PROTOCOL_VERSION, frames, preview
from .errors import (
    E_CANCELLED,
    E_INVALID_OPTIONS,
    E_MODELS_MISSING,
    E_PREVIEW_TRANSCODE,
    E_PREVIEW_UNAVAILABLE,
    SidecarError,
)
from .kernel import RESTORE_LIMIT, QueueKernel
from .models import (
    CPU_THREADS_DEFAULT,
    CPU_THREADS_RANGE,
    DEVICE_OPTIONS,
    DET_WORKERS_DEFAULT,
    DET_WORKERS_RANGE,
    FRAME_INTERVAL_RANGE,
    LANGUAGE_LABELS,
    MAX_GAP_MS_DEFAULT,
    RECOGNIZER,
    STAGES,
    STATES,
    THRESHOLD_DEFAULT,
    THRESHOLD_RANGE,
    RecognitionOptions,
)
from .protocol import JsonChannel, log

PACKAGE_NAME = "avl_open_ocr"

def _device_capability() -> dict:
    """这台机器上真正能用的加速方式（拿不到 avl-open 时按 CPU 处理）。"""
    try:
        from avl_open_ocr import onnx_runtime_info
    except Exception:  # noqa: BLE001 - 缺依赖时由识别链路自己报错
        return {"gpuAvailable": False, "gpuBackend": None, "providers": []}
    info = onnx_runtime_info()
    return {
        "gpuAvailable": bool(info.get("gpu")),
        "gpuBackend": {"DmlExecutionProvider": "DirectML",
                       "CUDAExecutionProvider": "CUDA"}.get(info.get("backend")),
        "providers": info.get("providers", []),
    }

class SidecarService:
    def __init__(self, channel: JsonChannel,
                 kernel: Optional[QueueKernel] = None,
                 preview_runner=None):
        self.channel = channel
        self.started_at = time.monotonic()
        self.kernel = kernel or QueueKernel(
            emit=lambda event, payload: self.channel.emit(event, payload))
        self._preview_runner = preview_runner or preview.prepare_preview
        self._preview_lock = threading.Lock()
        self._preview_jobs: dict[str, dict] = {}
        self._preview_queue: list[dict] = []
        self._preview_seq = 0
        self._preview_worker: Optional[threading.Thread] = None
        self._preview_running: Optional[dict] = None
        self._models_bundled = self._check_models()
        self._dispatch = {
            "system.ping": self._system_ping,
            "system.capabilities": self._system_capabilities,
            "system.shutdown": self._system_shutdown,
            "video.probe": self._video_probe,
            "video.preparePreview": self._video_prepare_preview,
            "video.previewCancel": self._video_preview_cancel,
            "video.frame": self._video_frame,
            "ocr.enqueue": self._ocr_enqueue,
            "ocr.start": self._ocr_start,
            "ocr.cancel": self._ocr_cancel,
            "queue.run": self._queue_run,
            "queue.cancel": self._queue_cancel,
            "queue.snapshot": self._queue_snapshot,
            "task.requeue": self._task_requeue,
            "task.remove": self._task_remove,
            "task.updateCues": self._task_update_cues,
            "task.restore": self._task_restore,
            "srt.serialize": self._srt_serialize,
            "srt.write": self._srt_write,
            "srt.writeBatch": self._srt_write_batch,
        }

    # ------------------------------------------------------------- lifecycle
    def hello(self) -> None:
        self.channel.emit("system.hello", {
            "protocolVersion": PROTOCOL_VERSION,
            "backendVersion": BACKEND_VERSION,
            "avlOpenVersion": _avl_open_version(),
            "python": _python_version(),
            "platform": _platform(),
            "modelsBundled": self._models_bundled,
            "previewTranscodeAvailable": preview.av_available(),
        })

    def handle(self, message: dict) -> bool:
        """Execute one request.  Returns True when the loop should exit."""
        request_id = message.get("id")
        method = str(message.get("method") or "")
        params = message.get("params")
        if params is not None and not isinstance(params, dict):
            self.channel.fail(request_id, {
                "code": E_INVALID_OPTIONS,
                "message": "params 必须是对象",
                "detail": type(params).__name__,
            })
            return False
        handler = self._dispatch.get(method)
        if handler is None:
            self.channel.fail(request_id, {
                "code": E_INVALID_OPTIONS,
                "message": f"未知方法：{method}",
            })
            return False
        with self.channel.defer_events():
            try:
                result, should_exit = handler(params or {})
            except SidecarError as exc:
                self.channel.fail(request_id, exc.to_dict())
                return False
            except Exception as exc:  # noqa: BLE001 - never kill the loop
                log(f"{method} 内部错误：{exc!r}")
                self.channel.fail(request_id, {
                    "code": "E_INTERNAL",
                    "message": "内部错误",
                    "detail": str(exc),
                })
                return False
            self.channel.respond(request_id, result)
        return should_exit

    def stop(self) -> None:
        self.kernel.shutdown()

    # --------------------------------------------------------------- system
    def _system_ping(self, params: dict):
        return {"pong": True,
                "uptimeMs": int((time.monotonic() - self.started_at) * 1000)}, False

    def _system_capabilities(self, params: dict):
        return {
            "languages": [
                {"code": code, "label": label}
                for code, label in LANGUAGE_LABELS.items()
            ],
            "frameInterval": {
                "min": FRAME_INTERVAL_RANGE[0],
                "max": FRAME_INTERVAL_RANGE[1],
                "default": FRAME_INTERVAL_RANGE[0],
            },
            "threshold": {
                "min": THRESHOLD_RANGE[0],
                "max": THRESHOLD_RANGE[1],
                "default": THRESHOLD_DEFAULT,
                "step": 0.01,
            },
            "detWorkers": {
                "min": DET_WORKERS_RANGE[0],
                "max": DET_WORKERS_RANGE[1],
                "default": DET_WORKERS_DEFAULT,
            },
            "cpuThreads": {
                "min": CPU_THREADS_RANGE[0],
                "max": CPU_THREADS_RANGE[1],
                "default": CPU_THREADS_DEFAULT,
            },
            # 推理设备：auto 有 GPU 执行器就用，否则 CPU。gpuBackend 是这台
            # 机器上真正可用的加速方式（DirectML / CUDA），界面据此提示用户
            # "选了 GPU 也只会跑 CPU"这种情况。
            "device": {
                "options": list(DEVICE_OPTIONS),
                "default": "auto",
                **_device_capability(),
            },
            "maxGapMs": {"default": MAX_GAP_MS_DEFAULT, "exposed": False},
            "roiMode": ["auto"],
            "recognizer": RECOGNIZER,
            # Kept in the payload so the front end never hard-codes the badge
            # or stage vocabulary.
            "states": list(STATES),
            "stages": list(STAGES),
            "supportsRequeue": True,
            "supportsCueEditing": True,
            "preview": {
                "supported": True,
                "transcodeAvailable": preview.av_available(),
                "cacheDir": str(preview.preview_cache_dir()),
                "cacheLimitBytes": preview.preview_cache_limit(),
                "playableContainers": sorted(preview.PLAYABLE_CONTAINERS),
                # 定格帧：暂停态 seek 不保证重绘，画面这帧由解码器直接给。
                "frameAvailable": frames.frame_available(),
                "frameMaxWidth": frames.DEFAULT_MAX_WIDTH,
            },
        }, False

    def _system_shutdown(self, params: dict):
        force = bool(params.get("force"))
        with self._preview_lock:
            for job in self._preview_jobs.values():
                job["cancelled"] = True
            self._preview_queue.clear()
        self.kernel.shutdown(timeout=2.0 if force else 8.0)
        return {"ok": True}, True

    # ---------------------------------------------------------------- video
    def _video_probe(self, params: dict):
        video_path = _require_path(params, "videoPath")
        info = self.kernel.probe_video(video_path)
        info["previewMode"] = preview.plan_preview(info)
        return info, False

    def _video_prepare_preview(self, params: dict):
        video_path = _require_path(params, "videoPath")
        force = bool(params.get("force"))
        info = self.kernel.probe_video(video_path)
        mode = preview.plan_preview(info)
        if mode == "direct" and not force:
            return {
                "state": "ready",
                "videoPath": video_path,
                "previewPath": str(Path(video_path).resolve()),
                "mode": "direct",
                "fromCache": False,
            }, False
        if mode == "unavailable":
            raise SidecarError(
                E_PREVIEW_UNAVAILABLE,
                "这个文件需要重新封装才能预览，但当前安装包缺少转码组件",
                f"container={info.get('container')} video={info.get('videoCodec')}")
        # A cached preview answers immediately for both remux and transcode.
        try:
            cached = preview.cache_path_for(video_path, mode)
        except OSError:
            cached = None
        if cached is not None and cached.is_file() and cached.stat().st_size > 0:
            return {
                "state": "ready",
                "videoPath": video_path,
                "previewPath": str(cached),
                "mode": mode,
                "fromCache": True,
            }, False
        job_id = self._start_preview_job(video_path, force)
        return {"state": "preparing", "jobId": job_id, "videoPath": video_path}, False

    def _video_frame(self, params: dict):
        """Decode one frame for the proofreader still (SIDECAR_API.md 12).

        Cheap enough to run on the protocol thread: PyAV seeks to the nearest
        keyframe and decodes forward, which is a few tens of milliseconds even
        for a long movie, and the result is cached per (video, time).
        """
        video_path = _require_path(params, "videoPath")
        time_ms = params.get("timeMs")
        if time_ms is None:
            raise SidecarError(E_INVALID_OPTIONS, "缺少 timeMs")
        try:
            max_width = int(params.get("maxWidth") or frames.DEFAULT_MAX_WIDTH)
        except (TypeError, ValueError):
            raise SidecarError(E_INVALID_OPTIONS, "maxWidth 必须是数字",
                               str(params.get("maxWidth")))
        result = frames.extract_frame(
            video_path, time_ms, max_width=max_width,
            force=bool(params.get("force")))
        return result, False

    def _video_preview_cancel(self, params: dict):
        job_id = str(params.get("jobId") or "")
        with self._preview_lock:
            job = self._preview_jobs.get(job_id)
            if job is None:
                return {"cancelled": False, "jobId": job_id}, False
            job["cancelled"] = True
        return {"cancelled": True, "jobId": job_id}, False

    def _start_preview_job(self, video_path: str, force: bool) -> str:
        """Queue one preview job and answer immediately.

        Only one re-wrap/transcode runs at a time.  Flipping through several
        mkv files used to start one PyAV pass per click, which saturates the
        CPU (and the cache directory) while the UI can only ever show one
        "正在准备预览".  Later jobs wait in FIFO order; cancelling a queued job
        drops it without ever touching the file.
        """
        self._preview_seq += 1
        job_id = f"preview-{self._preview_seq}"
        job = {"jobId": job_id, "videoPath": video_path,
               "cancelled": False, "force": force}
        with self._preview_lock:
            self._preview_jobs[job_id] = job
            self._preview_queue.append(job)
            ahead = len(self._preview_queue) - 1 + (1 if self._preview_running else 0)
            if self._preview_worker is None:
                self._preview_worker = threading.Thread(
                    target=self._preview_loop, name="preview", daemon=True)
                self._preview_worker.start()
        if ahead:
            # 事件会在本次响应之后发出（channel.defer_events），不会插队。
            self.channel.emit("video.previewProgress", {
                "jobId": job_id,
                "videoPath": video_path,
                "percent": 0,
                "message": f"排队等待中（前面还有 {ahead} 个预览）",
                "queuePosition": ahead,
            })
        return job_id

    def _preview_loop(self) -> None:
        while True:
            with self._preview_lock:
                job = self._preview_queue.pop(0) if self._preview_queue else None
                if job is None:
                    # 退出前先把自己摘掉：_start_preview_job 在锁内看 worker 是否为
                    # None 决定要不要再拉一根，否则刚排进来的任务没人处理。
                    self._preview_worker = None
                    self._preview_running = None
                    return
                self._preview_running = job
            try:
                if job.get("cancelled"):
                    self.channel.emit("video.previewFailed", {
                        "jobId": job["jobId"],
                        "videoPath": job["videoPath"],
                        "error": {"code": E_CANCELLED, "message": "已取消"},
                    })
                else:
                    self._run_preview_job(job, bool(job.get("force")))
            finally:
                with self._preview_lock:
                    self._preview_running = None
                    self._preview_jobs.pop(job["jobId"], None)

    def _run_preview_job(self, job: dict, force: bool) -> None:
        job_id = job["jobId"]
        video_path = job["videoPath"]

        def on_progress(percent, message):
            self.channel.emit("video.previewProgress", {
                "jobId": job_id,
                "videoPath": video_path,
                "percent": int(percent),
                "message": str(message or ""),
            })

        def should_stop():
            return bool(job.get("cancelled"))

        try:
            result = self._preview_runner(
                video_path, on_progress, should_stop, force)
        except SidecarError as exc:
            if exc.code == E_CANCELLED:
                self.channel.emit("video.previewFailed", {
                    "jobId": job_id, "videoPath": video_path,
                    "error": {"code": E_CANCELLED, "message": "已取消"},
                })
            else:
                self.channel.emit("video.previewFailed", {
                    "jobId": job_id, "videoPath": video_path,
                    "error": exc.to_dict(),
                })
        except Exception as exc:  # noqa: BLE001
            log(f"预览准备失败：{exc!r}")
            self.channel.emit("video.previewFailed", {
                "jobId": job_id, "videoPath": video_path,
                "error": {"code": E_PREVIEW_TRANSCODE,
                          "message": "预览准备失败", "detail": str(exc)},
            })
        else:
            self.channel.emit("video.previewReady", {
                "jobId": job_id,
                "videoPath": video_path,
                "previewPath": result.get("previewPath"),
                "mode": result.get("mode"),
                "fromCache": bool(result.get("fromCache")),
            })

    # ------------------------------------------------------------------ ocr
    def _ocr_enqueue(self, params: dict):
        task_id = _require_task_id(params)
        video_path = _require_path(params, "videoPath")
        record = self.kernel.add_task(task_id, video_path)
        return {"taskId": record.task_id, "state": record.state}, False

    def _ocr_start(self, params: dict):
        task_id = _require_task_id(params)
        video_path = _require_path(params, "videoPath")
        options = RecognitionOptions.from_dict(params.get("options"))
        _ensure_models(self._models_bundled)
        return self.kernel.start_single(task_id, video_path, options), False

    def _ocr_cancel(self, params: dict):
        task_id = _require_task_id(params)
        return self.kernel.cancel_task(task_id), False

    def _queue_run(self, params: dict):
        options = RecognitionOptions.from_dict(params.get("options"))
        _ensure_models(self._models_bundled)
        task_ids = params.get("taskIds")
        if task_ids is not None and not isinstance(task_ids, list):
            raise SidecarError(E_INVALID_OPTIONS, "taskIds 必须是数组")
        return self.kernel.run_queue(
            [str(item) for item in task_ids] if task_ids else None, options), False

    def _queue_cancel(self, params: dict):
        return self.kernel.cancel_all(), False

    def _queue_snapshot(self, params: dict):
        return self.kernel.snapshot(), False

    def _task_requeue(self, params: dict):
        task_id = _require_task_id(params)
        return self.kernel.requeue(task_id, params.get("videoPath")), False

    def _task_remove(self, params: dict):
        task_id = _require_task_id(params)
        return self.kernel.remove(task_id), False

    def _task_update_cues(self, params: dict):
        task_id = _require_task_id(params)
        cues = params.get("cues")
        if not isinstance(cues, list):
            raise SidecarError(E_INVALID_OPTIONS, "cues 必须是数组")
        return self.kernel.update_cues(task_id, cues), False

    def _task_restore(self, params: dict):
        """把上次会话的任务列表交回内核（只读回读 SRT，不写盘）。"""
        items = params.get("items")
        if not isinstance(items, list):
            raise SidecarError(
                E_INVALID_OPTIONS, "items 必须是数组", type(items).__name__)
        if len(items) > RESTORE_LIMIT:
            log(f"task.restore 只恢复前 {RESTORE_LIMIT} 条，收到 {len(items)} 条")
        return self.kernel.restore_tasks(items), False

    # ------------------------------------------------------------------ srt
    def _srt_serialize(self, params: dict):
        return self.kernel.serialize_srt(_require_task_id(params)), False

    def _srt_write(self, params: dict):
        task_id = _require_task_id(params)
        target = params.get("targetPath")
        return self.kernel.write_srt(task_id, str(target) if target else None), False

    def _srt_write_batch(self, params: dict):
        task_ids = params.get("taskIds")
        if task_ids is not None and not isinstance(task_ids, list):
            raise SidecarError(E_INVALID_OPTIONS, "taskIds 必须是数组")
        directory = params.get("dir")
        return self.kernel.write_batch(
            [str(item) for item in task_ids] if task_ids else None,
            str(directory) if directory else None), False

    # -------------------------------------------------------------- helpers
    def _check_models(self) -> bool:
        try:
            spec = importlib.util.find_spec(PACKAGE_NAME)
        except (ImportError, ValueError):
            return False
        if spec is None or not spec.submodule_search_locations:
            return False
        for location in spec.submodule_search_locations:
            model_dir = Path(location) / "model_files"
            if model_dir.is_dir() and any(model_dir.glob("*.onnx")):
                return True
        return False


def _ensure_models(models_bundled: bool) -> None:
    if not models_bundled:
        raise SidecarError(
            E_MODELS_MISSING,
            "安装包里没有 OCR 模型文件",
            "请重新安装（或重新打包）完整的程序")


def _require_task_id(params: dict) -> str:
    task_id = str(params.get("taskId") or "").strip()
    if not task_id:
        raise SidecarError(E_INVALID_OPTIONS, "缺少 taskId")
    return task_id


def _require_path(params: dict, key: str) -> str:
    value = str(params.get(key) or "").strip()
    if not value:
        raise SidecarError(E_INVALID_OPTIONS, f"缺少 {key}")
    return value


def _avl_open_version() -> str:
    try:
        spec = importlib.util.find_spec(PACKAGE_NAME)
    except (ImportError, ValueError):
        spec = None
    if spec is None:
        return "missing"
    try:
        from importlib.metadata import version

        return version("avl-open-ocr")
    except Exception:  # noqa: BLE001
        return "unknown"


def _python_version() -> str:
    import platform

    return platform.python_version()


def _platform() -> str:
    import sys

    return sys.platform


__all__ = ["SidecarService"]
