from concurrent import futures
from typing import Optional

from .backends import (OCRBackend, PaddleOCRBackend, SubtleOnnxBackend,
                       crop_roi, offset_detections)
from .auto_roi import AutoROICollector, merge_boxes
from .models import (Detection, FrameResult, LANGUAGE_RECOGNIZERS, OCRConfig,
                     V6_LANGUAGES, width_mode_for_language)
from .postprocess import build_cues, build_cues_a3, build_cues_f1
from .video import iter_video_frames


# 自动选框只扫画面下半部分，跳过多少由**内容纵横比**决定（``content_width`` 已
# 去掉左右黑边）：横屏字幕基本贴着底部，竖屏（含方屏）字幕常常顶得比较高，所以
# 只丢最上面那一小条。旧版竖屏写死 0.40，靠近上部的字幕会被整段切掉。
ROI_WIDE_ASPECT = 1.2
ROI_TOP_RATIO_WIDE = 0.70
ROI_TOP_RATIO_TALL = 0.10


def roi_top_ratio(content_width: float, height: float) -> float:
    """从画面上方往下跳过多少比例（竖屏 / 方屏 0.10，横屏 0.70）。"""
    if height > 0 and content_width / height >= ROI_WIDE_ASPECT:
        return ROI_TOP_RATIO_WIDE
    return ROI_TOP_RATIO_TALL


class ExtractionCancelled(RuntimeError):
    """Raised internally when a caller-requested stop interrupts extraction."""


class _ProgressReporter:
    """Throttled progress bridge plus cooperative cancellation.

    ``callback`` receives ``(percent, message)`` with a monotonic percent in
    the 0..100 range.  ``should_stop`` is polled between frames so callers can
    abort a long extraction without waiting for it to finish.
    """

    def __init__(self, callback=None, should_stop=None):
        self._callback = callback
        self._should_stop = should_stop
        self._total = 1
        self._last = -1
        self._floor = 0
        self._ceil = 100

    def set_total(self, total) -> None:
        try:
            self._total = max(1, int(total))
        except (TypeError, ValueError):
            self._total = 1

    def set_span(self, floor: int, ceil: int) -> None:
        self._floor = max(0, min(100, int(floor)))
        self._ceil = max(self._floor, min(100, int(ceil)))

    def check_stop(self) -> None:
        if self._should_stop is not None and self._should_stop():
            raise ExtractionCancelled()

    def report(self, frame_index: int, message: str = "正在识别字幕") -> None:
        if self._callback is None:
            return
        fraction = min(1.0, max(0.0, (int(frame_index) + 1) / self._total))
        percent = int(round(self._floor + fraction * (self._ceil - self._floor)))
        percent = max(self._last, percent)
        if percent == self._last:
            return
        self._last = percent
        self._callback(percent, message)

    def finish(self, message: str = "正在整理字幕结果") -> None:
        if self._callback is None or self._last >= 100:
            return
        self._last = 100
        self._callback(100, message)


