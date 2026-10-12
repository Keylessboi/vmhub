"""The virtual Bluetooth lab: named emulated devices on one of two backends.

``local-link``
    Every device gets a Bumble virtual controller; all controllers are joined by
    one in-process ``LocalLink``.  No kernel support needed; nothing leaves the
    process.

``vhci``
    Each (peripheral) device attaches to the Linux kernel's virtual HCI
    (``/dev/vhci``) so the VM's own BlueZ sees it as a nearby controller/device.

All state lives in the module-level :data:`LAB`.  Public coroutines take
``LAB.lock`` for the parts that mutate state and never hold it across sleeps.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import dataclasses
import os
import re
import struct
import tempfile
import time
from pathlib import Path
from typing import Any

from bumble import a2dp, avdtp, avrcp
from bumble.controller import Controller
from bumble.core import UUID, PhysicalTransport
from bumble.device import Device, DeviceConfiguration, Peer
from bumble.gatt import Characteristic, Descriptor, Service
from bumble.hci import Address
from bumble.host import Host
from bumble.link import LocalLink
from bumble.profiles.gap import GenericAccessService
from bumble.rtp import MediaPacket
from bumble.snoop import BtSnooper, Snooper
from bumble.transport.common import AsyncPipeSink

from . import profiles as profiles_mod
from .profiles import flags_to_int, is_unknown, to_int

SBC = a2dp.SbcMediaCodecInformation
VHCI_PATH = "/dev/vhci"
DEFAULT_ADV_INTERVAL_MS = 50.0

_PROP = {
    "broadcast": Characteristic.Properties.BROADCAST,
    "read": Characteristic.Properties.READ,
    "write_without_response": Characteristic.Properties.WRITE_WITHOUT_RESPONSE,
    "write": Characteristic.Properties.WRITE,
    "notify": Characteristic.Properties.NOTIFY,
    "indicate": Characteristic.Properties.INDICATE,
    "authenticated_signed_writes": Characteristic.Properties.AUTHENTICATED_SIGNED_WRITES,
    "extended_properties": Characteristic.Properties.EXTENDED_PROPERTIES,
}


class LabError(Exception):
    """A user-facing error: the message is returned to the MCP client as-is."""


# --------------------------------------------------------------------------- helpers
def ukey(text: str | UUID) -> str:
    """Canonical key for a UUID: 128-bit lowercase hex, no separators."""
    try:
        u = text if isinstance(text, UUID) else UUID(str(text).strip().removeprefix("0x"))
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"bad UUID {text!r}: {exc}") from exc
    return _u128(u)


def _u128(u: UUID) -> str:
    # Bumble stores UUID bytes little-endian; to_hex_str gives the canonical order.
    full = UUID.from_bytes(u.to_bytes(force_128=True))
    return full.to_hex_str().lower()


def short_uuid(u: UUID) -> str:
    return u.to_hex_str() if len(u.uuid_bytes) < 16 else u.to_hex_str("-").lower()


def hex_to_bytes(text: str, what: str = "value") -> bytes:
    cleaned = re.sub(r"[\s:_-]|^0x", "", text.strip())
    try:
        return bytes.fromhex(cleaned)
    except ValueError as exc:
        raise LabError(f"{what} is not valid hex: {text!r}") from exc


def _ad(ad_type: int, data: bytes) -> bytes:
    return bytes([len(data) + 1, ad_type]) + data


def build_adv(adv: dict[str, Any] | None, fallback_name: str | None, appearance: int | None) -> tuple[bytes, list[str]]:
    """Encode a profile advertising block into an AD payload.

    Returns ``(payload, notes)``.  Unknown fields are skipped, never invented.
    """
    notes: list[str] = []
    if not adv or is_unknown(adv):
        return b"", notes
    if "raw_hex" in adv:
        return bytes.fromhex(adv["raw_hex"]), notes
    out = b""
    flags = flags_to_int(adv.get("flags"))
    if flags is not None:
        out += _ad(0x01, bytes([flags]))
    uuids16: list[bytes] = []
    uuids32: list[bytes] = []
    uuids128: list[bytes] = []
    for text in adv.get("service_uuids", []):
        u = UUID(text.removeprefix("0x"))
        {2: uuids16, 4: uuids32, 16: uuids128}[len(u.uuid_bytes)].append(u.uuid_bytes)
    if uuids16:
        out += _ad(0x03, b"".join(uuids16))
    if uuids32:
        out += _ad(0x05, b"".join(uuids32))
    if uuids128:
        out += _ad(0x07, b"".join(uuids128))
    for sd in adv.get("service_data", []):
        if "data_hex" not in sd:
            notes.append(f"service_data {sd['uuid']} skipped: payload unknown")
            continue
        u = UUID(sd["uuid"].removeprefix("0x"))
        kind = {2: 0x16, 4: 0x20, 16: 0x21}[len(u.uuid_bytes)]
        out += _ad(kind, u.uuid_bytes + bytes.fromhex(sd["data_hex"]))
    md = adv.get("manufacturer_data")
    if isinstance(md, dict) and not is_unknown(md):
        out += _ad(0xFF, struct.pack("<H", md["company_id"]) + bytes.fromhex(md["data_hex"]))
    if "tx_power" in adv:
        out += _ad(0x0A, struct.pack("<b", adv["tx_power"]))
    app = adv.get("appearance", appearance if appearance is not None and "appearance" in adv else None)
    if app is not None:
        out += _ad(0x19, struct.pack("<H", to_int(app)))
    name = adv.get("local_name")
    if isinstance(name, str):
        out += _ad(0x09, name.encode())
    elif is_unknown(name) or name is None:
        pass
    if "shortened_local_name" in adv:
        out += _ad(0x08, adv["shortened_local_name"].encode())
    return out, notes


def _check_adv_len(data: bytes, what: str) -> None:
    if len(data) > 31:
        raise LabError(f"{what} is {len(data)} bytes; legacy advertising allows at most 31")


class MultiSnooper(Snooper):
    def __init__(self, *snoopers: Snooper) -> None:
        self.snoopers = list(snoopers)

    def snoop(self, hci_packet: bytes, direction: Snooper.Direction) -> None:
        for s in self.snoopers:
            s.snoop(hci_packet, direction)


# --------------------------------------------------------------------------- model
@dataclasses.dataclass
class A2dpState:
    """What the emulated sink endpoint has seen."""

    connected: bool = False
    state: str = "idle"
    configuration: dict[str, Any] | None = None
    rtp_packets: int = 0
    rtp_bytes: int = 0
    last_event: str | None = None
    events: collections.deque = dataclasses.field(default_factory=lambda: collections.deque(maxlen=50))

    def log(self, event: str) -> None:
        self.last_event = event
        self.events.append({"t": round(time.time(), 3), "event": event})


@dataclasses.dataclass
class Emu:
    id: str
    name: str
    role: str
    backend: str
    profile_id: str
    profile: dict[str, Any]
    device: Device
    controller: Controller | None = None
    transport: Any = None
    unknowns: list[str] = dataclasses.field(default_factory=list)
    notes: list[str] = dataclasses.field(default_factory=list)
    # peripheral
    chars: list[tuple[str, Characteristic]] = dataclasses.field(default_factory=list)
    adv_data: bytes = b""
    scan_data: bytes = b""
    advertising: bool = False
    scripts: dict[int, asyncio.Task] = dataclasses.field(default_factory=dict)
    a2dp: A2dpState = dataclasses.field(default_factory=A2dpState)
    avdtp_protocol: Any = None
    sink: Any = None
    avrcp_protocol: Any = None
    connections: dict[str, Any] = dataclasses.field(default_factory=dict)  # peer emu id -> Connection
    # central
    scan_results: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    peers: dict[str, Peer] = dataclasses.field(default_factory=dict)
    last_peer: str | None = None
    notifications: collections.deque = dataclasses.field(default_factory=lambda: collections.deque(maxlen=2000))
    notification_count: int = 0
    subscriptions: set[tuple[str, str]] = dataclasses.field(default_factory=set)
    a2dp_source: dict[str, Any] = dataclasses.field(default_factory=dict)
    snoop_file: Any = None
    background: set[asyncio.Task] = dataclasses.field(default_factory=set)

    def char(self, uuid: str, index: int = 0) -> Characteristic:
        key = ukey(uuid)
        matches = [c for k, c in self.chars if k == key]
        if not matches:
            raise LabError(f"{self.id} has no characteristic {uuid}")
        if index >= len(matches):
            raise LabError(f"{self.id} has only {len(matches)} instance(s) of {uuid}")
        return matches[index]


class Lab:
    def __init__(self, backend: str = "local-link") -> None:
        self.backend = backend
        self.lock = asyncio.Lock()
        self.link: LocalLink | None = LocalLink() if backend == "local-link" else None
        self.devices: dict[str, Emu] = {}
        self._counter = 0
        self.snoop_path: str | None = None
        self.snoop_files: dict[str, Any] = {}
        self._combined: BtSnooper | None = None

    # ------------------------------------------------------------------ plumbing
    def get(self, device_id: str, role: str | None = None) -> Emu:
        emu = self.devices.get(device_id)
        if emu is None:
            raise LabError(f"no such device {device_id!r}; known: {sorted(self.devices)}")
        if role and emu.role != role:
            raise LabError(f"device {device_id} is a {emu.role}, this operation needs a {role}")
        return emu

    def _next_id(self, role: str) -> str:
        self._counter += 1
        return f"{'p' if role == 'peripheral' else 'c'}{self._counter}"

    def _unique_address(self, wanted: str | None) -> tuple[str, str | None]:
        used = {str(e.device.random_address)[:17].upper() for e in self.devices.values()}
        used |= {e.profile.get("_addr", "").upper() for e in self.devices.values()}
        if wanted:
            addr = wanted.upper()
            note = None
            n = 0
            while addr in used:
                n += 1
                parts = addr.split(":")
                parts[-1] = f"{(int(parts[-1], 16) + 1) & 0xFF:02X}"
                addr = ":".join(parts)
                if n > 255:
                    raise LabError("no free address")
            if addr != wanted.upper():
                note = f"address {wanted} already in use in this lab; using {addr}"
            return addr, note
        n = self._counter
        return f"F0:C0:00:00:{(n >> 8) & 0xFF:02X}:{n & 0xFF:02X}", None

    # ------------------------------------------------------------------ devices
    async def device_create(self, profile: str | dict, name: str | None, role: str, address: str | None) -> dict[str, Any]:
        if role not in ("peripheral", "central"):
            raise LabError("role must be 'peripheral' or 'central'")
        raw = profiles_mod.load_profile(profile)
        if role == "central" and self.backend == "vhci":
            raise LabError("with the vhci backend only peripherals can be emulated; use the VM's BlueZ (bluetoothctl) as the central")
        if self.backend == "vhci" and not os.access(VHCI_PATH, os.R_OK | os.W_OK):
            raise LabError(
                f"{VHCI_PATH} is not accessible (exists={os.path.exists(VHCI_PATH)}). "
                "Load the module (sudo modprobe hci_vhci) and make the service user a member of the group that owns it, "
                "or use backend 'local-link'."
            )
        async with self.lock:
            dev_id = self._next_id(role)
            notes: list[str] = []
            dev_name = name or (raw["name"] if isinstance(raw["name"], str) else None) or raw["id"]
            if not isinstance(raw["name"], str) and not name:
                notes.append("profile name unknown; using profile id")
            wanted = address or (raw.get("address") if isinstance(raw.get("address"), str) else None)
            if role == "central" and not address:
                wanted = None
            addr, anote = self._unique_address(wanted)
            if anote:
                notes.append(anote)
            if wanted is None and role == "peripheral":
                notes.append("profile address unknown; generated a lab address")
            cod = raw.get("class_of_device")
            cfg = DeviceConfiguration()
            cfg.name = dev_name
            cfg.address = Address(addr)
            cfg.le_enabled = True
            cfg.classic_enabled = role == "central" or isinstance(raw.get("a2dp_sink"), dict) and not is_unknown(raw["a2dp_sink"])
            cfg.gap_service_enabled = False
            cfg.advertising_interval_min = DEFAULT_ADV_INTERVAL_MS
            cfg.advertising_interval_max = DEFAULT_ADV_INTERVAL_MS
            if cod is not None and not is_unknown(cod):
                cfg.class_of_device = to_int(cod)
            controller = transport = None
            if self.backend == "local-link":
                assert self.link is not None
                controller = Controller(dev_id, link=self.link, public_address=addr)
                host = Host(controller, AsyncPipeSink(controller))
                device = Device(config=cfg, host=host)
            else:
                from bumble.transport import open_transport

                try:
                    transport = await open_transport("vhci")
                except Exception as exc:  # noqa: BLE001
                    raise LabError(f"could not open the vhci transport: {exc}") from exc
                device = Device.from_config_with_hci(cfg, transport.source, transport.sink)

            appearance = raw.get("appearance")
            appearance_int = to_int(appearance) if appearance is not None and not is_unknown(appearance) else 0
            device.add_service(GenericAccessService(dev_name, appearance_int))
            emu = Emu(
                id=dev_id, name=dev_name, role=role, backend=self.backend, profile_id=raw["id"],
                profile=raw, device=device, controller=controller, transport=transport,
                unknowns=profiles_mod.find_unknowns(raw), notes=notes,
            )
            emu.profile = dict(raw, _addr=addr)
            if role == "peripheral":
                self._build_gatt(emu, raw)
                adv, n1 = build_adv(raw.get("advertising"), dev_name, appearance_int)
                scan, n2 = build_adv(raw.get("scan_response"), None, None)
                emu.notes += n1 + n2
                if not adv:
                    adv = _ad(0x01, bytes([0x06])) + _ad(0x09, dev_name.encode())
                    emu.notes.append("profile advertising block empty/unknown; advertising only flags + device name")
                if name and isinstance(raw.get("advertising"), dict) and "local_name" in raw["advertising"] and isinstance(raw["advertising"]["local_name"], str):
                    adv, _ = build_adv(dict(raw["advertising"], local_name=name), dev_name, appearance_int)
                _check_adv_len(adv, "advertising data")
                _check_adv_len(scan, "scan response")
                emu.adv_data, emu.scan_data = adv, scan
                device.on("characteristic_subscription", lambda c, ch, n, i, e=emu: self._on_subscription(e, ch, n, i))
                device.on("connection", lambda conn, e=emu: self._on_peripheral_connection(e, conn))
                if cfg.classic_enabled:
                    self._setup_classic(emu, raw)
            if self._combined is not None:
                self._attach_snoop(emu)
            await device.power_on()
            if role == "central" or cfg.classic_enabled:
                with contextlib.suppress(Exception):
                    await device.set_connectable(role == "peripheral")
                    await device.set_discoverable(role == "peripheral")
            self.devices[dev_id] = emu
            return {
                "device_id": dev_id, "name": dev_name, "role": role, "backend": self.backend,
                "address": addr, "profile": raw["id"], "skeleton": bool(raw.get("skeleton")),
                "unknown_fields": len(emu.unknowns), "notes": emu.notes,
                "a2dp_sink": bool(emu.sink is not None or emu.avdtp_protocol is not None or (role == "peripheral" and cfg.classic_enabled)),
            }

    async def device_remove(self, device_id: str) -> dict[str, Any]:
        async with self.lock:
            emu = self.get(device_id)
            await self._teardown(emu)
            del self.devices[device_id]
            return {"removed": device_id}

    async def _teardown(self, emu: Emu) -> None:
        for t in list(emu.scripts.values()) + list(emu.background):
            t.cancel()
        emu.scripts.clear()
        for conn in list(emu.connections.values()):
            with contextlib.suppress(Exception):
                await asyncio.wait_for(conn.disconnect(), 2)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(emu.device.power_off(), 2)
        if emu.controller is not None and self.link is not None:
            with contextlib.suppress(Exception):
                self.link.remove_controller(emu.controller)
        if emu.transport is not None:
            with contextlib.suppress(Exception):
                await emu.transport.close()
        if emu.snoop_file is not None:
            with contextlib.suppress(Exception):
                emu.snoop_file.close()
            emu.snoop_file = None

    def list_devices(self) -> list[dict[str, Any]]:
        out = []
        for e in self.devices.values():
            row: dict[str, Any] = {
                "device_id": e.id, "name": e.name, "role": e.role, "profile": e.profile_id,
                "address": e.profile.get("_addr"),
            }
            if e.role == "peripheral":
                row["advertising"] = e.advertising
                row["connected_to"] = sorted(e.connections)
                row["a2dp"] = e.a2dp.state if e.a2dp.connected else None
            else:
                row["connected_to"] = sorted(e.peers)
                row["buffered_notifications"] = len(e.notifications)
            out.append(row)
        return out

    # ------------------------------------------------------------------ GATT build
    def _build_gatt(self, emu: Emu, raw: dict[str, Any]) -> None:
        gatt = raw.get("gatt")
        if not isinstance(gatt, dict) or is_unknown(gatt):
            return
        for svc in gatt.get("services", []):
            chars: list[Characteristic] = []
            for ch in svc.get("characteristics", []):
                names = ch.get("properties")
                if names is None:
                    names = ["read"]
                    emu.notes.append(f"characteristic {ch['uuid']}: properties unknown, defaulting to read")
                props = Characteristic.Properties(0)
                for n in names:
                    props |= _PROP[n]
                perms = 0
                if "read" in names:
                    perms |= Characteristic.READABLE
                if "write" in names or "write_without_response" in names:
                    perms |= Characteristic.WRITEABLE
                value = bytes.fromhex(ch["value_hex"]) if "value_hex" in ch else b""
                descs = [
                    Descriptor(UUID(d["uuid"].removeprefix("0x")), Descriptor.READABLE, bytes.fromhex(d.get("value_hex", "")))
                    for d in ch.get("descriptors", [])
                ]
                c = Characteristic(UUID(ch["uuid"].removeprefix("0x")), props, perms, value, descs)
                chars.append(c)
                emu.chars.append((ukey(ch["uuid"]), c))
                if ch.get("notify_script"):
                    c._bt_emu_script = ch["notify_script"]  # type: ignore[attr-defined]
            emu.device.add_service(Service(UUID(svc["uuid"].removeprefix("0x")), chars, svc.get("primary", True)))

    # ------------------------------------------------------------------ events
    def _on_peripheral_connection(self, emu: Emu, conn: Any) -> None:
        emu.advertising = False
        peer = next((e for e in self.devices.values() if e.role == "central" and conn.peer_address and str(conn.peer_address)[:17] == e.profile.get("_addr")), None)
        key = peer.id if peer else f"peer-{conn.handle}"
        emu.connections[key] = conn
        conn.on("disconnection", lambda *_a, e=emu, k=key: e.connections.pop(k, None))

    def _on_subscription(self, emu: Emu, ch: Characteristic, notify: bool, indicate: bool) -> None:
        script = getattr(ch, "_bt_emu_script", None)
        if not script:
            return
        running = emu.scripts.get(id(ch))
        if (notify or indicate) and (running is None or running.done()):
            emu.scripts[id(ch)] = asyncio.get_running_loop().create_task(self._run_script(emu, ch, script))
        elif not (notify or indicate) and running is not None:
            running.cancel()

    async def _run_script(self, emu: Emu, ch: Characteristic, script: dict[str, Any]) -> None:
        frames = [bytes.fromhex(f) for f in script["frames_hex"]] if "frames_hex" in script else [bytes.fromhex(script["pattern_hex"])]
        repeat = script.get("repeat", 0)
        interval = script["interval_ms"] / 1000.0
        counter = script.get("counter", {}).get("offset")
        i = 0
        with contextlib.suppress(asyncio.CancelledError):
            while repeat == 0 or i < repeat:
                frame = bytearray(frames[i % len(frames)])
                if counter is not None and counter < len(frame):
                    frame[counter] = i & 0xFF
                ch.value = bytes(frame)
                await emu.device.notify_subscribers(ch, bytes(frame))
                i += 1
                await asyncio.sleep(interval)

    # ------------------------------------------------------------------ classic
    def _setup_classic(self, emu: Emu, raw: dict[str, Any]) -> None:
        device = emu.device
        records: dict[int, Any] = {}
        a2dp_cfg = raw.get("a2dp_sink")
        if isinstance(a2dp_cfg, dict) and not is_unknown(a2dp_cfg):
            codec = a2dp_cfg["codecs"][0]
            caps = avdtp.MediaCodecCapabilities(avdtp.AVDTP_AUDIO_MEDIA_TYPE, a2dp.A2DP_SBC_CODEC_TYPE, _sbc_info(codec))
            records[0x00010001] = a2dp.make_audio_sink_service_sdp_records(0x00010001)
            listener = avdtp.Listener.for_device(device)

            def on_conn(protocol: avdtp.Protocol) -> None:
                emu.avdtp_protocol = protocol
                emu.a2dp.connected = True
                emu.a2dp.state = "idle"
                emu.a2dp.log("avdtp signalling connected")
                sink = protocol.add_sink(caps)
                emu.sink = sink

                def on_config() -> None:
                    emu.a2dp.state = "configured"
                    emu.a2dp.configuration = _describe_config(sink.configuration)
                    emu.a2dp.log("configured")

                sink.on("configuration", on_config)
                sink.on("open", lambda: (setattr(emu.a2dp, "state", "open"), emu.a2dp.log("open")))
                sink.on("start", lambda: (setattr(emu.a2dp, "state", "streaming"), emu.a2dp.log("start")))
                sink.on("suspend", lambda: (setattr(emu.a2dp, "state", "suspended"), emu.a2dp.log("suspend")))
                sink.on("stop", lambda: (setattr(emu.a2dp, "state", "suspended"), emu.a2dp.log("stop")))
                sink.on("close", lambda: (setattr(emu.a2dp, "state", "idle"), emu.a2dp.log("close")))
                sink.on("rtp_packet", lambda pkt: _count_rtp(emu, pkt))
                protocol.on("close", lambda: (setattr(emu.a2dp, "connected", False), setattr(emu.a2dp, "state", "idle"), emu.a2dp.log("avdtp closed")))

            listener.on("connection", on_conn)
        rc = raw.get("avrcp")
        if isinstance(rc, dict) and not is_unknown(rc):
            events = [avrcp.EventId[n] for n in rc.get("supported_events", [])]
            protocol = avrcp.Protocol(avrcp.Delegate(supported_events=events))
            protocol.listen(device)
            emu.avrcp_protocol = protocol
            records[0x00010002] = avrcp.TargetServiceSdpRecord(0x00010002).to_service_attributes()
        if records:
            device.sdp_service_records = records

    # ------------------------------------------------------------------ snoop
    def _attach_snoop(self, emu: Emu) -> None:
        assert self._combined is not None and self.snoop_path
        path = Path(self.snoop_path)
        per = path.with_name(f"{path.stem}.{emu.id}{path.suffix or '.btsnoop'}")
        emu.snoop_file = open(per, "wb", buffering=0)  # noqa: SIM115
        self.snoop_files[emu.id] = str(per)
        emu.device.host.snooper = MultiSnooper(self._combined, BtSnooper(emu.snoop_file))

    async def hci_log_start(self, path: str | None) -> dict[str, Any]:
        async with self.lock:
            if self._combined is not None:
                raise LabError(f"HCI log already running at {self.snoop_path}; call hci_log_stop first")
            if path is None:
                fd, path = tempfile.mkstemp(prefix="bt-emu-", suffix=".btsnoop")
                os.close(fd)
            p = Path(path).expanduser()
            p.parent.mkdir(parents=True, exist_ok=True)
            self.snoop_path = str(p)
            self._combined_file = open(p, "wb", buffering=0)  # noqa: SIM115
            self._combined = BtSnooper(self._combined_file)
            self.snoop_files = {}
            for emu in self.devices.values():
                self._attach_snoop(emu)
            return {"path": self.snoop_path, "per_device": dict(self.snoop_files),
                    "note": "path holds all devices interleaved; per_device files are one controller each (use these for clean connection handles in Wireshark)"}

    async def hci_log_stop(self) -> dict[str, Any]:
        async with self.lock:
            if self._combined is None:
                raise LabError("no HCI log is running")
            for emu in self.devices.values():
                emu.device.host.snooper = None
                if emu.snoop_file is not None:
                    emu.snoop_file.close()
                    emu.snoop_file = None
            self._combined_file.close()
            self._combined = None
            result = {"path": self.snoop_path, "bytes": os.path.getsize(self.snoop_path), "per_device": dict(self.snoop_files)}
            return result

    # ------------------------------------------------------------------ reset
    async def reset(self, backend: str | None = None) -> None:
        async with self.lock:
            if self._combined is not None:
                for emu in self.devices.values():
                    emu.device.host.snooper = None
                self._combined_file.close()
                self._combined = None
            for emu in list(self.devices.values()):
                await self._teardown(emu)
            self.devices.clear()
            self.lock = asyncio.Lock()
            self.snoop_files = {}
            self._counter = 0
            if backend is not None:
                self.backend = backend
            self.link = LocalLink() if self.backend == "local-link" else None


def _sbc_info(codec: dict[str, Any]) -> SBC:
    freq = SBC.SamplingFrequency(0)
    for f in codec.get("sampling_frequencies", [44100, 48000]):
        freq |= SBC.SamplingFrequency.from_int(f)
    cm = SBC.ChannelMode(0)
    cmap = {"mono": SBC.ChannelMode.MONO, "dual_channel": SBC.ChannelMode.DUAL_CHANNEL,
            "stereo": SBC.ChannelMode.STEREO, "joint_stereo": SBC.ChannelMode.JOINT_STEREO}
    for m in codec.get("channel_modes", ["stereo", "joint_stereo"]):
        cm |= cmap[m]
    bl = SBC.BlockLength(0)
    bmap = {4: SBC.BlockLength.BL_4, 8: SBC.BlockLength.BL_8, 12: SBC.BlockLength.BL_12, 16: SBC.BlockLength.BL_16}
    for b in codec.get("block_lengths", [16]):
        bl |= bmap[b]
    sb = SBC.Subbands(0)
    for s in codec.get("subbands", [8]):
        sb |= SBC.Subbands.S_4 if s == 4 else SBC.Subbands.S_8
    am = SBC.AllocationMethod(0)
    for a in codec.get("allocation_methods", ["loudness"]):
        am |= SBC.AllocationMethod.SNR if a == "snr" else SBC.AllocationMethod.LOUDNESS
    return SBC(freq, cm, bl, sb, am, codec.get("min_bitpool", 2), codec.get("max_bitpool", 53))


def _describe_config(config: list[Any]) -> dict[str, Any] | None:
    for cap in config or []:
        if isinstance(cap, avdtp.MediaCodecCapabilities):
            info = cap.media_codec_information
            if isinstance(info, SBC):
                return {
                    "codec": "SBC",
                    "sampling_frequency": _flag_names(info.sampling_frequency),
                    "channel_mode": _flag_names(info.channel_mode),
                    "block_length": _flag_names(info.block_length),
                    "subbands": _flag_names(info.subbands),
                    "allocation_method": _flag_names(info.allocation_method),
                    "bitpool": [info.minimum_bitpool_value, info.maximum_bitpool_value],
                }
            return {"codec": str(cap.media_codec_type)}
    return None


def _flag_names(flag: Any) -> str:
    return str(flag.name) if flag.name else str(flag)


def _count_rtp(emu: Emu, pkt: Any) -> None:
    emu.a2dp.rtp_packets += 1
    emu.a2dp.rtp_bytes += len(pkt.payload)


def _highest(flag: Any) -> Any:
    bit = int(flag).bit_length() - 1
    return type(flag)(1 << bit) if int(flag) else flag


def _lowest(flag: Any) -> Any:
    v = int(flag)
    return type(flag)(v & -v) if v else flag


LAB = Lab()
