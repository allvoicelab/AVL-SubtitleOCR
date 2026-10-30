"""Build-time collector for the third-party license bundle.

The hand-maintained ``licenses/`` folder is not part of the source repository.
When it is absent, ``SubtitleSidecar.spec`` calls :func:`collect` and bundles the
texts that the build virtualenv actually contains, so a clean checkout can still
produce a complete package.

Layout produced here is the same one the spec validates in ``REQUIRED_LICENSES``.
"""

from __future__ import annotations

import importlib.metadata as metadata
import shutil
import sys
import sysconfig
from pathlib import Path

DIST_FILES = (
    # (dist-info prefix, path inside dist-info, destination in the bundle)
    ("numpy-", "licenses/LICENSE.txt", "numpy/LICENSE.txt"),
    ("av-", "licenses/LICENSE.txt", "pyav/LICENSE.txt"),
    ("opencv_python-", "LICENSE.txt", "opencv/LICENSE.txt"),
    ("opencv_python-", "LICENSE-3RD-PARTY.txt", "opencv/LICENSE-3RD-PARTY.txt"),
    ("pillow-", "licenses/LICENSE", "pillow/LICENSE"),
    ("pyclipper-", "licenses/LICENSE", "pyclipper/LICENSE"),
    ("shapely-", "licenses/LICENSE.txt", "shapely/LICENSE.txt"),
    ("shapely-", "licenses/LICENSE_GEOS", "shapely/LICENSE_GEOS"),
    ("shapely-", "licenses/LICENSE_win32", "shapely/LICENSE_win32"),
    ("pyinstaller-", "licenses/COPYING.txt", "pyinstaller/COPYING.txt"),
)

DIRECTML_NOTICE = """# DirectML.dll

- 文件：`_internal/DirectML.dll`（随 `onnxruntime-directml` {ort} 分发）
- 上游：https://github.com/microsoft/DirectML
- 许可：MIT License，Copyright (c) Microsoft Corporation
- 用途：Windows 上的 GPU 推理后端（`DmlExecutionProvider`），无需安装 CUDA/cuDNN

上游 wheel 没有随包提供许可文本，这里只登记来源与许可类型。
MIT 许可正文与 `../onnxruntime/LICENSE` 的正文一致（同为 MIT，仅版权主体不同）。
"""

FFMPEG_NOTICE = """# PyAV wheel 内置的 FFmpeg 动态库

- 位置：`_internal/av.libs/`（PyAV {av} 的官方 Windows wheel 自带整套 FFmpeg 动态库）
- 上游：https://pyav.org / https://ffmpeg.org
- 许可：PyAV 自身为 BSD-3-Clause（见同目录 `LICENSE.txt`）；FFmpeg 上游以 LGPL-2.1-or-later 为主，
  若构建时启用 `--enable-gpl` 则整体按 GPL 分发。本包携带的库见下表，其中 `libx264`、`libx265`
  在上游 FFmpeg 生态中属于 GPL 授权的第三方组件。

本机实测该目录下的非 `av*` 动态库：

{libs}

上游 wheel 内没有 FFmpeg 的 `LICENSE` / `COPYING` 文本（`av.libs/` 下只有 DLL），因此这里只登记
组件与来源。如需补齐，可从 https://ffmpeg.org/legal.html 取 `COPYING.LGPLv2.1` / `COPYING.GPLv2`。
"""

PYTHON_NOTICE = """# 随包分发的 Python 运行时

PyInstaller 会把 CPython 及其依赖一起打进 `SubtitleSidecar.exe` / `_internal/`：

| 文件 | 组件 | 许可 |
| --- | --- | --- |
| `python314.dll`、`python3.dll` | CPython {python} | PSF-2.0，正文见同目录 `LICENSE.txt` |
| `libcrypto-3-x64.dll`、`libssl-3-x64.dll` | OpenSSL 3.x | Apache-2.0（上游未随包提供文本） |
| `libffi-8.dll` | libffi | MIT（上游 https://github.com/libffi/libffi） |
| `vcruntime140.dll`、`vcruntime140_1.dll`、`msvcp140.dll`、`MSVCP140_1.dll` | Microsoft Visual C++ 运行时 | 微软可再发行组件条款 |

`LICENSE.txt` 取自构建该 sidecar 的 CPython 安装目录。
"""

LUCIDE_LICENSE = """ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

说明：本文件正文抄自上游仓库 https://github.com/lucide-icons/lucide 的 LICENSE（ISC）。
界面图标是手工拷进 `frontend/src/icons/lucide/` 的 SVG，本机没有安装 lucide npm 包。
"""


def _site_packages() -> Path:
    return Path(sysconfig.get_paths()["purelib"])


def _dist_dir(prefix: str) -> Path:
    matches = sorted(p for p in _site_packages().glob(prefix + "*.dist-info") if p.is_dir())
    if not matches:
        raise SystemExit("[licenses] missing dist-info for " + prefix + " in " + str(_site_packages()))
    return matches[-1]


def _version(name: str) -> str:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return "unknown"


def _copy(src: Path, dest_root: Path, rel: str) -> None:
    if not src.is_file():
        raise SystemExit("[licenses] missing " + str(src))
    dst = dest_root / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def _python_license() -> Path:
    for base in (sys.base_prefix, sys.prefix):
        for name in ("LICENSE.txt", "LICENSE"):
            candidate = Path(base) / name
            if candidate.is_file():
                return candidate
    raise SystemExit("[licenses] cannot find the CPython LICENSE.txt next to " + sys.base_prefix)


