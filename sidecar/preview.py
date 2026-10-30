"""Video probing plus mkv/avi preview preparation (SIDECAR_API.md §11).

Chromium only plays MP4/WebM/Ogg containers, so anything else has to be
re-wrapped (or, as a fallback, re-encoded) before it can be shown inside the
app.  Re-wrapping copies the existing streams, which takes seconds even for a
multi-gigabyte movie; re-encoding is the exception and is only attempted when
the container switch alone cannot produce a playable file.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import sys
import time
from fractions import Fraction
from pathlib import Path
from typing import Callable, Optional

from .errors import (
    E_CANCELLED,
    E_PREVIEW_TRANSCODE,
    E_PREVIEW_UNAVAILABLE,
    E_VIDEO_DECODE,
    E_VIDEO_NOT_FOUND,
    SidecarError,
)
from .protocol import log

# Containers Chromium accepts as-is.
PLAYABLE_CONTAINERS = {"mp4", "m4v", "mov", "webm", "ogv", "ogg"}
# Codecs Chromium can decode.  H.265 is deliberately absent: it only plays
# when the platform decoder happens to be available, which is not a promise we
# can make across machines.
PLAYABLE_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
PLAYABLE_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac", ""}
# Streams the MP4 muxer can carry *and* Chromium can decode after re-wrapping.
REMUX_VIDEO_CODECS = {"h264", "vp9", "av1"}
REMUX_AUDIO_CODECS = {"aac", "mp3", "opus", ""}

DEFAULT_CACHE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024  # 10GB, see §11.6
_PROBE_CACHE: dict[str, tuple[tuple, dict]] = {}


def av_available() -> bool:
    if "av" in sys.modules:
        return True
    try:
        return importlib.util.find_spec("av") is not None
    except (ImportError, ValueError):
        return False


def load_av():
    """Import PyAV on demand; injected in tests and by the frozen build."""
    import av

    return av


def preview_cache_dir() -> Path:
    override = os.environ.get("VIDEO_SUBTITLE_PREVIEW_CACHE")
    if override:
        return Path(override).expanduser()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "AVL-SubtitleOCR" / "preview"
    return Path.home() / ".cache" / "avl-subtitle-ocr" / "preview"


def preview_cache_limit() -> int:
    try:
        gigabytes = float(
            os.environ.get("VIDEO_SUBTITLE_PREVIEW_CACHE_GB", "10"))
    except (TypeError, ValueError):
        gigabytes = 10.0
    return max(0, int(gigabytes * 1024 * 1024 * 1024))


def probe(video_path: str) -> dict:
    """Container/codec/fps facts used by both the timeline and the previewer."""
    path = Path(video_path)
    if not path.is_file():
        raise SidecarError(E_VIDEO_NOT_FOUND, "找不到视频文件", str(path))
    stat = path.stat()
    fingerprint = (str(path.resolve()), int(stat.st_mtime), stat.st_size)
    cached = _PROBE_CACHE.get(str(path))
    if cached and cached[0] == fingerprint:
        return dict(cached[1])

    info = _probe_with_av(path)
    if info is None:
        info = _probe_with_cv2(path)
    info["videoPath"] = str(path)
    info["probedAt"] = int(time.time() * 1000)
    _PROBE_CACHE[str(path)] = (fingerprint, dict(info))
    return info


def _probe_with_av(path: Path) -> Optional[dict]:
    try:
        import av
    except Exception:
        return None
    try:
        with av.open(str(path)) as container:
            video = _first_video_stream(container)
            audio = _first_audio_stream(container)
            duration_ms = _container_duration_ms(container)
            fps = _stream_fps(container, video)
            info = {
                "container": _container_name(container, path),
                "videoCodec": _codec_name(video),
                "audioCodec": _codec_name(audio),
                "durationMs": duration_ms,
                "frameCount": int(round(duration_ms * fps / 1000.0)) if fps else 0,
                "width": int(getattr(video.codec_context, "width", 0) or 0),
                "height": int(getattr(video.codec_context, "height", 0) or 0),
                "fps": round(fps, 6),
                "variableFrameRate": _is_variable_rate(video),
            }
    except Exception as exc:  # noqa: BLE001 - a broken file must not crash the app
        log(f"PyAV 探测失败：{exc!r}")
        return None
    info["previewPlayable"] = is_playable(info)
    return info


def _probe_with_cv2(path: Path) -> dict:
    """Fallback probe when PyAV is not installed.

    Codecs are unknown here, so preview support is decided by the container
    alone; mkv/avi will simply report "not playable" and rely on the
    "open in system player" fallback.
    """
    fps = 0.0
    frames = 0.0
    width = 0
    height = 0
    try:
        import cv2

        capture = cv2.VideoCapture(str(path))
        try:
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
            frames = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        finally:
            capture.release()
    except Exception as exc:  # noqa: BLE001
        raise SidecarError(
            E_VIDEO_DECODE, "无法读取视频信息", f"{path}：{exc}") from exc
    container = _container_name(None, path)
    duration_ms = int(round(frames / fps * 1000)) if fps > 0 and frames > 0 else 0
    info = {
        "container": container,
        "videoCodec": "unknown",
        "audioCodec": "unknown",
        "durationMs": duration_ms,
        "frameCount": int(frames),
        "width": width,
        "height": height,
        "fps": round(fps, 6),
        "variableFrameRate": False,
    }
    info["previewPlayable"] = container in PLAYABLE_CONTAINERS
    return info


def is_playable(info: dict) -> bool:
    container = str(info.get("container") or "").lower()
    if container not in PLAYABLE_CONTAINERS:
        return False
    video = str(info.get("videoCodec") or "unknown").lower()
    audio = str(info.get("audioCodec") or "").lower()
    if video not in PLAYABLE_VIDEO_CODECS:
        return False
    return audio in PLAYABLE_AUDIO_CODECS


def plan_preview(info: dict) -> str:
    """Return ``direct``, ``remux`` or ``transcode`` for this file."""
    if is_playable(info):
        return "direct"
    video = str(info.get("videoCodec") or "unknown").lower()
    audio = str(info.get("audioCodec") or "").lower()
    if (video in REMUX_VIDEO_CODECS and audio in REMUX_AUDIO_CODECS
            and not av_available()):
        return "unavailable"
    if video in REMUX_VIDEO_CODECS and audio in REMUX_AUDIO_CODECS:
        return "remux"
    return "transcode"


def cache_path_for(video_path: str, mode: str) -> Path:
    path = Path(video_path)
    stat = path.stat()
    digest = hashlib.sha1(
        f"{path.resolve()}|{int(stat.st_mtime)}|{stat.st_size}|{mode}".encode(
            "utf-8", "surrogatepass")
    ).hexdigest()[:16]
    return preview_cache_dir() / f"{_safe_stem(path.stem)}-{digest}.mp4"


def prepare_preview(
    video_path: str,
    on_progress: Optional[Callable[[int, str], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    force: bool = False,
    av_module=None,
) -> dict:
    """Make ``video_path`` playable, returning the path to use in ``<video>``.

    Runs in the preview worker thread, never on the protocol thread: a
    two-hour movie can take a minute to re-wrap, during which the UI still
    has to answer ``system.ping`` and accept ``video.previewCancel``.
    """
    info = probe(video_path)
    if info.get("previewPlayable") and not force:
        return {
            "state": "ready",
            "previewPath": str(Path(video_path).resolve()),
            "mode": "direct",
            "fromCache": False,
        }

    av_module = av_module or (load_av() if av_available() else None)
    mode = plan_preview(info)
    if mode == "unavailable" or av_module is None:
        raise SidecarError(
            E_PREVIEW_UNAVAILABLE,
            "这个文件需要重新封装才能预览，但当前安装包缺少转码组件",
            f"container={info.get('container')} video={info.get('videoCodec')}",
        )

    target = cache_path_for(video_path, mode)
    if target.is_file() and target.stat().st_size > 0:
        return {
            "state": "ready",
            "previewPath": str(target),
            "mode": mode,
            "fromCache": True,
        }

    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    if partial.exists():
        partial.unlink(missing_ok=True)
    try:
        if mode == "remux":
            _remux(video_path, partial, info, on_progress, should_stop,
                   av_module)
        else:
            _transcode(video_path, partial, info, on_progress, should_stop,
                       av_module)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(target)
    _evict_cache(keep=target)
    return {
        "state": "ready",
        "previewPath": str(target),
        "mode": mode,
        "fromCache": False,
    }


def _evict_cache(keep: Optional[Path] = None) -> None:
    limit = preview_cache_limit()
    if limit <= 0:
        return
    root = preview_cache_dir()
    if not root.is_dir():
        return
    entries = []
    total = 0
    for item in root.glob("*.mp4"):
        try:
            stat = item.stat()
        except OSError:
            continue
        entries.append((stat.st_mtime, stat.st_size, item))
        total += stat.st_size
    if total <= limit:
        return
    entries.sort()
    for _, size, item in entries:
        if total <= limit:
            break
        if keep is not None and item == keep:
            continue
        try:
            item.unlink()
            total -= size
        except OSError:
            continue


def _remux(video_path: str, target: Path, info: dict,
           on_progress, should_stop, av) -> None:
    """Copy every stream into a fresh MP4 without touching the codecs."""
    total_us = int(info.get("durationMs") or 0) * 1000
    try:
        with av.open(video_path) as source:
            streams = _remux_streams(source)
            if not streams:
                raise SidecarError(
                    E_PREVIEW_TRANSCODE, "文件里没有可用的视频轨道", video_path)
            with av.open(str(target), "w", format="mp4") as sink:
                mapping = {}
                for stream in streams:
                    mapping[stream.index] = _add_stream(sink, stream)
                for packet in source.demux(*streams):
                    if should_stop and should_stop():
                        raise SidecarError(E_CANCELLED, "预览准备已取消")
                    if packet.dts is None or packet.size == 0:
                        continue
                    out_stream = mapping.get(packet.stream.index)
                    if out_stream is None:
                        continue
                    packet.stream = out_stream
                    sink.mux(packet)
                    if total_us and on_progress and packet.pts is not None:
                        pts_us = int(packet.pts * packet.time_base * 1_000_000)
                        on_progress(min(99, int(pts_us / total_us * 100)), "正在重新封装")
    except SidecarError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise SidecarError(
            E_PREVIEW_TRANSCODE, "重新封装失败", f"{video_path}：{exc}") from exc


def _transcode(video_path: str, target: Path, info: dict,
               on_progress, should_stop, av) -> None:
    """Fallback for codecs the MP4 muxer or Chromium cannot carry."""
    encoder = os.environ.get("VIDEO_SUBTITLE_PREVIEW_ENCODER", "libx264")
    try:
        av.codec.Codec(encoder, "w")
    except Exception as exc:
        raise SidecarError(
            E_PREVIEW_TRANSCODE,
            f"当前转码组件不含 {encoder} 编码器，无法生成预览",
            "请改用“用系统播放器打开”",
        ) from exc

    total_us = int(info.get("durationMs") or 0) * 1000
    try:
        with av.open(video_path) as source:
            video_in = _first_video_stream(source)
            audio_in = _first_audio_stream(source)
            if video_in is None:
                raise SidecarError(
                    E_PREVIEW_TRANSCODE, "文件里没有可用的视频轨道", video_path)
            with av.open(str(target), "w", format="mp4") as sink:
                sink_options = {"preset": "veryfast", "crf": "23"}
                # PyAV 18 rejects a float rate (to_avrational wants
                # .numerator), so hand the encoder a real fraction.
                # PyAV 18 rejects a float rate (to_avrational wants
                # .numerator), so hand the encoder a real fraction.
                fps = _stream_fps(source, video_in)
                video_out = sink.add_stream(
                    encoder, rate=Fraction(fps).limit_denominator(1000))
                video_out.width = int(video_in.codec_context.width)
                video_out.height = int(video_in.codec_context.height)
                video_out.pix_fmt = "yuv420p"
                video_out.options = dict(sink_options)
                audio_out = None
                resampler = None
                if audio_in is not None:
                    audio_out = sink.add_stream("aac", rate=48000)
                    resampler = av.AudioResampler(
                        format="fltp",
                        layout=audio_out.layout.name
                        if audio_out.layout else "stereo",
                        rate=audio_out.rate,
                    )
                for frame in source.decode(video_in, audio_in):
                    if should_stop and should_stop():
                        raise SidecarError(E_CANCELLED, "预览准备已取消")
                    if isinstance(frame, av.VideoFrame):
                        for packet in video_out.encode(frame):
                            sink.mux(packet)
                    elif isinstance(frame, av.AudioFrame) and audio_out is not None:
                        for resampled in resampler.resample(frame):
                            for packet in audio_out.encode(resampled):
                                sink.mux(packet)
                    if total_us and on_progress and frame.pts is not None:
                        pts_us = int(frame.pts * frame.time_base * 1_000_000)
                        on_progress(min(99, int(pts_us / total_us * 100)), "正在转码")
                for packet in video_out.encode(None):
                    sink.mux(packet)
                if audio_out is not None:
                    for packet in audio_out.encode(None):
                        sink.mux(packet)
    except SidecarError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise SidecarError(
            E_PREVIEW_TRANSCODE, "转码失败", f"{video_path}：{exc}") from exc


def _remux_streams(container) -> list:
    """Video + audio streams worth copying, cover art excluded."""
    streams = []
    video = _first_video_stream(container)
    audio = _first_audio_stream(container)
    if video is not None:
        streams.append(video)
    if audio is not None:
        streams.append(audio)
    return streams


def _add_stream(sink, stream):
    add_from_template = getattr(sink, "add_stream_from_template", None)
    if add_from_template is not None:
        return add_from_template(stream)
    return sink.add_stream(template=stream)


def _first_video_stream(container):
    for stream in container.streams.video:
        if _is_attached_picture(stream):
            continue
        return stream
    return None


def _first_audio_stream(container):
    for stream in container.streams.audio:
        return stream
    return None


def _is_attached_picture(stream) -> bool:
    disposition = getattr(stream, "disposition", None)
    if disposition is None:
        return False
    flag = getattr(disposition, "attached_pic", None)
    if flag is None:
        return False
    # PyAV exposes ``Disposition`` as an IntFlag: ``stream.disposition`` is the
    # raw bit set and ``Disposition.attached_pic`` is the *value* of the flag
    # (1024), not a boolean.  ``bool(...)`` on it is always True, which used to
    # hide every real video stream.  Test the bits instead; plain namespaces
    # (the test doubles) keep working through the fallback.
    try:
        return bool(int(disposition) & int(flag))
    except (TypeError, ValueError):
        return bool(flag)


def _codec_name(stream) -> str:
    if stream is None:
        return "none"
    codec = getattr(stream, "codec_context", None)
    name = getattr(codec, "name", None) or getattr(stream, "name", None)
    return str(name or "unknown").lower()


def _stream_fps(container, stream) -> float:
    if stream is None:
        return 0.0
    for attribute in ("average_rate", "guessed_rate", "base_rate"):
        rate = getattr(stream, attribute, None)
        if rate is None:
            continue
        try:
            value = float(rate)
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if value > 0:
            return value
    return 0.0


def _is_variable_rate(stream) -> bool:
    if stream is None:
        return False
    try:
        average = float(stream.average_rate)
        guessed = float(stream.guessed_rate)
    except (TypeError, ValueError, ZeroDivisionError, AttributeError):
        return False
    if average <= 0 or guessed <= 0:
        return False
    return abs(average - guessed) / average > 0.01


def _container_duration_ms(container) -> int:
    duration = getattr(container, "duration", None)
    if duration:
        return int(round(float(duration) / 1000.0))
    longest = 0.0
    for stream in container.streams:
        stream_duration = getattr(stream, "duration", None)
        time_base = getattr(stream, "time_base", None)
        if stream_duration and time_base:
            longest = max(longest, float(stream_duration * time_base))
    return int(round(longest * 1000))


def _container_name(container, path: Path) -> str:
    name = ""
    if container is not None:
        fmt = getattr(container, "format", None)
        name = str(getattr(fmt, "name", "") or "")
    if not name:
        name = path.suffix.lstrip(".").lower()
    # PyAV reports mkv as "matroska,webm"; keep the first, most specific name.
    return name.split(",")[0].strip().lower()


def _safe_stem(stem: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in "-_" else "_"
        for character in stem)
    return (cleaned or "video")[:60]
