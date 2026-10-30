import argparse
import json
from pathlib import Path

from .export import write_json, write_srt
from .models import OCRConfig
from .pipeline import create_pipeline


def build_parser():
    parser = argparse.ArgumentParser(description="Extract subtitles from video with CPU-friendly OCR")
    parser.add_argument("video", help="input video path")
    parser.add_argument("-o", "--output", default="subtitle_output", help="output prefix or directory")
    parser.add_argument("--lang", default="ch",
                        help="language code; the bundled heads cover "
                             "avl_open_ocr.BUNDLED_LANGUAGES, other codes need --backend paddle")
    parser.add_argument("--sample-fps", type=float, default=2.0,
                        help="legacy A3 sampling rate; F1 uses --ocr-interval")
    parser.add_argument("--ocr-interval", type=_positive_int, default=2,
                        help="formal OCR interval in original video frames; default: every 2 frames")
    parser.add_argument("--pre-scan-interval", "--roi-interval",
                        dest="pre_scan_interval", type=_positive_int, default=2,
                        help="automatic ROI pre-scan interval in original video frames; default: every 2 frames")
    parser.add_argument("--no-auto-roi", action="store_true", help="run OCR on the full frame")
    parser.add_argument("--no-det-first", action="store_true",
                        help="disable the two-pass detection-first pipeline")
    parser.add_argument("--no-single-pass", action="store_true",
                        help="use the legacy two-pass det-first pipeline")
    parser.add_argument("--det-workers", type=_positive_int, default=24,
                        help="parallel detector workers used by det-first")
    parser.add_argument("--roi", nargs=4, type=float, metavar=("X1", "Y1", "X2", "Y2"), help="normalized ROI")
    parser.add_argument("--rec-threshold", type=float, default=0.38)
    parser.add_argument("--backend", default="subtle-v5",
                        choices=("subtle-v5", "paddle"))
    parser.add_argument("--recognizer", default="v6_small",
                        choices=("v5", "v6_small", "v6_tiny"),
                        help="bundled ONNX recognizer profile (subtle-v5 backend)")
    parser.add_argument("--num-threads", type=_positive_int, default=None,
                        help="ONNX Runtime intra-op threads; default: onnxruntime default")
    parser.add_argument("--postprocess", default="f1",
                        choices=("f1", "a3", "legacy"))
    parser.add_argument("--no-roi-filter", action="store_true",
                        help="keep detections outside the final auto-ROI band")
    parser.add_argument("--f1-text-similarity", type=float, default=None,
                        help="F1 text similarity; defaults to the selected language profile")
    parser.add_argument("--f1-max-gap-seconds", type=float, default=None,
                        help="F1 maximum track gap; defaults to the selected language profile")
    parser.add_argument("--f1-support-threshold", type=float, default=None,
                        help="F1 track support ratio; defaults to the selected language profile")
    parser.add_argument("--device", default="cpu", choices=("cpu", "gpu"), help="backend device hint")
    return parser


def _positive_int(value):
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.device == "gpu" and args.backend == "paddle":
        print("PaddleOCR device selection is controlled by its installed runtime; continuing.")
    language_config = OCRConfig.for_language(args.lang)
    config = OCRConfig(sample_fps=args.sample_fps,
                       ocr_interval=max(1, args.ocr_interval),
                       roi_interval=max(1, args.pre_scan_interval),
                       auto_roi=not args.no_auto_roi,
                       det_first=not args.no_det_first,
                       single_pass=not args.no_single_pass,
                       det_workers=max(1, args.det_workers),
                       roi=tuple(args.roi) if args.roi else None,
                       recognition_threshold=args.rec_threshold,
                       postprocess_mode=args.postprocess,
                       filter_to_selected_roi=not args.no_roi_filter,
                       f1_text_similarity=(args.f1_text_similarity
                                           if args.f1_text_similarity is not None
                                           else language_config.f1_text_similarity),
                       f1_max_gap_seconds=(args.f1_max_gap_seconds
                                           if args.f1_max_gap_seconds is not None
                                           else language_config.f1_max_gap_seconds),
                       f1_support_threshold=(args.f1_support_threshold
                                             if args.f1_support_threshold is not None
                                             else language_config.f1_support_threshold))
    pipeline_kwargs = dict(
        language=args.lang, config=config, backend=args.backend,
        recognition_threshold=args.rec_threshold, device=args.device,
        recognizer=args.recognizer,
    )
    if args.num_threads:
        pipeline_kwargs["num_threads"] = args.num_threads
    pipeline = create_pipeline(**pipeline_kwargs)
    metadata, _, cues = pipeline.extract(args.video)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    prefix = output if output.suffix == "" else output.with_suffix("")
    write_srt(cues, str(prefix.with_suffix(".srt")))
    write_json(cues, str(prefix.with_suffix(".json")))
    prefix.with_suffix(".meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Extracted {len(cues)} subtitle cues")
    print(f"SRT: {prefix.with_suffix('.srt')}")
    print(f"JSON: {prefix.with_suffix('.json')}")
    return 0
