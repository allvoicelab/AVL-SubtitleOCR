import re
import math
import statistics
import unicodedata
from difflib import SequenceMatcher
from dataclasses import dataclass
from typing import Iterable, List, Optional

from .models import Cue, Detection, FrameResult


@dataclass(frozen=True)
class _A3Record:
    frame: int
    bbox: tuple[float, float, float, float]
    text: str


@dataclass(frozen=True)
class _F1Record:
    frame: int
    bbox: tuple[float, float, float, float]
    text: str
    score: float


@dataclass
class _F1Track:
    records: list[_F1Record]


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", "", clean_output_text(text))


def clean_output_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", text).strip()


def iou(left, right) -> float:
    x1 = max(left[0], right[0])
    y1 = max(left[1], right[1])
    x2 = min(left[2], right[2])
    y2 = min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if intersection <= 0:
        return 0.0
    area_left = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    area_right = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = area_left + area_right - intersection
    return intersection / union if union else 0.0


def text_similarity(left: str, right: str) -> float:
    return SequenceMatcher(None, normalize_text(left), normalize_text(right)).ratio()


def _same_caption(previous: Detection, current: Detection, config) -> bool:
    return (iou(previous.bbox, current.bbox) >= config.bbox_iou and
            text_similarity(previous.text, current.text) >= config.text_similarity)


def build_cues(frames: Iterable[FrameResult], config) -> List[Cue]:
    cues: List[Cue] = []
    active: Optional[Cue] = None
    last_detection: Optional[Detection] = None
    last_timestamp = 0.0
    for frame in frames:
        detections = [
            Detection(d.bbox, clean_output_text(d.text), d.score)
            for d in frame.detections
            if d.score >= config.recognition_threshold and
            len(normalize_text(d.text)) >= config.min_text_length
        ]
        detections.sort(key=lambda item: (item.bbox[1], item.bbox[0]))
        current = detections[0] if detections else None
        contiguous = (current is not None and last_detection is not None and
                      frame.timestamp_ms - last_timestamp <= config.max_gap_ms and
                      _same_caption(last_detection, current, config))
        if current is None:
            if active and frame.timestamp_ms - last_timestamp > config.max_gap_ms:
                _close(cues, active, last_timestamp, config)
                active, last_detection = None, None
        elif contiguous and active:
            active.end_ms = frame.timestamp_ms
            active.confidence = max(active.confidence, current.score)
            last_detection = current
        else:
            if active:
                _close(cues, active, last_timestamp, config)
            active = Cue(frame.timestamp_ms, frame.timestamp_ms, current.text,
                         current.bbox, current.score)
            last_detection = current
        last_timestamp = frame.timestamp_ms
    if active:
        _close(cues, active, last_timestamp, config)
    return _merge_adjacent(cues, config.merge_gap_ms)


def build_cues_a3(frames: Iterable[FrameResult], config, metadata) -> List[Cue]:
    source_fps = float(metadata.get("fps") or 25.0)
    sample_span = max(1, round(source_fps / config.sample_fps))
    records = [
        _A3Record(frame.frame_index, detection.bbox, detection.text)
        for frame in frames
        for detection in frame.detections
        if detection.score >= config.recognition_threshold and detection.text.strip()
    ]
    records = _a3_auto_select_subtitle_band(
        records, int(metadata.get("height") or 0),
        int(metadata.get("frame_count") or 0))
    normalized = [
        _A3Record(record.frame, record.bbox, clean_output_text(record.text))
        for record in records if normalize_text(record.text)
    ]
    merged = _a3_merge_records(normalized, sample_span)
    filtered = [item for item in merged
                if item[1] - item[0] + 1 >= sample_span * 2]
    frame_ms = 1000.0 / source_fps
    return [
        Cue(start * frame_ms, end * frame_ms, text)
        for start, end, text in filtered
    ]


