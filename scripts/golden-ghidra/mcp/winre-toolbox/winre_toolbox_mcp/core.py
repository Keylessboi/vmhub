"""Shared plumbing: tool lookup, path sandbox, bounded subprocess runner.

The sandbox is written against a path module (`ntpath` on Windows, `posixpath`
elsewhere) so the Windows rules can be unit-tested on Linux with ntpath.
"""

from __future__ import annotations

import functools
import ntpath
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from typing import Any, Callable

OUTPUT_CAP = 64 * 1024
MAX_TIMEOUT = 600
IS_WINDOWS = os.name == "nt"

DEFAULT_ROOTS_WIN = (
    r"C:\Users\vmhub",
    r"C:\Users\Public",
    r"C:\Tools\re-samples",
    r"C:\Windows\Temp",
)
DEFAULT_ROOTS_POSIX = ("/tmp",)

# name -> default install location (from install-windows-re-tools.ps1).
# Override any of them with env RE_TOOL_<NAME> (upper case), e.g. RE_TOOL_SIGCHECK.
SYSINT = r"C:\Tools\sysinternals"
TOOL_DEFAULTS = {
    "sigcheck": SYSINT + r"\sigcheck64.exe",
    "strings": SYSINT + r"\strings64.exe",
    "handle": SYSINT + r"\handle64.exe",
    "listdlls": SYSINT + r"\Listdlls64.exe",
    "procdump": SYSINT + r"\procdump64.exe",
    "autorunsc": SYSINT + r"\autorunsc64.exe",
    "procmon": SYSINT + r"\Procmon64.exe",
    "diec": r"C:\Tools\die\diec.exe",
    "capa": r"C:\Tools\capa\capa.exe",
    "floss": r"C:\Tools\floss\floss.exe",
    "ilspycmd": r"C:\Tools\dotnet-tools\ilspycmd.exe",
    "tshark": r"C:\Program Files\Wireshark\tshark.exe",
}


class ToolError(Exception):
    """Raised for caller errors (bad path, bad argv); converted to an error dict."""


# --------------------------------------------------------------------------
# path sandbox
# --------------------------------------------------------------------------

def default_mod():
    return ntpath if IS_WINDOWS else posixpath


def work_root() -> str:
    default = r"C:\Windows\Temp\re-toolbox" if IS_WINDOWS else "/tmp/winre-toolbox"
    return os.environ.get("RE_TOOLBOX_WORK", default)


def roots_for(mod=None) -> list[str]:
    mod = mod or default_mod()
    roots = list(DEFAULT_ROOTS_WIN if mod is ntpath else DEFAULT_ROOTS_POSIX)
    sep = ";" if mod is ntpath else ":"
    extra = os.environ.get("RE_TOOLBOX_ROOTS", "")
    roots += [r.strip() for r in extra.split(sep) if r.strip()]
    return roots


_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")


def lexical_normalise(p: Any, mod) -> str:
    """Return the normalised absolute form of `p` or raise ToolError.

    Windows rules (mod is ntpath): drive-letter absolute paths only, no UNC or
    device paths (\\\\server\\share, \\\\?\\, \\\\.\\), no ':' beyond the drive
    (alternate data streams), no wildcards, no components with trailing
    dots/spaces (Win32 strips those, so '.. ' would act as '..').
    """
    if not isinstance(p, str) or not p or "\x00" in p:
        raise ToolError("path must be a non-empty string")
    if mod is ntpath:
        if p.startswith(("\\\\", "//")):
            raise ToolError(f"UNC and device paths are not allowed: {p!r}")
        if not _DRIVE_RE.match(p):
            raise ToolError(f"path must be an absolute drive path like C:\\dir\\file: {p!r}")
        if ":" in p[2:] or any(c in p for c in '*?"<>|'):
            raise ToolError(f"path contains forbidden characters (':', wildcard, quote or pipe): {p!r}")
        for comp in re.split(r"[\\/]+", p[3:]):
            if comp in ("", ".", ".."):
                continue
            if comp != comp.rstrip(" ."):
                raise ToolError(f"path component {comp!r} ends in a dot or space")
    else:
        if not p.startswith("/"):
            raise ToolError(f"path must be absolute: {p!r}")
    return mod.normpath(p)


