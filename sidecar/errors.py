"""Error codes shared with the Electron front end (SIDECAR_API.md §7)."""
from __future__ import annotations

E_BACKEND_NOT_READY = "E_BACKEND_NOT_READY"
E_PROTOCOL_VERSION = "E_PROTOCOL_VERSION"
E_MODELS_MISSING = "E_MODELS_MISSING"
E_VIDEO_NOT_FOUND = "E_VIDEO_NOT_FOUND"
E_VIDEO_DECODE = "E_VIDEO_DECODE"
# 送进来的根本不是视频：.lnk 快捷方式、文件夹、或者不认识的扩展名。
E_VIDEO_UNSUPPORTED = "E_VIDEO_UNSUPPORTED"
E_UNSUPPORTED_LANGUAGE = "E_UNSUPPORTED_LANGUAGE"
E_INVALID_OPTIONS = "E_INVALID_OPTIONS"
E_OCR_RUNTIME = "E_OCR_RUNTIME"
# 看门狗判定：任务长时间没有任何进展（加载模型/探测视频时最常见）。
E_OCR_STALLED = "E_OCR_STALLED"
E_OUTPUT_WRITE = "E_OUTPUT_WRITE"
E_CANCELLED = "E_CANCELLED"
E_TASK_NOT_FOUND = "E_TASK_NOT_FOUND"
E_TASK_BUSY = "E_TASK_BUSY"
E_PREVIEW_UNAVAILABLE = "E_PREVIEW_UNAVAILABLE"
E_PREVIEW_TRANSCODE = "E_PREVIEW_TRANSCODE"
E_INTERNAL = "E_INTERNAL"


class SidecarError(Exception):
    """An error that maps onto one of the documented protocol codes."""

    def __init__(self, code: str, message: str, detail: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail

    def to_dict(self) -> dict:
        payload = {"code": self.code, "message": self.message}
        if self.detail:
            payload["detail"] = self.detail
        return payload


class UnknownMethod(SidecarError):
    def __init__(self, method: str):
        super().__init__(E_INTERNAL, f"未知方法：{method}", method)


class TaskNotFound(SidecarError):
    def __init__(self, task_id: str):
        super().__init__(E_TASK_NOT_FOUND, f"任务不存在：{task_id}", str(task_id))