def build_cues_f1(frames: Iterable[FrameResult], config, metadata) -> List[Cue]:
    source_fps = float(metadata.get("fps") or 25.0)
    height = int(metadata.get("height") or 0)
    records = [
        _F1Record(
            frame.frame_index,
            detection.bbox,
            clean_output_text(detection.text),
            detection.score,
        )
        for frame in frames
        for detection in frame.detections
        if detection.score >= config.recognition_threshold
        and normalize_text(detection.text)
    ]
    records = _f1_dominant_band(records, height)
    records = _f1_compose_english_frames(records)
    tracks = _f1_associate(records, source_fps, config)
    tracks = [
        track for track in tracks
        if _f1_support_ratio(track, source_fps) > config.f1_support_threshold
    ]
    cues = [_f1_track_to_cue(track, source_fps) for track in tracks]
    return _f1_merge_exact(cues, source_fps)


def _f1_compose_english_frames(records):
    grouped = {}
    for record in records:
        grouped.setdefault(record.frame, []).append(record)
    composed = []
    for frame_records in grouped.values():
        if len(frame_records) == 1 or not any(
                re.search(r"[A-Za-z]", record.text) for record in frame_records):
            composed.extend(frame_records)
            continue
        line_groups = _f1_group_lines(frame_records)
        line_groups.sort(key=lambda group: min(item.bbox[1] for item in group))
        line_texts = []
        for group in line_groups:
            group.sort(key=lambda item: item.bbox[0])
            line_texts.append(_join_text_fragments(item.text for item in group))
        bbox = (
            min(item.bbox[0] for item in frame_records),
            min(item.bbox[1] for item in frame_records),
            max(item.bbox[2] for item in frame_records),
            max(item.bbox[3] for item in frame_records),
        )
        composed.append(_F1Record(
            frame_records[0].frame,
            bbox,
            _join_text_fragments(line_texts),
            max(item.score for item in frame_records),
        ))
    return sorted(composed, key=lambda item: (item.frame, item.bbox[1], item.bbox[0]))


def _f1_group_lines(records):
    median_height = statistics.median(
        max(1.0, record.bbox[3] - record.bbox[1]) for record in records)
    lines = []
    for record in sorted(records, key=lambda item: (item.bbox[1], item.bbox[0])):
        center = (record.bbox[1] + record.bbox[3]) / 2
        height = max(1.0, record.bbox[3] - record.bbox[1])
        matched = None
        for line in lines:
            line_center = statistics.mean(
                (item.bbox[1] + item.bbox[3]) / 2 for item in line)
            line_height = statistics.median(
                max(1.0, item.bbox[3] - item.bbox[1]) for item in line)
            overlap = max(
                0.0,
                min(record.bbox[3], max(item.bbox[3] for item in line)) -
                max(record.bbox[1], min(item.bbox[1] for item in line)),
            ) / max(1.0, min(height, line_height))
            if overlap >= 0.25 or abs(center - line_center) <= 0.6 * median_height:
                matched = line
                break
        if matched is None:
            lines.append([record])
        else:
            matched.append(record)
    return lines


def _join_text_fragments(fragments):
    result = ""
    punctuation_without_prefix = set(",.!?:;)]}%，。！？：；）》】」』")
    for fragment in fragments:
        fragment = clean_output_text(fragment)
        if not fragment:
            continue
        if not result:
            result = fragment
        elif fragment[0] in punctuation_without_prefix or fragment[0] in "'\"’”":
            result += fragment
        elif result[-1] in "-‐‑‒–—/'\"‘“":
            result += fragment
        else:
            result += " " + fragment
    return result


