# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

from PyInstaller.utils.hooks import (collect_data_files, collect_dynamic_libs,
                                     collect_submodules)


# The sidecar is the OCR backend for the Electron front end
# (SIDECAR_API.md).  It is deliberately built as a *console* onedir bundle:
# the protocol runs over stdin/stdout, and a windowed (console=False) build
# would set sys.stdout to None on Windows.
#
# The runtime is taken from the checkout next to this spec so a broken build
# fails here instead of on the user's machine.
SPEC_ROOT = Path(SPECPATH).resolve()
AVL_OPEN_ROOT = SPEC_ROOT / 'avl-open'
AVL_OPEN_PACKAGE = AVL_OPEN_ROOT / 'avl_open_ocr'
MODEL_DIR = AVL_OPEN_PACKAGE / 'model_files'

if not (SPEC_ROOT / 'sidecar_main.py').is_file():
    raise SystemExit('[build] sidecar_main.py is missing from ' + str(SPEC_ROOT))
if not (AVL_OPEN_PACKAGE / '__init__.py').is_file():
    raise SystemExit(
        '[build] avl-open sources not found: {}\n'
        '        Run build_sidecar_windows.bat from the project root.'.format(
            AVL_OPEN_PACKAGE))
# Every head the picker can reach has to be in the checkout; a missing
# file here would only show up as a runtime error on the user machine.
REQUIRED_MODELS = (
    'res18-db-damo_mixed.onnx',          # text detector
    'paddle_v6_rec_small.onnx',          # multilingual recognizer
    'paddle_v6_dict.txt',
    'korean_PP-OCRv5_mobile_rec.onnx',   # Korean recognizer (ONNX export)
    'korean_v5_dict.txt',
)
missing = [name for name in REQUIRED_MODELS if not (MODEL_DIR / name).is_file()]
if missing:
    raise SystemExit(
        '[build] missing OCR model files in {}: {}\n'
        '        The sidecar cannot run standalone without them; aborting.'.format(
            MODEL_DIR, ', '.join(missing)))

if str(AVL_OPEN_ROOT) not in sys.path:
    sys.path.insert(0, str(AVL_OPEN_ROOT))

datas = collect_data_files('avl_open_ocr') + collect_data_files('shapely')


def _is_bundled_model(source) -> bool:
    """model_files 里只有 REQUIRED_MODELS 允许进包。

    collect_data_files 会把整个 model_files 目录收进来，而里面除了运行时必需的
    五个文件，还躺着两个可选识别头（paddle_v5_rec_sft.onnx 80.6 MB、
    paddle_v6_rec_tiny.onnx 4.3 MB，只有 avl-open CLI 手动指定才会加载）和韩文
    PIR 转换源目录（13 MB + HF 下载缓存）。这些一律不进发行包。
    """
    path = str(source).replace('\\', '/')
    if '/avl_open_ocr/model_files/' not in path:
        return True
    return path.rsplit('/', 1)[-1] in REQUIRED_MODELS


datas = [(source, dest) for source, dest in datas if _is_bundled_model(source)]
# editable 安装下 PyInstaller 可能一个数据文件都收不到，这时按白名单逐个补，
# 而不是把整个 model_files 塞进去（那样又会把上面那些可选头带进来）。
if not any(str(source).lower().endswith('.onnx') for source, _dest in datas):
    datas.extend((str(MODEL_DIR / name), 'avl_open_ocr/model_files')
                 for name in REQUIRED_MODELS)

# 第三方许可文本随包（清单见 licenses/README.md）。装到用户机上后的位置是
# resources\sidecar\_internal\licenses\ —— 漏了只有在用户机器上才会发现，所以这里
# 跟模型一样按白名单校验，缺一个文件就让构建失败。
# 本地 licenses\ 是人工复核过的版本；没有这份目录时（例如干净的源码检出）就从
# 当前虚拟环境已安装的 wheel 生成一份，保证构建不依赖某个未入库的目录。
LICENSE_DIR = SPEC_ROOT / 'licenses'
if not LICENSE_DIR.is_dir():
    if str(SPEC_ROOT) not in sys.path:
        sys.path.insert(0, str(SPEC_ROOT))
    from tools.collect_licenses import collect
    LICENSE_DIR = collect(SPEC_ROOT / 'build-sidecar' / 'licenses')
REQUIRED_LICENSES = (
    'README.md',
    'python/LICENSE.txt',
    'python/NOTICE.md',
    'numpy/LICENSE.txt',
    'onnxruntime/LICENSE',
    'onnxruntime/ThirdPartyNotices.txt',
    'directml/NOTICE.md',
    'opencv/LICENSE.txt',
    'opencv/LICENSE-3RD-PARTY.txt',
    'pyav/LICENSE.txt',
    'pyav/FFMPEG-NOTICE.md',
    'pyclipper/LICENSE',
    'shapely/LICENSE.txt',
    'shapely/LICENSE_GEOS',
    'shapely/LICENSE_win32',
    'pillow/LICENSE',
    'pyinstaller/COPYING.txt',
    'lucide/LICENSE',
)
missing_licenses = [name for name in REQUIRED_LICENSES
                    if not (LICENSE_DIR / name).is_file()]
if missing_licenses:
    raise SystemExit(
        '[build] missing third-party license files in {}: {}\n'
        '        See the build-time licenses folder for the expected set.'.format(
            LICENSE_DIR, ', '.join(missing_licenses)))
datas.append((str(LICENSE_DIR), 'licenses'))

binaries = collect_dynamic_libs('shapely')
hiddenimports = sorted(set(collect_submodules('avl_open_ocr')) | {
    'avl_open_ocr',
    'onnxruntime',
    'cv2',
    'numpy',
    'pyclipper',
    'shapely',
    'shapely.geometry',
    # Imported lazily by sidecar/kernel.py.
    'app.ocr_engine',
    'app.srt',
    # sidecar/frames.py encodes the still frame as JPEG.
    'PIL',
    'PIL.Image',
})

# PyAV powers mkv/avi preview re-wrapping (SIDECAR_API.md §11).  It is
# optional: without it the sidecar still recognises audio/video, it just
# reports "cannot preview" for containers Chromium does not play.
try:
    import av  # noqa: F401

    hiddenimports.extend(collect_submodules('av'))
    binaries += collect_dynamic_libs('av')
    print('[build] PyAV found: preview re-wrapping is enabled')
except ImportError:
    print('[build] PyAV not installed: preview will be unavailable for mkv/avi')

# Nothing the sidecar imports pulls these in; they only bloat the bundle.
excludes = [
    'torch', 'torchvision', 'torchgen', 'sympy', 'nltk', 'scenedetect',
    'matplotlib', 'pandas', 'IPython', 'pytest', 'notebook', 'tkinter',
]

# UPX is deliberately off.  Compressing a PyInstaller onedir with UPX is a
# classic source of (a) antivirus false positives and (b) silently corrupted
# native DLLs (onnxruntime / opencv ship large ones).  The saved size is not
# worth a build that behaves differently on the customer's machine.

a = Analysis(
    ['sidecar_main.py'],
    pathex=[str(AVL_OPEN_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='SubtitleSidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='SubtitleSidecar',
)
