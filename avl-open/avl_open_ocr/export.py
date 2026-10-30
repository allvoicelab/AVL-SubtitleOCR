import json
from pathlib import Path
from typing import Iterable

from .models import Cue


def format_timestamp(milliseconds: float) -> str:
    total_ms = max(0, int(round(milliseconds)))
    hours, remainder = divmod(total_ms, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def write_srt(cues: Iterable[Cue], path: str):
    lines = []
    for index, cue in enumerate(cues, 1):
        lines.extend([str(index), f"{format_timestamp(cue.start_ms)} --> {format_timestamp(cue.end_ms)}", cue.text, ""])
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def write_json(cues: Iterable[Cue], path: str):
    payload = [
        {"start_ms": cue.start_ms, "end_ms": cue.end_ms, "text": cue.text,
         "bbox": cue.bbox, "confidence": cue.confidence}
        for cue in cues
    ]
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
