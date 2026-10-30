"""PyInstaller entry point for ``SubtitleSidecar.exe``."""
from __future__ import annotations

import sys

from sidecar.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
