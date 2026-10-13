"""The MCP tools. Plain functions returning dicts; registered in server.py.

Every tool returns a dict. Process-running tools include: exit_code, stdout,
stderr, truncated, duration_s (plus timed_out). Failures are returned as
{"error": ..., "exit_code": None} (and "missing_binary" when a tool is absent);
tools do not raise for caller mistakes.
"""

from __future__ import annotations

import csv
import datetime
import io
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from collections import Counter
from typing import Any, Literal

from .core import (
    OUTPUT_CAP, ToolError, check_argv, check_command, check_path, check_pid, clamp_int,
    clamp_timeout, decode_bytes, find_tool, kill_tree, missing, new_workdir, popen_kwargs,
    read_all_bounded, run_cmd, safe, work_root, TOOL_DEFAULTS,
)

MB = 1024 * 1024


def _tool(name: str) -> str | None:
    return find_tool(name)


def _with_tool(name: str):
    p = _tool(name)
    if p is None:
        return None, missing(name)
    return p, None


def _csv_rows(text: str) -> list[dict[str, str]]:
    text = text.lstrip("\ufeff")
    return [dict(r) for r in csv.DictReader(io.StringIO(text))]


# --------------------------------------------------------------------------
# static analysis
# --------------------------------------------------------------------------

@safe
def sigcheck_scan(path: str, timeout_s: int = 120) -> dict[str, Any]:
    """Authenticode signature, hashes and version info of a file (Sysinternals sigcheck).

    Returns `info` = the parsed CSV record (Verified, Publisher, Company,
    Description, Product, File Version, Machine Type, MD5, SHA1, SHA256, ...)
    plus the raw stdout. Does not hit the network (no -vt / -vr).
    """
    p = check_path(path, what="path")
    exe, err = _with_tool("sigcheck")
    if err:
        return err
    res = run_cmd([exe, "-accepteula", "-nobanner", "-a", "-h", "-c", p], timeout_s)
    if res.get("missing_binary"):
        return res
    rows = _csv_rows(res["stdout"])
    res["info"] = rows[0] if rows else {}
    return res


@safe
def strings_scan(path: str, min_length: int = 6, kind: Literal["ascii", "unicode", "both"] = "both",
                 max_lines: int = 2000, timeout_s: int = 120) -> dict[str, Any]:
    """Extract printable strings with offsets (Sysinternals strings).

    kind: ascii, unicode or both (two runs, reported separately).
    Each list is capped at `max_lines` (hard limit 20000); `counts` holds the full totals.
    """
    if kind not in ("ascii", "unicode", "both"):
        raise ToolError("kind must be ascii, unicode or both")
    p = check_path(path, what="path")
    n = clamp_int(min_length, 3, 1000, "min_length")
    lim = clamp_int(max_lines, 1, 20000, "max_lines")
    exe, err = _with_tool("strings")
    if err:
        return err
    out: dict[str, Any] = {"exit_code": 0, "counts": {}, "truncated": False}
    for k, flag in (("ascii", "-a"), ("unicode", "-u")):
        if kind not in (k, "both"):
            continue
        work = new_workdir("strings")
        sf = os.path.join(work, "out.txt")
        try:
            res = run_cmd([exe, "-accepteula", "-nobanner", flag, "-o", "-n", str(n), p], timeout_s,
                          stdout_file=sf)
            if res.get("missing_binary"):
                return res
            lines: list[str] = []
            total = 0
            with open(sf, "rb") as f:
                for raw in f:
                    total += 1
                    if len(lines) < lim:
                        lines.append(decode_bytes(raw).rstrip("\r\n"))
            out[k] = lines
            out["counts"][k] = total
            if total > lim:
                out["truncated"] = True
            if res.get("error"):
                out["error"] = res["error"]
                out["timed_out"] = res.get("timed_out")
            out["exit_code"] = res["exit_code"]
            if res["stderr"].strip():
                out.setdefault("stderr", "")
                out["stderr"] += res["stderr"]
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return out


