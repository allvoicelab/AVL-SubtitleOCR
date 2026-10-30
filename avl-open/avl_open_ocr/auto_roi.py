"""Automatic subtitle-band selection adapted for the standalone OCR core."""

from collections import defaultdict
from typing import Dict, Iterable, List, Tuple

import numpy as np


def _merge_boxes_direction(boxes, direction, direct_thr=1.5,
                           tolerance=0.2, direct_rev_thr=0.62):
    indexed = [(tuple(box),) for box in boxes]
    key = (lambda item: (item[0][0], item[0][1])) if direction == "horizontal" \
        else (lambda item: (item[0][1], item[0][0]))
    indexed = sorted(indexed, key=key)
    links = defaultdict(list)
    for left_index, item in enumerate(indexed):
        x1, y1, x2, y2 = item[0]
        if direction == "horizontal":
            if not (x2 - x1 > (y2 - y1) / direct_thr):
                continue
            size = y2 - y1
            low = (y2 + y1) / 2 - size * (0.5 + tolerance)
            high = (y2 + y1) / 2 + size * (0.5 + tolerance)
        else:
            if not (y2 - y1 > (x2 - x1) / direct_thr):
                continue
            size = x2 - x1
            low = (x2 + x1) / 2 - size * (0.5 + tolerance)
            high = (x2 + x1) / 2 + size * (0.5 + tolerance)
        for right_index in range(left_index + 1, len(indexed)):
            a1, b1, a2, b2 = indexed[right_index][0]
            if direction == "horizontal":
                other_size = b2 - b1
                valid = (a2 - a1 > other_size / direct_thr and
                         high > b2 > b1 > low and
                         min(other_size, size) / max(other_size, size, 1) > direct_rev_thr and
                         ((x1 < a1 < x2 < a2) or
                          (x2 < a1 and abs(x2 - a1) < max(other_size, size) * direct_thr)))
            else:
                other_size = a2 - a1
                valid = (b2 - b1 > other_size / direct_thr and
                         high > a2 > a1 > low and
                         min(other_size, size) / max(other_size, size, 1) > direct_rev_thr and
                         ((y1 < b1 < y2 < b2) or
                          (y2 < b1 and abs(y2 - b1) < max(other_size, size) * direct_thr)))
            if valid:
                links[left_index].append(right_index)
    output = []
    finished = set()
    for index in range(len(indexed)):
        pending = {index}
        merged = set()
        while pending:
            current = pending.pop()
            if current in finished:
                break
            merged.add(current)
            pending.update(links.pop(current, ()))
        finished.update(merged)
        if merged:
            values = np.asarray([indexed[item][0] for item in merged])
            output.append((float(values[:, 0].min()), float(values[:, 1].min()),
                           float(values[:, 2].max()), float(values[:, 3].max())))
    return output


def merge_boxes(boxes):
    boxes = _merge_boxes_direction(boxes, "horizontal")
    return _merge_boxes_direction(boxes, "vertical")


