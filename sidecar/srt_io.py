"""SRT rendering and writing.

The formatter is imported from :mod:`app.srt` so every producer writes the
same bytes instead of reimplementing the format here.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

from .errors import E_OUTPUT_WRITE, SidecarError
from .models import Cue

# utf-8-sig so Windows editors and legacy players that sniff the BOM still
# show Chinese correctly.
SRT_ENCODING = "utf-8-sig"


def to_subtitle_cues(cues: Iterable[Cue]):
    from app.ocr_engine import SubtitleCue

    converted = []
    for cue in cues:
        subtitle = SubtitleCue(
            start=cue.start_ms / 1000.0,
            end=cue.end_ms / 1000.0,
            text=cue.text,
            confidence=cue.confidence,
            fps=cue.fps or None,
        )
        subtitle.sync_frames_from_times()
        converted.append(subtitle)
    return converted


def serialize(cues: Iterable[Cue]) -> str:
    from app.srt import to_srt

    return to_srt(to_subtitle_cues(cues))


def write(cues: Iterable[Cue], target: str) -> str:
    path = Path(target)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialize(cues), encoding=SRT_ENCODING)
    except OSError as exc:
        raise SidecarError(
            E_OUTPUT_WRITE, "无法写入字幕文件", f"{path}：{exc}") from exc
    return str(path)


def unique_path(directory: Path, stem: str,
                claimed: Optional[set] = None) -> Path:
    """``<stem>.srt``, then ``<stem> (2).srt`` when the name is taken."""
    claimed = claimed if claimed is not None else set()
    candidate = directory / f"{stem}.srt"
    suffix = 2
    while str(candidate).lower() in claimed or candidate.exists():
        candidate = directory / f"{stem} ({suffix}).srt"
        suffix += 1
    claimed.add(str(candidate).lower())
    return candidate


def parse(text: str, fps: float = 0.0) -> tuple[list[Cue], int]:
    """Read SRT text back: ``(cues, unparsed_blocks)``.

    The grammar lives in :func:`app.srt.from_srt` -- the same producer that
    renders the SRTs we write -- so read-back and write-back cannot drift.
    """
    from app.srt import from_srt

    subtitle_cues, unparsed = from_srt(text)
    cues: list[Cue] = []
    for subtitle in subtitle_cues:
        cue = Cue.from_source(subtitle, fps=fps)
        cue.index = len(cues) + 1
        if fps > 0:
            cue.start_frame, cue.end_frame = cue.frames_for(fps)
        cues.append(cue)
    return cues, unparsed


# Editors on Windows still default to the local code page for .srt files, so a
# file written by hand is as likely to be gbk as utf-8.  A file we cannot
# decode at all is reported as unreadable instead of half-parsed.
SRT_READ_DECODINGS = (SRT_ENCODING, "gbk")


def read(path: str, fps: float = 0.0) -> Optional[tuple[list[Cue], int]]:
    """Parse the SRT at *path*; ``None`` when it cannot be read or decoded."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    for encoding in SRT_READ_DECODINGS:
        try:
            return parse(data.decode(encoding), fps=fps)
        except UnicodeDecodeError:
            continue
    return None