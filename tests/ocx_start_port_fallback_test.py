"""Isolated unit tests for ocx-start.py port-fallback helpers.

Uses ports in the high range (54321+) so we never collide with the real
proxy on 10100. Each test binds a TCP listener only as long as it needs,
then closes it, so successive tests can reuse ports.

Run:
    python tests/ocx_start_port_fallback_test.py
Exit code 0 = all pass; non-zero = at least one failed.
"""
import socket
import sys
import tempfile
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OCX = ROOT / "ocx-start.py"

# Load ocx-start.py as a module, but neutralise the __main__ guard so the
# interactive menu does not start.
src = OCX.read_text(encoding="utf-8")
src = src.replace('if __name__ == "__main__":', 'if False and __name__ == "__main__":')
# Build a module manually with __file__ pre-set so module-level Path(__file__) works.
mod = type(sys)("ocx_start_test_module")
mod.__file__ = str(OCX)
mod.__package__ = ""
exec(compile(src, str(OCX), "exec"), mod.__dict__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def bind(port: int) -> socket.socket:
    """Bind a TCP listener on 127.0.0.1:port; return the socket (caller closes)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
    s.listen(1)
    return s


class StubPrompt:
    """In-process replacement for prompt_with_echo_and_timeout.

    Queues canned responses so we can simulate user input without TTY.
    """
    def __init__(self, queue):
        self.queue = list(queue)

    def __call__(self, *_args, **_kwargs):
        if self.queue:
            return self.queue.pop(0)
        return None  # timeout


# ---------------------------------------------------------------------------
# T1: is_port_busy — false when free, true when bound
# ---------------------------------------------------------------------------

assert mod.is_port_busy(54321, host="127.0.0.1", timeout=0.2) is False
print("[T1.1] is_port_busy(54321 free) = False  OK")

srv = bind(54321)
try:
    assert mod.is_port_busy(54321, host="127.0.0.1", timeout=0.3) is True
    print("[T1.2] is_port_busy(54321 bound) = True  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T2: suggest_next_free_port — must skip the busy port
# ---------------------------------------------------------------------------

srv = bind(54322)
try:
    nxt = mod.suggest_next_free_port(54322, host="127.0.0.1", max_scan=20)
    assert nxt is not None and nxt != 54322, f"got {nxt}"
    print(f"[T2.1] suggest_next_free_port(54322 busy) = {nxt}  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T3: resolve_runtime_port — user accepts suggested (free) port
# ---------------------------------------------------------------------------

srv = bind(54323)
try:
    mod.prompt_with_echo_and_timeout = StubPrompt([""])
    out = mod.resolve_runtime_port(54323, max_attempts=5, timeout_sec=5)
    assert out != 54323, f"should NOT return 54323 (busy), got {out}"
    print(f"[T3] user accepts default -> {out}  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T4: resolve_runtime_port — user types 'n' -> fall through to bun fallback
# ---------------------------------------------------------------------------

srv = bind(54324)
try:
    mod.prompt_with_echo_and_timeout = StubPrompt(["n"])
    out = mod.resolve_runtime_port(54324, max_attempts=5, timeout_sec=5)
    assert out == 54324, f"user typed 'n' should fall back to original 54324, got {out}"
    print(f"[T4] user types 'n' -> {out} (bun fallback)  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T5: resolve_runtime_port — timeout (empty queue) -> bun fallback
# ---------------------------------------------------------------------------

srv = bind(54325)
try:
    mod.prompt_with_echo_and_timeout = StubPrompt([])
    out = mod.resolve_runtime_port(54325, max_attempts=5, timeout_sec=5)
    assert out == 54325, f"timeout should fall back to original, got {out}"
    print(f"[T5] prompt times out -> {out} (bun fallback)  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T6: resolve_runtime_port — user types same busy port -> bun fallback
# ---------------------------------------------------------------------------

srv = bind(54326)
try:
    mod.prompt_with_echo_and_timeout = StubPrompt(["54326"])
    out = mod.resolve_runtime_port(54326, max_attempts=5, timeout_sec=5)
    assert out == 54326, f"user stuck on busy port should fall back, got {out}"
    print(f"[T6] user sticks with busy port -> {out} (bun fallback)  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T7: resolve_runtime_port — garbage input -> falls back to suggested (free)
# ---------------------------------------------------------------------------

srv = bind(54327)
try:
    mod.prompt_with_echo_and_timeout = StubPrompt(["garbage"])
    out = mod.resolve_runtime_port(54327, max_attempts=5, timeout_sec=5)
    assert out != 54327, f"garbage input should accept suggested, got {out}"
    print(f"[T7] garbage input -> {out} (suggested free port)  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T8: resolve_runtime_port — out-of-range input (70000) -> loop continues
# ---------------------------------------------------------------------------

srv = bind(54328)
try:
    # First input is out-of-range; second is the default (empty -> suggested)
    mod.prompt_with_echo_and_timeout = StubPrompt(["70000", ""])
    out = mod.resolve_runtime_port(54328, max_attempts=5, timeout_sec=5)
    assert out != 54328 and 1 <= out <= 65535, f"got {out}"
    print(f"[T8] out-of-range (70000) then accept default -> {out}  OK")
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T9: resolve_runtime_port — max_attempts hit (always busy) -> bun fallback
# ---------------------------------------------------------------------------

srv = bind(54329)
try:
    # Each user input is also busy (port +1) — bind that too
    srv2 = bind(54330)
    try:
        mod.prompt_with_echo_and_timeout = StubPrompt(["54330"] * 10)
        out = mod.resolve_runtime_port(54329, max_attempts=3, timeout_sec=5)
        assert out == 54329, f"max_attempts exceeded should fall back to 54329, got {out}"
        print(f"[T9] max_attempts exceeded -> {out} (bun fallback)  OK")
    finally:
        srv2.close()
finally:
    srv.close()

# ---------------------------------------------------------------------------
# T10: read_runtime_port_file — returns None when file absent
# ---------------------------------------------------------------------------

# Use a temp HOME so we never collide with the real ~/.opencodex/runtime-port.json
with tempfile.TemporaryDirectory() as tmp_home:
    real_home = mod.Path.home
    mod.Path.home = classmethod(lambda cls: Path(tmp_home))
    try:
        val = mod.read_runtime_port_file()
        assert val is None, f"expected None with empty HOME, got {val}"
        print(f"[T10] read_runtime_port_file(empty HOME) = None  OK")
    finally:
        mod.Path.home = real_home

# ---------------------------------------------------------------------------
# T11: read_runtime_port_file — returns port from a synthetic file
# ---------------------------------------------------------------------------

with tempfile.TemporaryDirectory() as tmp_home:
    real_home = mod.Path.home
    mod.Path.home = classmethod(lambda cls: Path(tmp_home))
    try:
        ocx_dir = Path(tmp_home) / ".opencodex"
        ocx_dir.mkdir(parents=True, exist_ok=True)
        (ocx_dir / "runtime-port.json").write_text('{"pid": 99999, "port": 54331}\n', encoding="utf-8")
        val = mod.read_runtime_port_file()
        assert val == 54331, f"expected 54331, got {val}"
        print(f"[T11] read_runtime_port_file(synthetic 54331) = {val}  OK")
    finally:
        mod.Path.home = real_home

# ---------------------------------------------------------------------------
# T12: read_runtime_port_file — malformed JSON returns None
# ---------------------------------------------------------------------------

with tempfile.TemporaryDirectory() as tmp_home:
    real_home = mod.Path.home
    mod.Path.home = classmethod(lambda cls: Path(tmp_home))
    try:
        ocx_dir = Path(tmp_home) / ".opencodex"
        ocx_dir.mkdir(parents=True, exist_ok=True)
        (ocx_dir / "runtime-port.json").write_text('not json {', encoding="utf-8")
        val = mod.read_runtime_port_file()
        assert val is None, f"expected None for malformed JSON, got {val}"
        print(f"[T12] read_runtime_port_file(malformed JSON) = None  OK")
    finally:
        mod.Path.home = real_home

print()
print("ALL 12 PORT-FALLBACK TESTS PASS")