def _inside(path: str, root: str, mod) -> bool:
    a = mod.normcase(path)
    r = mod.normcase(root).rstrip("\\/")
    return a == r or a.startswith(r + mod.sep)


def _real_default(p: str) -> str:
    # Resolves junctions/symlinks on the real filesystem.
    return os.path.realpath(p)


def check_path(p: Any, *, must_exist: bool = True, what: str = "path", mod=None,
               roots: list[str] | None = None, exists: Callable[[str], bool] | None = None,
               real: Callable[[str], str] | None = None) -> str:
    """Normalise `p`, require it under an allowed root (before AND after link resolution)."""
    mod = mod or default_mod()
    exists = exists or os.path.exists
    if real is None:
        real = _real_default if mod is default_mod() else (lambda x: x)
    try:
        norm = lexical_normalise(p, mod)
    except ToolError as e:
        raise ToolError(f"{what}: {e}") from None
    rts = [mod.normpath(r) for r in (roots if roots is not None else roots_for(mod))]
    if not any(_inside(norm, r, mod) for r in rts):
        raise ToolError(f"{what} {p!r} resolves to {norm!r}, outside allowed roots: " + ", ".join(rts))
    resolved = real(norm)
    if resolved and mod.normcase(resolved) != mod.normcase(norm):
        # junction / symlink: the target must also be inside a root
        res_n = mod.normpath(resolved)
        if res_n.startswith("\\\\?\\"):
            res_n = res_n[4:]
        allowed = rts + [mod.normpath(real(r)) for r in rts]
        if not any(_inside(res_n, r, mod) for r in allowed):
            raise ToolError(f"{what} {p!r} is a link that leads outside the allowed roots ({res_n!r})")
        norm = res_n
    if must_exist and not exists(norm):
        raise ToolError(f"{what} {norm!r} does not exist")
    return norm


def check_argv(argv: Any, *, what: str = "command") -> list[str]:
    if not isinstance(argv, list) or not argv:
        raise ToolError(f"{what} must be a non-empty list of strings")
    for a in argv:
        if not isinstance(a, str):
            raise ToolError(f"{what} contains a non-string element: {a!r}")
        if "\x00" in a:
            raise ToolError(f"{what} contains a NUL byte")
    return list(argv)


def check_command(argv: Any, *, what: str = "command", mod=None, **kw) -> list[str]:
    """Validate argv; argv[0] must be a full, sandboxed path to an existing file."""
    argv = check_argv(argv, what=what)
    if not any(c in argv[0] for c in "/\\"):
        raise ToolError(f"{what}[0] must be a full path to an executable under an allowed root")
    argv[0] = check_path(argv[0], what=f"{what}[0]", mod=mod, **kw)
    return argv


def clamp_timeout(t: Any) -> float:
    if isinstance(t, bool) or not isinstance(t, (int, float)):
        raise ToolError("timeout_s must be a number")
    return float(min(max(t, 1), MAX_TIMEOUT))


