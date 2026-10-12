"""Shared plumbing: path sandbox, argv validation, bounded subprocess runner."""

from __future__ import annotations

import functools
import os
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from typing import Any, Callable

OUTPUT_CAP = 64 * 1024
MAX_TIMEOUT = 600
DEFAULT_ROOTS = ("/home/vmuser", "/tmp", "/opt/re-samples")


class ToolError(Exception):
    """Raised for caller errors (bad path, bad argv); converted to an error dict."""


def work_root() -> str:
    return os.environ.get("RE_TOOLBOX_WORK", "/tmp/re-toolbox")


def re_python() -> str:
    return os.environ.get("RE_PYTHON", "/opt/re-venv/bin/python")


def allowed_roots() -> list[str]:
    roots = list(DEFAULT_ROOTS)
    extra = os.environ.get("RE_TOOLBOX_ROOTS", "")
    roots += [r for r in extra.split(":") if r.strip()]
    return [os.path.realpath(r) for r in roots]


def check_path(p: Any, *, must_exist: bool = True, what: str = "path") -> str:
    """Resolve `p` (realpath) and require it to sit under an allowed root."""
    if not isinstance(p, str) or not p or "\x00" in p:
        raise ToolError(f"{what} must be a non-empty string")
    rp = os.path.realpath(p)
    for root in allowed_roots():
        if rp == root or rp.startswith(root.rstrip(os.sep) + os.sep):
            break
    else:
        raise ToolError(
            f"{what} {p!r} resolves to {rp!r}, outside allowed roots: "
            + ", ".join(allowed_roots())
        )
    if must_exist and not os.path.exists(rp):
        raise ToolError(f"{what} {rp!r} does not exist")
    return rp


def check_argv(argv: Any, *, what: str = "command") -> list[str]:
    if not isinstance(argv, list) or not argv:
        raise ToolError(f"{what} must be a non-empty list of strings")
    for a in argv:
        if not isinstance(a, str):
            raise ToolError(f"{what} contains a non-string element: {a!r}")
        if "\x00" in a:
            raise ToolError(f"{what} contains a NUL byte")
    return list(argv)


def check_command(argv: Any, *, what: str = "command") -> list[str]:
    """Validate argv; if argv[0] is a path (contains '/'), sandbox it."""
    argv = check_argv(argv, what=what)
    if os.sep in argv[0]:
        argv[0] = check_path(argv[0], what=f"{what}[0]")
    return argv


def clamp_timeout(t: Any) -> float:
    if isinstance(t, bool) or not isinstance(t, (int, float)):
        raise ToolError("timeout_s must be a number")
    return float(min(max(t, 1), MAX_TIMEOUT))


def new_workdir(kind: str) -> str:
    d = os.path.join(work_root(), kind, uuid.uuid4().hex)
    os.makedirs(d, exist_ok=True)
    return d


def missing(binary: str) -> dict[str, Any]:
    return {
        "error": f"required binary not found on PATH: {binary}",
        "missing_binary": binary,
        "exit_code": None,
    }


def have(binary: str) -> bool:
    return shutil.which(binary) is not None


def read_tail(path: str, cap: int = OUTPUT_CAP) -> tuple[str, bool]:
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > cap:
                f.seek(size - cap)
            data = f.read(cap)
    except OSError:
        return "", False
    return data.decode("utf-8", "replace"), size > cap


def _tail_fp(fp, cap: int = OUTPUT_CAP) -> tuple[str, bool]:
    fp.flush()
    size = fp.seek(0, os.SEEK_END)
    fp.seek(max(0, size - cap))
    return fp.read(cap).decode("utf-8", "replace"), size > cap


def kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except OSError:
            pass


def run_cmd(argv: list[str], timeout_s: Any = 30, cwd: str | None = None) -> dict[str, Any]:
    """Run argv (never via a shell) with a hard timeout and tail-capped output."""
    timeout = clamp_timeout(timeout_s)
    exe = argv[0]
    if os.sep not in exe and shutil.which(exe) is None:
        return missing(exe)
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        t0 = time.monotonic()
        try:
            proc = subprocess.Popen(
                argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                cwd=cwd, start_new_session=True,
            )
        except FileNotFoundError:
            return missing(exe)
        except OSError as e:
            return {"error": f"cannot execute {exe}: {e}", "exit_code": None}
        timed_out = False
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(proc)
            proc.wait()
        dur = round(time.monotonic() - t0, 3)
        so, t1 = _tail_fp(out)
        se, t2 = _tail_fp(err)
    res: dict[str, Any] = {
        "exit_code": proc.returncode,
        "stdout": so,
        "stderr": se,
        "truncated": t1 or t2,
        "duration_s": dur,
        "timed_out": timed_out,
    }
    if timed_out:
        res["error"] = f"timed out after {timeout:g}s; process group killed"
    return res


def safe(fn: Callable[..., dict]) -> Callable[..., dict]:
    """Turn ToolError into an error dict so tools never raise to the agent."""

    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except ToolError as e:
            return {"error": str(e), "exit_code": None}

    return wrapper