def _ffmpeg_libs() -> str:
    libs_dir = _site_packages() / "av.libs"
    if not libs_dir.is_dir():
        return "    （未找到 av.libs；该构建可能没有随包 FFmpeg 动态库）"
    names = sorted(p.name for p in libs_dir.glob("*.dll") if not p.name.lower().startswith("av"))
    if not names:
        return "    （av.libs 下没有非 av* 动态库）"
    lines = []
    for i in range(0, len(names), 3):
        lines.append("    " + "  ".join(names[i:i + 3]))
    return "\n".join(lines)


def _readme(versions: dict) -> str:
    rows = [
        ("CPython", versions["python"], "`python/LICENSE.txt`、`python/NOTICE.md`", "PSF-2.0"),
        ("numpy", versions["numpy"], "`numpy/LICENSE.txt`、`numpy/bundled/**`", "BSD-3-Clause"),
        ("OpenCV", versions["opencv"], "`opencv/LICENSE.txt`、`opencv/LICENSE-3RD-PARTY.txt`", "MIT / Apache-2.0"),
        ("ONNX Runtime (DirectML)", versions["ort"], "`onnxruntime/LICENSE`、`onnxruntime/ThirdPartyNotices.txt`", "MIT"),
        ("DirectML.dll", versions["ort"], "`directml/NOTICE.md`", "MIT"),
        ("PyAV", versions["av"], "`pyav/LICENSE.txt`、`pyav/FFMPEG-NOTICE.md`", "BSD-3-Clause"),
        ("FFmpeg（PyAV 内置）", versions["av"], "`pyav/FFMPEG-NOTICE.md`", "LGPL-2.1+ / 含 GPL 组件"),
        ("pyclipper", versions["pyclipper"], "`pyclipper/LICENSE`", "MIT"),
        ("Shapely / GEOS", versions["shapely"], "`shapely/LICENSE.txt`、`LICENSE_GEOS`、`LICENSE_win32`", "BSD-3-Clause / LGPL-2.1"),
        ("Pillow", versions["pillow"], "`pillow/LICENSE`", "MIT-CMU"),
        ("PyInstaller", versions["pyinstaller"], "`pyinstaller/COPYING.txt`", "GPLv2+ 与打包例外"),
        ("Lucide 图标", "未固定", "`lucide/LICENSE`", "ISC"),
    ]
    table = "\n".join("| {} | {} | {} | {} |".format(*row) for row in rows)
    return """# 第三方许可文本（随包分发）

本目录由 `tools/collect_licenses.py` 在构建时从已安装的 wheel / 解释器目录生成，
打包时由 `SubtitleSidecar.spec` 原样复制到 `resources/sidecar/_internal/licenses/`。

| 组件 | 版本 | 随包文件 | 许可（上游声明） |
| --- | --- | --- | --- |
{}

说明：上游 wheel 未随包提供许可文本的组件（DirectML、FFmpeg、OpenSSL 等）用 `NOTICE.md`
记录组件、版本、上游地址与许可类型。模型权重不在本目录，来源与许可由项目团队单独留档。
""".format(table)


def collect(dest: Path) -> Path:
    """Write the license bundle to *dest* and return it."""
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)

    for prefix, rel_src, rel_dst in DIST_FILES:
        _copy(_dist_dir(prefix) / rel_src, dest, rel_dst)

    numpy_bundled = _dist_dir("numpy-") / "licenses" / "numpy"
    if numpy_bundled.is_dir():
        shutil.copytree(numpy_bundled, dest / "numpy" / "bundled", dirs_exist_ok=True)

    ort_dir = _site_packages() / "onnxruntime"
    _copy(ort_dir / "LICENSE", dest, "onnxruntime/LICENSE")
    _copy(ort_dir / "ThirdPartyNotices.txt", dest, "onnxruntime/ThirdPartyNotices.txt")

    _copy(_python_license(), dest, "python/LICENSE.txt")

    versions = {
        "python": sys.version.split()[0],
        "numpy": _version("numpy"),
        "opencv": _version("opencv-python"),
        "ort": _version("onnxruntime-directml") if _version("onnxruntime-directml") != "unknown" else _version("onnxruntime"),
        "av": _version("av"),
        "pyclipper": _version("pyclipper"),
        "shapely": _version("shapely"),
        "pillow": _version("pillow"),
        "pyinstaller": _version("pyinstaller"),
    }

    (dest / "directml").mkdir(parents=True, exist_ok=True)
    (dest / "directml" / "NOTICE.md").write_text(
        DIRECTML_NOTICE.format(ort=versions["ort"]), encoding="utf-8", newline="\n")
    (dest / "pyav").mkdir(parents=True, exist_ok=True)
    (dest / "pyav" / "FFMPEG-NOTICE.md").write_text(
        FFMPEG_NOTICE.format(av=versions["av"], libs=_ffmpeg_libs()), encoding="utf-8", newline="\n")
    (dest / "python" / "NOTICE.md").write_text(
        PYTHON_NOTICE.format(python=versions["python"]), encoding="utf-8", newline="\n")
    (dest / "lucide").mkdir(parents=True, exist_ok=True)
    (dest / "lucide" / "LICENSE").write_text(LUCIDE_LICENSE, encoding="utf-8", newline="\n")
    (dest / "README.md").write_text(_readme(versions), encoding="utf-8", newline="\n")

    print("[licenses] generated " + str(dest))
    return dest


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build-sidecar") / "licenses"
    collect(target)
