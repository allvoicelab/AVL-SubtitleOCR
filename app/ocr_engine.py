from __future__ import annotations

import importlib
import os
import sys
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


@dataclass
class SubtitleCue:
    start: float
    end: float
    text: str
    confidence: float = 0.96
    start_frame: Optional[int] = None
    end_frame: Optional[int] = None
    fps: Optional[float] = None

    def sync_frames_from_times(self) -> None:
        """Keep optional OCR frame metadata aligned after time edits."""
        if self.fps is None or self.fps <= 0:
            self.start_frame = None
            self.end_frame = None
            return
        self.start_frame = max(0, int(round(self.start * self.fps)))
        self.end_frame = max(
            self.start_frame, int(round(self.end * self.fps)))

    def preview_seek_seconds(self) -> float:
        """Return a seek point that displays the subtitle's first frame.

        Seeking just before ``start`` leaves a paused player on the previous
        decoded frame.  Bias the target slightly into the cue so the video
        sink presents the subtitle immediately after a list/timeline click.
        """
        if (
            self.start_frame is not None
            and self.start_frame >= 0
            and self.fps is not None
            and self.fps > 0
        ):
            target_seconds = self.start_frame / self.fps
            return max(0.0, target_seconds + (1.0 / self.fps))
        return max(0.0, self.start + 0.001)


def _describe_device(module, device: str) -> str:
    """给进度/日志用的一行设备描述；老版本 avl-open 没有这个入口就原样返回。"""
    describe = getattr(module, "describe_device", None)
    try:
        return describe(device) if describe else str(device)
    except Exception:  # pragma: no cover - 描述失败不该影响识别
        return str(device)