@safe
def diec_scan(path: str, deep: bool = False, heuristic: bool = False, timeout_s: int = 120) -> dict[str, Any]:
    """Detect It Easy (diec): packer, compiler, linker and protector detection as JSON.

    deep: deep scan (slower). heuristic: heuristic scan. `detects` holds the
    parsed JSON when diec produced valid JSON, otherwise see stdout.
    """
    p = check_path(path, what="path")
    exe, err = _with_tool("diec")
    if err:
        return err
    argv = [exe, "-j"]
    if deep:
        argv.append("-d")
    if heuristic:
        argv.append("-r")
    res = run_cmd(argv + [p], timeout_s)
    if res.get("missing_binary"):
        return res
    try:
        res["detects"] = json.loads(res["stdout"])
    except ValueError:
        res["detects"] = None
    return res


def summarise_capa(doc: dict[str, Any], top: int = 25) -> dict[str, Any]:
    """Condense a capa JSON document into ATT&CK/MBC tags and the top rules."""
    rules = doc.get("rules") or {}
    attack: dict[str, set[str]] = {}
    mbc: dict[str, set[str]] = {}
    ranked = []
    for name, rule in rules.items():
        meta = rule.get("meta") or {}
        matches = rule.get("matches") or []
        nmatch = len(matches) if hasattr(matches, "__len__") else 0
        ranked.append((nmatch, name, meta))
        for a in meta.get("attack") or []:
            tactic = a.get("tactic") or "?"
            label = " / ".join(x for x in (a.get("technique"), a.get("subtechnique")) if x)
            attack.setdefault(f"{tactic}::{label} [{a.get('id', '?')}]", set()).add(name)
        for m in meta.get("mbc") or []:
            obj = m.get("objective") or "?"
            label = " / ".join(x for x in (m.get("behavior"), m.get("method")) if x)
            mbc.setdefault(f"{obj}::{label} [{m.get('id', '?')}]", set()).add(name)
    ranked.sort(key=lambda t: (-t[0], t[1]))
    meta = doc.get("meta") or {}
    analysis = meta.get("analysis") or {}
    return {
        "rule_count": len(rules),
        "format": analysis.get("format"),
        "arch": analysis.get("arch"),
        "os": analysis.get("os"),
        "attack": {k: sorted(v) for k, v in sorted(attack.items())},
        "mbc": {k: sorted(v) for k, v in sorted(mbc.items())},
        "top_rules": [
            {"rule": n, "matches": c, "namespace": m.get("namespace"), "scope": m.get("scope")}
            for c, n, m in ranked[:top]
        ],
    }


@safe
def capa_scan(path: str, timeout_s: int = 300, top_rules: int = 25) -> dict[str, Any]:
    """Mandiant capa capability detection, summarised.

    Returns `summary` = {rule_count, format, arch, os, attack: {tactic::technique [id]: [rules]},
    mbc: {...}, top_rules: [{rule, matches, namespace, scope}]}. The full JSON is parsed
    in-process and not returned (it can be tens of MB).
    """
    p = check_path(path, what="path")
    n = clamp_int(top_rules, 1, 200, "top_rules")
    exe, err = _with_tool("capa")
    if err:
        return err
    work = new_workdir("capa")
    sf = os.path.join(work, "capa.json")
    try:
        res = run_cmd([exe, "-q", "-j", p], timeout_s, stdout_file=sf)
        if res.get("missing_binary"):
            return res
        res["stdout"] = res["stdout"][:2000]  # JSON is not useful here; the summary is
        try:
            doc = json.loads(read_all_bounded(sf))
            res["summary"] = summarise_capa(doc, n)
        except (ValueError, OSError, ToolError) as e:
            res["summary"] = None
            res.setdefault("error", f"could not parse capa JSON output: {e}")
        return res
    finally:
        shutil.rmtree(work, ignore_errors=True)


