"""ONNX Runtime 执行器的选择（CPU / DirectML / CUDA）。

Windows 上打包的是 ``onnxruntime-directml``：同一份二进制里同时带 DirectML
和 CPU 两个执行器，所以 GPU 加速不需要用户再装 CUDA / cuDNN，也不挑显卡品牌
（N 卡 / A 卡 / Intel 核显都走 DirectX 12），用不了的时候直接回落 CPU——界面
只显示"实际生效的设备"，不让用户以为开了 GPU 其实没开。
"""
from __future__ import annotations

DML_PROVIDER = "DmlExecutionProvider"
CUDA_PROVIDER = "CUDAExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
GPU_PROVIDERS = (DML_PROVIDER, CUDA_PROVIDER)
#: ``auto`` = 有 GPU 执行器就用，否则 CPU（默认）；``cpu`` = 强制 CPU；
#: ``gpu`` = 优先 GPU，实在用不了仍然回落 CPU（不能让任务跑不起来）。
DEVICES = ("auto", "cpu", "gpu")

_LABELS = {DML_PROVIDER: "DirectML", CUDA_PROVIDER: "CUDA"}


def normalize_device(device) -> str:
    value = str(device or "").strip().lower()
    return value if value in DEVICES else "auto"


def provider_label(provider) -> str:
    return _LABELS.get(provider, str(provider or "GPU"))


def _available_providers() -> list:
    try:
        import onnxruntime as ort
    except ImportError:  # pragma: no cover - 调用方会给出更清楚的缺依赖报错
        return []
    try:
        return list(ort.get_available_providers())
    except Exception:  # pragma: no cover - 个别环境里 ORT 自己会炸
        return []


def onnx_runtime_info() -> dict:
    """当前运行时真正可用的加速方式（给界面和日志用）。"""
    providers = _available_providers()
    backend = next((name for name in GPU_PROVIDERS if name in providers), None)
    return {
        "providers": providers,
        "gpu": backend is not None,
        "backend": backend,
        "devices": list(DEVICES),
    }


def resolved_device(device) -> str:
    """把 auto / gpu / cpu 解析成实际会生效的设备。"""
    wanted = normalize_device(device)
    if wanted == "cpu" or not onnx_runtime_info()["gpu"]:
        return "cpu"
    return "gpu"


def describe_device(device) -> str:
    """一行描述，例如 "GPU（DirectML）" / "CPU（没有可用的 GPU 执行器）"。"""
    wanted = normalize_device(device)
    info = onnx_runtime_info()
    if resolved_device(wanted) == "cpu":
        if wanted != "cpu" and not info["gpu"]:
            return "CPU（没有可用的 GPU 执行器）"
        return "CPU"
    return f"GPU（{provider_label(info['backend'])}）"


def onnx_providers(device) -> list:
    """按设备选择 ORT 的 provider 列表（优先级从高到低）。

    不可用的执行器一律不写进去：ORT 遇到不认识的 provider 只会打一行警告，
    然后静默用 CPU 跑完，宿主根本看不出来。
    """
    if normalize_device(device) == "cpu":
        return [CPU_PROVIDER]
    picked = [name for name in GPU_PROVIDERS if name in _available_providers()]
    return picked + [CPU_PROVIDER] if picked else [CPU_PROVIDER]


def apply_provider_options(session_options, providers) -> None:
    """DirectML 的会话选项：动态 shape 时会踩到内存模式，按官方建议关掉。"""
    if DML_PROVIDER in (providers or []):
        session_options.enable_mem_pattern = False


def serialize_runs(providers) -> bool:
    """Whether ONNX sessions must be run one at a time (GPU execution).

    DirectML runs fused graph dispatches on the GPU.  Letting the detect
    pool and the recognize thread call ``Run`` at the same time makes the
    device hang (DXGI_ERROR_DEVICE_HUNG / 0x887A0006); ONNX Runtime then
    raises from ``DmlGraphFusionHelper`` and the host process dies with
    0xC0000005, which the front end shows as "backend exited".  Longer
    clips only make the hang more likely.  CPU execution has no such
    constraint, so there the pools keep running in parallel.
    """
    return any(name in GPU_PROVIDERS for name in (providers or []))
