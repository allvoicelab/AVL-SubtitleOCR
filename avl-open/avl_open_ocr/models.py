from dataclasses import dataclass, field
from typing import List, Optional, Tuple

BBox = Tuple[float, float, float, float]

# Language codes the bundled PP-OCRv6 recognizer head ships a dictionary
# for (``paddle_v6_dict.txt``).  Keep this in sync with the sidecar
# ``LANGUAGE_LABELS`` table, which is what the desktop picker renders.
V6_LANGUAGES = (
    "ch", "chinese_cht", "en", "japan", "af", "az", "bs", "ca", "cs", "cy",
    "da", "de", "es", "et", "eu", "fi", "fr", "ga", "gl", "hr", "hu", "id",
    "is", "it", "ku", "la", "lb", "lt", "lv", "mi", "ms", "mt", "nl", "no",
    "oc", "pl", "pt", "qu", "rm", "ro", "rs_latin", "sk", "sl", "sq", "sv",
    "sw", "tl", "tr", "uz", "vi", "french", "german"
)

# Languages that need a dedicated recognizer head instead of the
# multilingual v6 dictionary, mapped to the profile name in
# ``backends.SubtleOnnxBackend._RECOGNIZERS``.  The Korean head is a
# PP-OCRv5 mobile recognizer converted from its Paddle PIR export.
LANGUAGE_RECOGNIZERS = {
    "korean": "korean_v5",
}

# Everything the bundled ONNX backend can read without PaddleOCR.
BUNDLED_LANGUAGES = V6_LANGUAGES + tuple(LANGUAGE_RECOGNIZERS)

# Large-glyph scripts already keep enough detail at the recognizer's 320 px
# baseline.  Small-glyph scripts need the input widened by its source aspect
# ratio, otherwise long subtitle lines are squeezed horizontally.
STATIC_WIDTH_LANGUAGES = frozenset({
    "ch", "zh", "chinese", "chinese_cht", "zh-tw", "zh_tw", "zh_hant",
    "traditional", "japan", "ja", "japanese", "korean", "ko",
})
WIDTH_MODES = ("static", "dynamic")


def width_mode_for_language(language: str = "ch") -> str:
    """Return the recognizer input-width policy for a language code."""
    normalized = str(language or "ch").strip().lower()
    return "static" if normalized in STATIC_WIDTH_LANGUAGES else "dynamic"


@dataclass
class Detection:
    bbox: BBox
    text: str
    score: float = 1.0
    polygon: Optional[Tuple[Tuple[float, float], ...]] = None


@dataclass
class FrameResult:
    frame_index: int
    timestamp_ms: float
    detections: List[Detection] = field(default_factory=list)


@dataclass
class Cue:
    start_ms: float
    end_ms: float
    text: str
    bbox: Optional[BBox] = None
    confidence: float = 0.0


@dataclass
class OCRConfig:
    sample_fps: float = 2.0
    ocr_interval: int = 2
    recognition_threshold: float = 0.38
    min_text_length: int = 1
    roi: Optional[Tuple[float, float, float, float]] = None
    auto_roi: bool = True
    det_first: bool = True
    single_pass: bool = True
    det_workers: int = 24
    max_gap_ms: float = 900.0
    min_duration_ms: float = 160.0
    text_similarity: float = 0.55
    bbox_iou: float = 0.25
    filter_to_selected_roi: bool = True
    f1_text_similarity: float = 0.95
    f1_max_gap_seconds: float = 0.125
    f1_support_threshold: float = 0.10
    max_cue_duration_ms: float = 12000.0
    merge_gap_ms: float = 180.0
    roi_interval: int = 2
    roi_watermark_ratio: float = 0.90
    roi_strict_ratio: float = 0.05
    roi_relax_ratio: float = 0.005
    roi_neighbor_height: float = 0.05
    roi_band_density_ratio: float = 0.15
    roi_band_max_height: float = 0.25
    roi_band_min_height: float = 0.02
    roi_top_ratio: float = 0.40
    roi_time_gap_seconds: float = 5.0
    roi_expand_ratio: float = 1.05
    roi_top_exclude_ratio: float = 0.15
    roi_span_soft_cap: float = 0.95
    roi_span_weight: float = 1.0
    roi_contrast_weight: float = 1.0
    roi_rgb_min_contrast: float = 0.35
    roi_rgb_min_bimodal: float = 0.10
    roi_dilation_overlap: float = 0.30
    roi_dilation_min_contrast: float = 0.30
    roi_dilation_min_bimodal: float = 0.08
    postprocess_mode: str = "f1"

    @property
    def pre_scan_interval(self) -> int:
        return self.roi_interval

    @property
    def formal_ocr_interval(self) -> int:
        return self.ocr_interval

    @classmethod
    def for_language(cls, language: str = "ch", **kwargs):
        normalized = language.lower()
        if normalized in ("en", "english"):
            kwargs.setdefault("f1_text_similarity", 0.95)
            kwargs.setdefault("f1_max_gap_seconds", 0.125)
            kwargs.setdefault("f1_support_threshold", 0.075)
        else:
            kwargs.setdefault("f1_text_similarity", 0.95)
            kwargs.setdefault("f1_max_gap_seconds", 0.125)
            kwargs.setdefault("f1_support_threshold", 0.10)
        return cls(**kwargs)