@safe
def floss_scan(path: str, min_length: int = 6, include_static: bool = False, max_strings: int = 500,
               timeout_s: int = 300) -> dict[str, Any]:
    """Mandiant FLOSS: decoded, stack and tight strings (static strings are off by default).

    Each category is capped at `max_strings` (hard limit 5000); `counts` has the totals.
    """
    p = check_path(path, what="path")
    n = clamp_int(min_length, 3, 1000, "min_length")
    lim = clamp_int(max_strings, 1, 5000, "max_strings")
    exe, err = _with_tool("floss")
    if err:
        return err
    work = new_workdir("floss")
    sf = os.path.join(work, "floss.json")
    try:
        # The sample goes first: `--no` takes several values, so a path after it is parsed as a category.
        argv = [exe, p, "-q", "-j", "-n", str(n)]
        if not include_static:
            argv += ["--no", "static"]
        res = run_cmd(argv, timeout_s, stdout_file=sf)
        if res.get("missing_binary"):
            return res
        res["stdout"] = res["stdout"][:2000]
        try:
            doc = json.loads(read_all_bounded(sf))
        except (ValueError, OSError, ToolError) as e:
            res["strings"] = None
            res.setdefault("error", f"could not parse FLOSS JSON output: {e}")
            return res
        strs = doc.get("strings") or {}
        out: dict[str, list] = {}
        counts: dict[str, int] = {}
        for cat in ("decoded_strings", "stack_strings", "tight_strings", "static_strings"):
            items = strs.get(cat) or []
            counts[cat] = len(items)
            if items:
                out[cat] = [
                    (it if isinstance(it, str) else
                     {k: it.get(k) for k in ("string", "offset", "address", "function", "encoding",
                                             "decoding_routine") if k in it})
                    for it in items[:lim]
                ]
        res["strings"] = out
        res["counts"] = counts
        res["truncated"] = bool(res["truncated"] or any(c > lim for c in counts.values()))
        return res
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _dir_listing(root: str, max_files: int = 200) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    total = 0
    count = 0
    for dp, _dn, fn in os.walk(root):
        for f in sorted(fn):
            fp = os.path.join(dp, f)
            try:
                sz = os.path.getsize(fp)
            except OSError:
                continue
            count += 1
            total += sz
            if len(files) < max_files:
                files.append({"path": os.path.relpath(fp, root), "bytes": sz})
    return {"file_count": count, "total_bytes": total, "files": files, "listing_truncated": count > max_files}


@safe
def ilspy_decompile(path: str, mode: Literal["list", "type", "all"] = "list", type_name: str | None = None,
                    output_dir: str | None = None, list_kinds: str = "c", timeout_s: int = 300) -> dict[str, Any]:
    """Decompile a .NET assembly with ilspycmd.

    mode "list": list types (list_kinds: any of c=classes i=interfaces s=structs d=delegates e=enums).
    mode "type": decompile one type (type_name, full name e.g. Namespace.Class) to C# in `code`
      (first 256 KiB).
    mode "all": decompile the whole assembly as a project into output_dir (default: a fresh
      work folder); returns a capped file listing. output_dir must be under an allowed root.
    """
    if mode not in ("list", "type", "all"):
        raise ToolError("mode must be list, type or all")
    p = check_path(path, what="path")
    exe, err = _with_tool("ilspycmd")
    if err:
        return err
    if mode == "list":
        if not isinstance(list_kinds, str) or not re.fullmatch(r"[cisde]{1,5}", list_kinds):
            raise ToolError("list_kinds must be made of the letters c i s d e")
        res = run_cmd([exe, "-l", list_kinds, p], timeout_s, cap=256 * 1024)
        if not res.get("missing_binary"):
            res["types"] = [ln.strip() for ln in res["stdout"].splitlines() if ln.strip()][:5000]
        return res
    if mode == "type":
        if not isinstance(type_name, str) or not type_name or not re.fullmatch(r"[\w.`+<>,\[\]]+", type_name):
            raise ToolError("type_name must be a full type name such as Namespace.Class")
        res = run_cmd([exe, "-t", type_name, p], timeout_s, cap=256 * 1024, keep="head")
        if not res.get("missing_binary"):
            res["code"] = res["stdout"]
        return res
    if output_dir is None:
        out_dir = new_workdir("ilspy")
    else:
        out_dir = check_path(output_dir, must_exist=False, what="output_dir")
        os.makedirs(out_dir, exist_ok=True)
    res = run_cmd([exe, "-p", "-o", out_dir, p], timeout_s)
    if not res.get("missing_binary"):
        res["output_dir"] = out_dir
        res.update(_dir_listing(out_dir))
    return res


# --------------------------------------------------------------------------
# live process inspection
# --------------------------------------------------------------------------

