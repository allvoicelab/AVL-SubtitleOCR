from __future__ import annotations

import re
from typing import Optional

from .ocr_engine import SubtitleCue

# Timing line: ``HH:MM:SS,mmm --> HH:MM:SS,mmm``.  Hours are 1-3 digits and
# the millisecond separator is whatever the editor wrote (`,` `.` or a space),
# because these files come back from other tools.  Anything a writer appends
# after the range (coordinates) is ignored on purpose.
_TIMING = re.compile(
    r"(\d{1,3}):(\d{1,2}):(\d{1,2})[,.\s](\d{1,3})"
    r"\s*-->\s*"
    r"(\d{1,3}):(\d{1,2}):(\d{1,2})[,.\s](\d{1,3})")


def format_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds_part, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds_part:02d},{millis:03d}"


def to_srt(cues: list[SubtitleCue]) -> str:
    blocks = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(
            f"{index}\n{format_timestamp(cue.start)} --> {format_timestamp(cue.end)}\n"
            f"{cue.text.strip()}\n"
        )
    return "\n".join(blocks)


def _milliseconds(parts: tuple[str, str, str, str]) -> int:
    hours, minutes, seconds, millis = parts
    return (
        (int(hours) * 3600 + int(minutes) * 60 + int(seconds)) * 1000
        + int(millis.ljust(3, "0"))
    )


def parse_timing(line: str) -> Optional[tuple[int, int]]:
    """``(startMs, endMs)`` from one SRT timing line, or ``None``."""
    match = _TIMING.match(line.strip())
    if match is None:
        return None
    groups = match.groups()
    return _milliseconds(groups[:4]), _milliseconds(groups[4:])


def from_srt(text: str) -> tuple[list[SubtitleCue], int]:
    """Read SRT text back into cues; returns ``(cues, unparsed_blocks)``.

    Read-back must not invent content: a block whose timing line cannot be
    parsed (or whose range runs backwards) is *counted* and dropped instead of
    being repaired or clamped, and the caller decides what that count means
    (``sidecar/srt_io.py`` turns it into ``partial``).
    """
    cues: list[SubtitleCue] = []
    unparsed = 0
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n[ \t]*\n", normalized):
        lines = block.split("\n")
        timing = next(
            (index for index, line in enumerate(lines) if "-->" in line), None)
        if timing is None:
            if block.strip():
                unparsed += 1
            continue
        parsed = parse_timing(lines[timing])
        if parsed is None:
            unparsed += 1
            continue
        start_ms, end_ms = parsed
        if end_ms < start_ms:
            unparsed += 1
            continue
        cues.append(SubtitleCue(
            start=start_ms / 1000.0,
            end=end_ms / 1000.0,
            text="\n".join(lines[timing + 1:]).strip(),
        ))
    return cues, unparsed