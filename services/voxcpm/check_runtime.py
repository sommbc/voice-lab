#!/usr/bin/env python3
import importlib
import os
import platform
import sys
from importlib import metadata


DEFAULT_MODEL = "openbmb/VoxCPM2"
REQUIRED_MODULES = (
    "fastapi",
    "pydantic",
    "numpy",
    "soundfile",
    "voxcpm",
    "torch",
    "torchaudio",
)


def main() -> int:
    print(f"python: {platform.python_version()} ({sys.executable})")
    print(f"VOXCPM_MODEL: {os.environ.get('VOXCPM_MODEL', DEFAULT_MODEL)}")
    print(f"VOXCPM_DEVICE: {os.environ.get('VOXCPM_DEVICE', 'auto')}")

    missing: list[str] = []
    imported: dict[str, object] = {}

    for module_name in REQUIRED_MODULES:
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            missing.append(module_name)
            print(f"{module_name}: fail {exc.__class__.__name__}: {exc}")
            continue

        imported[module_name] = module
        print(f"{module_name}: ok {module_version(module_name, module)}")

    torch = imported.get("torch")
    if torch is None:
        print("torch cuda available: unknown")
        print("torch cuda device count: unknown")
    else:
        cuda_available = bool(torch.cuda.is_available())
        device_count = int(torch.cuda.device_count())
        print(f"torch cuda available: {cuda_available}")
        print(f"torch cuda device count: {device_count}")
        if device_count > 0:
            for index in range(device_count):
                try:
                    print(f"torch cuda device {index}: {torch.cuda.get_device_name(index)}")
                except Exception as exc:
                    print(f"torch cuda device {index}: unavailable ({exc.__class__.__name__})")

    if missing:
        print(f"runtime check: fail missing modules: {', '.join(missing)}")
        return 1

    print("runtime check: ok")
    return 0


def module_version(module_name: str, module: object) -> str:
    version = getattr(module, "__version__", None)
    if isinstance(version, str) and version:
        return version

    try:
        return metadata.version(module_name)
    except metadata.PackageNotFoundError:
        return "unknown"


if __name__ == "__main__":
    raise SystemExit(main())