@safe
def procdump_run(pid: int | None = None, command: list[str] | None = None, output_dir: str | None = None,
                 on_exception: bool = False, timeout_s: int = 120) -> dict[str, Any]:
    """Full-memory dump (procdump -ma) of a running pid, or of a program launched by procdump.

    Give either `pid`, or `command` (argv list, argv[0] a full path under an allowed root; procdump
    -x launches it and dumps at start, or with on_exception=True waits for the first unhandled
    exception). Dumps go to output_dir (default: a fresh work folder; must be under an allowed
    root). Returns `dumps` = [{path, bytes}]. The launched process tree is killed on timeout.
    """
    if (pid is None) == (command is None):
        raise ToolError("give exactly one of pid or command")
    exe, err = _with_tool("procdump")
    if err:
        return err
    if output_dir is None:
        out_dir = new_workdir("procdump")
    else:
        out_dir = check_path(output_dir, must_exist=False, what="output_dir")
        os.makedirs(out_dir, exist_ok=True)
    argv = [exe, "-accepteula", "-ma"]
    if pid is not None:
        argv += [str(check_pid(pid)), out_dir]
    else:
        cmd = check_command(command)
        if on_exception:
            argv.append("-e")
        argv += ["-x", out_dir] + cmd
    res = run_cmd(argv, timeout_s)
    if res.get("missing_binary"):
        return res
    res["output_dir"] = out_dir
    dumps = []
    try:
        for f in sorted(os.listdir(out_dir)):
            if f.lower().endswith(".dmp"):
                fp = os.path.join(out_dir, f)
                dumps.append({"path": fp, "bytes": os.path.getsize(fp)})
    except OSError:
        pass
    res["dumps"] = dumps
    return res


_HANDLE_RE = re.compile(r"^\s*([0-9A-Fa-f]+):\s+(\S+)\s+(?:\(([-RWD]*)\)\s+)?(.*)$")
_HANDLE_PROC_RE = re.compile(r"^(\S.*?)\s+pid:\s*(\d+)\s*(.*)$")


def parse_handles(text: str, limit: int) -> tuple[list[dict[str, Any]], int]:
    out: list[dict[str, Any]] = []
    total = 0
    cur: dict[str, Any] = {}
    for line in text.splitlines():
        m = _HANDLE_PROC_RE.match(line)
        if m and not line.startswith(" "):
            cur = {"process": m.group(1), "pid": int(m.group(2)), "user": m.group(3).strip() or None}
            continue
        m = _HANDLE_RE.match(line)
        if m:
            total += 1
            if len(out) < limit:
                out.append({**cur, "handle": m.group(1), "type": m.group(2),
                            "access": m.group(3), "name": m.group(4).strip()})
    return out, total


@safe
def handle_list(pid: int | None = None, process_name: str | None = None, all_types: bool = False,
                max_entries: int = 1000, timeout_s: int = 120) -> dict[str, Any]:
    """Open handles of a process (Sysinternals handle). Give pid or a process name prefix.

    all_types: include every handle type (default shows files/dirs/ports/keys... as handle's default does).
    Returns `handles` [{process, pid, handle, type, access, name}] capped at max_entries, `total`.
    """
    if (pid is None) == (process_name is None):
        raise ToolError("give exactly one of pid or process_name")
    lim = clamp_int(max_entries, 1, 10000, "max_entries")
    exe, err = _with_tool("handle")
    if err:
        return err
    target = str(check_pid(pid)) if pid is not None else process_name
    if not isinstance(target, str) or not re.fullmatch(r"[\w .\-]{1,64}", target):
        raise ToolError("process_name must be 1-64 chars of letters, digits, space, dot, dash or underscore")
    argv = [exe, "-accepteula", "-nobanner", "-u"] + (["-a"] if all_types else []) + ["-p", target]
    res = run_cmd(argv, timeout_s, cap=4 * MB)
    if res.get("missing_binary"):
        return res
    res["handles"], res["total"] = parse_handles(res["stdout"], lim)
    res["stdout"] = res["stdout"][-OUTPUT_CAP:]
    return res


_DLL_RE = re.compile(r"^\s*(0x[0-9A-Fa-f]+)\s+(0x[0-9A-Fa-f]+)\s+(.*)$")
_VER_RE = re.compile(r"^(\d+(?:\.\d+){1,3})\s+(.*)$")


def parse_listdlls(text: str, limit: int) -> tuple[list[dict[str, Any]], int]:
    mods: list[dict[str, Any]] = []
    total = 0
    cur: dict[str, Any] = {}
    for line in text.splitlines():
        m = _DLL_RE.match(line)
        if m:
            total += 1
            rest = m.group(3).strip()
            ver = None
            vm = _VER_RE.match(rest)
            if vm:
                ver, rest = vm.group(1), vm.group(2).strip()
            if len(mods) < limit:
                mods.append({**cur, "base": m.group(1), "size": m.group(2), "version": ver, "path": rest})
            continue
        pm = re.match(r"^(\S.*?)\s+pid:\s*(\d+)\s*$", line)
        if pm:
            cur = {"process": pm.group(1), "pid": int(pm.group(2))}
    return mods, total


