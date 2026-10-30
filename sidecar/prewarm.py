"""Warm the compiled runtime up before the protocol loop parks the main thread.

``__main__`` keeps the main thread inside a blocking stdin read for the whole
session.  On Windows a *fresh* compiled-extension import (``.pyd``/DLL) started
from a worker thread never completes while another thread is parked in that
pipe read, so the very first recognition of a session stalled at 0% until the
user cancelled the task (which poked stdin) or closed the app.

Importing the runtime here - on the protocol thread, before the read loop
blocks - keeps every extension module cached.  ONNX Runtime needs the same
treatment one level deeper: ``InferenceSession`` is what pulls in the provider
DLLs, so the sessions are built here as well and reused by every task
(``RealOcrEngine.warm``).  Machines that built the first session on a worker
thread - or where security software held the DLL open - sat at "正在加载模型"
with the CPU idle and no error at all (report: 2026-09-21).

``VIDEO_SUBTITLE_PREWARM=0`` skips the model part; that keeps ``python -m
sidecar`` cheap for tests and for field diagnostics.
"""
from __future__ import annotations

import importlib
import os
import time

from .protocol import log

# Extensions the OCR worker and the preview worker would otherwise import
# lazily from their own threads.  Missing entries are ignored: trimmed or
# test builds do not have to ship all of them (PaddleOCR builds, for
# instance, have no subtle-v5 detector dependencies).
MODULES = (
    "numpy",
    "cv2",
    "onnxruntime",
    "pyclipper",
    "shapely.geometry",
    "av",
    "PIL.Image",
)


def _model_prewarm_enabled() -> bool:
    value = os.environ.get("VIDEO_SUBTITLE_PREWARM", "").strip().lower()
    return value not in ("0", "false", "no", "off")


def prewarm() -> dict:
    """Warm the OCR/preview runtime; returns what was loaded and prebuilt."""
    loaded = []
    for name in MODULES:
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - optional in trimmed builds
            continue
        loaded.append(name)
    result = {"modules": loaded, "warmed": False, "backend": "",
              "seconds": 0.0}
    if not _model_prewarm_enabled():
        log("模型预热已关闭（VIDEO_SUBTITLE_PREWARM=0）")
        return result
    started = time.monotonic()
    try:
        from app.ocr_engine import RealOcrEngine

        info = RealOcrEngine.warm()
    except Exception as exc:  # noqa: BLE001 - reported per task by the recogniser
        result["error"] = repr(exc)
        log(f"模型预热失败：{exc!r}")
        return result
    result.update(info)
    result["seconds"] = round(time.monotonic() - started, 2)
    if info.get("warmed"):
        suffix = "（复用已有会话）" if info.get("cached") else ""
        # GPU（DirectML）首次建会话要编译算子，这里顺带把"实际在用哪个设备"
        # 说清楚，省得现场只能靠猜。
        device = str(info.get("device") or "").strip()
        parts = ["模型预热完成：{backend} {language}/{recognizer}，"
                 "{threads} 线程".format(**result)]
        if device:
            parts.append(device)
        parts.append("耗时 {seconds}s".format(**result))
        log("，".join(parts) + suffix)
    else:
        log("模型预热跳过（{backend} 后端，语言 {language}）".format(**result))
    return result
