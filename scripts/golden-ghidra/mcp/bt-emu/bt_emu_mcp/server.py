"""MCP server exposing the virtual Bluetooth lab.

Every tool returns a compact dict.  Failures come back as
``{"ok": false, "error": "..."}`` (never a stack trace).
"""

from __future__ import annotations

import argparse
import functools
import inspect
import logging
import os
import sys
from typing import Any, Awaitable, Callable

from mcp.server.fastmcp import FastMCP

from . import ops
from . import profiles as profiles_mod
from .lab import LAB, VHCI_PATH, LabError
from .profiles import ProfileError

log = logging.getLogger("bt_emu_mcp")

INSTRUCTIONS = (
    "Virtual Bluetooth lab for testing Bluetooth software without hardware or radio. "
    "Typical flow: lab_create -> device_create(profile='generic-earbud', role='peripheral') -> adv_start -> "
    "device_create(profile='generic-earbud', role='central') -> central_scan -> central_connect -> central_discover -> "
    "central_read / central_subscribe -> gatt_notify -> central_notifications. Use hci_log_start for a btsnoop trace."
)

mcp = FastMCP("bt-emu-mcp", instructions=INSTRUCTIONS, host="0.0.0.0", port=8087)


def tool(fn: Callable[..., Awaitable[dict[str, Any]] | dict[str, Any]]) -> Callable[..., Any]:
    """Register ``fn`` as an MCP tool, converting exceptions into error dicts."""

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> dict[str, Any]:
        try:
            result = fn(*args, **kwargs)
            if inspect.isawaitable(result):
                result = await result
            return {"ok": True, **result}
        except (LabError, ProfileError) as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            log.exception("tool %s failed", fn.__name__)
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    mcp.tool()(wrapper)
    return wrapper


# --------------------------------------------------------------------------- profiles
@tool
def list_profiles() -> dict[str, Any]:
    """List the device profiles available to device_create (bundled and BT_EMU_PROFILES directory).

    Skeleton profiles are incomplete (only values from the user's research notes);
    each row says how many fields are still unknown."""
    rows = []
    for name, path in sorted(profiles_mod.list_profile_files().items()):
        try:
            data = profiles_mod.load_profile(str(path))
            rows.append({"name": name, "path": str(path), "skeleton": bool(data.get("skeleton")),
                         "unknown_fields": len(profiles_mod.find_unknowns(data)), "description": data.get("description", "")})
        except ProfileError as exc:
            rows.append({"name": name, "path": str(path), "error": str(exc)})
    return {"profiles": rows}


@tool
def load_profile(name_or_path: str, full: bool = False) -> dict[str, Any]:
    """Load and validate a profile by bundled name or JSON file path (JSON schema plus semantic checks).

    Returns a summary including every field still marked unknown and the provenance block.
    Set full=true to include the whole profile document."""
    data = profiles_mod.load_profile(name_or_path)
    gatt = data.get("gatt") if isinstance(data.get("gatt"), dict) else {}
    services = gatt.get("services", []) if gatt else []
    out: dict[str, Any] = {
        "valid": True, "id": data["id"], "name": data["name"], "skeleton": bool(data.get("skeleton")),
        "address": data.get("address"), "services": [s["uuid"] for s in services],
        "characteristics": sum(len(s.get("characteristics", [])) for s in services),
        "has_a2dp_sink": isinstance(data.get("a2dp_sink"), dict) and not profiles_mod.is_unknown(data["a2dp_sink"]),
        "has_avrcp": isinstance(data.get("avrcp"), dict) and not profiles_mod.is_unknown(data["avrcp"]),
        "unknown": profiles_mod.find_unknowns(data), "provenance": data.get("provenance"),
    }
    if full:
        out["profile"] = data
    return out


# --------------------------------------------------------------------------- lab
@tool
async def lab_create(backend: str = "local-link") -> dict[str, Any]:
    """Start a fresh lab, discarding any existing devices.

    backend='local-link' (default): in-process virtual controllers joined by a Bumble LocalLink; works anywhere.
    backend='vhci': attach emulated peripherals to the kernel virtual HCI (/dev/vhci) so the VM's BlueZ sees them;
    returns an error if /dev/vhci is not accessible."""
    if backend not in ("local-link", "vhci"):
        raise LabError("backend must be 'local-link' or 'vhci'")
    if backend == "vhci" and not os.access(VHCI_PATH, os.R_OK | os.W_OK):
        raise LabError(
            f"{VHCI_PATH} is not accessible (exists={os.path.exists(VHCI_PATH)}). Run 'sudo modprobe hci_vhci' and give the service "
            "user read/write access (udev rule or group), or use backend 'local-link'."
        )
    await LAB.reset(backend)
    return {"backend": backend}


