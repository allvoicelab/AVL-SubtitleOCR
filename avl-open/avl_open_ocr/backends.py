import importlib.util
import math
import re
import threading
from pathlib import Path
from typing import Any, List

import cv2
import numpy as np

from .models import Detection
from .providers import (apply_provider_options, onnx_providers,
                        serialize_runs)


_TARGET_HEIGHT = 48
_STATIC_WIDTH = 320
_DYNAMIC_MAX_WIDTH = 2048


def _normalize_width_mode(value):
    mode = str(value or "dynamic").strip().lower()
    if mode not in ("static", "dynamic"):
        raise ValueError(
            f"Unsupported recognizer width mode: {value}. "
            "Choose 'static' or 'dynamic'."
        )
    return mode


class OCRBackend:
    """Backend interface. Implementations return frame-level detections."""

    def detect_and_recognize(self, image):
        raise NotImplementedError

    def detect(self, image):
        return self.detect_and_recognize(image)

    def recognize(self, image, detections):
        return detections


class SubtleOnnxBackend(OCRBackend):
    """Bundled subtle detector plus a PaddleOCR ONNX recognizer.

    ``recognizer`` selects a bundled recognizer profile (``v5``,
    ``v6_small`` or ``v6_tiny``); explicit ``recognizer_path``/``vocab_path``
    still override the profile.  ``num_threads`` caps the ONNX Runtime intra-op
    thread pool so background OCR does not saturate the desktop CPU.
    """

    _RECOGNIZERS = {
        "v5": ("paddle_v5_rec_sft.onnx", "paddle_v5_dict.txt"),
        "v6_small": ("paddle_v6_rec_small.onnx", "paddle_v6_dict.txt"),
        "v6_tiny": ("paddle_v6_rec_tiny.onnx", "paddle_v6_tiny_dict.txt"),
        # PP-OCRv5 mobile Korean, exported from the Paddle PIR weights with
        # paddle2onnx (see model_files/korean_PP-OCRv5_mobile_rec_infer).
        "korean_v5": ("korean_PP-OCRv5_mobile_rec.onnx", "korean_v5_dict.txt"),
    }

    def __init__(self, detector_path=None, recognizer_path=None, vocab_path=None,
                 recognition_threshold=0.38, device="cpu", num_threads=None,
                 recognizer="v6_small", width_mode="dynamic"):
        from .subtle_detector import SubtleOnnxDetector

        model_root = Path(__file__).parent / "model_files"
        providers = onnx_providers(device)
        profile = self._RECOGNIZERS.get(str(recognizer or "v6_small").lower())
        if profile is None:
            raise ValueError(
                f"Unsupported recognizer profile: {recognizer}. "
                f"Choose one of {', '.join(sorted(self._RECOGNIZERS))}."
            )
        default_model, default_vocab = profile
        self.detector = SubtleOnnxDetector(
            model_path=detector_path, providers=providers,
            num_threads=num_threads,
        )
        self.recognizer = _SubtleV5Recognizer(
            recognizer_path or model_root / default_model,
            vocab_path or model_root / default_vocab,
            recognition_threshold,
            providers,
            num_threads=num_threads,
            width_mode=width_mode,
        )
        # GPU execution: one ONNX Runtime call at a time (see
        # providers.serialize_runs) - concurrent DML runs hang the device.
        self._run_lock = threading.Lock() if serialize_runs(providers) else None

    def detect_and_recognize(self, image) -> List[Detection]:
        return self.recognize(image, self.detect(image))

    def detect(self, image) -> List[Detection]:
        if self._run_lock is None:
            return self.detector.detect(image)
        with self._run_lock:
            return self.detector.detect(image)

    def recognize(self, image, detections) -> List[Detection]:
        if self._run_lock is None:
            return self.recognizer.recognize(image, detections)
        with self._run_lock:
            return self.recognizer.recognize(image, detections)


