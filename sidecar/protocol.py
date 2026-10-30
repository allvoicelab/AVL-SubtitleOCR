"""Line-delimited JSON framing (SIDECAR_API.md §2–§3).

stdout carries protocol messages only; every log line goes to stderr so a
stray ``print`` can never corrupt the stream.
"""
from __future__ import annotations

import contextlib
import json
import sys
import threading
from typing import Any, IO, Iterator, Optional


def configure_streams() -> None:
    """Force UTF-8 / LF on the standard streams.

    Windows defaults to a legacy code page and CRLF: the code page breaks
    Chinese payloads and CRLF would leave a stray ``\\r`` on every line.
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", newline="\n")
        except (ValueError, OSError):
            pass


def log(message: str) -> None:
    """Write a diagnostic line to stderr (never stdout)."""
    try:
        sys.stderr.write(f"[sidecar] {message}\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def encode(message: dict) -> str:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"))


class JsonChannel:
    """Thread-safe writer for responses and events.

    ``seq`` is monotonic across every event so the renderer can drop stale
    ones; the lock keeps two worker threads from interleaving half-lines.
    """

    def __init__(self, stream: Optional[IO[str]] = None):
        self._stream = stream if stream is not None else sys.stdout
        # Re-entrant: handle() holds it for the whole request, and the
        # response write inside it must not deadlock.
        self._lock = threading.RLock()
        self._seq = 0
        self._deferred: Optional[list] = None

    @contextlib.contextmanager
    def defer_events(self):
        """Hold events back until the response has been written.

        A request ("start this video") triggers its first events immediately,
        and a worker thread can emit them before the handler has returned.
        The front end routes events by ``taskId``, so an event that arrives
        before its own response would be applied to a row that does not exist
        yet (SIDECAR_API.md §3.3).  Everything emitted while this context is
        active is buffered and written right after the response.
        """
        with self._lock:
            outer = self._deferred
            self._deferred = []
            try:
                yield
            finally:
                buffered, self._deferred = self._deferred, outer
                if outer is not None and buffered:
                    outer.extend(buffered)
                elif buffered:
                    for message in buffered:
                        message["seq"] = self._seq
                        self._seq += 1
                        self._write(message)

    @property
    def seq(self) -> int:
        with self._lock:
            return self._seq

    def emit(self, event: str, payload: Optional[dict] = None) -> int:
        with self._lock:
            if self._deferred is not None:
                self._deferred.append(
                    {"event": event, "payload": payload or {}})
                return -1
            seq = self._seq
            self._seq += 1
            self._write({"event": event, "seq": seq, "payload": payload or {}})
            return seq

    def respond(self, request_id: Any, result: Any = None) -> None:
        with self._lock:
            self._write({"id": request_id, "ok": True, "result": result})

    def fail(self, request_id: Any, error: dict) -> None:
        with self._lock:
            self._write({"id": request_id, "ok": False, "error": error})

    def _write(self, message: dict) -> None:
        line = encode(message)
        try:
            self._stream.write(line + "\n")
            self._stream.flush()
        except (OSError, ValueError):
            # The parent process is gone; stdin EOF will end the service.
            pass


def iter_messages(stream: Optional[IO[str]] = None) -> Iterator[dict]:
    """Yield decoded requests until EOF.

    A malformed line is reported on stderr and skipped: one bad message must
    not take the whole sidecar down while the user is mid-batch.
    """
    stream = stream if stream is not None else sys.stdin
    for raw in stream:
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            log(f"忽略无法解析的消息：{exc}")
            continue
        if not isinstance(message, dict):
            log("忽略非对象的消息")
            continue
        yield message