@tool
async def lab_reset() -> dict[str, Any]:
    """Remove every device, stop any HCI log and clear all lab state (keeps the current backend)."""
    await LAB.reset()
    return {"backend": LAB.backend, "devices": 0}


@tool
async def device_create(profile: str, name: str | None = None, role: str = "peripheral", address: str | None = None) -> dict[str, Any]:
    """Create an emulated device from a profile (bundled name or JSON path) and power it on.

    role='peripheral' builds the profile's GATT database (and A2DP sink/AVRCP if the profile has them);
    role='central' makes an empty host that can scan, connect and read.  name overrides the device name;
    address overrides the profile address (duplicates are bumped automatically).
    Returns device_id plus notes about anything unknown in the profile."""
    return await LAB.device_create(profile, name, role, address)


@tool
async def device_remove(device_id: str) -> dict[str, Any]:
    """Disconnect, power off and delete one device."""
    return await LAB.device_remove(device_id)


@tool
def list_devices() -> dict[str, Any]:
    """List the lab's devices with role, address, advertising state and connections."""
    return {"backend": LAB.backend, "devices": LAB.list_devices()}


# --------------------------------------------------------------------------- advertising
@tool
async def adv_start(device_id: str) -> dict[str, Any]:
    """Start connectable, scannable advertising for a peripheral (data comes from its profile or adv_set_data)."""
    return await ops.adv_start(device_id)


@tool
async def adv_stop(device_id: str) -> dict[str, Any]:
    """Stop advertising for a peripheral."""
    return await ops.adv_stop(device_id)


@tool
async def adv_set_data(device_id: str, data_hex: str, scan_response: bool = False) -> dict[str, Any]:
    """Replace the raw advertising payload (hex AD structures, max 31 bytes) or, with scan_response=true, the scan response.
    Restarts advertising if it is running."""
    return await ops.adv_set_data(device_id, data_hex, scan_response)


# --------------------------------------------------------------------------- GATT (peripheral side)
@tool
async def gatt_read(device_id: str, characteristic_uuid: str, index: int = 0) -> dict[str, Any]:
    """Read a characteristic's current value from a peripheral's local GATT database.
    index selects among duplicate UUIDs (default first)."""
    return await ops.gatt_read(device_id, characteristic_uuid, index)


@tool
async def gatt_write(device_id: str, characteristic_uuid: str, value_hex: str, index: int = 0) -> dict[str, Any]:
    """Set a characteristic's value in a peripheral's local GATT database (does not notify; use gatt_notify for that)."""
    return await ops.gatt_write(device_id, characteristic_uuid, value_hex, index)


@tool
async def gatt_notify(device_id: str, characteristic_uuid: str, value_hex: str, index: int = 0) -> dict[str, Any]:
    """Set the value and send a notification to every connected peer subscribed to it; reports the subscriber count."""
    return await ops.gatt_notify(device_id, characteristic_uuid, value_hex, index)


@tool
async def gatt_dump(device_id: str) -> dict[str, Any]:
    """Dump a device's full local GATT database: services, characteristics (handles, properties, values) and descriptors."""
    return await ops.gatt_dump(device_id)


@tool
async def send_scripted_notifications(
    device_id: str, characteristic_uuid: str, frames: list[str], interval_ms: int = 100, repeat: int = 1,
    background: bool = False, index: int = 0,
) -> dict[str, Any]:
    """Replay recorded frames (hex strings, e.g. head-tracking reports captured from a real device) as notifications.

    Frames are sent in order, interval_ms apart, and the whole list is played repeat times.  Only subscribed peers
    receive them.  Runs to completion unless background=true (required if it would take over 2 minutes)."""
    return await ops.send_scripted_notifications(device_id, characteristic_uuid, frames, interval_ms, repeat, background, index)


# --------------------------------------------------------------------------- central
@tool
async def central_scan(central_id: str, duration_s: float = 3.0) -> dict[str, Any]:
    """Run an active LE scan on a central for duration_s seconds; returns each advertiser (address, name, services, raw data)."""
    return await ops.central_scan(central_id, duration_s)


