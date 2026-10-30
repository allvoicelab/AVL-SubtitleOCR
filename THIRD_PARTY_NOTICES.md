# 第三方组件说明

AVL-SubtitleOCR 使用以下第三方模型、组件和资源。其版权属于各自的作者或权利人，并适用各自的许可证。本项目自有代码与文档的许可证见 [LICENSE](LICENSE)。

## OCR 模型

本项目的文字检测使用 [DamoDBNet 来源的模型](https://modelscope.cn/models/iic/cv_resnet18_ocr-detection-db-line-level_damo)，文字识别使用 [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 来源的模型与字符表。相关模型转换为 ONNX 格式后，由 [ONNX Runtime](https://github.com/microsoft/onnxruntime) 在本机执行推理。

PaddleOCR 上游项目采用 [Apache License 2.0](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)。上游模型权重与字符表的版权归其原始权利人所有，ONNX 转换产物保留原模型适用的许可；AVL-SubtitleOCR 不主张拥有上游模型的版权。

## 主要组件与许可

下表列出主要上游项目的许可信息。各发行版本所包含组件及其子依赖的授权范围，以对应版本的许可文件为准。

| 项目 / 组件 | 用途 | 上游许可 |
| --- | --- | --- |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 文字识别模型与字符表 | [Apache-2.0](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)；模型适用其对应授权 |
| [DamoDBNet](https://modelscope.cn/models/iic/cv_resnet18_ocr-detection-db-line-level_damo) | 文字检测模型 | [Apache-2.0（模型页声明）](https://www.modelscope.cn/models/iic/cv_resnet18_ocr-detection-db-line-level_damo/quickstart)；模型适用其对应授权 |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | 本地模型推理 | [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) |
| [DirectML](https://github.com/microsoft/DirectML) | Windows GPU 推理 | 运行时适用微软对应版本的软件许可条款，见 [官方包许可入口](https://www.nuget.org/packages/Microsoft.AI.DirectML) |
| [Electron](https://github.com/electron/electron) | 桌面应用运行时 | [MIT](https://github.com/electron/electron/blob/main/LICENSE)；Chromium 及内置组件另有许可声明 |
| [CPython](https://www.python.org/) | Python 后端运行时 | [PSF / Python 许可及相关声明](https://docs.python.org/3/license.html) |
| [OpenCV](https://github.com/opencv/opencv) | 视频读取与图像处理 | [Apache-2.0](https://github.com/opencv/opencv/blob/4.x/LICENSE)；内置第三方库另有许可声明 |
| [PyAV](https://github.com/PyAV-Org/PyAV) | 视频预览、重封装与帧解码 | [BSD-3-Clause](https://github.com/PyAV-Org/PyAV/blob/master/LICENSE.txt) |
| [FFmpeg](https://ffmpeg.org/) | 视频编解码基础库 | [LGPL / GPL，取决于构建及所用组件](https://ffmpeg.org/legal.html) |
| [NumPy](https://numpy.org/) | 数组与数值计算 | [BSD-3-Clause 及内置组件许可](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| [Pillow](https://python-pillow.github.io/) | 图像编解码 | [MIT-CMU 及内置组件许可](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| [PyClipper](https://github.com/fonttools/pyclipper) | 多边形处理 | [MIT](https://github.com/fonttools/pyclipper/blob/main/LICENSE) |
| [Shapely](https://github.com/shapely/shapely) / [GEOS](https://libgeos.org/) | 检测框几何运算 | [Shapely：BSD-3-Clause](https://github.com/shapely/shapely/blob/main/LICENSE.txt)；[GEOS：LGPL-2.1-or-later](https://github.com/libgeos/geos/blob/main/COPYING) |
| [Lucide](https://lucide.dev/) | 界面图标 | [ISC / MIT](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |

## 构建工具

本项目使用 [PyInstaller](https://pyinstaller.org/) 和 [electron-builder](https://github.com/electron-userland/electron-builder) 构建桌面发行包。PyInstaller 采用 [GPL 与官方打包例外](https://pyinstaller.org/en/stable/license.html)；electron-builder 采用 [MIT](https://github.com/electron-userland/electron-builder/blob/master/LICENSE)。

## 发行包中的许可材料

许可材料的目录索引如下：

| 位置 | 内容 |
| --- | --- |
| `LICENSE.electron.txt` | Electron 许可 |
| `LICENSES.chromium.html` | Chromium 及相关第三方组件的许可声明 |
| `resources/sidecar/_internal/licenses/` | Python 后端所附的第三方许可与声明 |

该目录索引不表示已覆盖全部组件。第三方的版权、许可及源码提供义务均由其相应许可证规定，本文件不对这些条款作出修改。

## 致谢与引用

感谢上述项目的作者与贡献者。如在研究或评测中使用相关模型，请参阅 [PaddleOCR 官方引用说明](https://github.com/PaddlePaddle/PaddleOCR#-citation)，引用实际使用的模型与对应工作。
