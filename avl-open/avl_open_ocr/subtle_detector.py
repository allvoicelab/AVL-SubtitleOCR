from pathlib import Path

import cv2
import numpy as np

from .models import Detection
from .providers import apply_provider_options, onnx_providers


class SubtleOnnxDetector:
    def __init__(self, model_path=None, score_threshold=0.5,
                 offset_threshold=0.12, providers=None, num_threads=None):
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise RuntimeError("onnxruntime is required for the subtle detector") from error
        path = Path(model_path or Path(__file__).parent / "model_files/res18-db-damo_mixed.onnx")
        if not path.exists():
            raise FileNotFoundError(f"Subtle detector model not found: {path}")
        session_options = ort.SessionOptions()
        # Keep ONNX Runtime from spawning its own unbounded thread pool; a
        # desktop host must stay responsive while OCR runs in the background.
        session_options.inter_op_num_threads = 1
        # 只留 ERROR 以上：paddle2onnx 转换出来的识别头会打十几条
        # "Removing initializer ..." 警告（带 ANSI 转义），宿主会把 stderr
        # 整份收进日志，噪音比信息多。
        session_options.log_severity_level = 3
        providers = providers or onnx_providers("auto")
        apply_provider_options(session_options, providers)
        if num_threads:
            session_options.intra_op_num_threads = max(1, int(num_threads))
        self.session = ort.InferenceSession(
            str(path), sess_options=session_options,
            providers=providers,
        )
        self.input_name = self.session.get_inputs()[0].name
        self.input_size = int(self.session.get_inputs()[0].shape[-1])
        self.threshold = score_threshold - offset_threshold
        self.mean = np.asarray([123.68, 116.78, 103.94], dtype=np.float16)

    def detect(self, image):
        tensor, resized_height, resized_width = self._preprocess(image)
        prediction = self.session.run(None, {self.input_name: tensor})[0][0].astype(np.float32)
        bitmap = prediction[:resized_height, :resized_width]
        mask = cv2.dilate((bitmap > self.threshold).astype(np.uint8),
                          np.ones((3, 3), dtype=np.uint8))
        boxes, scores = boxes_from_bitmap(
            bitmap, mask, image.shape[1], image.shape[0], self.threshold)
        return [
            Detection(_polygon_bbox(points), "", float(score),
                      tuple((float(x), float(y)) for x, y in points))
            for points, score in zip(boxes, scores)
        ]

    def _preprocess(self, image):
        height, width = image.shape[:2]
        scale = min(self.input_size / width, self.input_size / height)
        resized_width = max(1, int(round(width * scale)))
        resized_height = max(1, int(round(height * scale)))
        resized = cv2.resize(image, (resized_width, resized_height))
        padded = np.zeros((self.input_size, self.input_size, 3), dtype=np.uint8)
        padded[:resized_height, :resized_width] = resized
        rgb = padded[..., ::-1].astype(np.float16)
        tensor = ((rgb - self.mean) / np.float16(255.0)).transpose(2, 0, 1)[None]
        return tensor, resized_height, resized_width


def boxes_from_bitmap(prediction, bitmap, destination_width,
                      destination_height, box_threshold):
    contours, _ = cv2.findContours(
        (bitmap * 255).astype(np.uint8), cv2.RETR_LIST,
        cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    scores = []
    height, width = bitmap.shape
    for contour in contours[:1000]:
        points, short_side = get_mini_boxes(contour)
        if short_side < 3:
            continue
        points = np.asarray(points)
        score = box_score_fast(prediction, points)
        if score < box_threshold:
            continue
        expanded = unclip(points, 1.5)
        if len(expanded) != 1:
            continue
        points, short_side = get_mini_boxes(expanded.reshape(-1, 1, 2))
        if short_side < 5:
            continue
        points = np.asarray(points, dtype=np.float32)
        points[:, 0] = np.clip(
            np.round(points[:, 0] / width * destination_width),
            0, destination_width)
        points[:, 1] = np.clip(
            np.round(points[:, 1] / height * destination_height),
            0, destination_height)
        boxes.append(points)
        scores.append(score)
    return boxes, scores


def box_score_fast(bitmap, box):
    height, width = bitmap.shape[:2]
    points = box.copy()
    x0 = np.clip(np.floor(points[:, 0].min()).astype(np.int32), 0, width - 1)
    x1 = np.clip(np.ceil(points[:, 0].max()).astype(np.int32), 0, width - 1)
    y0 = np.clip(np.floor(points[:, 1].min()).astype(np.int32), 0, height - 1)
    y1 = np.clip(np.ceil(points[:, 1].max()).astype(np.int32), 0, height - 1)
    mask = np.zeros((y1 - y0 + 1, x1 - x0 + 1), dtype=np.uint8)
    points[:, 0] -= x0
    points[:, 1] -= y0
    cv2.fillPoly(mask, points.reshape(1, -1, 2).astype(np.int32), 1)
    return cv2.mean(bitmap[y0:y1 + 1, x0:x1 + 1], mask)[0]


def unclip(box, ratio):
    try:
        import pyclipper
        from shapely.geometry import Polygon
    except ImportError as error:
        raise RuntimeError("pyclipper and shapely are required for detector postprocess") from error
    polygon = Polygon(box)
    if polygon.length <= 0:
        return np.empty((0, 0, 2), dtype=np.float32)
    distance = polygon.area * ratio / polygon.length
    offset = pyclipper.PyclipperOffset()
    offset.AddPath(box, pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    return np.asarray(offset.Execute(distance))


def get_mini_boxes(contour):
    bounding_box = cv2.minAreaRect(contour)
    points = sorted(cv2.boxPoints(bounding_box).tolist(), key=lambda point: point[0])
    index_1, index_4 = (0, 1) if points[1][1] > points[0][1] else (1, 0)
    index_2, index_3 = (2, 3) if points[3][1] > points[2][1] else (3, 2)
    return [points[index_1], points[index_2], points[index_3], points[index_4]], min(bounding_box[1])


def _polygon_bbox(points):
    points = np.asarray(points)
    return (float(points[:, 0].min()), float(points[:, 1].min()),
            float(points[:, 0].max()), float(points[:, 1].max()))
