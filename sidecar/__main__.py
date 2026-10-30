"""Process entry point: ``python -m sidecar`` (or the frozen exe)."""
from __future__ import annotations

import argparse
import os
import sys
from typing import Optional

from . import PROTOCOL_VERSION
from .kernel import QueueKernel
from .prewarm import prewarm
from .protocol import JsonChannel, configure_streams, iter_messages, log
from .service import SidecarService

EXIT_OK = 0
EXIT_FATAL = 1
EXIT_PROTOCOL = 2
EXIT_INIT = 3


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="subtitle-ocr-sidecar",
        description="OCR backend for the AVL-SubtitleOCR UI")
    parser.add_argument("--protocol-version", type=int, default=PROTOCOL_VERSION,
                        help="protocol version the front end speaks")
    parser.add_argument("--log-level", default="info",
                        choices=("debug", "info", "warn", "error"))
    parser.add_argument("--preview-cache", default=None,
                        help="override the preview cache directory")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    configure_streams()
    if args.preview_cache:
        os.environ["VIDEO_SUBTITLE_PREVIEW_CACHE"] = args.preview_cache
    if int(args.protocol_version) != PROTOCOL_VERSION:
        log(f"协议版本不兼容：前端 {args.protocol_version}，后端 {PROTOCOL_VERSION}")
        return EXIT_PROTOCOL

    channel = JsonChannel()
    try:
        kernel = QueueKernel(
            emit=lambda event, payload: channel.emit(event, payload),
            # 看门狗判定卡死之后由后端自己退出：worker 卡在原生调用里，
            # 留着这个进程只会一直占着显存，还挡着后面排队的视频。
            exit_process=os._exit)
        service = SidecarService(channel, kernel=kernel)
    except Exception as exc:  # noqa: BLE001 - nothing works without the kernel
        log(f"初始化失败：{exc!r}")
        return EXIT_INIT

    service.hello()
    log(f"sidecar 已启动（protocol={PROTOCOL_VERSION}，"
        f"modelsBundled={service._models_bundled}）")
    # Warm the compiled runtime up here: the read loop below parks the main
    # thread on stdin, and a worker thread cannot complete a first-time
    # extension import while that read is pending (see sidecar/prewarm.py).
    prewarm()
    exit_code = EXIT_OK
    try:
        for message in iter_messages():
            if service.handle(message):
                break
    except KeyboardInterrupt:
        exit_code = EXIT_OK
    except Exception as exc:  # noqa: BLE001
        log(f"协议循环异常退出：{exc!r}")
        exit_code = EXIT_FATAL
    finally:
        service.stop()
        log("sidecar 已退出")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