class AutoROICollector:
    """Collect detection statistics and select a stable subtitle band."""

    def __init__(self, width: int, height: int, fps: float, config,
                 content_bounds=(0, 0), top_ratio=None, total_frames=0):
        self.width = width
        self.height = height
        self.fps = fps
        self.config = config
        self.content_bounds = content_bounds
        self.top_ratio = config.roi_top_ratio if top_ratio is None else top_ratio
        self.total_frames = total_frames
        self.coverage = np.zeros((height, width), dtype=np.int32)
        self.presence: Dict[int, List[int]] = defaultdict(list)
        self.row_stats = np.zeros((height, 7), dtype=np.float64)
        self.sampled_frames = set()
        self.total_boxes = 0
        self.kept_boxes = 0
        self.frame_boxes = defaultdict(list)

    def collect(self, frame_index: int, image, detections: Iterable):
        self.sampled_frames.add(frame_index)
        for detection in detections:
            x1, y1, x2, y2 = detection.bbox
            x1 = max(0, min(self.width - 1, int(round(x1))))
            y1 = max(0, min(self.height - 1, int(round(y1))))
            x2 = max(x1 + 1, min(self.width, int(round(x2))))
            y2 = max(y1 + 1, min(self.height, int(round(y2))))
            self.total_boxes += 1
            if (y2 - y1) / max(x2 - x1, 1) > 1.54:
                continue
            if (y1 + y2) / 2.0 < self.height * self.top_ratio:
                continue
            self.frame_boxes[frame_index].append(
                ((x1, y1, x2, y2), self._rgb_block(image, x1, y1, x2, y2)))

    def _rgb_block(self, image, x1, y1, x2, y2):
        try:
            import cv2
            gray = cv2.cvtColor(image[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY).astype(np.float32)
            if gray.size == 0:
                return None
            kernel = max(3, int((y2 - y1) // 2) | 1)
            background = cv2.blur(gray, (kernel, kernel))
            contrast = np.abs(gray - background)
        except (ImportError, ValueError):
            return None
        means = gray.mean(axis=1)
        block = np.zeros((y2 - y1, 7), dtype=np.float64)
        block[:, 0] = x2 - x1
        block[:, 1] = (gray > 220).sum(axis=1)
        block[:, 2] = (gray < 40).sum(axis=1)
        block[:, 3] = contrast.sum(axis=1)
        block[:, 4] = means
        block[:, 5] = means ** 2
        block[:, 6] = 1
        return block

    @staticmethod
    def _time_span(frame_indices, fps, gap_seconds, step_seconds):
        if not frame_indices or fps <= 0:
            return 0.0
        times = sorted(set(frame_indices))
        seconds = [frame_index / fps for frame_index in times]
        total = 0.0
        start = previous = seconds[0]
        for current in seconds[1:]:
            if current - previous > gap_seconds:
                total += previous - start + step_seconds
                start = current
            previous = current
        return total + previous - start + step_seconds

    def _features(self, y0, y1):
        stats = self.row_stats[y0:y1 + 1]
        pixels = float(stats[:, 0].sum())
        if pixels <= 0:
            return 0.0, 0.0, 0.0, 0.0
        contrast = float(stats[:, 3].sum()) / pixels
        bimodal = float(stats[:, 1].sum() + stats[:, 2].sum()) / pixels
        seen = stats[:, 6] > 0
        if seen.any():
            means = stats[seen, 4] / stats[seen, 6]
            means2 = stats[seen, 5] / stats[seen, 6]
            variances = np.maximum(0.0, means2 - means ** 2)
            stability_rows = 1.0 / (1.0 + variances / 1000.0)
            stability = float(np.average(stability_rows, weights=stats[seen, 6]))
        else:
            stability = 0.0
        contrast_normalized = min(1.0, contrast / 64.0)
        rgb_score = 0.4 * contrast_normalized + 0.3 * bimodal + 0.3 * stability
        return (round(rgb_score, 4), round(contrast_normalized, 4),
                round(bimodal, 4), round(stability, 4))

    def finalize(self):
        self.coverage.fill(0)
        self.presence.clear()
        self.row_stats.fill(0)
        self.kept_boxes = 0
        for frame_index in sorted(self.frame_boxes):
            raw = self.frame_boxes[frame_index]
            for box, stats in raw:
                x1, y1, x2, y2 = [int(round(value)) for value in box]
                self.coverage[y1:y2, x1:x2] += 1
                for row in range(y1, y2):
                    self.presence[row].append(frame_index)
                self.kept_boxes += 1
                if stats is not None:
                    self.row_stats[box[1]:box[3]] += stats
        n_sampled = max(len(self.sampled_frames), 1)
        watermark_occurrence = max(1, int(round(self.config.roi_watermark_ratio * n_sampled)))
        watermark_mask = self.coverage >= watermark_occurrence
        watermark_pixels = int(watermark_mask.sum())
        filtered = self.coverage.copy()
        filtered[watermark_mask] = 0

        strict = filtered >= max(1, int(round(self.config.roi_strict_ratio * n_sampled)))
        relax = filtered >= max(1, int(round(self.config.roi_relax_ratio * n_sampled)))
        row_indices = np.where(strict.any(axis=1))[0]
        if row_indices.size:
            neighbor = min(int(round(self.config.roi_neighbor_height * self.height)),
                           int(row_indices[-1] - row_indices[0] + 1))
            dilated = np.zeros_like(strict)
            for offset in range(-neighbor, neighbor + 1):
                source_start = max(0, -offset)
                source_end = min(self.height, self.height - offset)
                target_start = source_start + offset
                target_end = source_end + offset
                dilated[target_start:target_end] |= strict[source_start:source_end]
            keep = strict | (dilated & relax)
        else:
            keep = strict
            neighbor = 0

        density = keep.sum(axis=1).astype(np.float64)
        peak = float(density.max()) if density.size else 0.0
        candidates = []
        if peak > 0:
            above = density >= peak * self.config.roi_band_density_ratio
            start = None
            for row, enabled in enumerate(np.r_[above, False]):
                if enabled and start is None:
                    start = row
                elif not enabled and start is not None:
                    candidates.append((start, row - 1))
                    start = None

        min_height = max(1, int(round(self.config.roi_band_min_height * self.height)))
        max_height = max(min_height, int(round(self.config.roi_band_max_height * self.height)))
        candidates = self._split_candidates(candidates, density, max_height)
        candidates = sorted(set(candidates))
        merged = []
        for y0, y1 in candidates:
            if (merged and y0 <= merged[-1][1] + 1 and
                    y1 - merged[-1][0] + 1 <= max_height):
                merged[-1] = (merged[-1][0], max(merged[-1][1], y1))
            else:
                merged.append((y0, y1))
        candidates = merged
        candidates = [band for band in candidates if band[1] - band[0] + 1 >= min_height]
        candidates = [band for band in candidates if band[0] >= int(self.height * 0.15)]

        video_duration = ((self.total_frames / self.fps) if self.total_frames and self.fps else
                          ((max(self.sampled_frames) + 1) / self.fps if self.fps else 0.0))
        video_duration = max(video_duration, 1e-6)
        scored = []
        for y0, y1 in candidates:
            frames = [frame for row in range(y0, y1 + 1) for frame in self.presence.get(row, ())]
            span = self._time_span(
                frames, self.fps, self.config.roi_time_gap_seconds,
                self.config.roi_interval / self.fps)
            rgb_score, contrast, bimodal, stability = self._features(y0, y1)
            scored.append((y0, y1, span / video_duration, rgb_score, contrast, bimodal, stability))
        eligible = [item for item in scored if item[4] >= self.config.roi_rgb_min_contrast and item[5] >= self.config.roi_rgb_min_bimodal]
        if not eligible:
            eligible = scored
        band = None
        selected_score_band = None
        if eligible:
            ratios = [item[2] for item in eligible]
            if max(ratios) - min(ratios) < 0.02:
                band = max(eligible, key=lambda item: item[3])
            else:
                band = max(eligible, key=lambda item: min(item[2], self.config.roi_span_soft_cap) * self.config.roi_span_weight + item[4] * self.config.roi_contrast_weight)
            band = (band[0], band[1])
            selected_score_band = band

        if band:
            y0, y1 = band
            band_frames = {frame for row in range(y0, y1 + 1) for frame in self.presence.get(row, ())}
            for row in range(max(0, y0 - neighbor), y0):
                row_frames = set(self.presence.get(row, ()))
                stats = self.row_stats[row]
                contrast = stats[3] / max(stats[0], 1.0)
                bimodal = (stats[1] + stats[2]) / max(stats[0], 1.0)
                if (density[row] > 0 and row_frames and row_frames & band_frames and
                        len(row_frames & band_frames) / len(row_frames) >= self.config.roi_dilation_overlap and
                        contrast >= self.config.roi_dilation_min_contrast and
                        bimodal >= self.config.roi_dilation_min_bimodal):
                    y0 = min(y0, row)
            for row in range(y1 + 1, min(self.height, y1 + neighbor + 1)):
                row_frames = set(self.presence.get(row, ()))
                stats = self.row_stats[row]
                contrast = stats[3] / max(stats[0], 1.0)
                bimodal = (stats[1] + stats[2]) / max(stats[0], 1.0)
                if (density[row] > 0 and row_frames and row_frames & band_frames and
                        len(row_frames & band_frames) / len(row_frames) >= self.config.roi_dilation_overlap and
                        contrast >= self.config.roi_dilation_min_contrast and
                        bimodal >= self.config.roi_dilation_min_bimodal):
                    y1 = row
            main_band = [y0, y1]
            center = (y0 + y1) / 2.0
            expanded_height = (y1 - y0 + 1) * self.config.roi_expand_ratio
            y0 = max(0, int(round(center - expanded_height / 2.0)))
            y1 = min(self.height, int(round(center + expanded_height / 2.0)))
            region = [0.0, round(y0 / self.height, 6), 1.0, round(y1 / self.height, 6)]
            pixel_range = [0, y0, self.width, y1]
            span_ratio = next((item[2] for item in scored
                               if item[:2] == selected_score_band), 0.0)
        else:
            region = [0.0, self.top_ratio, 1.0, 1.0]
            pixel_range = []
            main_band = []
            span_ratio = 0.0

        return {
            "selected_region": region,
            "pixel_range": pixel_range,
            "main_band": main_band,
            "candidate_bands": [list(item) for item in scored],
            "time_span_ratio": round(float(span_ratio), 4),
            "n_sampled_frames": len(self.sampled_frames),
            "n_det_boxes": self.total_boxes,
            "n_kept_boxes": self.kept_boxes,
            "watermark_pixels": watermark_pixels,
            "watermark_occurrence": watermark_occurrence,
            "strict_occurrence": max(1, int(round(self.config.roi_strict_ratio * n_sampled))),
            "relax_occurrence": max(1, int(round(self.config.roi_relax_ratio * n_sampled))),
            "peak_density": round(peak, 2),
        }

    @staticmethod
    def _split_candidates(candidates, density, max_height):
        output = []
        stack = list(candidates)
        while stack:
            y0, y1 = stack.pop()
            if y1 - y0 + 1 <= max_height:
                output.append((y0, y1))
                continue
            low = y0 + 4
            high = y1 - 4
            segment = density[y0:y1 + 1]
            if low > high or segment.max() == segment.min():
                peak = y0 + int(np.argmax(segment))
                half = (max_height - 1) // 2
                output.append((max(y0, peak - half), min(y1, peak + half)))
                continue
            cut = low + int(np.argmin(density[low:high + 1]))
            stack.append((y0, cut - 1))
            stack.append((cut + 1, y1))
        return sorted(set(output))
