"""OCR sidecar used by the Electron front end.

The recognition adapter (:mod:`app.ocr_engine`) is shared with the historical
desktop front end (removed 2026-09-21); only the process boundary and the
queue plumbing differ.

Nothing in this package may depend on a GUI toolkit.
"""
from __future__ import annotations

PROTOCOL_VERSION = 1
BACKEND_VERSION = "0.1.0"

__all__ = ["PROTOCOL_VERSION", "BACKEND_VERSION"]