@safe
def listdlls_list(pid: int, max_entries: int = 2000, timeout_s: int = 120) -> dict[str, Any]:
    """Loaded modules of a process (Sysinternals ListDLLs): base, size, version, path.

    Also shows the command line header in `stdout`. Modules are capped at max_entries.
    """
    p = check_pid(pid)
    lim = clamp_int(max_entries, 1, 20000, "max_entries")
    exe, err = _with_tool("listdlls")
    if err:
        return err
    res = run_cmd([exe, "-accepteula", str(p)], timeout_s, cap=4 * MB)
    if res.get("missing_binary"):
        return res
    res["modules"], res["total"] = parse_listdlls(res["stdout"], lim)
    res["stdout"] = res["stdout"][:OUTPUT_CAP]
    return res


@safe
def autoruns_scan(verify_signatures: bool = False, hide_microsoft: bool = False, max_rows: int = 500,
                  timeout_s: int = 300) -> dict[str, Any]:
    """Autostart entries (Sysinternals autorunsc -a * -c): services, run keys, tasks, drivers, ...

    verify_signatures: -s (slow, may use the network). hide_microsoft: -m. `rows` are parsed CSV
    records capped at max_rows; `counts` has totals per Category.
    """
    lim = clamp_int(max_rows, 1, 5000, "max_rows")
    exe, err = _with_tool("autorunsc")
    if err:
        return err
    work = new_workdir("autoruns")
    sf = os.path.join(work, "autoruns.csv")
    try:
        argv = [exe, "-accepteula", "-nobanner", "-a", "*", "-c", "-h"]
        if verify_signatures:
            argv.append("-s")
        if hide_microsoft:
            argv.append("-m")
        res = run_cmd(argv, timeout_s, stdout_file=sf)
        if res.get("missing_binary"):
            return res
        res["stdout"] = res["stdout"][:2000]
        try:
            rows = _csv_rows(read_all_bounded(sf))
        except (OSError, ToolError, csv.Error) as e:
            rows = []
            res.setdefault("error", f"could not read autorunsc output: {e}")
        res["counts"] = dict(Counter(r.get("Category", "?") for r in rows))
        res["total"] = len(rows)
        res["rows"] = rows[:lim]
        res["truncated"] = bool(res["truncated"] or len(rows) > lim)
        return res
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --------------------------------------------------------------------------
# Process Monitor
# --------------------------------------------------------------------------

_procmon: dict[str, dict[str, Any]] = {}


@safe
def procmon_capture_start(timeout_s: int = 20) -> dict[str, Any]:
    """Start a Process Monitor capture to a PML backing file (procmon /Quiet /Minimized).

    Needs administrator rights (the service runs as SYSTEM). Returns capture_id and pml path; stop
    it with procmon_capture_stop. Only one capture can run at a time.
    """
    exe, err = _with_tool("procmon")
    if err:
        return err
    for cid, st in _procmon.items():
        if st["proc"].poll() is None:
            raise ToolError(f"capture {cid} is still running; stop it first")
    cid = uuid.uuid4().hex[:12]
    work = new_workdir("procmon")
    pml = os.path.join(work, "capture.pml")
    log = open(os.path.join(work, "procmon.log"), "wb")
    try:
        proc = subprocess.Popen(
            [exe, "/AcceptEula", "/Quiet", "/Minimized", "/BackingFile", pml],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, **popen_kwargs())
    except OSError as e:
        log.close()
        return {"error": f"cannot execute procmon: {e}", "exit_code": None}
    log.close()
    wait = clamp_timeout(timeout_s)
    deadline = time.monotonic() + min(wait, 20)
    while time.monotonic() < deadline and not os.path.exists(pml):
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    if proc.poll() is not None:
        return {"error": f"procmon exited immediately with code {proc.returncode} (needs admin?)",
                "exit_code": proc.returncode}
    _procmon[cid] = {"proc": proc, "pml": pml, "work": work, "t0": time.time()}
    return {"capture_id": cid, "pml": pml, "pid": proc.pid, "exit_code": 0}


