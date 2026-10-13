"""Android tools for the re-toolbox: static APK analysis (apktool, jadx, aapt, apksigner)
and adb against a device given as host:port (typically the android-re lab image's :5555).

Same conventions as tools.py: plain functions returning dicts; failures are
{"error": ..., "exit_code": None} and a missing binary adds "missing_binary".
"""

from __future__ import annotations

import os
import re
import shutil
from typing import Any

from .core import (
    ToolError, check_path, have, missing, new_workdir, read_tail, run_cmd, safe,
)

_DEVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,252}:\d{1,5}$")
_PKG_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$")


def _apk(path: str) -> str:
    p = check_path(path, what="apk")
    if not os.path.isfile(p):
        raise ToolError(f"{p!r} is not a regular file")
    return p


def _outdir(output_dir: str | None, kind: str) -> str:
    """A fresh output directory: given (must not exist, under an allowed root) or a new workdir."""
    if output_dir is None:
        return new_workdir(kind)
    o = check_path(output_dir, must_exist=False, what="output_dir")
    if os.path.exists(o):
        raise ToolError(f"output_dir {o!r} already exists")
    return o


def _count_files(root: str, limit: int = 300) -> tuple[list[str], int]:
    names: list[str] = []
    total = 0
    for dp, _dn, fns in os.walk(root):
        for fn in sorted(fns):
            total += 1
            if len(names) < limit:
                names.append(os.path.relpath(os.path.join(dp, fn), root))
    return names, total


def _device(device: Any) -> str:
    if not isinstance(device, str) or not _DEVICE_RE.match(device) or int(device.rsplit(":", 1)[1]) > 65535:
        raise ToolError("device must be host:port, e.g. 10.10.10.100:5555")
    return device


def _adb(device: str, args: list[str], timeout_s: int = 60) -> dict[str, Any]:
    """Run `adb -s device ...` after (re)connecting; connect is idempotent."""
    if not have("adb"):
        return missing("adb")
    c = run_cmd(["adb", "connect", device], 20)
    res = run_cmd(["adb", "-s", device] + args, timeout_s)
    res["connect"] = (c.get("stdout") or c.get("stderr") or "").strip()
    return res


# --------------------------------------------------------------------------
# static APK analysis
# --------------------------------------------------------------------------

@safe
def apktool_decode(apk: str, output_dir: str | None = None, decode_sources: bool = True,
                   timeout_s: int = 300) -> dict[str, Any]:
    """Decode an APK with apktool: AndroidManifest.xml, resources and smali code.

    apk: path under an allowed root. output_dir: new directory (must not exist);
    default is a fresh dir under /tmp/re-toolbox/apktool/. decode_sources=False
    passes -s (keep classes.dex undecoded; much faster). Returns `output_dir`,
    `manifest` (path of the decoded AndroidManifest.xml or null), `files`
    (relative paths, first 300) and `file_count`.
    """
    a = _apk(apk)
    if not have("apktool"):
        return missing("apktool")
    o = _outdir(output_dir, "apktool")
    argv = ["apktool", "d", "-f", "-o", o]
    if not decode_sources:
        argv.append("-s")
    res = run_cmd(argv + [a], timeout_s)
    if res.get("missing_binary"):
        return res
    files, total = _count_files(o)
    man = os.path.join(o, "AndroidManifest.xml")
    res.update(output_dir=o, manifest=man if os.path.exists(man) else None, files=files, file_count=total)
    return res


@safe
def jadx_decompile(apk: str, output_dir: str | None = None, timeout_s: int = 600) -> dict[str, Any]:
    """Decompile an APK/DEX/JAR to Java source with jadx.

    output_dir: new directory (must not exist); default a fresh dir under
    /tmp/re-toolbox/jadx/. jadx exits non-zero when it hit decompile errors
    but still writes most classes, so judge by `java_files`, not exit_code
    alone. Returns `output_dir`, `sources_dir`, `java_files` (count), `files`
    (first 300 relative paths) and `errors` (jadx's reported error count, if
    present in the log).
    """
    a = _apk(apk)
    if not have("jadx"):
        return missing("jadx")
    o = _outdir(output_dir, "jadx")
    res = run_cmd(["jadx", "-d", o, a], timeout_s)
    if res.get("missing_binary"):
        return res
    src = os.path.join(o, "sources")
    names, total = _count_files(src) if os.path.isdir(src) else ([], 0)
    m = re.search(r"errors count:\s*(\d+)", (res.get("stdout") or "") + (res.get("stderr") or ""))
    res.update(output_dir=o, sources_dir=src if os.path.isdir(src) else None,
               java_files=sum(1 for _dp, _dn, fns in os.walk(src) for f in fns if f.endswith(".java")),
               files=names, errors=int(m.group(1)) if m else None)
    return res


