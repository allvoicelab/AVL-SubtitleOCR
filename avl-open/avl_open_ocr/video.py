from typing import Iterator, Optional, Tuple

def iter_video_frames(path: str, sample_fps: Optional[float] = 2.0,
                      frame_interval: Optional[int] = None) -> Tuple[dict, Iterator[tuple]]:
    try:
        import cv2
    except ImportError as error:
        raise RuntimeError(
            "OpenCV is required for video extraction. Install with: "
            "pip install -e ."
        ) from error
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise FileNotFoundError(f"Unable to open video: {path}")
    source_fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration_ms = frame_count / source_fps * 1000 if frame_count else 0.0
    if frame_interval is not None:
        frame_interval = max(1, int(frame_interval))
        effective_fps = source_fps / frame_interval
    else:
        effective_fps = sample_fps or source_fps
    metadata = {
        "fps": source_fps, "sample_fps": effective_fps, "frame_count": frame_count,
        "width": width, "height": height, "duration_ms": duration_ms,
    }

    def generator():
        interval = frame_interval or max(1, round(source_fps / (sample_fps or source_fps)))
        index = 0
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                if index % interval == 0:
                    yield index, index / source_fps * 1000.0, frame
                index += 1
        finally:
            capture.release()

    return metadata, generator()
