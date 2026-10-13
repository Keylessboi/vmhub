"""The MCP tools. Plain functions returning dicts; registered in server.py.

Every tool returns a dict. Process-running tools include: exit_code, stdout,
stderr, truncated, duration_s (plus timed_out). Failures are returned as
{"error": ..., "exit_code": None} (and "missing_binary" when a tool is absent);
tools do not raise for caller mistakes.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import uuid
from collections import Counter
from typing import Any, Literal

from .android_tools import ANDROID_TOOLS
from .core import (
    OUTPUT_CAP, ToolError, check_argv, check_command, check_path, clamp_timeout,
    have, kill_group, missing, new_workdir, re_python, read_tail, run_cmd, safe,
)

QEMU_ARCHES = ("aarch64", "arm", "mips", "mipsel", "riscv64", "ppc64", "x86_64", "i386")
RESULT_MARK = "@@RESULT@@"

_SYSCALL_RE = re.compile(r"^(?:\[pid\s+\d+\]\s+|\d+\s+)?(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+)?([a-z_][a-z0-9_]*)\(")


# --------------------------------------------------------------------------
# tracing
# --------------------------------------------------------------------------

@safe
def strace_run(command: list[str], timeout_s: int = 30, follow_forks: bool = True,
               filter: str | None = None) -> dict[str, Any]:
    """Run a program under strace and return the syscall trace plus a summary.

    command: argv list (e.g. ["/tmp/a.out", "--flag"]); no shell is involved.
    follow_forks: pass -f to trace child processes/threads.
    filter: optional strace -e expression, e.g. "trace=network" or "trace=openat,read".
    Returns the target's own stdout/stderr, `trace` (timestamped, last 64 KiB),
    and `summary` = {total, distinct, top: {syscall: count}} computed over the
    FULL trace (not just the capped tail). The trace is only as complete as
    `timeout_s` allows; on timeout the process group is killed.
    """
    cmd = check_command(command)
    if filter is not None and not isinstance(filter, str):
        raise ToolError("filter must be a string")
    if not have("strace"):
        return missing("strace")
    work = new_workdir("strace")
    tf = os.path.join(work, "trace.txt")
    argv = ["strace", "-tt"]
    if follow_forks:
        argv.append("-f")
    if filter:
        argv += ["-e", filter]
    argv += ["-o", tf, "--"] + cmd
    res = run_cmd(argv, timeout_s)
    if res.get("missing_binary"):
        return res
    trace, trunc = read_tail(tf)
    counts: Counter[str] = Counter()
    try:
        with open(tf, "r", errors="replace") as f:
            for line in f:
                m = _SYSCALL_RE.match(line)
                if m:
                    counts[m.group(1)] += 1
    except OSError:
        pass
    res["trace"] = trace
    res["truncated"] = bool(res["truncated"] or trunc)
    res["summary"] = {
        "total": sum(counts.values()),
        "distinct": len(counts),
        "top": dict(counts.most_common(20)),
    }
    shutil.rmtree(work, ignore_errors=True)
    return res


@safe
def ltrace_run(command: list[str], timeout_s: int = 30) -> dict[str, Any]:
    """Run a program under ltrace (library-call trace, follows forks, timestamped).

    command: argv list. Returns the target's stdout/stderr plus `trace`
    (last 64 KiB of ltrace output). Works on dynamically linked binaries only.
    """
    cmd = check_command(command)
    if not have("ltrace"):
        return missing("ltrace")
    work = new_workdir("ltrace")
    tf = os.path.join(work, "trace.txt")
    res = run_cmd(["ltrace", "-f", "-tt", "-o", tf, "--"] + cmd, timeout_s)
    if res.get("missing_binary"):
        return res
    trace, trunc = read_tail(tf)
    res["trace"] = trace
    res["truncated"] = bool(res["truncated"] or trunc)
    shutil.rmtree(work, ignore_errors=True)
    return res


@safe
def valgrind_run(command: list[str], tool: Literal["memcheck", "callgrind", "helgrind"] = "memcheck",
                 timeout_s: int = 120) -> dict[str, Any]:
    """Run a program under valgrind (tool: memcheck, callgrind or helgrind).

    command: argv list. Returns the target's stdout/stderr and `report`
    (valgrind's own log, last 64 KiB). For callgrind, `callgrind_out` is the
    path of the profile file (analyse it with callgrind_annotate via a shell
    outside this server); it is kept under /tmp/re-toolbox/valgrind/.
    """
    if tool not in ("memcheck", "callgrind", "helgrind"):
        raise ToolError("tool must be one of memcheck, callgrind, helgrind")
    cmd = check_command(command)
    if not have("valgrind"):
        return missing("valgrind")
    work = new_workdir("valgrind")
    log = os.path.join(work, "valgrind.log")
    argv = ["valgrind", f"--tool={tool}", f"--log-file={log}"]
    out_file = None
    if tool == "callgrind":
        out_file = os.path.join(work, "callgrind.out")
        argv.append(f"--callgrind-out-file={out_file}")
    res = run_cmd(argv + cmd, timeout_s)
    if res.get("missing_binary"):
        return res
    report, trunc = read_tail(log)
    res["report"] = report
    res["truncated"] = bool(res["truncated"] or trunc)
    if out_file:
        res["callgrind_out"] = out_file if os.path.exists(out_file) else None
    else:
        shutil.rmtree(work, ignore_errors=True)
    return res


# --------------------------------------------------------------------------
# static helpers
# --------------------------------------------------------------------------

def _list_files(root: str, limit: int = 500) -> tuple[list[dict[str, Any]], bool]:
    out: list[dict[str, Any]] = []
    for dp, _dn, fns in os.walk(root):
        for fn in sorted(fns):
            p = os.path.join(dp, fn)
            try:
                size = os.lstat(p).st_size
            except OSError:
                size = -1
            out.append({"path": p, "size": size})
            if len(out) >= limit:
                return out, True
    return out, False


@safe
def binwalk_scan(path: str, extract: bool = False) -> dict[str, Any]:
    """Signature-scan a file with binwalk (embedded files, filesystems, compression).

    extract=True also extracts into a fresh directory
    /tmp/re-toolbox/extract/<uuid> (returned as `extract_dir`, with `files`
    listing up to 500 extracted files and sizes). Extraction can be slow and
    large; sizes are not capped by this server.
    """
    p = check_path(path)
    if not have("binwalk"):
        return missing("binwalk")
    if not extract:
        return run_cmd(["binwalk", p], 120)
    d = new_workdir("extract")
    res = run_cmd(["binwalk", "-e", "-C", d, p], 300)
    if res.get("missing_binary"):
        return res
    files, more = _list_files(d)
    res.update(extract_dir=d, files=files, files_truncated=more)
    return res


_YARA_STR_RE = re.compile(r"^0x[0-9a-fA-F]+:")


def _parse_yara(stdout: str) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        if _YARA_STR_RE.match(line):
            if matches:
                matches[-1]["strings"].append(line.strip())
            continue
        parts = line.split(None, 1)
        matches.append({"rule": parts[0], "target": parts[1] if len(parts) > 1 else "", "strings": []})
    return matches


@safe
def yara_scan(path: str, rules_text: str | None = None, rules_path: str | None = None) -> dict[str, Any]:
    """Scan a file (or directory, recursively) with YARA rules.

    Provide EXACTLY ONE of rules_text (YARA source) or rules_path (a rules
    file under an allowed root). Returns `matches`: [{rule, target, strings}]
    where strings are matched-string lines ("0xOFFSET:$id: data").
    """
    if (rules_text is None) == (rules_path is None):
        raise ToolError("provide exactly one of rules_text or rules_path")
    target = check_path(path)
    if rules_text is not None:
        if not isinstance(rules_text, str) or not rules_text.strip():
            raise ToolError("rules_text must be a non-empty string")
        if not have("yara"):
            return missing("yara")
        d = new_workdir("yara")
        rf = os.path.join(d, "rules.yar")
        with open(rf, "w") as f:
            f.write(rules_text)
    else:
        rf = check_path(rules_path, what="rules_path")
        d = None
    if not have("yara"):
        return missing("yara")
    res = run_cmd(["yara", "-s", "-r", rf, target], 120)
    if d:
        shutil.rmtree(d, ignore_errors=True)
    if res.get("missing_binary"):
        return res
    res["matches"] = _parse_yara(res["stdout"])
    return res


@safe
def upx_info(path: str) -> dict[str, Any]:
    """Test whether a file is UPX-packed and intact (`upx -t`).

    exit_code 0 means UPX-packed and the packed data tests OK; non-zero with
    "not packed by UPX" in stderr means it is not packed. `packed` is a bool
    convenience derived from exit_code.
    """
    p = check_path(path)
    res = run_cmd(["upx", "-t", p], 60)
    if not res.get("missing_binary"):
        res["packed"] = res.get("exit_code") == 0
    return res


@safe
def upx_unpack(path: str, output_path: str) -> dict[str, Any]:
    """Decompress a UPX-packed file (`upx -d -o output_path path`).

    output_path must be under an allowed root and must not already exist
    (the input is never modified).
    """
    p = check_path(path)
    o = check_path(output_path, must_exist=False, what="output_path")
    if os.path.exists(o):
        raise ToolError(f"output_path {o!r} already exists")
    res = run_cmd(["upx", "-d", "-o", o, p], 120)
    if not res.get("missing_binary"):
        res["output_exists"] = os.path.exists(o)
    return res


@safe
def file_info(path: str) -> dict[str, Any]:
    """Quick triage of a file: `file`, ELF headers/sections, and printable strings.

    Returns `file` (file(1) description), for ELF files `elf_header`
    (readelf -h) and `elf_sections` (readelf -S -W) -- falling back to
    objdump -f if readelf is missing -- and `strings` (first 200 lines of
    `strings -n 8`). Each missing helper binary is listed in `missing_binaries`.
    """
    p = check_path(path)
    if not os.path.isfile(p):
        raise ToolError(f"{p!r} is not a regular file")
    miss: list[str] = []
    out: dict[str, Any] = {"path": p, "exit_code": 0, "missing_binaries": miss}
    t0 = time.monotonic()
    truncated = False

    def sub(argv: list[str]) -> str | None:
        nonlocal truncated
        r = run_cmd(argv, 30)
        if r.get("missing_binary"):
            miss.append(argv[0])
            return None
        truncated = truncated or r["truncated"]
        return r["stdout"] if r["exit_code"] == 0 else (r["stdout"] + r["stderr"])

    out["file"] = (sub(["file", "-b", p]) or "").strip()
    with open(p, "rb") as f:
        is_elf = f.read(4) == b"\x7fELF"
    out["is_elf"] = is_elf
    if is_elf:
        hdr = sub(["readelf", "-h", p])
        if hdr is None:
            out["objdump_f"] = sub(["objdump", "-f", p])
        else:
            out["elf_header"] = hdr
            out["elf_sections"] = sub(["readelf", "-S", "-W", p])
    s = sub(["strings", "-n", "8", p])
    if s is not None:
        lines = s.splitlines()
        out["strings"] = "\n".join(lines[:200])
        out["strings_total_shown"] = min(len(lines), 200)
    out["stdout"] = out["file"]
    out["stderr"] = ""
    out["truncated"] = truncated
    out["duration_s"] = round(time.monotonic() - t0, 3)
    return out


# --------------------------------------------------------------------------
# qemu-user
# --------------------------------------------------------------------------

@safe
def qemu_user_run(arch: Literal["aarch64", "arm", "mips", "mipsel", "riscv64", "ppc64", "x86_64", "i386"],
                  binary: str, args: list[str] | None = None, timeout_s: int = 30,
                  strace_syscalls: bool = False, sysroot: str | None = None) -> dict[str, Any]:
    """Run a foreign-architecture ELF using qemu-<arch>-static (user-mode emulation).

    arch: aarch64, arm, mips, mipsel, riscv64, ppc64, x86_64 or i386.
    binary: path to the ELF; args: its arguments (list of strings).
    strace_syscalls: add qemu's `-strace`; the syscall log appears in `stderr`.
    sysroot: optional directory passed as `-L` (dynamic-linker prefix for
    dynamically linked foreign binaries).
    Fails with a clear error if qemu-<arch>-static is not on PATH.
    """
    if arch not in QEMU_ARCHES:
        raise ToolError(f"arch must be one of {', '.join(QEMU_ARCHES)}")
    b = check_path(binary, what="binary")
    a = check_argv(args or [], what="args") if args else []
    exe = f"qemu-{arch}-static"
    if not have(exe):
        return missing(exe)
    argv = [exe]
    if sysroot:
        argv += ["-L", check_path(sysroot, what="sysroot")]
    if strace_syscalls:
        argv.append("-strace")
    argv += [b] + a
    return run_cmd(argv, timeout_s)


# --------------------------------------------------------------------------
# angr (isolated subprocess)
# --------------------------------------------------------------------------

def _run_py(script: str, args: list[str], timeout_s: Any) -> dict[str, Any]:
    """Run `script` under RE_PYTHON -I -c; parse the @@RESULT@@ line into `result`."""
    res = run_cmd([re_python(), "-I", "-c", script] + args, timeout_s)
    if res.get("missing_binary"):
        res["error"] = f"RE_PYTHON interpreter not found: {re_python()}"
        return res
    for line in reversed(res.get("stdout", "").splitlines()):
        if line.startswith(RESULT_MARK):
            try:
                res["result"] = json.loads(line[len(RESULT_MARK):])
            except ValueError:
                res["error"] = "unparseable result from helper"
            break
    else:
        if not res.get("error"):
            res["error"] = "helper produced no result (is angr/mitmproxy installed in RE_PYTHON?)"
    return res


_ANGR_CFG = r'''
import sys, json, logging
logging.disable(logging.CRITICAL)
import angr
p = angr.Project(sys.argv[1], auto_load_libs=False)
cfg = p.analyses.CFGFast(normalize=True)
mx = int(sys.argv[2])
fs = sorted(cfg.kb.functions.values(), key=lambda f: f.addr)
out = [{"name": f.name, "addr": hex(f.addr), "size": f.size} for f in fs[:mx]]
print("@@RESULT@@" + json.dumps({"arch": p.arch.name, "entry": hex(p.entry),
      "function_count": len(fs), "returned": len(out), "functions": out}))
'''

_ANGR_FIND = r'''
import sys, json, logging
logging.disable(logging.CRITICAL)
import angr
try:
    import claripy  # older angr releases ship it as a separate package
except ImportError:
    from angr import claripy  # angr 10+ vendors it
path, find, avoid, argv_len = sys.argv[1], int(sys.argv[2]), json.loads(sys.argv[3]), int(sys.argv[4])
p = angr.Project(path, auto_load_libs=False)
args = [path]
sym = None
if argv_len > 0:
    sym = claripy.BVS("argv1", 8 * argv_len)
    args.append(sym)
st = p.factory.full_init_state(args=args)
sm = p.factory.simulation_manager(st)
sm.explore(find=find, avoid=avoid)
res = {"found": bool(sm.found), "active": len(sm.active), "deadended": len(sm.deadended),
       "avoided": len(sm.avoid) if hasattr(sm, "avoid") else 0}
if sm.found:
    s = sm.found[0]
    stdin = s.posix.dumps(0)
    res["stdin_hex"] = stdin.hex()
    res["stdin_repr"] = repr(stdin)
    res["stdout_repr"] = repr(s.posix.dumps(1))
    if sym is not None:
        v = s.solver.eval(sym, cast_to=bytes)
        res["argv1_hex"] = v.hex()
        res["argv1_repr"] = repr(v)
print("@@RESULT@@" + json.dumps(res))
'''


@safe
def angr_cfg(path: str, max_functions: int = 200, timeout_s: int = 300) -> dict[str, Any]:
    """Build a fast CFG (angr CFGFast) and list recovered functions.

    Runs in a separate process (interpreter from env RE_PYTHON, default
    /opt/re-venv/bin/python) so angr's memory use is isolated and killable.
    `result` = {arch, entry, function_count, returned, functions:[{name, addr, size}]}
    sorted by address, limited to max_functions. Large binaries can take minutes.
    """
    p = check_path(path)
    if not isinstance(max_functions, int) or isinstance(max_functions, bool) or max_functions < 1:
        raise ToolError("max_functions must be a positive integer")
    return _run_py(_ANGR_CFG, [p, str(max_functions)], timeout_s)


@safe
def angr_find(path: str, find: int, avoid: list[int] | None = None, timeout_s: int = 120,
              symbolic_argv_len: int = 0) -> dict[str, Any]:
    """Symbolically explore a binary to reach address `find` while avoiding `avoid` addresses.

    Runs in a separate process (RE_PYTHON) with a hard timeout. stdin is
    symbolic by default; set symbolic_argv_len=N to also pass a symbolic
    N-byte argv[1]. `result` = {found, active, deadended, ...} and, when
    found, stdin_hex/stdin_repr (solved stdin), stdout_repr, and
    argv1_hex/argv1_repr if symbolic_argv_len was set. Addresses are plain
    integers (use the loaded/virtual addresses, e.g. 0x401136 as 4198710).
    """
    p = check_path(path)
    avoid = avoid or []
    for name, v in (("find", find),) + tuple(("avoid", x) for x in avoid):
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise ToolError(f"{name} addresses must be non-negative integers")
    if not isinstance(symbolic_argv_len, int) or not 0 <= symbolic_argv_len <= 256:
        raise ToolError("symbolic_argv_len must be an integer 0..256")
    return _run_py(_ANGR_FIND, [p, str(find), json.dumps(avoid), str(symbolic_argv_len)], timeout_s)


# --------------------------------------------------------------------------
# mitmproxy
# --------------------------------------------------------------------------

_mitm: dict[str, Any] = {"proc": None, "flows": None, "port": None, "log": None}
_MITM_READY_TIMEOUT_S = 20.0

_MITM_READ = r'''
import sys, json
from mitmproxy import io
from mitmproxy.exceptions import FlowReadException
path, limit = sys.argv[1], int(sys.argv[2])
rows, total, err = [], 0, None
try:
    with open(path, "rb") as f:
        for fl in io.FlowReader(f).stream():
            if getattr(fl, "type", "http") != "http":
                continue
            total += 1
            if len(rows) < limit:
                r, s = fl.request, fl.response
                rows.append({"method": r.method, "url": r.pretty_url,
                             "status": s.status_code if s else None,
                             "size": len(s.raw_content or b"") if s else 0,
                             "request_size": len(r.raw_content or b"")})
except FlowReadException as e:
    err = "partial read: " + str(e)
out = {"total": total, "returned": len(rows), "flows": rows}
if err:
    out["note"] = err
print("@@RESULT@@" + json.dumps(out))
'''


def _mitm_running() -> bool:
    p = _mitm["proc"]
    return p is not None and p.poll() is None


@safe
def mitm_capture_start(listen_port: int = 8080, flows_file: str | None = None) -> dict[str, Any]:
    """Start a background `mitmdump -w <flows_file>` capture proxy (only one at a time).

    listen_port: proxy port (1-65535). flows_file: where to write flows
    (must be under an allowed root); default /tmp/re-toolbox/mitm/<uuid>/flows.
    Refuses to start if a capture is already running. Point the target's
    proxy settings at <vm>:listen_port. Read results with mitm_flows, then
    mitm_capture_stop.
    """
    if isinstance(listen_port, bool) or not isinstance(listen_port, int) or not 1 <= listen_port <= 65535:
        raise ToolError("listen_port must be an integer 1..65535")
    if _mitm_running():
        return {"error": "a capture is already running; call mitm_capture_stop first",
                "exit_code": None, "pid": _mitm["proc"].pid,
                "flows_file": _mitm["flows"], "listen_port": _mitm["port"]}
    if flows_file is None:
        flows = os.path.join(new_workdir("mitm"), "flows")
    else:
        flows = check_path(flows_file, must_exist=False, what="flows_file")
        os.makedirs(os.path.dirname(flows), exist_ok=True)
    if not have("mitmdump"):
        return missing("mitmdump")
    logf = tempfile.NamedTemporaryFile(prefix="mitmdump-", suffix=".log", delete=False)
    try:
        proc = subprocess.Popen(
            ["mitmdump", "--listen-port", str(listen_port), "-w", flows],
            stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as e:
        logf.close()
        return {"error": f"cannot start mitmdump: {e}", "exit_code": None}
    logf.close()
    # mitmdump takes a few seconds to import and bind. Return only once the proxy accepts
    # connections, so the caller can send traffic straight away without a race.
    deadline = time.monotonic() + _MITM_READY_TIMEOUT_S
    listening = False
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            tail, _ = read_tail(logf.name, 4096)
            os.unlink(logf.name)
            return {"error": "mitmdump exited before listening", "exit_code": proc.returncode, "log": tail}
        try:
            with socket.create_connection(("127.0.0.1", listen_port), timeout=0.5):
                listening = True
                break
        except OSError:
            time.sleep(0.2)
    _mitm.update(proc=proc, flows=flows, port=listen_port, log=logf.name)
    result = {"started": True, "listening": listening, "pid": proc.pid, "listen_port": listen_port,
              "flows_file": flows, "exit_code": 0}
    if not listening:
        result["warning"] = f"mitmdump is running but port {listen_port} was not accepting connections after {_MITM_READY_TIMEOUT_S:.0f} s"
    return result


@safe
def mitm_capture_stop() -> dict[str, Any]:
    """Stop the running mitmdump capture (SIGTERM, then SIGKILL after 5 s).

    Returns the flows file path (still on disk for mitm_flows) and the tail of
    mitmdump's log. Error if no capture was started.
    """
    proc = _mitm["proc"]
    if proc is None:
        return {"error": "no capture has been started", "exit_code": None}
    was_running = proc.poll() is None
    if was_running:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            kill_group(proc)
            proc.wait()
    log, _ = read_tail(_mitm["log"] or "", 4096)
    out = {"stopped": True, "was_running": was_running, "exit_code": proc.returncode,
           "flows_file": _mitm["flows"], "log": log}
    try:
        if _mitm["log"]:
            os.unlink(_mitm["log"])
    except OSError:
        pass
    _mitm.update(proc=None, port=None, log=None)  # flows path kept for mitm_flows
    return out


@safe
def mitm_flows(limit: int = 100, flows_file: str | None = None) -> dict[str, Any]:
    """Parse captured flows and return method/url/status/size per HTTP flow.

    Reads flows_file (default: the current/last capture's file) with
    mitmproxy's FlowReader, run under RE_PYTHON. Works while capturing
    (a partially written tail is tolerated). `result` =
    {total, returned, flows:[{method, url, status, size, request_size}]};
    size is the response body size in bytes.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ToolError("limit must be a positive integer")
    src = flows_file if flows_file is not None else _mitm["flows"]
    if not src:
        raise ToolError("no flows file: start a capture or pass flows_file")
    p = check_path(src, what="flows_file")
    return _run_py(_MITM_READ, [p, str(limit)], 60)


# --------------------------------------------------------------------------
# tool_versions
# --------------------------------------------------------------------------

def _version_probes() -> list[tuple[str, list[str]]]:
    probes = [
        ("strace", ["strace", "-V"]), ("ltrace", ["ltrace", "--version"]),
        ("valgrind", ["valgrind", "--version"]), ("binwalk", ["binwalk", "--help"]),
        ("yara", ["yara", "--version"]), ("upx", ["upx", "-V"]),
        ("file", ["file", "--version"]), ("readelf", ["readelf", "--version"]),
        ("objdump", ["objdump", "--version"]), ("strings", ["strings", "--version"]),
        ("mitmdump", ["mitmdump", "--version"]),
        ("jadx", ["jadx", "--version"]), ("apktool", ["apktool", "--version"]),
        ("adb", ["adb", "version"]), ("aapt", ["aapt", "version"]),
        ("apksigner", ["apksigner", "--version"]),
    ]
    probes += [(f"qemu-{a}-static", [f"qemu-{a}-static", "--version"]) for a in QEMU_ARCHES]
    return probes


@safe
def tool_versions() -> dict[str, Any]:
    """Report which underlying tools are installed, with a version line each.

    `tools` maps name -> {installed: bool, version: first output line or null}.
    Includes angr and mitmproxy as importable in RE_PYTHON. Missing tools are
    reported as installed=false, never as errors. `missing` lists them.
    """
    t0 = time.monotonic()
    tools: dict[str, Any] = {}
    for name, argv in _version_probes():
        if not have(argv[0]):
            tools[name] = {"installed": False, "version": None}
            continue
        r = run_cmd(argv, 10)
        text = (r.get("stdout") or r.get("stderr") or "").strip().splitlines()
        tools[name] = {"installed": True, "version": text[0].strip() if text else None}
    py = re_python()
    for mod in ("angr", "mitmproxy"):
        if os.path.exists(py):
            r = run_cmd([py, "-I", "-c", f"import {mod};print({mod}.__version__)" if mod == "angr"
                         else "from mitmproxy import version;print(version.VERSION)"], 60)
            ok = r.get("exit_code") == 0
            ver = (r["stdout"].strip().splitlines() or [None])[-1] if ok else None
            tools[f"python:{mod}"] = {"installed": ok, "version": ver}
        else:
            tools[f"python:{mod}"] = {"installed": False, "version": None}
    return {
        "exit_code": 0, "stdout": "", "stderr": "", "truncated": False,
        "duration_s": round(time.monotonic() - t0, 3),
        "re_python": py, "tools": tools,
        "missing": sorted(k for k, v in tools.items() if not v["installed"]),
    }


ALL_TOOLS = [
    strace_run, ltrace_run, valgrind_run, binwalk_scan, yara_scan, upx_info,
    upx_unpack, file_info, qemu_user_run, angr_cfg, angr_find,
    mitm_capture_start, mitm_capture_stop, mitm_flows, tool_versions,
]
ALL_TOOLS += ANDROID_TOOLS
