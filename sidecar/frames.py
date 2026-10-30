"""Single-frame extraction for the proofreader still image (SIDECAR_API.md 12).

Chromium does not repaint a paused ``<video>`` after a seek on every machine, so
"click a cue and look at that frame" cannot be made reliable inside the player.
This module asks the decoder instead: PyAV seeks to the requested time and
returns the frame the player is *supposed* to be showing.  It also works for
mkv/avi files that have no in-app preview at all.

Two decoder facts have to be absorbed here, because getting them wrong produces
a still that looks plausible but belongs to another subtitle (SIDECAR_API.md 13):

* Timestamps are not always 0-based.  Plenty of mp4/mkv/ts files start at a
  positive timestamp, while the ``<video>`` clock and the OCR sampler both
  count from the first frame.  Everything below therefore works on the
  container's absolute timestamp axis and converts at the edges.
* A backward seek normally lands on the keyframe *before* the target, but some
  demuxers hand back a frame that is already past it.  When that happens we walk
  further back and decode again instead of returning the wrong picture.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Optional

from .errors import (
    E_PREVIEW_UNAVAILABLE,
    E_VIDEO_DECODE,
    E_VIDEO_NOT_FOUND,
    SidecarError,
)
from .preview import (
    _first_video_stream,
    _safe_stem,
    _stream_fps,
    av_available,
    load_av,
    preview_cache_dir,
)

DEFAULT_MAX_WIDTH = 1280
FRAME_CACHE_MAX_FILES = 400
# PTS values are rationals; allow a hair of float noise when comparing them with
# the requested millisecond.  Deliberately well below one frame so the returned
# frame is still the one on screen at ``timeMs``.
_PTS_EPSILON_MS = 1.0
# Retry ladder for demuxers whose backward seek overshoots the target: seek this
# many milliseconds *before* the wanted frame and decode forward again.  ``None``
# means "seek to the first frame of the file", which cannot overshoot.
_SEEK_BACKOFF_MS = (0, 1500, 6000, 30000, None)
# A retry from further back may have to walk a long way; report a failure rather
# than stall on a file whose index lies about where its keyframes are.
_MAX_DECODE_FRAMES = 30000
# Bumped whenever the mapping from ``timeMs`` to a picture changes, so stills
# cached by an older build are not reused for the new meaning.
_CACHE_VERSION = "2"


def frame_available() -> bool:
    """True when this install can decode a still (PyAV is present)."""
    return av_available()


def frame_cache_dir() -> Path:
    override = os.environ.get("VIDEO_SUBTITLE_FRAME_CACHE")
    if override:
        return Path(override).expanduser()
    return preview_cache_dir().parent / "frames"


def frame_path_for(video_path: str, time_ms: int, max_width: int) -> Path:
    path = Path(video_path)
    stat = path.stat()
    digest = hashlib.sha1(
        f"{_CACHE_VERSION}|{path.resolve()}|{int(stat.st_mtime)}|"
        f"{int(stat.st_size)}|{int(time_ms)}|{int(max_width)}"
        .encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return frame_cache_dir() / f"{_safe_stem(path.stem)}-{digest}.jpg"


def extract_frame(video_path: str, time_ms, max_width=DEFAULT_MAX_WIDTH,
                  force: bool = False, av_module=None) -> dict:
    """Decode the frame shown at ``time_ms`` and cache it as a JPEG."""
    path = Path(video_path)
    if not path.is_file():
        raise SidecarError(E_VIDEO_NOT_FOUND, "找不到视频文件", video_path)
    try:
        target_ms = max(0, int(round(float(time_ms))))
    except (TypeError, ValueError):
        raise SidecarError(E_VIDEO_DECODE, "timeMs 必须是数字", str(time_ms))
    width_limit = max(160, int(max_width or DEFAULT_MAX_WIDTH))

    cached = frame_path_for(video_path, target_ms, width_limit)
    if cached.is_file() and cached.stat().st_size > 0 and not force:
        width, height = _image_size(cached)
        return _payload(path, cached, target_ms, target_ms, width, height,
                        0.0, from_cache=True)

    module = av_module or (load_av() if av_available() else None)
    if module is None:
        raise SidecarError(E_PREVIEW_UNAVAILABLE, "当前安装包缺少取帧组件",
                           video_path)

    decoded = None
    for backoff_ms in _SEEK_BACKOFF_MS:
        try:
            decoded = _decode_frame(module, path, target_ms, backoff_ms)
        except SidecarError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(E_VIDEO_DECODE, "取帧失败",
                               f"{video_path}：{exc}") from exc
        if decoded is not None:
            break
    if decoded is None:
        raise SidecarError(E_VIDEO_DECODE, "无法在该时间点解码出画面",
                           f"{video_path} @ {target_ms}ms")

    image, actual_ms, fps = decoded
    if image.width > width_limit:
        height = max(1, round(image.height * width_limit / image.width))
        image = image.resize((width_limit, height))
    elif image.mode != "RGB":
        image = image.convert("RGB")

    cached.parent.mkdir(parents=True, exist_ok=True)
    partial = cached.with_name(cached.name + ".part")
    try:
        image.save(str(partial), format="JPEG", quality=86)
        partial.replace(cached)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    _evict_cache(keep=cached)
    return _payload(path, cached, target_ms, actual_ms, image.width,
                    image.height, fps, from_cache=False)


def _decode_frame(module, path: Path, target_ms: int, backoff_ms):
    """Decode the picture shown ``target_ms`` into the player's clock.

    ``target_ms`` counts from the first video frame, like ``<video>.currentTime``
    and like the OCR sampler.  Returns ``(image, actual_ms, fps)`` on success, or
    ``None`` when the demuxer dropped us past the target, in which case the
    caller retries from further back.
    """
    with module.open(str(path)) as container:
        stream = _first_video_stream(container)
        if stream is None:
            raise SidecarError(E_VIDEO_DECODE, "文件里没有可用的视频轨道",
                               str(path))
        fps = _stream_fps(container, stream) or 25.0
        frame_ms = 1000.0 / fps if fps > 0 else 40.0
        origin_ms = _timeline_origin_ms(container, stream)
        want_ms = origin_ms + target_ms
        start_ms = origin_ms if backoff_ms is None else want_ms - backoff_ms
        start_ms = max(origin_ms, start_ms)
        _seek_to(container, stream, start_ms / 1000.0)

        chosen = None
        chosen_ms = None
        estimate_ms = start_ms
        for index, frame in enumerate(container.decode(stream)):
            if index >= _MAX_DECODE_FRAMES:
                break
            pts_ms = _frame_pts_ms(frame)
            if pts_ms is None:
                # No usable timestamp: fall back to counting from the seek
                # point so a file without PTS still yields a frame.
                pts_ms = estimate_ms
            if pts_ms > want_ms + _PTS_EPSILON_MS:
                break
            chosen = frame
            chosen_ms = pts_ms
            estimate_ms = pts_ms + frame_ms
        if chosen is None:
            return None
        return _to_image(chosen), max(0, int(round(chosen_ms - origin_ms))), fps


def _timeline_origin_ms(container, stream) -> float:
    """Timestamp of the first video frame on the container's absolute axis.

    Reported stills are shifted back by this much so ``timeMs`` means the same
    thing as ``<video>.currentTime``.
    """
    raw = getattr(stream, "start_time", None)
    if raw is not None:
        time_base = getattr(stream, "time_base", None)
        try:
            return max(0.0, float(raw * time_base) * 1000.0)
        except (TypeError, ValueError, ZeroDivisionError):
            return 0.0
    raw = getattr(container, "start_time", None)
    if raw is None:
        return 0.0
    try:
        # Container timestamps are microseconds (AV_TIME_BASE).
        return max(0.0, float(raw) / 1000.0)
    except (TypeError, ValueError):
        return 0.0


def _payload(path: Path, target: Path, target_ms: int, actual_ms: int,
             width: int, height: int, fps: float, *, from_cache: bool) -> dict:
    return {
        "videoPath": str(path.resolve()),
        "path": str(target),
        "requestedMs": int(target_ms),
        "timeMs": int(actual_ms),
        "width": int(width or 0),
        "height": int(height or 0),
        "fps": round(float(fps or 0.0), 3),
        "fromCache": bool(from_cache),
    }


def _seek_to(container, stream, seconds: float) -> None:
    """Seek to ``seconds`` on the container's absolute timestamp axis."""
    time_base = getattr(stream, "time_base", None)
    if not time_base:
        time_base = getattr(container, "time_base", None)
    try:
        offset = int(round(seconds / float(time_base)))
    except (TypeError, ValueError, ZeroDivisionError):
        offset = int(round(seconds * 1_000_000))
    container.seek(offset, backward=True, any_frame=False, stream=stream)


def _frame_pts_ms(frame) -> Optional[float]:
    """Frame timestamp in milliseconds, as stored in the container."""
    pts = getattr(frame, "pts", None)
    time_base = getattr(frame, "time_base", None)
    if pts is None or time_base is None:
        return None
    try:
        return float(pts * time_base) * 1000.0
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _to_image(frame):
    converter = getattr(frame, "to_image", None)
    if converter is None:
        raise SidecarError(E_VIDEO_DECODE, "当前取帧组件无法导出图像", "")
    return converter()


def _image_size(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image

        with Image.open(str(path)) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001
        return 0, 0


def _evict_cache(keep: Optional[Path] = None) -> None:
    root = frame_cache_dir()
    if not root.is_dir():
        return
    entries = []
    for item in root.glob("*.jpg"):
        try:
            entries.append((item.stat().st_mtime, item))
        except OSError:
            continue
    if len(entries) <= FRAME_CACHE_MAX_FILES:
        return
    entries.sort()
    for _, item in entries[: len(entries) - FRAME_CACHE_MAX_FILES]:
        if keep is not None and item == keep:
            continue
        try:
            item.unlink()
        except OSError:
            continue