def _aapt_bin() -> str | None:
    for b in ("aapt2", "aapt"):
        if have(b):
            return b
    return None


def _parse_badging(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {"permissions": [], "activities_launchable": [], "features": []}
    m = re.search(r"package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'", text)
    if m:
        out.update(package=m.group(1), version_code=m.group(2), version_name=m.group(3))
    for key, pat in (("min_sdk", r"sdkVersion:'(\d+)'"), ("target_sdk", r"targetSdkVersion:'(\d+)'"),
                     ("label", r"application-label:'([^']*)'")):
        m = re.search(pat, text)
        if m:
            out[key] = m.group(1)
    out["permissions"] = sorted(set(re.findall(r"uses-permission(?:-sdk-23)?: name='([^']*)'", text)))
    out["features"] = sorted(set(re.findall(r"uses-feature(?:-not-required)?: name='([^']*)'", text)))
    out["activities_launchable"] = re.findall(r"launchable-activity: name='([^']*)'", text)
    out["native_code"] = (re.search(r"native-code: ([^\n]*)", text) or [None, ""])[1].replace("'", "").split()
    return out


@safe
def apk_manifest(apk: str) -> dict[str, Any]:
    """Summarise an APK's manifest from `aapt dump badging` (aapt2 if installed).

    Returns `manifest`: {package, version_code, version_name, min_sdk,
    target_sdk, label, permissions[], features[], activities_launchable[],
    native_code[]} plus the raw `stdout`. For the full decoded manifest XML
    use apktool_decode.
    """
    a = _apk(apk)
    b = _aapt_bin()
    if b is None:
        return missing("aapt")
    res = run_cmd([b, "dump", "badging", a], 60)
    if res.get("missing_binary"):
        return res
    res["manifest"] = _parse_badging(res.get("stdout") or "")
    return res


@safe
def apk_sign_info(apk: str) -> dict[str, Any]:
    """Verify an APK's signature and list its signing certificates (`apksigner verify --print-certs -v`).

    Returns `verified` (bool), `schemes` ({v1,v2,v3,v4: bool}), `signers`
    (list of {n, dn, sha256, sha1, md5}) and the raw output. A debug/unsigned
    APK shows verified=false (see `stderr`).
    """
    a = _apk(apk)
    if not have("apksigner"):
        return missing("apksigner")
    res = run_cmd(["apksigner", "verify", "--print-certs", "-v", a], 120)
    if res.get("missing_binary"):
        return res
    text = res.get("stdout") or ""
    res["verified"] = res.get("exit_code") == 0 and "Verifies" in text
    res["schemes"] = {
        f"v{n}": bool(re.search(rf"Verified using v{n} scheme.*?:\s*true", text, re.I)) for n in (1, 2, 3, 4)
    }
    signers: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"Signer #(\d+) certificate (DN|SHA-256 digest|SHA-1 digest|MD5 digest): (.*)", text):
        s = signers.setdefault(m.group(1), {"n": m.group(1)})
        key = {"DN": "dn", "SHA-256 digest": "sha256", "SHA-1 digest": "sha1", "MD5 digest": "md5"}[m.group(2)]
        s[key] = m.group(3).strip()
    res["signers"] = list(signers.values())
    return res


# --------------------------------------------------------------------------
# adb against host:port
# --------------------------------------------------------------------------

@safe
def adb_shell(device: str, command: str, timeout_s: int = 60) -> dict[str, Any]:
    """Run a shell command ON THE ANDROID DEVICE (`adb -s host:port shell <command>`).

    device: host:port of the device's adbd, e.g. "10.10.10.100:5555" (the
    android-re lab VM). command: a shell command line interpreted by the
    device's own sh, not by this machine. stdin is closed. adb shell prints
    stderr into stdout and gives the device command's exit code in exit_code.
    """
    d = _device(device)
    if not isinstance(command, str) or not command.strip() or "\x00" in command:
        raise ToolError("command must be a non-empty string")
    return _adb(d, ["shell", command], timeout_s)