class RealOcrEngine:
    """Adapter for the lightweight ``avl-open`` OCR runtime.

    Recognition runs through the standalone ``avl_open_ocr`` package.  The
    heavyweight runtime (OpenCV, ONNX Runtime, model files) is imported only
    when recognition starts; a clear setup error is raised when the package or
    its dependencies are unavailable.  There is no mock fallback.
    """

    # ``subtle-v5`` bundles a Chinese recognizer; every other language is
    # handled by the optional PaddleOCR backend.
    _SUBTLE_LANGUAGES = {"ch", "zh", "chinese", "chinese_cht"}
    _PACKAGE_NAME = "avl_open_ocr"

    def recognize(
        self,
        video_path: str,
        duration: float,
        interval: int = 1,
        roi: Optional[tuple[int, int, int, int]] = None,
        language: str = "zh",
        frame_size: Optional[tuple[int, int]] = None,
        on_progress: Optional[Callable[[int, str], None]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
        auto_roi: bool = False,
        threshold: Optional[float] = None,
        max_gap_ms: Optional[float] = None,
        det_workers: Optional[int] = None,
        recognizer: Optional[str] = None,
        cpu_threads: Optional[int] = None,
        device: Optional[str] = None,
        roi_interval: Optional[int] = None,
    ) -> list[SubtitleCue]:
        """Run OCR.

        ``threshold``/``max_gap_ms``/``det_workers``/``cpu_threads`` and
        ``recognizer`` override the ``VIDEO_SUBTITLE_OCR_*`` environment
        defaults.  Callers that keep their settings in the environment can
        leave them unset.

        ``roi_interval`` 是预扫描（自动选区 ROI 统计）的抽帧步长，由调用方按
        视频 fps 推导；它和 ``interval``（正式识别步长）是两件事。``None``
        表示沿用 avl-open 的默认值。
        """
        return self._recognize_with_avl_open(
            video_path,
            duration,
            interval,
            roi,
            language,
            frame_size,
            on_progress,
            should_stop,
            auto_roi,
            threshold=threshold,
            max_gap_ms=max_gap_ms,
            det_workers=det_workers,
            recognizer=recognizer,
            cpu_threads=cpu_threads,
            device=device,
            roi_interval=roi_interval,
        )

    # ONNX 会话的创建很贵（读模型 + 建线程池），更重要的是**不能第一次发生在
    # worker 线程里**：那时主线程正阻塞在 stdin 读上，worker 里的首次 DLL 加载
    # 会和它互锁（现场见 sidecar/prewarm.py 的说明；2026-09-21 用户报的"别的
    # 机器卡在加载模型、CPU 0%"）。所以会话先在协议线程里建好（warm），之后
    # 任务复用缓存；换语言只是换识别头，运行库 DLL 已经驻留，再建会话就安全了。
    _BACKEND_CACHE: OrderedDict[tuple, object] = OrderedDict()
    _BACKEND_CACHE_LIMIT = 2
    _BACKEND_CACHE_LOCK = threading.RLock()

    @classmethod
    def warm(cls, language: str = "ch", recognizer: Optional[str] = None,
             cpu_threads: Optional[int] = None, device: Optional[str] = None,
             threshold: Optional[float] = None) -> dict:
        """Build and cache the bundled ONNX backend before any task runs.

        The returned dict is meant for logging by the caller
        (sidecar/prewarm.py).  "warmed": False means the language does not
        use the bundled ONNX backend, so nothing had to be loaded here.
        """
        module = cls._import_avl_open()
        language_code = cls._normalize_language(language)
        recognizer = recognizer or os.environ.get(
            "VIDEO_SUBTITLE_OCR_RECOGNIZER", "v6_small") or "v6_small"
        bundled = getattr(
            module, "BUNDLED_LANGUAGES", ("ch", "zh", "en", "korean"))
        if language_code not in bundled:
            return {"warmed": False, "backend": "paddle",
                    "language": language_code}
        if not hasattr(module, "create_subtle_backend"):
            return {"warmed": False, "backend": "subtle-v5",
                    "language": language_code}
        # auto = 有 DirectML / CUDA 就用 GPU，否则 CPU（见 avl_open_ocr.providers）
        device = device or os.environ.get("VIDEO_SUBTITLE_OCR_DEVICE") or "auto"
        onnx_threads, _det_workers = cls._thread_budget(cpu_threads)
        recognition_threshold = (
            float(threshold) if threshold is not None
            else cls._env_float("VIDEO_SUBTITLE_OCR_REC_THRESHOLD", 0.38))
        key = cls._backend_cache_key(
            module, language_code, recognizer, device, onnx_threads,
            recognition_threshold)
        with cls._BACKEND_CACHE_LOCK:
            cached = key in cls._BACKEND_CACHE
        if not cached:
            cls._reusable_backend(
                module, "subtle-v5", language_code, recognizer, device,
                onnx_threads, recognition_threshold)
        describe = getattr(module, "describe_device", None)
        return {"warmed": True, "backend": "subtle-v5",
                "language": language_code, "recognizer": recognizer,
                "threads": onnx_threads, "cached": cached,
                "device": describe(device) if describe else device,
                "requestedDevice": device}

    @staticmethod
    def _backend_cache_key(module, language: str, recognizer: Optional[str],
                           device: str, num_threads: int,
                           threshold: float) -> tuple:
        """Cache key for one ONNX backend.

        Languages that share a recognizer head (ch and en both use v6_small)
        also share the sessions; Korean loads its own head.
        """
        heads = getattr(module, "LANGUAGE_RECOGNIZERS", {}) or {}
        head = heads.get(language, str(recognizer or "v6_small").lower())
        resolver = getattr(module, "width_mode_for_language", None)
        try:
            width_mode = str(resolver(language)) if resolver else "default"
        except Exception:
            width_mode = "default"
        return (head, width_mode, str(device), int(num_threads),
                round(float(threshold), 6))

    @classmethod
    def _reusable_backend(cls, module, backend: str, language: str,
                          recognizer: Optional[str], device: str,
                          num_threads: int, threshold: float):
        """Return the shared backend for this configuration, building it once.

        None means this avl-open has no backend reuse: the caller then falls
        back to building a pipeline the old way.
        """
        if backend != "subtle-v5" or not hasattr(module, "create_subtle_backend"):
            return None
        key = cls._backend_cache_key(
            module, language, recognizer, device, num_threads, threshold)
        with cls._BACKEND_CACHE_LOCK:
            cached = cls._BACKEND_CACHE.get(key)
            if cached is not None:
                cls._BACKEND_CACHE.move_to_end(key)
                return cached
        # 建会话时不持锁：这一下可能很慢甚至卡住，不该把别的线程一起拖住。
        built = module.create_subtle_backend(
            language=language, recognizer=recognizer, device=device,
            num_threads=num_threads, recognition_threshold=threshold)
        with cls._BACKEND_CACHE_LOCK:
            cls._BACKEND_CACHE[key] = built
            cls._BACKEND_CACHE.move_to_end(key)
            while len(cls._BACKEND_CACHE) > cls._BACKEND_CACHE_LIMIT:
                cls._BACKEND_CACHE.popitem(last=False)
        return built

    @classmethod
    def release_backends(cls) -> None:
        """Drop every cached ONNX session (tests, and shutdown paths)."""
        with cls._BACKEND_CACHE_LOCK:
            cls._BACKEND_CACHE.clear()

    def _recognize_with_avl_open(
        self,
        video_path: str,
        duration: float,
        interval: int,
        roi: Optional[tuple[int, int, int, int]],
        language: str,
        frame_size: Optional[tuple[int, int]],
        on_progress: Optional[Callable[[int, str], None]],
        should_stop: Optional[Callable[[], bool]],
        auto_roi: bool,
        threshold: Optional[float] = None,
        max_gap_ms: Optional[float] = None,
        det_workers: Optional[int] = None,
        recognizer: Optional[str] = None,
        cpu_threads: Optional[int] = None,
        device: Optional[str] = None,
        roi_interval: Optional[int] = None,
    ) -> list[SubtitleCue]:
        module = self._import_avl_open()
        OCRConfig = module.OCRConfig
        create_pipeline = module.create_pipeline
        cancelled_error = module.ExtractionCancelled

        language_code = self._normalize_language(language)
        recognizer = recognizer or os.environ.get(
            "VIDEO_SUBTITLE_OCR_RECOGNIZER", "v6_small") or "v6_small"
        # The bundled recognizers cover the multilingual v6 dictionary plus a
        # few dedicated heads (Korean), so every code in ``BUNDLED_LANGUAGES``
        # stays on the lightweight ONNX backend; anything outside that table
        # still falls back to PaddleOCR.
        bundled_languages = getattr(
            module, "BUNDLED_LANGUAGES", ("ch", "zh", "en", "korean"))
        backend = "subtle-v5" if language_code in bundled_languages else "paddle"
        recognition_threshold = (
            float(threshold) if threshold is not None
            else self._env_float("VIDEO_SUBTITLE_OCR_REC_THRESHOLD", 0.38))
        # Longest gap inside one subtitle track before a new cue is started.
        gap_setting = (
            float(max_gap_ms) if max_gap_ms is not None
            else self._env_float("VIDEO_SUBTITLE_OCR_MAX_GAP_MS", 900.0))
        # 协议传进来的设备优先，其次环境变量（命令行场景），默认 auto。
        device = device or os.environ.get("VIDEO_SUBTITLE_OCR_DEVICE") or "auto"
        onnx_threads, det_workers_budget = self._thread_budget(cpu_threads)
        det_workers = det_workers_budget if det_workers is None else max(
            1, min(int(det_workers), onnx_threads))

        selected_region = self._normalized_region(roi, frame_size)
        config_kwargs = dict(
            ocr_interval=max(1, int(interval or 1)),
            auto_roi=bool(auto_roi) and selected_region is None,
            roi=selected_region,
            recognition_threshold=recognition_threshold,
            max_gap_ms=max(0.0, gap_setting),
            det_workers=det_workers,
        )
        if roi_interval is not None:
            # 预扫描（自动选区）抽帧步长：与 interval（正式识别步长）互不影响。
            config_kwargs["roi_interval"] = max(1, int(roi_interval))
        config = OCRConfig.for_language(language_code, **config_kwargs)

        previous_env = self._configure_resource_limits(onnx_threads)
        if on_progress:
            on_progress(
                2,
                f"正在加载 avl-open OCR 引擎（{backend}/{recognizer}，"
                f"{onnx_threads} 线程 × {det_workers} 检测并发，"
                f"{_describe_device(module, device)}）",
            )
        try:
            pipeline_kwargs = dict(
                language=language_code,
                config=config,
                backend=backend,
                recognition_threshold=recognition_threshold,
                device=device,
            )
            if backend == "subtle-v5":
                pipeline_kwargs.update(num_threads=onnx_threads, recognizer=recognizer)
            reused = self._reusable_backend(
                module, backend, language_code, recognizer, device,
                onnx_threads, recognition_threshold)
            if reused is not None:
                pipeline = module.create_subtle_pipeline(
                    language=language_code, config=config,
                    backend_instance=reused)
            else:
                pipeline = create_pipeline(**pipeline_kwargs)

            def progress(percent, message):
                if not on_progress:
                    return
                try:
                    value = int(percent)
                except (TypeError, ValueError):
                    return
                # Keep the runtime's 0..100 span inside the app's 5..99 window
                # so setup/finalization messages stay visible.
                on_progress(max(5, min(99, 5 + round(value * 0.94))), message)

            try:
                metadata, _frames, cues = pipeline.extract(
                    str(video_path),
                    progress_callback=progress,
                    should_stop=should_stop,
                )
            except cancelled_error:
                # Do not compute cues for an aborted run and do not push the
                # progress bar to 100%; the UI shows a dedicated stopped state.
                return []
        finally:
            self._restore_env(previous_env)

        result = self._to_subtitle_cues(cues, metadata)
        if on_progress:
            on_progress(100, "识别完成")
        return result

    @classmethod
    def _import_avl_open(cls):
        """Import the ``avl_open_ocr`` package, adding a local copy to sys.path.

        Packaging installs the runtime (``pip install -e avl-open``), but a
        portable checkout can also be discovered next to the app or through
        ``VIDEO_SUBTITLE_OCR_ROOT``.
        """
        last_error = None
        search_roots = cls._candidate_roots()
        for import_root in search_roots:
            if import_root is not None:
                if not (import_root / cls._PACKAGE_NAME / "__init__.py").is_file():
                    continue
                parent = str(import_root)
                if parent not in sys.path:
                    sys.path.insert(0, parent)
            cls._drop_partial_imports()
            try:
                module = importlib.import_module(cls._PACKAGE_NAME)
            except ModuleNotFoundError as exc:
                last_error = exc
                missing = exc.name or ""
                if missing and not missing.startswith(cls._PACKAGE_NAME):
                    raise RuntimeError(
                        f"avl-open OCR 依赖未安装：{missing}。"
                        "请在运行应用的 Python 环境中执行 "
                        "`pip install -r requirements.txt` 和 "
                        "`pip install -e avl-open`。"
                    ) from exc
                continue
            except Exception as exc:  # noqa: BLE001 - surface a clear setup error
                last_error = exc
                continue
            if hasattr(module, "create_pipeline") and hasattr(module, "OCRConfig"):
                cls._verify_bundled_models(module)
                return module
            last_error = RuntimeError(
                f"{cls._PACKAGE_NAME} 不是有效的 avl-open 包：{getattr(module, '__file__', '')}"
            )
        raise RuntimeError(
            "未找到 avl-open OCR 运行环境。请执行 `pip install -e avl-open`，"
            "或通过 VIDEO_SUBTITLE_OCR_ROOT 指向 avl-open 目录。"
            + (f"（最后一个错误：{last_error}）" if last_error else "")
        )

    @staticmethod
    def _is_frozen() -> bool:
        """True when running from a PyInstaller bundle."""
        return bool(getattr(sys, "frozen", False))

    @classmethod
    def _verify_bundled_models(cls, module) -> None:
        """Refuse to run a packaged build that lost its ONNX models.

        Without this, a build that forgot ``avl_open_ocr/model_files`` fails
        deep inside ONNX Runtime with a file-not-found error that says nothing
        about packaging.
        """
        if not cls._is_frozen():
            return
        module_dir = Path(getattr(module, "__file__", "") or "").parent
        if not any((module_dir / "model_files").glob("*.onnx")):
            raise RuntimeError(
                "打包后的程序里没有 OCR 模型文件（{}）。"
                "请重新执行 build_sidecar_windows.bat 打包；"
                "若仍然失败，请检查 SubtitleSidecar.spec 是否收集了 "
                "avl_open_ocr 的 model_files。".format(module_dir / "model_files")
            )

    @staticmethod
    def _drop_partial_imports() -> None:
        for name in [n for n in sys.modules if n == RealOcrEngine._PACKAGE_NAME
                     or n.startswith(RealOcrEngine._PACKAGE_NAME + ".")]:
            sys.modules.pop(name, None)

    @staticmethod
    def _candidate_roots() -> list[Optional[Path]]:
        """Import locations to try, most preferred first.

        ``None`` means "plain ``sys.path``", which is all a packaged build is
        allowed to use: PyInstaller puts the runtime inside the bundle, so
        falling back to a checkout on disk would hide a broken bundle (it keeps
        working on the build machine and fails on every other machine).
        ``VIDEO_SUBTITLE_OCR_ROOT`` remains the explicit escape hatch.
        """
        configured = os.environ.get("VIDEO_SUBTITLE_OCR_ROOT")
        roots: list[Optional[Path]] = [None]
        dirs: list[Path] = []
        if configured:
            configured_path = Path(configured).expanduser()
            dirs.extend([
                configured_path,
                configured_path / "avl-open",
                configured_path.parent,
            ])
        if not RealOcrEngine._is_frozen():
            # Development runs: also look for a portable checkout next to the
            # sources or the interpreter.
            project_root = Path(__file__).resolve().parents[1]
            dirs.extend([
                Path.cwd() / "avl-open",
                Path.cwd(),
                project_root / "avl-open",
                project_root,
            ])
            try:
                executable = Path(sys.executable).resolve()
                dirs.extend([
                    executable.parent.parent / "avl-open",
                    executable.parents[2] / "avl-open",
                ])
            except (IndexError, OSError):
                pass
        roots.extend(dirs)
        return roots

    @staticmethod
    def _normalize_language(language: str) -> str:
        value = (language or "ch").strip().lower()
        if value in ("zh", "chinese", "ch"):
            return "ch"
        if value in ("zh-tw", "zh_hant", "traditional", "chinese_cht"):
            return "ch"
        return value or "ch"

    @staticmethod
    def _env_float(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name, str(default)))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _thread_budget(
        cpu_threads: Optional[int] = None,
    ) -> tuple[int, int]:
        """Return ``(onnx_intra_op_threads, detector_workers)`` for OCR.

        The GUI, video decoder and audio share the same CPU, so the ONNX Runtime
        sessions do not get one intra-op thread per core by default: they start
        at half the cores and the front end can lower that further.  An explicit
        ``cpu_threads`` wins over ``VIDEO_SUBTITLE_OCR_ONNX_THREADS``, which in
        turn wins over the built-in default; the detector pool stays a single
        worker unless ``VIDEO_SUBTITLE_OCR_DET_WORKERS`` says otherwise.
        """
        cpu_count = max(1, os.cpu_count() or 1)

        def bounded(name: str, default: int, maximum: int, minimum: int = 1) -> int:
            try:
                value = int(os.environ.get(name, str(default)))
            except (TypeError, ValueError):
                value = default
            return max(minimum, min(value, maximum))

        default_threads = max(1, cpu_count // 2)
        if cpu_threads is None:
            onnx_threads = bounded(
                "VIDEO_SUBTITLE_OCR_ONNX_THREADS", default_threads, cpu_count)
        else:
            try:
                requested = int(cpu_threads)
            except (TypeError, ValueError):
                requested = default_threads
            onnx_threads = max(1, min(requested, cpu_count))
        det_workers = bounded(
            "VIDEO_SUBTITLE_OCR_DET_WORKERS", 1, onnx_threads)
        return onnx_threads, det_workers

    @staticmethod
    def _configure_resource_limits(cpu_threads: int) -> dict[str, Optional[str]]:
        """Align native math-thread env vars with the OCR thread budget."""
        cpu_threads = max(1, int(cpu_threads or 1))
        values = {
            "OMP_NUM_THREADS": str(cpu_threads),
            "MKL_NUM_THREADS": str(cpu_threads),
            "OPENBLAS_NUM_THREADS": str(cpu_threads),
            "NUMEXPR_NUM_THREADS": str(cpu_threads),
            "VECLIB_MAXIMUM_THREADS": str(cpu_threads),
            "BLIS_NUM_THREADS": str(cpu_threads),
            "OMP_WAIT_POLICY": "PASSIVE",
            "OMP_DYNAMIC": "FALSE",
            "KMP_DYNAMIC_MODE": "thread_limit",
            "VIDEO_SUBTITLE_OCR_CPU_THREADS": str(cpu_threads),
        }
        previous = {key: os.environ.get(key) for key in values}
        os.environ.update(values)
        try:
            import cv2
            cv2.setNumThreads(cpu_threads)
        except Exception:
            pass
        return previous

    @staticmethod
    def _restore_env(previous: dict[str, Optional[str]]) -> None:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    @staticmethod
    def _normalized_region(roi, frame_size):
        if not roi or not frame_size or frame_size[0] <= 0 or frame_size[1] <= 0:
            return None
        x, y, width, height = roi
        frame_width, frame_height = frame_size
        left = max(0.0, min(1.0, x / frame_width))
        top = max(0.0, min(1.0, y / frame_height))
        right = max(left, min(1.0, (x + width) / frame_width))
        bottom = max(top, min(1.0, (y + height) / frame_height))
        return [left, top, right, bottom]

    @staticmethod
    def _to_subtitle_cues(raw_cues, metadata) -> list[SubtitleCue]:
        if not raw_cues:
            return []
        try:
            fps = float(metadata.get("fps"))
            if fps <= 0:
                fps = None
        except (AttributeError, TypeError, ValueError):
            fps = None
        cues = []
        for item in raw_cues:
            try:
                start = float(item.start_ms) / 1000.0
                end = float(item.end_ms) / 1000.0
            except (AttributeError, TypeError, ValueError) as exc:
                raise RuntimeError(f"avl-open OCR 结果缺少有效时间：{item}") from exc
            text = str(getattr(item, "text", "") or "").strip()
            if end <= start or not text:
                continue
            confidence = getattr(item, "confidence", None)
            try:
                confidence = float(confidence)
            except (TypeError, ValueError):
                confidence = 0.96
            cue = SubtitleCue(start, end, text, confidence=confidence, fps=fps)
            cue.sync_frames_from_times()
            cues.append(cue)
        cues.sort(key=lambda cue: (cue.start, cue.end))
        return cues


# Backward-compatible import name for callers that used the original demo API.
HybridOcrEngine = RealOcrEngine