def _f1_dominant_band(records, height):
    if not records or height <= 0:
        return records
    bin_height = max(24, height // 20)
    bins = {}
    for record in records:
        center = (record.bbox[1] + record.bbox[3]) / 2
        if center >= height * 0.35:
            bins.setdefault(int(center // bin_height), []).append(record)
    if not bins:
        return records
    best = max(
        bins,
        key=lambda key: (
            len({record.frame for record in bins[key]}), len(bins[key]),
        ),
    )
    return [
        record for record in records
        if abs(int(((record.bbox[1] + record.bbox[3]) / 2) // bin_height) - best) <= 2
    ]


def _f1_associate(records, fps, config):
    tracks = []
    active = []
    max_gap = max(2, round(fps * config.f1_max_gap_seconds))
    for record in sorted(
        records, key=lambda item: (item.frame, item.bbox[1], item.bbox[0]),
    ):
        active = [
            track for track in active
            if record.frame - track.records[-1].frame <= max_gap
        ]
        candidates = []
        for track in active:
            previous = track.records[-1]
            if previous.frame == record.frame:
                continue
            spatial_score = iou(previous.bbox, record.bbox)
            text_score = text_similarity(previous.text, record.text)
            if (spatial_score >= 0.41 and
                    text_score >= config.f1_text_similarity):
                candidates.append((spatial_score, track))
        if candidates:
            max(candidates, key=lambda item: item[0])[1].records.append(record)
        else:
            track = _F1Track([record])
            tracks.append(track)
            active.append(track)
    return tracks


def _f1_support_ratio(track, fps):
    frames = sorted({record.frame for record in track.records})
    radius = max(1, math.ceil(2.2 * fps / 2))
    denominator = 2 * radius + 1
    best = 0
    left = 0
    for right, frame in enumerate(frames):
        while frame - frames[left] > 2 * radius:
            left += 1
        best = max(best, right - left + 1)
    return best / denominator


def _f1_track_to_cue(track, fps):
    first = track.records[0]
    start = min(record.frame for record in track.records)
    end = max(record.frame for record in track.records) + 1
    return Cue(
        start * 1000.0 / fps,
        end * 1000.0 / fps,
        first.text,
        first.bbox,
        max(record.score for record in track.records),
    )


def _f1_merge_exact(cues, fps):
    output = []
    max_gap_ms = round(fps * 0.35) * 1000.0 / fps
    for cue in sorted(cues, key=lambda item: (item.start_ms, item.end_ms)):
        if (
            output
            and cue.start_ms - output[-1].end_ms <= max_gap_ms
            and normalize_text(output[-1].text) == normalize_text(cue.text)
        ):
            output[-1].end_ms = max(output[-1].end_ms, cue.end_ms)
            output[-1].confidence = max(output[-1].confidence, cue.confidence)
        else:
            output.append(cue)
    return output


def _a3_auto_select_subtitle_band(records, height, total_frames):
    if not records:
        return []
    frames = sorted({record.frame for record in records})
    text_frames = {}
    for record in records:
        text_frames.setdefault(normalize_text(record.text).lower(), set()).add(record.frame)
    persistent = {
        text for text, seen in text_frames.items()
        if len(seen) >= max(6, int(len(frames) * 0.18))
    }
    candidates = [record for record in records
                  if normalize_text(record.text).lower() not in persistent]
    candidates = candidates or records
    bin_height = max(24, height // 20)
    bins = {}
    for record in candidates:
        center_y = (record.bbox[1] + record.bbox[3]) / 2
        if center_y < height * 0.35:
            continue
        bins.setdefault(int(center_y // bin_height), []).append(record)
    if not bins:
        return candidates
    best_bin, best_items = max(
        bins.items(),
        key=lambda pair: (
            len({item.frame for item in pair[1]}),
            len({normalize_text(item.text).lower() for item in pair[1]}),
            pair[0],
        ),
    )
    center = (best_bin + 0.5) * bin_height
    median_height = statistics.median(
        max(1.0, item.bbox[3] - item.bbox[1]) for item in best_items)
    half_band = max(height * 0.08, median_height * 2.5)
    return [
        record for record in candidates
        if abs((record.bbox[1] + record.bbox[3]) / 2 - center) <= half_band
    ]


def _a3_merge_records(records, sample_span):
    if not records:
        return []
    ordered = sorted(records, key=lambda item: (item.frame, item.bbox[1], item.bbox[0]))
    groups = [[ordered[0]]]
    for item in ordered[1:]:
        previous = groups[-1][-1]
        same_text = normalize_text(previous.text).lower() == normalize_text(item.text).lower()
        close_frame = item.frame - previous.frame <= sample_span * 1.25
        if same_text and close_frame:
            groups[-1].append(item)
        else:
            groups.append([item])
    output = []
    for group in groups:
        text_groups = {}
        for item in group:
            text_groups.setdefault(normalize_text(item.text).lower(), []).append(item.text)
        text = max(text_groups.values(), key=lambda values: (len(values), len(max(values, key=len))))[0]
        output.append((group[0].frame, group[-1].frame + sample_span, text))
    return output


def build_cues_variant(frames: Iterable[FrameResult], config, variant: str) -> List[Cue]:
    if variant == "E1_narrow_roi":
        return build_cues(frames, config)
    tracks = []
    for frame in frames:
        detections = [
            Detection(d.bbox, clean_output_text(d.text), d.score)
            for d in frame.detections
            if d.score >= config.recognition_threshold and
            len(normalize_text(d.text)) >= config.min_text_length
        ]
        detections.sort(key=lambda item: (item.bbox[1], item.bbox[0]))
        used = set()
        for track in tracks:
            if frame.timestamp_ms - track["last_ts"] > config.max_gap_ms:
                continue
            candidates = [
                (index, detection) for index, detection in enumerate(detections)
                if index not in used and _track_match(track["last"], detection)
            ]
            if not candidates:
                continue
            index, detection = max(candidates, key=lambda item: _track_score(track["last"], item[1]))
            used.add(index)
            track["observations"].append((frame.timestamp_ms, detection))
            track["last"] = detection
            track["last_ts"] = frame.timestamp_ms
        for index, detection in enumerate(detections):
            if index in used:
                continue
            tracks.append({
                "observations": [(frame.timestamp_ms, detection)],
                "last": detection,
                "last_ts": frame.timestamp_ms,
            })

    cues = []
    for track in tracks:
        observations = track["observations"]
        if not observations:
            continue
        start = observations[0][0]
        end = observations[-1][0]
        duration = end - start
        if duration < config.min_duration_ms:
            continue
        if variant in {"E3_duration_window", "E4_track_voting"}:
            expected = max(1.0, duration / max(1.0, 1000.0 / config.sample_fps)) + 1.0
            support = len(observations) / expected
            if support < 0.30:
                continue
        if variant == "E4_track_voting":
            text, confidence = _vote_text(observations)
        else:
            text, confidence = max(
                ((item.text, item.score) for _, item in observations),
                key=lambda item: item[1],
            )
        cues.append(Cue(start, min(end, start + config.max_cue_duration_ms),
                        text, observations[-1][1].bbox, confidence))
    cues.sort(key=lambda cue: (cue.start_ms, cue.bbox[1] if cue.bbox else 0.0))
    return _merge_adjacent(cues, config.merge_gap_ms)


def _track_match(previous: Detection, current: Detection) -> bool:
    if iou(previous.bbox, current.bbox) >= 0.15:
        return True
    prev_center = ((previous.bbox[0] + previous.bbox[2]) / 2,
                   (previous.bbox[1] + previous.bbox[3]) / 2)
    cur_center = ((current.bbox[0] + current.bbox[2]) / 2,
                  (current.bbox[1] + current.bbox[3]) / 2)
    height = max(previous.bbox[3] - previous.bbox[1], 1.0)
    return abs(prev_center[1] - cur_center[1]) <= height * 1.5 and \
        abs(prev_center[0] - cur_center[0]) <= max(height * 8.0, 80.0)


def _track_score(previous: Detection, current: Detection) -> float:
    return iou(previous.bbox, current.bbox) + 0.1 * text_similarity(previous.text, current.text)


def _vote_text(observations):
    groups = {}
    for _, detection in observations:
        key = normalize_text(detection.text)
        item = groups.setdefault(key, [0, 0.0, detection.text])
        item[0] += 1
        if detection.score >= item[1]:
            item[1] = detection.score
            item[2] = detection.text
    count, confidence, text = max(
        groups.values(), key=lambda item: (item[0], item[1]))
    return text, confidence


def _close(cues, cue, end_ms, config):
    cue.end_ms = min(max(end_ms, cue.start_ms + config.min_duration_ms),
                     cue.start_ms + config.max_cue_duration_ms)
    if cue.end_ms - cue.start_ms >= config.min_duration_ms:
        cues.append(cue)


def _merge_adjacent(cues: List[Cue], gap_ms: float) -> List[Cue]:
    merged = []
    for cue in cues:
        if (merged and cue.start_ms - merged[-1].end_ms <= gap_ms and
                text_similarity(merged[-1].text, cue.text) >= 0.8):
            merged[-1].end_ms = max(merged[-1].end_ms, cue.end_ms)
            merged[-1].confidence = max(merged[-1].confidence, cue.confidence)
        else:
            merged.append(cue)
    return merged