@safe
def adb_packages(device: str, third_party_only: bool = True, filter: str | None = None) -> dict[str, Any]:
    """List installed packages on the device with their APK paths (`pm list packages -f`).

    third_party_only: pass -3. filter: substring match on the package name.
    Returns `packages`: [{package, apk}].
    """
    d = _device(device)
    args = ["shell", "pm", "list", "packages", "-f"] + (["-3"] if third_party_only else [])
    res = _adb(d, args)
    if res.get("missing_binary"):
        return res
    pk = []
    for line in (res.get("stdout") or "").splitlines():
        m = re.match(r"package:(.*)=([^=\s]+)\s*$", line.strip())
        if m and (not filter or filter in m.group(2)):
            pk.append({"package": m.group(2), "apk": m.group(1)})
    res["packages"] = pk
    return res


@safe
def adb_pull_apk(device: str, package: str, output_path: str) -> dict[str, Any]:
    """Pull a package's base APK from the device to output_path (must not exist).

    The result `output_exists` and `size` confirm the copy; analyse it next
    with apk_manifest / apk_sign_info / apktool_decode / jadx_decompile.
    """
    d = _device(device)
    if not isinstance(package, str) or not _PKG_RE.match(package):
        raise ToolError("package must look like com.example.app")
    o = check_path(output_path, must_exist=False, what="output_path")
    if os.path.exists(o):
        raise ToolError(f"output_path {o!r} already exists")
    r = _adb(d, ["shell", "pm", "path", package], 30)
    if r.get("missing_binary"):
        return r
    paths = [ln.split(":", 1)[1].strip() for ln in (r.get("stdout") or "").splitlines() if ln.startswith("package:")]
    if not paths:
        return {"error": f"package {package!r} not found on {d}", "exit_code": None, "stdout": r.get("stdout", "")}
    base = next((p for p in paths if p.endswith("/base.apk")), paths[0])
    os.makedirs(os.path.dirname(o), exist_ok=True)
    res = run_cmd(["adb", "-s", d, "pull", base, o], 180)
    res.update(device_path=base, all_paths=paths, output_exists=os.path.exists(o),
               size=os.path.getsize(o) if os.path.exists(o) else None)
    return res


@safe
def adb_install(device: str, apk: str, replace: bool = True, grant_permissions: bool = False) -> dict[str, Any]:
    """Install a local APK on the device (`adb install [-r] [-g]`). Success prints "Success" in stdout."""
    d = _device(device)
    a = _apk(apk)
    args = ["install"] + (["-r"] if replace else []) + (["-g"] if grant_permissions else []) + [a]
    res = _adb(d, args, 300)
    res["installed"] = "Success" in (res.get("stdout") or "")
    return res


@safe
def adb_logcat(device: str, lines: int = 500, filter: str | None = None, clear: bool = False) -> dict[str, Any]:
    """Dump the device log (`adb logcat -d -t <lines>`), optionally filtered and/or cleared first.

    filter: a case-insensitive substring; only matching lines are returned
    (`matched`, `total_lines`). clear=True runs `logcat -c` afterwards.
    """
    d = _device(device)
    if isinstance(lines, bool) or not isinstance(lines, int) or not (1 <= lines <= 20000):
        raise ToolError("lines must be an integer in 1..20000")
    res = _adb(d, ["logcat", "-d", "-t", str(lines)], 60)
    if res.get("missing_binary"):
        return res
    all_lines = (res.get("stdout") or "").splitlines()
    res["total_lines"] = len(all_lines)
    if filter:
        f = filter.lower()
        sel = [ln for ln in all_lines if f in ln.lower()]
        res["stdout"] = "\n".join(sel)
        res["matched"] = len(sel)
    if clear:
        run_cmd(["adb", "-s", d, "logcat", "-c"], 20)
        res["cleared"] = True
    return res


ANDROID_TOOLS = [
    apktool_decode, jadx_decompile, apk_manifest, apk_sign_info,
    adb_shell, adb_packages, adb_pull_apk, adb_install, adb_logcat,
]
