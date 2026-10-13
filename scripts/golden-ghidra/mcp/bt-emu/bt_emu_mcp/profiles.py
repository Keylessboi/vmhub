"""Device profile loading and validation.

A profile is a JSON document (see ``profile.schema.json``) describing an
emulated Bluetooth device.  Fields that were never captured from a real device
are expressed as ``{"unknown": true}`` or listed in ``unknown_fields``; they are
reported by :func:`load_profile` and never filled in with invented data.
"""

from __future__ import annotations

import json
import os
from importlib import resources
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).with_name("profile.schema.json")

_FLAG_BITS = {
    "le_limited_discoverable": 0x01,
    "le_general_discoverable": 0x02,
    "br_edr_not_supported": 0x04,
    "le_br_edr_controller": 0x08,
    "le_br_edr_host": 0x10,
}


class ProfileError(ValueError):
    """Raised for a missing, unparsable or invalid profile."""


def schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text())


def profile_dirs() -> list[Path]:
    """Directories searched for profiles, highest priority first."""
    dirs: list[Path] = []
    env = os.environ.get("BT_EMU_PROFILES")
    if env:
        dirs.extend(Path(p) for p in env.split(os.pathsep) if p)
    dirs.append(Path.cwd() / "profiles")
    # Source checkout: <repo>/profiles next to the bt_emu_mcp package.
    dirs.append(Path(__file__).resolve().parent.parent / "profiles")
    # Installed wheel: profiles bundled inside the package.
    try:
        dirs.append(Path(str(resources.files("bt_emu_mcp").joinpath("profiles"))))
    except Exception:  # pragma: no cover - defensive
        pass
    seen: list[Path] = []
    for d in dirs:
        if d not in seen:
            seen.append(d)
    return [d for d in seen if d.is_dir()]


def list_profile_files() -> dict[str, Path]:
    found: dict[str, Path] = {}
    for d in profile_dirs():
        for f in sorted(d.glob("*.json")):
            found.setdefault(f.stem, f)
    return found


def is_unknown(value: Any) -> bool:
    return isinstance(value, dict) and value.get("unknown") is True


def find_unknowns(node: Any, path: str = "") -> list[str]:
    """Return the JSON paths of everything marked unknown in a profile."""
    out: list[str] = []
    if isinstance(node, dict):
        if is_unknown(node):
            out.append(path or "/")
            return out
        for name in node.get("unknown_fields", []) if isinstance(node.get("unknown_fields"), list) else []:
            out.append(f"{path}/{name}")
        for k, v in node.items():
            if k in ("provenance", "classic_info", "unknown_fields"):
                continue
            out.extend(find_unknowns(v, f"{path}/{k}"))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.extend(find_unknowns(v, f"{path}/{i}"))
    return out


def to_int(value: Any) -> int:
    if isinstance(value, int):
        return value
    return int(str(value), 0)


def flags_to_int(flags: Any) -> int | None:
    if flags is None or is_unknown(flags):
        return None
    if isinstance(flags, int):
        return flags
    out = 0
    for name in flags:
        out |= _FLAG_BITS[name]
    return out


def _semantic_check(profile: dict[str, Any]) -> list[str]:
    """Checks JSON Schema cannot express.  Returns a list of problems."""
    problems: list[str] = []
    from bumble.core import UUID

    def check_uuid(text: str, where: str) -> None:
        try:
            UUID(text.removeprefix("0x"))
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{where}: bad UUID {text!r}: {exc}")

    def check_adv(adv: Any, where: str) -> None:
        if not isinstance(adv, dict) or is_unknown(adv):
            return
        for u in adv.get("service_uuids", []):
            check_uuid(u, f"{where}/service_uuids")
        for sd in adv.get("service_data", []):
            check_uuid(sd["uuid"], f"{where}/service_data")
        md = adv.get("manufacturer_data")
        if isinstance(md, dict) and not is_unknown(md) and len(md["data_hex"]) % 2:
            problems.append(f"{where}/manufacturer_data: odd-length hex")

    check_adv(profile.get("advertising"), "/advertising")
    check_adv(profile.get("scan_response"), "/scan_response")
    gatt = profile.get("gatt")
    if isinstance(gatt, dict) and not is_unknown(gatt):
        for si, svc in enumerate(gatt.get("services", [])):
            check_uuid(svc["uuid"], f"/gatt/services/{si}")
            for ci, ch in enumerate(svc.get("characteristics", [])):
                where = f"/gatt/services/{si}/characteristics/{ci}"
                check_uuid(ch["uuid"], where)
                for d in ch.get("descriptors", []):
                    check_uuid(d["uuid"], f"{where}/descriptors")
                script = ch.get("notify_script")
                if script:
                    props = ch.get("properties", [])
                    if "notify" not in props and "indicate" not in props:
                        problems.append(f"{where}: notify_script on a characteristic without notify/indicate")
                    for fr in script.get("frames_hex", []):
                        if not fr:
                            problems.append(f"{where}: empty frame in notify_script")
                    off = script.get("counter", {}).get("offset")
                    if off is not None:
                        width = len(script["pattern_hex"]) // 2 if "pattern_hex" in script else min(
                            (len(f) // 2 for f in script["frames_hex"]), default=0
                        )
                        if off >= width:
                            problems.append(f"{where}: counter offset {off} outside the frame")
    a2dp = profile.get("a2dp_sink")
    if isinstance(a2dp, dict) and not is_unknown(a2dp):
        for ci, codec in enumerate(a2dp["codecs"]):
            lo, hi = codec.get("min_bitpool", 2), codec.get("max_bitpool", 53)
            if lo > hi:
                problems.append(f"/a2dp_sink/codecs/{ci}: min_bitpool > max_bitpool")
    return problems


def validate(profile: dict[str, Any]) -> list[str]:
    """Validate a profile dict.  Returns a list of problems (empty = valid)."""
    validator = Draft202012Validator(schema())
    problems = [
        f"{'/' + '/'.join(str(p) for p in e.absolute_path)}: {e.message}"[:300]
        for e in sorted(validator.iter_errors(profile), key=lambda e: list(map(str, e.absolute_path)))
    ]
    if problems:
        return problems[:25]
    return _semantic_check(profile)


def resolve_path(name_or_path: str) -> Path:
    p = Path(name_or_path).expanduser()
    if p.suffix == ".json" or os.sep in name_or_path:
        if not p.is_file():
            raise ProfileError(f"profile file not found: {name_or_path}")
        return p
    files = list_profile_files()
    if name_or_path in files:
        return files[name_or_path]
    raise ProfileError(f"unknown profile {name_or_path!r}; available: {sorted(files)}")


def load_profile(name_or_path: str | dict[str, Any]) -> dict[str, Any]:
    """Load and validate a profile by bundled name, file path or dict.

    Returns the raw (validated) profile; unknown markers are preserved.
    """
    if isinstance(name_or_path, dict):
        data = name_or_path
        source = "<inline>"
    else:
        path = resolve_path(name_or_path)
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            raise ProfileError(f"{path}: invalid JSON: {exc}") from exc
        source = str(path)
    problems = validate(data)
    if problems:
        raise ProfileError(f"{source}: invalid profile: " + "; ".join(problems[:8]))
    return data