class SubtitleOCR:
    def __init__(self, backend: OCRBackend, config: Optional[OCRConfig] = None):
        self.backend = backend
        self.config = config or OCRConfig()

    def extract(self, video_path: str, progress_callback=None, should_stop=None):
        reporter = _ProgressReporter(progress_callback, should_stop)
        if self.config.det_first:
            if self.config.single_pass:
                return self._extract_det_first_single_pass(video_path, reporter)
            return self._extract_det_first(video_path, reporter)
        if (self.config.single_pass and self.config.auto_roi and
                self.config.roi is None):
            return self._extract_regular_single_pass_auto_roi(video_path, reporter)
        if self.config.postprocess_mode == "f1":
            metadata, frames = iter_video_frames(
                video_path, sample_fps=None,
                frame_interval=self.config.ocr_interval,
            )
        else:
            metadata, frames = iter_video_frames(video_path, self.config.sample_fps)
        reporter.set_total(metadata.get("frame_count"))
        selected_roi = self.config.roi
        roi_stats = None
        if selected_roi is None and self.config.auto_roi:
            selected_roi, roi_stats = self._detect_roi(video_path, metadata)
        frame_results = []
        for frame_index, timestamp_ms, image in frames:
            reporter.check_stop()
            if selected_roi is None:
                cropped, offset = image, (0, 0, image.shape[1], image.shape[0])
            else:
                cropped, offset = crop_roi(image, selected_roi)
            detections = offset_detections(
                self.backend.detect_and_recognize(cropped), offset)
            frame_results.append(FrameResult(frame_index, timestamp_ms, detections))
            reporter.report(frame_index)
        metadata["selected_roi"] = selected_roi
        if roi_stats is not None:
            metadata["auto_roi"] = roi_stats
        metadata["single_pass"] = True
        metadata["decoded_passes"] = 1
        metadata["ocr_interval"] = self.config.ocr_interval
        metadata["pre_scan_interval"] = self.config.pre_scan_interval
        metadata["formal_ocr_interval"] = self.config.formal_ocr_interval
        metadata["postprocess_mode"] = self.config.postprocess_mode
        reporter.finish()
        cues = self._build_cues(frame_results, metadata)
        return metadata, frame_results, cues

    def _extract_regular_single_pass_auto_roi(self, video_path: str,
                                              reporter=None):
        reporter = reporter or _ProgressReporter()
        metadata, frames = iter_video_frames(
            video_path,
            sample_fps=self.config.sample_fps,
            frame_interval=(1 if self.config.postprocess_mode == "f1" else None),
        )
        reporter.set_total(metadata.get("frame_count"))
        content_bounds, top_ratio = self._detect_content_bounds(video_path, metadata)
        detector_roi = [
            content_bounds[0] / metadata["width"], top_ratio,
            content_bounds[1] / metadata["width"], 1.0,
        ]
        collector = AutoROICollector(
            metadata["width"], metadata["height"], metadata["fps"],
            self.config, content_bounds=content_bounds,
            top_ratio=top_ratio, total_frames=metadata["frame_count"],
        )
        frame_results = []
        for frame_index, timestamp_ms, image in frames:
            reporter.check_stop()
            roi_sample = frame_index % max(1, self.config.pre_scan_interval) == 0
            output_sample = (
                frame_index % max(1, self.config.ocr_interval) == 0
                if self.config.postprocess_mode == "f1" else True
            )
            if not roi_sample and not output_sample:
                continue
            detection_image, offset = crop_roi(image, detector_roi)
            detections = offset_detections(
                self.backend.detect_and_recognize(detection_image), offset)
            if roi_sample:
                collector.collect(frame_index, image, detections)
            if output_sample:
                frame_results.append(FrameResult(frame_index, timestamp_ms, detections))
            reporter.report(frame_index)

        roi_stats = collector.finalize()
        roi_stats["content_bounds"] = list(collector.content_bounds)
        roi_stats["top_ratio"] = collector.top_ratio
        selected_roi = roi_stats["selected_region"]
        selected_pixels = self._roi_pixels(selected_roi, metadata)
        dropped_boxes = 0
        for frame_result in frame_results:
            kept = []
            for detection in frame_result.detections:
                center_x = (detection.bbox[0] + detection.bbox[2]) / 2.0
                center_y = (detection.bbox[1] + detection.bbox[3]) / 2.0
                if (selected_pixels[0] <= center_x <= selected_pixels[2] and
                        selected_pixels[1] <= center_y <= selected_pixels[3]):
                    kept.append(detection)
                else:
                    dropped_boxes += 1
            frame_result.detections = kept

        metadata["selected_roi"] = selected_roi
        metadata["auto_roi"] = roi_stats
        metadata["single_pass"] = True
        metadata["decoded_passes"] = 1
        metadata["detection_frames"] = len(frame_results)
        metadata["recognized_boxes"] = sum(
            len(frame_result.detections) for frame_result in frame_results)
        metadata["roi_dropped_boxes"] = dropped_boxes
        metadata["ocr_interval"] = self.config.ocr_interval
        metadata["pre_scan_interval"] = self.config.pre_scan_interval
        metadata["formal_ocr_interval"] = self.config.formal_ocr_interval
        metadata["postprocess_mode"] = self.config.postprocess_mode
        reporter.finish()
        cues = self._build_cues(frame_results, metadata)
        return metadata, frame_results, cues

    def _extract_det_first(self, video_path: str, reporter=None):
        reporter = reporter or _ProgressReporter()
        metadata, frames = iter_video_frames(video_path, sample_fps=None,
                                             frame_interval=1)
        reporter.set_total(metadata.get("frame_count"))
        reporter.set_span(0, 50)
        selected_roi = self.config.roi
        collector = None
        roi_stats = None
        if selected_roi is None and self.config.auto_roi:
            content_bounds, top_ratio = self._detect_content_bounds(video_path, metadata)
            detector_roi = [
                content_bounds[0] / metadata["width"], top_ratio,
                content_bounds[1] / metadata["width"], 1.0,
            ]
            collector = AutoROICollector(
                metadata["width"], metadata["height"], metadata["fps"],
                self.config, content_bounds=content_bounds,
                top_ratio=top_ratio, total_frames=metadata["frame_count"])
        else:
            detector_roi = selected_roi

        if self.config.postprocess_mode == "f1":
            main_interval = max(1, int(self.config.ocr_interval))
        else:
            main_interval = max(1, round(metadata["fps"] / self.config.sample_fps))
        boxes_by_frame = {}
        detection_frames = 0
        max_workers = max(1, int(self.config.det_workers))
        pending = {}
        window = max(max_workers * 2, 4)
        with futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            for frame_index, _, image in frames:
                reporter.check_stop()
                roi_sample = (collector is not None and
                              frame_index % self.config.roi_interval == 0)
                output_sample = frame_index % main_interval == 0
                if not roi_sample and not output_sample:
                    continue
                future = executor.submit(
                    self._detect_frame, image, detector_roi, metadata)
                pending[future] = (frame_index, image, roi_sample, output_sample)
                reporter.report(frame_index, "正在检测字幕区域")
                if len(pending) >= window:
                    done, _ = futures.wait(
                        pending, return_when=futures.FIRST_COMPLETED)
                    detection_frames += self._collect_detection_futures(
                        done, pending, collector, boxes_by_frame)
            for future in futures.as_completed(tuple(pending)):
                reporter.check_stop()
                detection_frames += self._collect_detection_futures(
                    (future,), pending, collector, boxes_by_frame)

        if collector is not None:
            roi_stats = collector.finalize()
            roi_stats["content_bounds"] = list(collector.content_bounds)
            roi_stats["top_ratio"] = collector.top_ratio
            selected_roi = roi_stats["selected_region"]

        selected_pixels = self._roi_pixels(selected_roi, metadata)
        required = set(boxes_by_frame)
        last_required = max(required, default=-1)
        recognized_frames = []
        recognized_boxes = 0
        dropped_boxes = 0
        _, decode_frames = iter_video_frames(video_path, sample_fps=None,
                                             frame_interval=1)
        reporter.set_span(50, 100)
        reporter.set_total(max(1, last_required + 1))
        for frame_index, timestamp_ms, image in decode_frames:
            reporter.check_stop()
            if frame_index > last_required:
                break
            if frame_index not in required:
                continue
            detections = []
            for detection in boxes_by_frame[frame_index]:
                center_x = (detection.bbox[0] + detection.bbox[2]) / 2.0
                center_y = (detection.bbox[1] + detection.bbox[3]) / 2.0
                if (self.config.filter_to_selected_roi and selected_pixels is not None and not
                        (selected_pixels[0] <= center_x <= selected_pixels[2] and
                         selected_pixels[1] <= center_y <= selected_pixels[3])):
                    dropped_boxes += 1
                    continue
                detections.append(detection)
            recognized = self.backend.recognize(image, detections)
            recognized_boxes += len(recognized)
            recognized_frames.append(FrameResult(frame_index, timestamp_ms, recognized))
            reporter.report(frame_index)

        metadata["selected_roi"] = selected_roi
        metadata["det_first"] = {
            "enabled": True,
            "detection_frames": detection_frames,
            "stored_output_frames": len(boxes_by_frame),
            "recognized_boxes": recognized_boxes,
            "roi_dropped_boxes": dropped_boxes,
        }
        if roi_stats is not None:
            metadata["auto_roi"] = roi_stats
        metadata["ocr_interval"] = main_interval
        metadata["pre_scan_interval"] = self.config.pre_scan_interval
        metadata["formal_ocr_interval"] = main_interval
        metadata["postprocess_mode"] = self.config.postprocess_mode
        reporter.finish()
        cues = self._build_cues(recognized_frames, metadata)
        return metadata, recognized_frames, cues

    def _extract_det_first_single_pass(self, video_path: str, reporter=None):
        reporter = reporter or _ProgressReporter()
        metadata, frames = iter_video_frames(
            video_path, sample_fps=None, frame_interval=1,
        )
        reporter.set_total(metadata.get("frame_count"))
        selected_roi = self.config.roi
        collector = None
        roi_stats = None
        if selected_roi is None and self.config.auto_roi:
            content_bounds, top_ratio = self._detect_content_bounds(video_path, metadata)
            detector_roi = [
                content_bounds[0] / metadata["width"], top_ratio,
                content_bounds[1] / metadata["width"], 1.0,
            ]
            collector = AutoROICollector(
                metadata["width"], metadata["height"], metadata["fps"],
                self.config, content_bounds=content_bounds,
                top_ratio=top_ratio, total_frames=metadata["frame_count"],
            )
        else:
            detector_roi = selected_roi

        main_interval = (
            max(1, int(self.config.ocr_interval))
            if self.config.postprocess_mode == "f1"
            else max(1, round(metadata["fps"] / self.config.sample_fps))
        )
        selected_pixels = self._roi_pixels(selected_roi, metadata)
        pending = {}
        recognized_by_frame = {}
        detection_frames = 0
        recognized_boxes = 0
        roi_dropped_boxes = 0
        max_workers = max(1, int(self.config.det_workers))
        window = max(max_workers * 2, 4)

        def collect(done):
            nonlocal detection_frames, recognized_boxes, roi_dropped_boxes
            for future in done:
                reporter.check_stop()
                frame_index, timestamp_ms, image, roi_sample, output_sample = pending.pop(future)
                detections = future.result()
                if roi_sample and collector is not None:
                    collector.collect(frame_index, image, detections)
                detection_frames += 1
                if not output_sample:
                    reporter.report(frame_index)
                    continue
                current_detections = detections
                if self.config.filter_to_selected_roi and selected_pixels is not None:
                    current_detections = []
                    for detection in detections:
                        center_x = (detection.bbox[0] + detection.bbox[2]) / 2.0
                        center_y = (detection.bbox[1] + detection.bbox[3]) / 2.0
                        if (selected_pixels[0] <= center_x <= selected_pixels[2] and
                                selected_pixels[1] <= center_y <= selected_pixels[3]):
                            current_detections.append(detection)
                        else:
                            roi_dropped_boxes += 1
                recognized = self.backend.recognize(image, current_detections)
                recognized_boxes += len(recognized)
                recognized_by_frame[frame_index] = FrameResult(
                    frame_index, timestamp_ms, recognized,
                )
                reporter.report(frame_index)

        with futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            for frame_index, timestamp_ms, image in frames:
                reporter.check_stop()
                roi_sample = (
                    collector is not None and
                    frame_index % max(1, self.config.pre_scan_interval) == 0
                )
                output_sample = frame_index % main_interval == 0
                if not roi_sample and not output_sample:
                    continue
                future = executor.submit(
                    self._detect_frame, image, detector_roi, metadata,
                )
                pending[future] = (
                    frame_index, timestamp_ms, image, roi_sample, output_sample,
                )
                if len(pending) >= window:
                    done, _ = futures.wait(
                        pending, return_when=futures.FIRST_COMPLETED,
                    )
                    collect(done)
            for future in futures.as_completed(tuple(pending)):
                collect((future,))

        if collector is not None:
            roi_stats = collector.finalize()
            roi_stats["content_bounds"] = list(collector.content_bounds)
            roi_stats["top_ratio"] = collector.top_ratio
            selected_roi = roi_stats["selected_region"]
            selected_pixels = self._roi_pixels(selected_roi, metadata)

            if self.config.filter_to_selected_roi:
                for frame_result in recognized_by_frame.values():
                    kept = []
                    for detection in frame_result.detections:
                        center_x = (detection.bbox[0] + detection.bbox[2]) / 2.0
                        center_y = (detection.bbox[1] + detection.bbox[3]) / 2.0
                        if (selected_pixels[0] <= center_x <= selected_pixels[2] and
                                selected_pixels[1] <= center_y <= selected_pixels[3]):
                            kept.append(detection)
                        else:
                            roi_dropped_boxes += 1
                    frame_result.detections = kept

        recognized_frames = [
            recognized_by_frame[index]
            for index in sorted(recognized_by_frame)
        ]
        metadata["selected_roi"] = selected_roi
        metadata["det_first"] = {
            "enabled": True,
            "single_pass": True,
            "decoded_passes": 1,
            "detection_frames": detection_frames,
            "stored_output_frames": len(recognized_by_frame),
            "recognized_boxes": recognized_boxes,
            "roi_dropped_boxes": roi_dropped_boxes,
        }
        if roi_stats is not None:
            metadata["auto_roi"] = roi_stats
        metadata["ocr_interval"] = main_interval
        metadata["pre_scan_interval"] = self.config.pre_scan_interval
        metadata["formal_ocr_interval"] = main_interval
        metadata["postprocess_mode"] = self.config.postprocess_mode
        reporter.finish()
        cues = self._build_cues(recognized_frames, metadata)
        return metadata, recognized_frames, cues

    def _build_cues(self, frame_results, metadata):
        if self.config.postprocess_mode == "f1":
            return build_cues_f1(frame_results, self.config, metadata)
        if self.config.postprocess_mode == "a3":
            return build_cues_a3(frame_results, self.config, metadata)
        return build_cues(frame_results, self.config)

    def _detect_frame(self, image, detector_roi, metadata):
        if detector_roi is None:
            detection_image = image
            offset = (0, 0, image.shape[1], image.shape[0])
        else:
            detection_image, offset = crop_roi(image, detector_roi)
        detections = offset_detections(
            self.backend.detect(detection_image), offset)
        return self._prepare_detections(detections, metadata)

    @staticmethod
    def _collect_detection_futures(done, pending, collector, boxes_by_frame):
        count = 0
        for future in done:
            frame_index, image, roi_sample, output_sample = pending.pop(future)
            detections = future.result()
            if roi_sample:
                collector.collect(frame_index, image, detections)
            if output_sample:
                boxes_by_frame[frame_index] = detections
            count += 1
        return count

    @staticmethod
    def _prepare_detections(detections, metadata):
        min_width = max(1.0, (4.0 / 1080.0) * metadata["width"])
        min_height = max(1.0, (19.0 / 1920.0) * metadata["height"])
        filtered = [
            detection for detection in detections
            if (detection.bbox[2] - detection.bbox[0] > 0 and
                detection.bbox[3] - detection.bbox[1] > 0 and
                (detection.bbox[3] - detection.bbox[1]) /
                max(detection.bbox[2] - detection.bbox[0], 1.0) <= 1.54 and
                detection.bbox[2] - detection.bbox[0] >= min_width and
                detection.bbox[3] - detection.bbox[1] >= min_height)
        ]
        if not filtered:
            return []
        merged = merge_boxes([detection.bbox for detection in filtered])
        score = max(detection.score for detection in filtered)
        return [
            Detection(
                bbox,
                "",
                score,
                ((bbox[0], bbox[1]), (bbox[2], bbox[1]),
                 (bbox[2], bbox[3]), (bbox[0], bbox[3])),
            )
            for bbox in merged
        ]

    @staticmethod
    def _roi_pixels(roi, metadata):
        if roi is None:
            return None
        return (
            int(round(roi[0] * metadata["width"])),
            int(round(roi[1] * metadata["height"])),
            int(round(roi[2] * metadata["width"])),
            int(round(roi[3] * metadata["height"])),
        )

    def _detect_roi(self, video_path, metadata):
        scan_config = self.config
        content_bounds, top_ratio = self._detect_content_bounds(video_path, metadata)
        collector = AutoROICollector(metadata["width"], metadata["height"],
                                     metadata["fps"], scan_config,
                                     content_bounds=content_bounds,
                                     top_ratio=top_ratio,
                                     total_frames=metadata["frame_count"])
        # subtle 的正式 pre-ROI 是按原视频帧号每 roi_interval 帧统计，
        # 不是先降到 2 FPS 再抽帧。这里保持相同口径。
        _, frames = iter_video_frames(video_path, sample_fps=None,
                                      frame_interval=scan_config.roi_interval)
        for frame_index, _, image in frames:
            detections = self.backend.detect_and_recognize(image)
            collector.collect(frame_index, image, detections)
        stats = collector.finalize()
        stats["content_bounds"] = list(content_bounds)
        stats["top_ratio"] = top_ratio
        return stats["selected_region"], stats

    @staticmethod
    def _detect_content_bounds(video_path, metadata, sample_frames=5,
                               black_threshold=24.0,
                               min_bar_ratio=0.02):
        try:
            import cv2
            import numpy as np
            capture = cv2.VideoCapture(video_path)
            total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            indexes = ([min(total - 1, i * max(1, total // sample_frames))
                        for i in range(sample_frames)] if total else [0])
            columns = []
            for index in indexes:
                capture.set(cv2.CAP_PROP_POS_FRAMES, index)
                ok, frame = capture.read()
                if ok:
                    columns.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean(axis=0))
            capture.release()
            if not columns:
                return (0, metadata["width"]), roi_top_ratio(
                    metadata["width"], metadata["height"])
            means = np.mean(columns, axis=0)
            left = 0
            while left < len(means) and means[left] < black_threshold:
                left += 1
            right = len(means)
            while right > 0 and means[right - 1] < black_threshold:
                right -= 1
            bar_min = metadata["width"] * min_bar_ratio
            if left < bar_min or metadata["width"] - right < bar_min:
                left, right = 0, metadata["width"]
            content_width = max(1, right - left)
            top_ratio = roi_top_ratio(content_width, metadata["height"])
            return (left, right), top_ratio
        except (ImportError, ValueError, OSError):
            return (0, metadata["width"]), roi_top_ratio(
                metadata["width"], metadata["height"])


def create_paddle_pipeline(language="ch", config=None, **kwargs):
    return SubtitleOCR(PaddleOCRBackend(language=language, **kwargs), config=config)


def create_subtle_backend(language="ch", **kwargs):
    """Build the bundled ONNX backend (detector + recognizer sessions).

    Split out of :func:`create_subtle_pipeline` so a host can build the
    expensive sessions once and hand the same backend to many pipelines (see
    ``RealOcrEngine.warm``).  Creating a session is also the moment
    onnxruntime loads its provider DLLs, which must not happen for the first
    time on a worker thread while the host's main thread is parked in a
    blocking read - Windows deadlocks inside the loader lock when it does.
    """
    normalised = str(language or "ch").lower()
    recognizer = str(kwargs.get("recognizer") or "v6_small").lower()
    # A language with its own head always wins over the generic default.
    recognizer = LANGUAGE_RECOGNIZERS.get(normalised, recognizer)
    kwargs["recognizer"] = recognizer
    kwargs["width_mode"] = (
        kwargs.get("width_mode") or width_mode_for_language(normalised))
    # The v6 dictionary is multilingual, so every code in ``V6_LANGUAGES``
    # runs on the bundled recognizer; the legacy v5 head is Chinese-only.
    supported = {"ch", "zh"}
    if recognizer.startswith("v6"):
        supported |= set(V6_LANGUAGES) | {"english"}
    supported |= {code for code, profile in LANGUAGE_RECOGNIZERS.items()
                  if profile == recognizer}
    if normalised not in supported:
        raise ValueError(
            f"The bundled {recognizer} recognizer does not support language "
            f"'{language}'; use the PaddleOCR backend (--backend paddle) instead."
        )
    return SubtleOnnxBackend(**kwargs)


def create_subtle_pipeline(language="ch", config=None, backend_instance=None,
                           **kwargs):
    backend = (backend_instance if backend_instance is not None
               else create_subtle_backend(language, **kwargs))
    return SubtitleOCR(backend, config=config)


def create_pipeline(language="ch", config=None, backend="subtle-v5", **kwargs):
    if config is None:
        config = OCRConfig.for_language(language)
    if backend == "subtle-v5":
        return create_subtle_pipeline(language=language, config=config, **kwargs)
    if backend == "paddle":
        kwargs.pop("recognition_threshold", None)
        kwargs.pop("device", None)
        kernel = {"recognizer", "num_threads", "width_mode"}
        for key in kernel:
            kwargs.pop(key, None)
        return create_paddle_pipeline(language=language, config=config, **kwargs)
    raise ValueError(f"Unsupported OCR backend: {backend}")