class _SubtleV5Recognizer:
    def __init__(self, model_path, vocab_path, threshold, providers,
                 num_threads=None, width_mode="dynamic"):
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise RuntimeError("onnxruntime is required for the subtle-v5 backend") from error
        model_path = Path(model_path)
        vocab_path = Path(vocab_path)
        if not model_path.exists():
            raise FileNotFoundError(f"Subtle recognizer model not found: {model_path}")
        if not vocab_path.exists():
            raise FileNotFoundError(f"Subtle recognizer vocabulary not found: {vocab_path}")
        session_options = ort.SessionOptions()
        session_options.inter_op_num_threads = 1
        # 只留 ERROR 以上：paddle2onnx 转换出来的识别头会打十几条
        # "Removing initializer ..." 警告（带 ANSI 转义），宿主会把 stderr
        # 整份收进日志，噪音比信息多。
        session_options.log_severity_level = 3
        apply_provider_options(session_options, providers)
        if num_threads:
            session_options.intra_op_num_threads = max(1, int(num_threads))
        self.session = ort.InferenceSession(
            str(model_path), sess_options=session_options, providers=providers,
        )
        self.input_name = self.session.get_inputs()[0].name
        characters = vocab_path.read_text(encoding="utf-8").splitlines()
        self.characters = ["blank", *characters, " "]
        self.threshold = threshold
        self.width_mode = _normalize_width_mode(width_mode)

    def recognize(self, image, detections):
        output = []
        for detection in detections:
            crop = _perspective_crop(
                image, detection.polygon or _bbox_polygon(detection.bbox),
            )
            if crop.size == 0:
                continue
            prediction = self.session.run(
                None, {self.input_name: self._preprocess(crop, self.width_mode)},
            )[0]
            text, score = self._decode(prediction)
            text = re.sub(r"[◎※∞△]", "", text)
            if score >= self.threshold and text:
                output.append(Detection(
                    detection.bbox, text, score, detection.polygon,
                ))
        return output

    @staticmethod
    def _preprocess(image, width_mode="dynamic"):
        mode = _normalize_width_mode(width_mode)
        target_height = _TARGET_HEIGHT
        height, width = image.shape[:2]
        natural_width = max(
            1, int(math.ceil(target_height * width / max(height, 1))),
        )
        if mode == "static":
            target_width = _STATIC_WIDTH
        else:
            target_width = min(
                _DYNAMIC_MAX_WIDTH, max(_STATIC_WIDTH, natural_width))
        resized_width = min(natural_width, target_width)
        resized = cv2.resize(image, (resized_width, target_height))
        normalized = resized.astype(np.float32) / 255.0
        normalized = (normalized - 0.5) / 0.5
        if resized_width == target_width:
            padded = normalized
        else:
            padded = np.zeros((target_height, target_width, 3), dtype=np.float32)
            padded[:, :resized_width] = normalized
        return padded.transpose(2, 0, 1)[None]

    def _decode(self, prediction):
        indexes = prediction.argmax(axis=2)[0]
        probabilities = prediction.max(axis=2)[0]
        characters = []
        scores = []
        previous = None
        for index, probability in zip(indexes, probabilities):
            index = int(index)
            if index != 0 and index != previous and index < len(self.characters):
                characters.append(self.characters[index])
                scores.append(float(probability))
            previous = index
        return "".join(characters), float(np.mean(scores)) if scores else 0.0


def _perspective_crop(image, polygon):
    points = np.asarray(polygon, dtype=np.float32)
    width = max(
        np.linalg.norm(points[0] - points[1]),
        np.linalg.norm(points[2] - points[3]),
    )
    height = max(
        np.linalg.norm(points[0] - points[3]),
        np.linalg.norm(points[1] - points[2]),
    )
    width = max(1, int(width))
    height = max(1, int(height))
    destination = np.float32(
        [[0, 0], [width, 0], [width, height], [0, height]],
    )
    matrix = cv2.getPerspectiveTransform(points, destination)
    crop = cv2.warpPerspective(
        image, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE,
        flags=cv2.INTER_CUBIC,
    )
    if crop.shape[0] / max(crop.shape[1], 1) >= 1.5:
        crop = np.rot90(crop)
    return crop


def _onnx_providers(device):
    """兼容旧调用：设备解析统一挪到 :mod:`.providers`。"""
    return onnx_providers(device)