def classify_op(operation: str) -> str:
    op = operation or ""
    if op.startswith("Reg"):
        return "registry"
    if op.startswith(("TCP", "UDP")):
        return "network"
    if op.startswith(("Process", "Thread", "Load Image")):
        return "process"
    return "file"


_INTERESTING = {
    "file": ("CreateFile", "WriteFile", "SetDispositionInformationFile", "SetRenameInformationFile",
             "DeleteFile"),
    "registry": ("RegSetValue", "RegCreateKey", "RegDeleteKey", "RegDeleteValue"),
}


def summarise_procmon_csv(path: str, max_rows: int, process: str | None, path_contains: str | None,
                          categories: set[str] | None) -> dict[str, Any]:
    """Stream a Procmon CSV export and summarise it (never loads the file into memory)."""
    with open(path, "rb") as fb:
        head = fb.read(4)
    enc = "utf-16" if head[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    procs: Counter[str] = Counter()
    cats: Counter[str] = Counter()
    ops: Counter[str] = Counter()
    sample: list[dict[str, str]] = []
    total = 0
    matched = 0
    pf = process.lower() if process else None
    sf = path_contains.lower() if path_contains else None
    with open(path, "r", encoding=enc, errors="replace", newline="") as f:
        rd = csv.DictReader(f)
        for r in rd:
            total += 1
            pname = r.get("Process Name", "")
            op = r.get("Operation", "")
            cat = classify_op(op)
            if pf and pf not in pname.lower() and pf != str(r.get("PID", "")):
                continue
            if sf and sf not in (r.get("Path", "") or "").lower():
                continue
            matched += 1
            procs[pname] += 1
            cats[cat] += 1
            ops[op] += 1
            if len(sample) < max_rows and (categories is None or cat in categories):
                interesting = (categories is not None or cat == "network"
                               or op.startswith(_INTERESTING.get(cat, ("\0",))))
                if interesting:
                    sample.append({k: r.get(k, "") for k in
                                   ("Time of Day", "Process Name", "PID", "Operation", "Path", "Result", "Detail")})
    return {
        "events_total": total,
        "events_matched": matched,
        "by_category": dict(cats),
        "top_processes": procs.most_common(15),
        "top_operations": ops.most_common(20),
        "rows": sample,
    }


@safe
def procmon_capture_stop(capture_id: str | None = None, pml_path: str | None = None, max_rows: int = 200,
                         process: str | None = None, path_contains: str | None = None,
                         categories: list[Literal["file", "registry", "network", "process"]] | None = None,
                         timeout_s: int = 300) -> dict[str, Any]:
    """Stop the Procmon capture, convert it to CSV and return a summary.

    capture_id: from procmon_capture_start (omit to stop whichever capture is running); pml_path may
    be given instead to convert an existing PML file under an allowed root. Optional filters for the
    summary: process (name substring or pid), path_contains, categories. `rows` holds up to max_rows
    events (writes/creates/registry sets/network by default, or every event of the chosen categories).
    Returns `summary` {events_total, by_category, top_processes, top_operations, rows} and `csv`.
    """
    lim = clamp_int(max_rows, 1, 2000, "max_rows")
    cats = None
    if categories is not None:
        cats = set(categories)
        if not cats <= {"file", "registry", "network", "process"}:
            raise ToolError("categories must be a subset of file, registry, network, process")
    exe, err = _with_tool("procmon")
    if err:
        return err
    st = None
    if pml_path is not None:
        pml = check_path(pml_path, what="pml_path")
    else:
        if capture_id is None:
            running = [c for c, s in _procmon.items() if s["proc"].poll() is None]
            capture_id = running[-1] if running else (list(_procmon)[-1] if _procmon else None)
        if capture_id is None or capture_id not in _procmon:
            raise ToolError("no such capture; pass capture_id from procmon_capture_start or pml_path")
        st = _procmon[capture_id]
        pml = st["pml"]
        if st["proc"].poll() is None:
            term = run_cmd([exe, "/AcceptEula", "/Terminate"], 60)
            try:
                st["proc"].wait(60)
            except subprocess.TimeoutExpired:
                kill_tree(st["proc"])
                st["proc"].wait()
            if term.get("missing_binary"):
                return term
    if not os.path.exists(pml):
        raise ToolError(f"PML file {pml!r} was not written")
    csv_path = os.path.splitext(pml)[0] + ".csv"
    conv = run_cmd([exe, "/AcceptEula", "/Quiet", "/Minimized", "/OpenLog", pml, "/SaveAs", csv_path], timeout_s)
    if conv.get("missing_binary"):
        return conv
    if not os.path.exists(csv_path):
        return {"error": "procmon did not produce a CSV export", "exit_code": conv["exit_code"],
                "stderr": conv["stderr"], "pml": pml}
    summary = summarise_procmon_csv(csv_path, lim, process, path_contains, cats)
    if st is not None:
        _procmon.pop(capture_id, None)
    return {"exit_code": conv["exit_code"], "pml": pml, "csv": csv_path, "summary": summary,
            "pml_bytes": os.path.getsize(pml), "csv_bytes": os.path.getsize(csv_path)}


# --------------------------------------------------------------------------
# network capture analysis
# --------------------------------------------------------------------------

@safe
def tshark_summary(pcap: str, extra_stats: list[Literal["udp", "http", "dns"]] | None = None,
                   timeout_s: int = 300) -> dict[str, Any]:
    """Summarise a pcap/pcapng with tshark: TCP conversations (-z conv,tcp) and protocol hierarchy (-z io,phs).

    extra_stats may add udp (conv,udp), http (http,tree) or dns (dns,tree). Each section is capped at
    64 KiB (head kept). This only reads capture files; live capture is done on the Proxmox host.
    """
    p = check_path(pcap, what="pcap")
    exe, err = _with_tool("tshark")
    if err:
        return err
    stats = {"tcp_conversations": "conv,tcp", "protocol_hierarchy": "io,phs"}
    for e in extra_stats or []:
        if e not in ("udp", "http", "dns"):
            raise ToolError("extra_stats entries must be udp, http or dns")
        stats[{"udp": "udp_conversations", "http": "http", "dns": "dns"}[e]] = {
            "udp": "conv,udp", "http": "http,tree", "dns": "dns,tree"}[e]
    out: dict[str, Any] = {"exit_code": 0, "truncated": False}
    for key, z in stats.items():
        res = run_cmd([exe, "-r", p, "-q", "-z", z], timeout_s, keep="head")
        if res.get("missing_binary"):
            return res
        out[key] = res["stdout"]
        out["truncated"] = out["truncated"] or res["truncated"]
        if res["exit_code"] != 0:
            out["exit_code"] = res["exit_code"]
            out.setdefault("stderr", "")
            out["stderr"] += res["stderr"][-4000:]
        if res.get("timed_out"):
            out["timed_out"] = True
            out["error"] = res["error"]
            break
    return out


# --------------------------------------------------------------------------
# PE parsing (in-process, pefile)
# --------------------------------------------------------------------------

def _entropy(data: bytes) -> float:
    if not data:
        return 0.0
    import math
    counts = Counter(data)
    n = len(data)
    return round(-sum(c / n * math.log2(c / n) for c in counts.values()), 3)


@safe
def pe_info(path: str, max_imports: int = 200, max_exports: int = 500) -> dict[str, Any]:
    """Parse a PE file with pefile: headers, sections (with entropy), imports, exports, timestamp.

    Imports are capped at max_imports functions per DLL (and 100 DLLs), exports at max_exports.
    """
    p = check_path(path, what="path")
    mi = clamp_int(max_imports, 1, 5000, "max_imports")
    me = clamp_int(max_exports, 1, 20000, "max_exports")
    try:
        import pefile
    except ImportError:
        return {"error": "pefile is not installed in this environment", "missing_binary": "pefile",
                "exit_code": None}
    try:
        pe = pefile.PE(p, fast_load=True)
    except pefile.PEFormatError as e:
        return {"error": f"not a valid PE file: {e}", "exit_code": None}
    try:
        pe.parse_data_directories(directories=[
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"],
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXPORT"],
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_SECURITY"],
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR"],
        ])
        fh, oh = pe.FILE_HEADER, pe.OPTIONAL_HEADER
        ts = fh.TimeDateStamp
        try:
            iso = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            iso = None
        sections = []
        for s in pe.sections:
            data = s.get_data()
            sections.append({
                "name": s.Name.rstrip(b"\x00").decode("latin-1"),
                "virtual_address": hex(s.VirtualAddress), "virtual_size": s.Misc_VirtualSize,
                "raw_size": s.SizeOfRawData, "entropy": _entropy(data),
                "characteristics": hex(s.Characteristics),
                "flags": "".join(c for c, bit in (("R", 0x40000000), ("W", 0x80000000), ("X", 0x20000000))
                                 if s.Characteristics & bit),
            })
        imports = []
        for entry in (getattr(pe, "DIRECTORY_ENTRY_IMPORT", []) or [])[:100]:
            fns = [(i.name.decode("latin-1") if i.name else f"ord{i.ordinal}") for i in entry.imports]
            imports.append({"dll": entry.dll.decode("latin-1"), "count": len(fns), "functions": fns[:mi]})
        exports = []
        exp = getattr(pe, "DIRECTORY_ENTRY_EXPORT", None)
        export_total = 0
        if exp is not None:
            export_total = len(exp.symbols)
            for sym in exp.symbols[:me]:
                exports.append({"ordinal": sym.ordinal, "name": sym.name.decode("latin-1") if sym.name else None,
                                "rva": hex(sym.address)})
        try:
            imphash = pe.get_imphash()
        except Exception:
            imphash = None
        sec_dir = oh.DATA_DIRECTORY[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_SECURITY"]]
        com_dir = oh.DATA_DIRECTORY[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR"]]
        return {
            "exit_code": 0,
            "machine": pefile.MACHINE_TYPE.get(fh.Machine, hex(fh.Machine)),
            "is_dll": pe.is_dll(), "is_exe": pe.is_exe(), "is_driver": pe.is_driver(),
            "is_64bit": oh.Magic == 0x20B,
            "timestamp": ts, "timestamp_utc": iso,
            "subsystem": pefile.SUBSYSTEM_TYPE.get(oh.Subsystem, oh.Subsystem),
            "entry_point_rva": hex(oh.AddressOfEntryPoint), "image_base": hex(oh.ImageBase),
            "size_of_image": oh.SizeOfImage,
            "dll_characteristics": hex(oh.DllCharacteristics),
            "has_authenticode": bool(sec_dir.VirtualAddress and sec_dir.Size),
            "is_dotnet": bool(com_dir.VirtualAddress and com_dir.Size),
            "overlay_offset": pe.get_overlay_data_start_offset(),
            "imphash": imphash,
            "sections": sections,
            "imports": imports, "import_dll_count": len(getattr(pe, "DIRECTORY_ENTRY_IMPORT", []) or []),
            "exports": exports, "export_total": export_total,
        }
    finally:
        pe.close()


# --------------------------------------------------------------------------
# inventory
# --------------------------------------------------------------------------

# How to ask each tool for its version. None = never executed (procmon would open its GUI).
_VERSION_ARGS: dict[str, list[str] | None] = {
    "sigcheck": ["-accepteula"], "strings": ["-accepteula"], "handle": ["-accepteula"],
    "listdlls": ["-accepteula"], "procdump": ["-accepteula"], "autorunsc": ["-accepteula"],
    "procmon": None,
    "diec": ["--version"], "capa": ["--version"], "floss": ["--version"],
    "ilspycmd": ["--version"], "tshark": ["--version"],
}


@safe
def tool_versions() -> dict[str, Any]:
    """Report which tools are installed (path and first line of their version/banner output)."""
    tools: dict[str, Any] = {}
    for name in TOOL_DEFAULTS:
        p = find_tool(name)
        if p is None:
            tools[name] = {"found": False}
            continue
        entry: dict[str, Any] = {"found": True, "path": p, "version": None}
        args = _VERSION_ARGS.get(name)
        if args is not None:
            r = run_cmd([p] + args, 20, cap=4096, keep="head")
            text = (r.get("stdout") or "") + "\n" + (r.get("stderr") or "")
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            entry["version"] = lines[0][:200] if lines else None
        tools[name] = entry
    try:
        import pefile
        tools["pefile"] = {"found": True, "version": getattr(pefile, "__version__", None)}
    except ImportError:
        tools["pefile"] = {"found": False}
    return {"exit_code": 0, "tools": tools, "work_root": work_root()}


ALL_TOOLS = [
    sigcheck_scan, strings_scan, diec_scan, capa_scan, floss_scan, ilspy_decompile,
    procdump_run, handle_list, listdlls_list, autoruns_scan,
    procmon_capture_start, procmon_capture_stop, tshark_summary, pe_info, tool_versions,
]
