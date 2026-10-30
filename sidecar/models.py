"""Data structures for the sidecar protocol (SIDECAR_API.md §4)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

from .errors import E_INVALID_OPTIONS, E_UNSUPPORTED_LANGUAGE, SidecarError

STATE_IDLE = "idle"
STATE_WAITING = "waiting"
STATE_RUNNING = "running"
STATE_COMPLETED = "completed"
STATE_MODIFIED = "modified"
STATE_CANCELLED = "cancelled"
STATE_FAILED = "failed"

STATES = (
    STATE_IDLE,
    STATE_WAITING,
    STATE_RUNNING,
    STATE_COMPLETED,
    STATE_MODIFIED,
    STATE_CANCELLED,
    STATE_FAILED,
)

STAGE_LOADING_MODEL = "loading_model"
STAGE_PREPARING = "preparing"
STAGE_SCANNING = "scanning"
STAGE_DETECTING = "detecting"
STAGE_RECOGNIZING = "recognizing"
STAGE_FINALIZING = "finalizing"

STAGES = (
    STAGE_LOADING_MODEL,
    STAGE_PREPARING,
    STAGE_SCANNING,
    STAGE_DETECTING,
    STAGE_RECOGNIZING,
    STAGE_FINALIZING,
)

# Every language the bundled ONNX heads cover (mirrors
# ``avl_open_ocr.BUNDLED_LANGUAGES``: the PP-OCRv6 dictionary plus Korean).
# The front end renders this table
# straight from ``system.capabilities``, so adding a code here is all the UI
# needs; the value is the Chinese name shown in the picker.
LANGUAGE_LABELS = {
    "ch": "中文（简体）",
    "chinese_cht": "中文（繁体）",
    "en": "英文",
    "japan": "日文",
    "korean": "韩文",
    "af": "南非荷兰文",
    "az": "阿塞拜疆文",
    "bs": "波斯尼亚文",
    "ca": "加泰罗尼亚文",
    "cs": "捷克文",
    "cy": "威尔士文",
    "da": "丹麦文",
    "de": "德文",
    "es": "西班牙文",
    "et": "爱沙尼亚文",
    "eu": "巴斯克文",
    "fi": "芬兰文",
    "fr": "法文",
    "ga": "爱尔兰文",
    "gl": "加利西亚文",
    "hr": "克罗地亚文",
    "hu": "匈牙利文",
    "id": "印尼文",
    "is": "冰岛文",
    "it": "意大利文",
    "ku": "库尔德文",
    "la": "拉丁文",
    "lb": "卢森堡文",
    "lt": "立陶宛文",
    "lv": "拉脱维亚文",
    "mi": "毛利文",
    "ms": "马来文",
    "mt": "马耳他文",
    "nl": "荷兰文",
    "no": "挪威文",
    "oc": "奥克文",
    "pl": "波兰文",
    "pt": "葡萄牙文",
    "qu": "克丘亚文",
    "rm": "罗曼什文",
    "ro": "罗马尼亚文",
    "rs_latin": "塞尔维亚文（拉丁）",
    "sk": "斯洛伐克文",
    "sl": "斯洛文尼亚文",
    "sq": "阿尔巴尼亚文",
    "sv": "瑞典文",
    "sw": "斯瓦希里文",
    "tl": "他加禄文",
    "tr": "土耳其文",
    "uz": "乌兹别克文",
    "vi": "越南文",
    "french": "法文（别名）",
    "german": "德文（别名）",
}

FRAME_INTERVAL_RANGE = (1, 8)
THRESHOLD_RANGE = (0.05, 0.95)
THRESHOLD_DEFAULT = 0.38
DET_WORKERS_RANGE = (1, 8)
DET_WORKERS_DEFAULT = 1
# ONNX intra-op threads for the detection and recognition sessions.  Defaults
# to half the cores; the expert panel exposes the machine's full range.
CPU_THREADS_RANGE = (1, max(1, os.cpu_count() or 1))
CPU_THREADS_DEFAULT = max(1, (os.cpu_count() or 1) // 2)
#: 推理设备：auto = 有 GPU 执行器就用（默认），cpu = 强制 CPU，gpu = 优先 GPU
DEVICE_OPTIONS = ("auto", "cpu", "gpu")
MAX_GAP_MS_DEFAULT = 900.0
MAX_GAP_MS_RANGE = (0.0, 12000.0)
RECOGNIZER = "v6_small"
#: 预扫描（自动选区的 ROI 统计）抽帧间隔，按视频 fps 折算，和用户调的帧采样
#: 间隔（ocr_interval，正式识别的抽帧步长）是两件事。折算目标是"每秒约 15 帧"：
#: 30fps 及以下每 2 帧、60fps 每 4 帧、120fps 及以上每 8 帧，这样高帧率视频的
#: ROI 统计开销不会随帧率线性上涨。
ROI_INTERVAL_RULES = ((120.0, 8), (60.0, 4))
ROI_INTERVAL_DEFAULT = 2


def roi_interval_for_fps(fps: Any) -> int:
    """预扫描抽帧间隔：<60fps → 2，≥60fps → 4，≥120fps → 8。"""
    try:
        value = float(fps or 0.0)
    except (TypeError, ValueError):
        value = 0.0
    for threshold, interval in ROI_INTERVAL_RULES:
        if value >= threshold:
            return interval
    return ROI_INTERVAL_DEFAULT


@dataclass
class Cue:
    """One subtitle line, in the shape the protocol exposes."""

    index: int = 0
    start_ms: int = 0
    end_ms: int = 0
    text: str = ""
    confidence: float = 0.96
    fps: float = 0.0
    start_frame: Optional[int] = None
    end_frame: Optional[int] = None

    @classmethod
    def from_dict(cls, payload: dict, index: int = 0, fps: float = 0.0) -> "Cue":
        try:
            start_ms = int(round(float(payload.get("startMs", 0))))
            end_ms = int(round(float(payload.get("endMs", 0))))
        except (TypeError, ValueError) as exc:
            raise SidecarError(
                E_INVALID_OPTIONS, "字幕时间无效", str(payload.get("startMs"))) from exc
        try:
            confidence = float(payload.get("confidence", 0.96))
        except (TypeError, ValueError):
            confidence = 0.96
        try:
            cue_fps = float(payload.get("fps") or fps or 0.0)
        except (TypeError, ValueError):
            cue_fps = 0.0
        return cls(
            index=index,
            start_ms=max(0, start_ms),
            end_ms=max(0, end_ms),
            text=str(payload.get("text") or ""),
            confidence=confidence,
            fps=cue_fps,
            start_frame=_optional_int(payload.get("startFrame")),
            end_frame=_optional_int(payload.get("endFrame")),
        )

    @classmethod
    def from_source(cls, cue: Any, fps: float = 0.0) -> "Cue":
        """Build a :class:`Cue` from whatever a recognizer handed back.

        ``app.ocr_engine.SubtitleCue`` keeps ``start``/``end`` in **seconds**
        while this protocol speaks milliseconds.  Reading the wrong spelling
        is not a loud failure: every cue collapses to 0 ms, the kernel's
        ``end_ms > start_ms`` filter then drops all of them, and the task is
        reported as "completed" with no subtitles and no SRT on disk.  Both
        spellings are accepted here, once, instead of at every call site.
        """
        if isinstance(cue, cls):
            return cue
        start_ms = _milliseconds(getattr(cue, "start_ms", None),
                                 getattr(cue, "start", None))
        end_ms = _milliseconds(getattr(cue, "end_ms", None),
                               getattr(cue, "end", None))
        try:
            confidence = float(getattr(cue, "confidence", 0.96) or 0.96)
        except (TypeError, ValueError):
            confidence = 0.96
        try:
            cue_fps = float(getattr(cue, "fps", 0.0) or 0.0)
        except (TypeError, ValueError):
            cue_fps = 0.0
        return cls(
            start_ms=max(0, start_ms),
            end_ms=max(0, end_ms),
            text=str(getattr(cue, "text", "") or ""),
            confidence=confidence,
            fps=cue_fps or fps,
            start_frame=_optional_int(getattr(cue, "start_frame", None)),
            end_frame=_optional_int(getattr(cue, "end_frame", None)),
        )

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "text": self.text,
            "confidence": round(self.confidence, 4),
            "startFrame": self.start_frame,
            "endFrame": self.end_frame,
            "fps": round(self.fps, 6),
        }

    def frames_for(self, fps: float) -> tuple[Optional[int], Optional[int]]:
        """Frame numbers for this cue, or ``(None, None)`` when fps is unknown.

        ``startMs`` always sits on the frame grid, ``endMs`` does not (the OCR
        runtime clamps it to a computed duration), so the frames are purely
        informational and must not be used to rewrite the times.
        """
        if not fps or fps <= 0:
            return None, None
        return (
            int(round(self.start_ms * fps / 1000.0)),
            int(round(self.end_ms * fps / 1000.0)),
        )

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


def _optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


@dataclass
class RecognitionOptions:
    """Recognition settings; see SIDECAR_API.md §4.1."""

    language: str = "ch"
    frame_interval: int = 1
    # 预扫描抽帧间隔：由视频 fps 推导（见 roi_interval_for_fps），不是用户参数，
    # 所以既不进 to_dict() 也不进 config_key()——换台机器跑同一个视频不该因此
    # 变成"需要重跑"。
    roi_interval: int = ROI_INTERVAL_DEFAULT
    threshold: float = THRESHOLD_DEFAULT
    det_workers: int = DET_WORKERS_DEFAULT
    cpu_threads: int = CPU_THREADS_DEFAULT
    # auto / cpu / gpu，见 avl_open_ocr.providers：auto 有 GPU 执行器就用，
    # 否则 CPU；真正生效的设备会随 task 事件和 capabilities 一起回给前端。
    device: str = "auto"
    roi_mode: str = "auto"
    max_gap_ms: float = MAX_GAP_MS_DEFAULT
    output_dir: Optional[str] = None
    write_srt: bool = True

    @classmethod
    def from_dict(cls, payload: Optional[dict]) -> "RecognitionOptions":
        payload = dict(payload or {})
        language = str(payload.get("language") or "ch").strip().lower()
        if language not in LANGUAGE_LABELS:
            raise SidecarError(
                E_UNSUPPORTED_LANGUAGE,
                f"不支持的语言：{language}",
                f"当前支持 {len(LANGUAGE_LABELS)} 种语言，见 system.capabilities",
            )

        roi_mode = str(payload.get("roiMode") or "auto").strip().lower()
        if roi_mode != "auto":
            raise SidecarError(
                E_INVALID_OPTIONS, "本版本只支持自动选区（roiMode=auto）", roi_mode)

        frame_interval = _int_in_range(
            payload.get("frameInterval", 1), FRAME_INTERVAL_RANGE,
            "frameInterval")
        det_workers = _int_in_range(
            payload.get("detWorkers", DET_WORKERS_DEFAULT), DET_WORKERS_RANGE,
            "detWorkers")
        cpu_threads = _int_in_range(
            payload.get("cpuThreads", CPU_THREADS_DEFAULT), CPU_THREADS_RANGE,
            "cpuThreads")
        device = str(payload.get("device") or "auto").strip().lower()
        if device not in DEVICE_OPTIONS:
            raise SidecarError(
                E_INVALID_OPTIONS,
                f"不支持的推理设备：{device}",
                f"可选 {', '.join(DEVICE_OPTIONS)}",
            )
        threshold = _float_in_range(
            payload.get("threshold", THRESHOLD_DEFAULT), THRESHOLD_RANGE,
            "threshold")
        max_gap_ms = _float_in_range(
            payload.get("maxGapMs", MAX_GAP_MS_DEFAULT), MAX_GAP_MS_RANGE,
            "maxGapMs")

        output_dir = payload.get("outputDir")
        if output_dir is not None:
            output_dir = str(output_dir).strip() or None

        return cls(
            language=language,
            frame_interval=frame_interval,
            threshold=threshold,
            det_workers=det_workers,
            cpu_threads=cpu_threads,
            device=device,
            roi_mode=roi_mode,
            max_gap_ms=max_gap_ms,
            output_dir=output_dir,
            write_srt=bool(payload.get("writeSrt", True)),
        )

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "frameInterval": self.frame_interval,
            "threshold": self.threshold,
            "detWorkers": self.det_workers,
            "cpuThreads": self.cpu_threads,
            "device": self.device,
            "roiMode": self.roi_mode,
            "maxGapMs": self.max_gap_ms,
            "outputDir": self.output_dir,
            "writeSrt": self.write_srt,
        }

    def config_key(self) -> tuple:
        """Settings that invalidate a finished recognition.

        ``outputDir`` / ``cpu_threads`` / ``device`` are deliberately excluded:
        moving the output folder only needs the SRT rewritten, and the thread
        count and CPU/GPU choice are performance knobs that cannot change the
        recognised text, so neither should invalidate a finished run.
        """
        return (
            self.language,
            self.frame_interval,
            round(self.threshold, 4),
            self.det_workers,
            self.roi_mode,
            round(self.max_gap_ms, 3),
        )

    @classmethod
    def config_key_from(cls, value: Any) -> Optional[tuple]:
        """A :meth:`config_key` tuple from JSON, or ``None`` when it does not fit.

        Mirrors the normalisation above; ``task.restore`` uses it to put back
        what a previous process reported, so the two spellings must agree.
        """
        if not isinstance(value, (list, tuple)) or len(value) != 6:
            return None
        language, frame_interval, threshold, det_workers, roi_mode, max_gap_ms = value
        try:
            return (
                str(language),
                int(frame_interval),
                round(float(threshold), 4),
                int(det_workers),
                str(roi_mode),
                round(float(max_gap_ms), 3),
            )
        except (TypeError, ValueError):
            return None


def _int_in_range(value: Any, bounds: tuple[int, int], name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise SidecarError(
            E_INVALID_OPTIONS, f"{name} 必须是整数", str(value)) from exc
    if not bounds[0] <= parsed <= bounds[1]:
        raise SidecarError(
            E_INVALID_OPTIONS,
            f"{name} 必须在 {bounds[0]}–{bounds[1]} 之间",
            str(parsed))
    return parsed


def _float_in_range(value: Any, bounds: tuple[float, float], name: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise SidecarError(
            E_INVALID_OPTIONS, f"{name} 必须是数字", str(value)) from exc
    if not bounds[0] <= parsed <= bounds[1]:
        raise SidecarError(
            E_INVALID_OPTIONS,
            f"{name} 必须在 {bounds[0]}–{bounds[1]} 之间",
            str(parsed))
    return parsed


@dataclass
class TaskRecord:
    """One video in the queue; mirrors the protocol's ``TaskState``."""

    task_id: str
    video_path: str
    state: str = STATE_IDLE
    progress: int = 0
    stage: Optional[str] = None
    message: str = ""
    cues: list[Cue] = field(default_factory=list)
    output_path: Optional[str] = None
    error: Optional[dict] = None
    revision: int = 0
    duration_ms: int = 0
    fps: float = 0.0
    # (config key, output path) of the last successful run, or None.
    completed_config: Optional[tuple] = None
    options: Optional[RecognitionOptions] = None
    order: int = 0
    # Runtime flags owned by the queue kernel (kept here so the record stays
    # the single source of truth for one video).
    abort: bool = False
    removed: bool = False
    cancel_scope: Optional[str] = None
    # 最近一次成功识别是否一条字幕都没得到（界面据此提示，不再静默"完成"）。
    empty_result: bool = False
    # 看门狗按 E_OCR_STALLED 收过尾了：worker 从卡住的 C 调用回来时别再报一次。
    stalled: bool = False

    def touch(self) -> None:
        self.revision += 1

    def to_dict(self, queue_index: Optional[int] = None,
                queue_total: Optional[int] = None) -> dict:
        return {
            "taskId": self.task_id,
            "videoPath": self.video_path,
            "state": self.state,
            "progress": int(self.progress),
            "stage": self.stage,
            "message": self.message,
            "queueIndex": queue_index,
            "queueTotal": queue_total,
            "cueCount": len(self.cues),
            "outputPath": self.output_path,
            "error": self.error,
            "emptyResult": self.empty_result,
            "revision": self.revision,
            "durationMs": self.duration_ms,
            "fps": self.fps,
            # 上次跑出这份结果用的参数（config_key 的形状）；前端照着存进会话快照，
            # 重启后由 task.restore 播回来，这样同参数的批量才会跳过它。
            "completedConfig": list(self.completed_config) if self.completed_config else None,
        }

    def snapshot(self) -> dict:
        payload = self.to_dict()
        payload["cues"] = [cue.to_dict() for cue in self.cues]
        return payload


def _milliseconds(explicit: Any, seconds: Any) -> int:
    """Milliseconds from an explicit ``*_ms`` value, else from seconds.

    Missing or unparsable input degrades to 0 instead of raising: a single
    malformed cue must not take down the worker thread.
    """
    if explicit is not None:
        try:
            return int(round(float(explicit)))
        except (TypeError, ValueError):
            return 0
    try:
        return int(round(float(seconds or 0.0) * 1000.0))
    except (TypeError, ValueError):
        return 0