class PaddleOCRBackend(OCRBackend):
    """Adapter for PaddleOCR 2.x and 3.x style APIs."""

    def __init__(self, language: str = "ch", use_angle_cls: bool = False, **kwargs):
        detector_type = kwargs.pop("detector_type", "subtle")
        if importlib.util.find_spec("paddleocr") is None:
            raise RuntimeError(
                "PaddleOCR is not installed. Install with: "
                "pip install avl-open-ocr[paddleocr]"
            )
        from paddleocr import PaddleOCR

        kwargs.setdefault("enable_mkldnn", False)
        kwargs.setdefault("use_doc_orientation_classify", False)
        kwargs.setdefault("use_doc_unwarping", False)
        kwargs.setdefault("use_textline_orientation", use_angle_cls)
        try:
            self.ocr = PaddleOCR(lang=language, **kwargs)
        except ValueError:
            # PaddleOCR 2.x does not know the 3.x pipeline options.
            legacy = dict(kwargs)
            for key in ("enable_mkldnn", "use_doc_orientation_classify",
                        "use_doc_unwarping", "use_textline_orientation"):
                legacy.pop(key, None)
            self.ocr = PaddleOCR(lang=language, use_angle_cls=use_angle_cls, **legacy)
        pipeline = getattr(getattr(self.ocr, "paddlex_pipeline", None), "_pipeline", None)
        self._detector = getattr(pipeline, "text_det_model", None)
        self._recognizer = getattr(pipeline, "text_rec_model", None)
        self._cropper = getattr(pipeline, "_crop_by_polys", None)
        if detector_type == "subtle":
            from .subtle_detector import SubtleOnnxDetector
            self._split_detector = SubtleOnnxDetector()
        else:
            self._split_detector = None

    def detect_and_recognize(self, image) -> List[Detection]:
        if self._detector is not None and self._recognizer is not None:
            return self.recognize(image, self.detect(image))
        result = None
        if hasattr(self.ocr, "predict"):
            result = self.ocr.predict(image)
        else:
            result = self.ocr.ocr(image, cls=False)
        return _parse_paddle_result(result)

    def detect(self, image) -> List[Detection]:
        if self._split_detector is not None:
            return self._split_detector.detect(image)
        if self._detector is None:
            return super().detect(image)
        results = list(self._detector.predict([image]))
        if not results:
            return []
        result = results[0]
        polygons = result.get("dt_polys", [])
        scores = result.get("dt_scores", [])
        detections = []
        for index, polygon in enumerate(polygons):
            points = tuple((float(point[0]), float(point[1])) for point in polygon)
            bbox = _polygon_to_bbox(points)
            if bbox is not None:
                score = float(scores[index]) if index < len(scores) else 1.0
                detections.append(Detection(bbox, "", score, points))
        return detections

    def recognize(self, image, detections) -> List[Detection]:
        detections = list(detections)
        if not detections:
            return []
        if self._recognizer is None or self._cropper is None:
            return self.detect_and_recognize(image)
        polygons = [detection.polygon or _bbox_polygon(detection.bbox)
                    for detection in detections]
        crops = self._cropper(image, polygons)
        results = list(self._recognizer.predict(crops))
        output = []
        for detection, result in zip(detections, results):
            text = str(result.get("rec_text", "")).strip()
            score = float(result.get("rec_score", 0.0))
            if text:
                output.append(Detection(detection.bbox, text, score,
                                        detection.polygon))
        return output


def _parse_paddle_result(result: Any) -> List[Detection]:
    detections: List[Detection] = []
    if result is None:
        return detections
    if not isinstance(result, (list, tuple)):
        result = [result]
    for page in result:
        if isinstance(page, dict):
            detections.extend(_parse_paddle_dict(page))
            continue
        if hasattr(page, "json"):
            try:
                detections.extend(_parse_paddle_dict(page.json))
                continue
            except Exception:
                pass
        lines = page if isinstance(page, (list, tuple)) else []
        for line in lines:
            if not isinstance(line, (list, tuple)) or len(line) < 2:
                continue
            polygon, payload = line[0], line[1]
            if isinstance(payload, (list, tuple)) and payload:
                text = str(payload[0])
                score = float(payload[1]) if len(payload) > 1 else 1.0
            else:
                text, score = str(payload), 1.0
            bbox = _polygon_to_bbox(polygon)
            if bbox and text.strip():
                points = tuple((float(point[0]), float(point[1])) for point in polygon)
                detections.append(Detection(bbox, text.strip(), score, points))
    return detections


def _parse_paddle_dict(data):
    if callable(data):
        data = data()
    if not isinstance(data, dict):
        return []
    boxes = data.get("dt_polys") or data.get("boxes") or data.get("rec_polys")
    texts = data.get("rec_texts") or data.get("texts") or []
    scores = data.get("rec_scores") or data.get("scores") or []
    output = []
    for index, polygon in enumerate(boxes or []):
        text = str(texts[index]) if index < len(texts) else ""
        score = float(scores[index]) if index < len(scores) else 1.0
        bbox = _polygon_to_bbox(polygon)
        if bbox and text.strip():
            points = tuple((float(point[0]), float(point[1])) for point in polygon)
            output.append(Detection(bbox, text.strip(), score, points))
    return output


def _polygon_to_bbox(polygon):
    try:
        points = [(float(point[0]), float(point[1])) for point in polygon]
        if not points:
            return None
        xs, ys = zip(*points)
        return (min(xs), min(ys), max(xs), max(ys))
    except (TypeError, ValueError, IndexError):
        return None


def _bbox_polygon(bbox):
    x1, y1, x2, y2 = bbox
    return ((x1, y1), (x2, y1), (x2, y2), (x1, y2))


def crop_roi(image, roi):
    height, width = image.shape[:2]
    x1, y1, x2, y2 = roi
    x1 = max(0, min(width - 1, int(round(x1 * width))))
    y1 = max(0, min(height - 1, int(round(y1 * height))))
    x2 = max(x1 + 1, min(width, int(round(x2 * width))))
    y2 = max(y1 + 1, min(height, int(round(y2 * height))))
    return image[y1:y2, x1:x2], (x1, y1, x2, y2)


def offset_detections(detections, offset):
    x1, y1, _, _ = offset
    return [
        Detection((d.bbox[0] + x1, d.bbox[1] + y1,
                   d.bbox[2] + x1, d.bbox[3] + y1), d.text, d.score,
                  tuple((point[0] + x1, point[1] + y1)
                        for point in d.polygon) if d.polygon else None)
        for d in detections
    ]