@tool
async def central_connect(central_id: str, peripheral_id: str) -> dict[str, Any]:
    """Connect a central to an advertising peripheral over LE; returns connection info. Call adv_start first."""
    return await ops.central_connect(central_id, peripheral_id)


@tool
async def central_discover(central_id: str, peripheral_id: str | None = None) -> dict[str, Any]:
    """Discover services, characteristics and descriptors as seen over the link (defaults to the most recent connection)."""
    return await ops.central_discover(central_id, peripheral_id)


@tool
async def central_read(central_id: str, characteristic_uuid: str, peripheral_id: str | None = None, index: int = 0) -> dict[str, Any]:
    """GATT-read a characteristic over the link (discovers automatically if needed)."""
    return await ops.central_read(central_id, characteristic_uuid, peripheral_id, index)


@tool
async def central_write(central_id: str, characteristic_uuid: str, value_hex: str, with_response: bool | None = None,
                        peripheral_id: str | None = None, index: int = 0) -> dict[str, Any]:
    """GATT-write a characteristic over the link. with_response defaults to true when the characteristic supports Write."""
    return await ops.central_write(central_id, characteristic_uuid, value_hex, with_response, peripheral_id, index)


@tool
async def central_subscribe(central_id: str, characteristic_uuid: str, peripheral_id: str | None = None, index: int = 0) -> dict[str, Any]:
    """Subscribe to notifications on a characteristic; received values are buffered for central_notifications."""
    return await ops.central_subscribe(central_id, characteristic_uuid, peripheral_id, index)


@tool
async def central_notifications(central_id: str, limit: int = 50, clear: bool = False) -> dict[str, Any]:
    """Return the most recent buffered notifications (up to limit, oldest first); clear=true empties the buffer afterwards."""
    return await ops.central_notifications(central_id, limit, clear)


# --------------------------------------------------------------------------- A2DP
@tool
async def a2dp_status(device_id: str) -> dict[str, Any]:
    """Report A2DP state: for a peripheral, its SBC sink endpoint (connected, AVDTP state, negotiated codec, RTP packet counts,
    recent events); for a central, its source stream. Also states exactly which parts of A2DP are implemented."""
    return await ops.a2dp_status(device_id)


@tool
async def central_a2dp_connect(central_id: str, peripheral_id: str) -> dict[str, Any]:
    """Open a BR/EDR link from a central to a peripheral with an a2dp_sink profile and run AVDTP discover, configure, open and
    start (SBC). Afterwards a2dp_status(peripheral_id) shows the negotiated codec."""
    return await ops.central_a2dp_connect(central_id, peripheral_id)


@tool
async def central_a2dp_send(central_id: str, packets: int = 10, frames_per_packet: int = 5) -> dict[str, Any]:
    """Send synthetic SBC-shaped RTP packets over the open A2DP stream (not decodable audio) to exercise the sink's counters."""
    return await ops.central_a2dp_send(central_id, packets, frames_per_packet)


@tool
async def central_a2dp_control(central_id: str, action: str) -> dict[str, Any]:
    """Control the central's A2DP stream: action is 'start', 'suspend' or 'close'."""
    return await ops.central_a2dp_control(central_id, action)


# --------------------------------------------------------------------------- HCI log
@tool
async def hci_log_start(path: str | None = None) -> dict[str, Any]:
    """Start writing an HCI trace in btsnoop format (openable in Wireshark) for every device, current and future.
    path defaults to a temp file. Returns the combined file path plus one file per device (cleaner: one controller each)."""
    return await LAB.hci_log_start(path)


@tool
async def hci_log_stop() -> dict[str, Any]:
    """Stop the HCI trace and return the file path(s) and size."""
    return await LAB.hci_log_stop()


# --------------------------------------------------------------------------- entry point
def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="bt_emu_mcp", description="Virtual Bluetooth lab MCP server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8087)
    parser.add_argument("--transport", choices=["streamable-http", "stdio"], default="streamable-http")
    parser.add_argument("--log-level", default="WARNING")
    args = parser.parse_args(argv)
    logging.basicConfig(stream=sys.stderr, level=getattr(logging, args.log_level.upper(), logging.WARNING))
    mcp.settings.host = args.host
    mcp.settings.port = args.port
    mcp.run(transport=args.transport)


if __name__ == "__main__":
    main()
