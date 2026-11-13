"""Does this CPU have AVX / AVX2?

Bun only says "CPU lacks AVX support" inside a crash banner, so a healthy run
leaves no trace of the condition we are testing for. The Windows answer comes
from kernel32!IsProcessorFeaturePresent -- the same detection ocx-start.py uses
to decide whether Bun is safe to run here.
"""
import ctypes
import os
import platform
import subprocess
import sys

PF_XSAVE_ENABLED = 38
PF_AVX_INSTRUCTIONS_AVAILABLE = 39
PF_AVX2_INSTRUCTIONS_AVAILABLE = 40


def detect():
    if sys.platform == "win32":
        try:
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            present = k32.IsProcessorFeaturePresent
            present.argtypes = [ctypes.c_uint]
            present.restype = ctypes.c_bool
            return {
                "avx": bool(present(PF_AVX_INSTRUCTIONS_AVAILABLE)),
                "avx2": bool(present(PF_AVX2_INSTRUCTIONS_AVAILABLE)),
                "xsave": bool(present(PF_XSAVE_ENABLED)),
                "source": "kernel32!IsProcessorFeaturePresent",
            }
        except Exception as exc:  # noqa: BLE001 - diagnostics must never fail the run
            return {"avx": None, "avx2": None, "source": "error:%s" % exc}
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/cpuinfo", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if line.lower().startswith("flags"):
                        flags = line.split(":", 1)[1].split()
                        return {
                            "avx": "avx" in flags,
                            "avx2": "avx2" in flags,
                            "source": "/proc/cpuinfo",
                        }
        except Exception:
            pass
    return {"avx": None, "avx2": None, "source": "unknown"}


def cpu_name():
    if sys.platform == "win32":
        try:
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            # GetNativeSystemInfo -> SYSTEM_INFO -> wProcessorArchitecture
            return platform.processor() or platform.node()
        except Exception:
            return platform.node()
    return platform.processor() or platform.node()


if __name__ == "__main__":
    info = detect()
    print("CPU=%s" % cpu_name())
    print(
        "AVX=%s  AVX2=%s  (source=%s)"
        % (info.get("avx"), info.get("avx2"), info.get("source"))
    )
    if info.get("avx") is None:
        print("WARNING: AVX is UNKNOWN here -- do not read it as False.")
    elif info.get("avx") is False:
        print("CONFIRMED: this CPU has NO AVX -> Bun runs its baseline (no_avx) build.")