def clamp_int(v: Any, lo: int, hi: int, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ToolError(f"{what} must be an integer")
    return min(max(v, lo), hi)


def check_pid(pid: Any) -> int:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0 or pid > 0x7FFFFFFF:
        raise ToolError("pid must be a positive integer")
    return pid


def new_workdir(kind: str) -> str:
    d = os.path.join(work_root(), kind, uuid.uuid4().hex)
    os.makedirs(d, exist_ok=True)
    return d


# --------------------------------------------------------------------------
# tool lookup
# --------------------------------------------------------------------------

def find_tool(name: str) -> str | None:
    """Resolve a tool: env RE_TOOL_<NAME>, then the default location, then PATH."""
    override = os.environ.get("RE_TOOL_" + name.upper())
    if override:
        return override if os.path.isfile(override) else None
    d = TOOL_DEFAULTS.get(name)
    if d and os.path.isfile(d):
        return d
    cands = [name]
    if d:
        cands.insert(0, d.replace("\\", "/").rsplit("/", 1)[-1])
    for cand in cands:
        w = shutil.which(cand)
        if w:
            return w
    return None


def missing(binary: str) -> dict[str, Any]:
    return {
        "error": f"required tool not found: {binary} (see tool_versions; install-windows-re-tools.ps1 installs it)",
        "missing_binary": binary,
        "exit_code": None,
    }


# --------------------------------------------------------------------------
# output handling
# --------------------------------------------------------------------------

def decode_bytes(data: bytes) -> str:
    """UTF-16 (BOM or NUL-heavy, as some Sysinternals tools emit when redirected) or UTF-8."""
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", "replace")
    if data and data.count(b"\x00") > len(data) // 4:
        return data.decode("utf-16-le", "replace").lstrip("\ufeff")
    return data.decode("utf-8", "replace").lstrip("\ufeff")


def _slice_fp(fp, cap: int, keep: str) -> tuple[str, bool]:
    fp.flush()
    size = fp.seek(0, os.SEEK_END)
    if keep == "head":
        fp.seek(0)
        data = fp.read(cap)
    else:
        start = max(0, size - cap)
        if start % 2:
            start += 1  # keep UTF-16 code units aligned
        fp.seek(start)
        data = fp.read()
    return decode_bytes(data), size > cap


def read_tail(path: str, cap: int = OUTPUT_CAP, keep: str = "tail") -> tuple[str, bool]:
    try:
        with open(path, "rb") as f:
            return _slice_fp(f, cap, keep)
    except OSError:
        return "", False


def read_all_bounded(path: str, limit: int = 256 * 1024 * 1024) -> str:
    size = os.path.getsize(path)
    if size > limit:
        raise ToolError(f"tool output is {size} bytes, over the {limit} byte parse limit")
    with open(path, "rb") as f:
        return decode_bytes(f.read())


def kill_tree(proc: subprocess.Popen) -> None:
    if IS_WINDOWS:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        except Exception:
            pass
    else:
        import signal
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        proc.kill()
    except OSError:
        pass


def popen_kwargs() -> dict[str, Any]:
    if IS_WINDOWS:
        # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        return {"creationflags": 0x00000200 | 0x08000000}
    return {"start_new_session": True}


def run_cmd(argv: list[str], timeout_s: Any = 30, cwd: str | None = None, *,
            cap: int = OUTPUT_CAP, keep: str = "tail", stdout_file: str | None = None,
            env: dict[str, str] | None = None) -> dict[str, Any]:
    """Run argv (never via a shell) with a hard timeout and per-stream capped output.

    stdout_file: write stdout to this path (uncapped, for callers that parse it);
    the returned `stdout` is still the capped slice of it.
    """
    timeout = clamp_timeout(timeout_s)
    exe = argv[0]
    base = exe.replace("\\", "/").rsplit("/", 1)[-1]
    if not os.path.isfile(exe) and shutil.which(exe) is None:
        return missing(base)
    err = tempfile.TemporaryFile()
    out = open(stdout_file, "w+b") if stdout_file else tempfile.TemporaryFile()
    try:
        t0 = time.monotonic()
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, cwd=cwd,
                                    env=env, **popen_kwargs())
        except FileNotFoundError:
            return missing(base)
        except OSError as e:
            return {"error": f"cannot execute {exe}: {e}", "exit_code": None}
        timed_out = False
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_tree(proc)
            proc.wait()
        dur = round(time.monotonic() - t0, 3)
        so, t1 = _slice_fp(out, cap, keep)
        se, t2 = _slice_fp(err, cap, "tail")
    finally:
        out.close()
        err.close()
    res: dict[str, Any] = {
        "exit_code": proc.returncode,
        "stdout": so,
        "stderr": se,
        "truncated": t1 or t2,
        "duration_s": dur,
        "timed_out": timed_out,
    }
    if timed_out:
        res["error"] = f"timed out after {timeout:g}s; process tree killed"
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
