"""Lab operations: advertising, GATT, central actions, A2DP.

Each coroutine returns a compact JSON-serialisable dict or raises
:class:`~bt_emu_mcp.lab.LabError`.  The MCP layer (``server.py``) is a thin
wrapper over these functions.
"""

from __future__ import annotations

import asyncio
import contextlib
import struct
import time
from typing import Any

from bumble import a2dp, avdtp
from bumble.core import PhysicalTransport
from bumble.gatt import Characteristic, Service
from bumble.hci import Address
from bumble.rtp import MediaPacket

from .lab import (
    _PROP, LAB, SBC, Emu, LabError, _check_adv_len, _describe_config, _highest, hex_to_bytes, short_uuid, ukey,
)

CONNECT_TIMEOUT_S = 10.0
MAX_BLOCKING_S = 120.0


def _props_list(props: Any) -> list[str]:
    return [n for n, f in _PROP.items() if props & f]


def _hexv(v: bytes | None) -> str:
    return (v or b"").hex()


# --------------------------------------------------------------------------- advertising
async def adv_start(device_id: str) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id, "peripheral")
        if emu.advertising:
            return {"device_id": device_id, "advertising": True, "note": "already advertising"}
        await _start_adv(emu)
        return {"device_id": device_id, "advertising": True, "adv_len": len(emu.adv_data), "scan_response_len": len(emu.scan_data)}


async def _start_adv(emu: Emu) -> None:
    from bumble.device import AdvertisingType

    try:
        await emu.device.start_advertising(
            advertising_type=AdvertisingType.UNDIRECTED_CONNECTABLE_SCANNABLE,
            advertising_data=emu.adv_data,
            scan_response_data=emu.scan_data,
            advertising_interval_min=50.0,
            advertising_interval_max=50.0,
        )
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"could not start advertising: {exc}") from exc
    emu.advertising = True


async def adv_stop(device_id: str) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id, "peripheral")
        if emu.advertising:
            with contextlib.suppress(Exception):
                await emu.device.stop_advertising()
        emu.advertising = False
        return {"device_id": device_id, "advertising": False}


async def adv_set_data(device_id: str, data_hex: str, scan_response: bool = False) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id, "peripheral")
        data = hex_to_bytes(data_hex, "advertising data")
        _check_adv_len(data, "advertising data")
        if scan_response:
            emu.scan_data = data
        else:
            emu.adv_data = data
        was = emu.advertising
        if was:
            with contextlib.suppress(Exception):
                await emu.device.stop_advertising()
            emu.advertising = False
            await _start_adv(emu)
        return {"device_id": device_id, "target": "scan_response" if scan_response else "advertising", "len": len(data), "restarted": was}


# --------------------------------------------------------------------------- peripheral GATT
def _subscriber_count(emu: Emu, ch: Characteristic) -> int:
    n = 0
    for _bearer, cccds in emu.device.gatt_server.subscribers.items():
        v = cccds.get(ch.handle)
        if v and len(v) == 2 and (v[0] & 0x03):
            n += 1
    return n


async def gatt_read(device_id: str, uuid: str, index: int = 0) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id, "peripheral")
        ch = emu.char(uuid, index)
        v = ch.value if isinstance(ch.value, (bytes, bytearray)) else b""
        return {"device_id": device_id, "uuid": uuid, "value_hex": _hexv(bytes(v)), "len": len(v)}


async def gatt_write(device_id: str, uuid: str, value_hex: str, index: int = 0) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id, "peripheral")
        ch = emu.char(uuid, index)
        ch.value = hex_to_bytes(value_hex)
        return {"device_id": device_id, "uuid": uuid, "len": len(ch.value), "note": "local value updated; no notification sent"}


async def gatt_notify(device_id: str, uuid: str, value_hex: str, index: int = 0) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id, "peripheral")
        ch = emu.char(uuid, index)
        return await _notify(emu, ch, hex_to_bytes(value_hex), uuid)


async def _notify(emu: Emu, ch: Characteristic, value: bytes, uuid: str) -> dict[str, Any]:
    if not (ch.properties & (Characteristic.Properties.NOTIFY | Characteristic.Properties.INDICATE)):
        raise LabError(f"characteristic {uuid} has no notify/indicate property")
    ch.value = value
    subs = _subscriber_count(emu, ch)
    if subs:
        await emu.device.notify_subscribers(ch, value)
    return {"device_id": emu.id, "uuid": uuid, "len": len(value), "subscribers": subs,
            **({} if subs else {"warning": "no peer is subscribed; nothing was sent (value was stored)"})}


def _dump(emu: Emu) -> list[dict[str, Any]]:
    out = []
    for attr in emu.device.gatt_server.attributes:
        if isinstance(attr, Service):
            out.append({
                "uuid": short_uuid(attr.uuid), "handle": attr.handle, "end_handle": attr.end_group_handle,
                "primary": attr.is_primary if hasattr(attr, "is_primary") else True,
                "characteristics": [
                    {
                        "uuid": short_uuid(c.uuid), "handle": c.handle, "properties": _props_list(c.properties),
                        "value_hex": _hexv(bytes(c.value)) if isinstance(c.value, (bytes, bytearray)) else "<dynamic>",
                        "descriptors": [
                            {"uuid": short_uuid(d.type), "handle": d.handle,
                             "value_hex": _hexv(bytes(d.value)) if isinstance(d.value, (bytes, bytearray)) else "<dynamic>"}
                            for d in c.descriptors
                        ],
                        "notify_script": bool(getattr(c, "_bt_emu_script", None)),
                    }
                    for c in attr.characteristics
                ],
            })
    return out


async def gatt_dump(device_id: str) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id)
        return {"device_id": device_id, "services": _dump(emu)}


async def send_scripted_notifications(
    device_id: str, uuid: str, frames: list[str], interval_ms: int, repeat: int, background: bool = False, index: int = 0
) -> dict[str, Any]:
    if not frames:
        raise LabError("frames must contain at least one hex string")
    if interval_ms < 0 or repeat < 1:
        raise LabError("interval_ms must be >= 0 and repeat >= 1")
    blobs = [hex_to_bytes(f, f"frame {i}") for i, f in enumerate(frames)]
    if any(not b for b in blobs):
        raise LabError("empty frame")
    total_s = len(blobs) * repeat * interval_ms / 1000.0
    if total_s > MAX_BLOCKING_S and not background:
        raise LabError(f"replay would take {total_s:.0f}s; pass background=true or shorten it")
    async with LAB.lock:
        emu = LAB.get(device_id, "peripheral")
        ch = emu.char(uuid, index)
        if not (ch.properties & (Characteristic.Properties.NOTIFY | Characteristic.Properties.INDICATE)):
            raise LabError(f"characteristic {uuid} has no notify/indicate property")
        subs = _subscriber_count(emu, ch)
    state = {"sent": 0}

    async def run() -> None:
        for _ in range(repeat):
            for b in blobs:
                ch.value = b
                if _subscriber_count(emu, ch):
                    await emu.device.notify_subscribers(ch, b)
                    state["sent"] += 1
                await asyncio.sleep(interval_ms / 1000.0)

    if background:
        task = asyncio.get_running_loop().create_task(run())
        emu.background.add(task)
        task.add_done_callback(emu.background.discard)
        return {"device_id": device_id, "uuid": uuid, "started": True, "frames": len(blobs), "repeat": repeat, "subscribers": subs}
    await run()
    return {"device_id": device_id, "uuid": uuid, "frames": len(blobs), "repeat": repeat, "notifications_sent": state["sent"],
            "subscribers_at_start": subs,
            **({} if subs else {"warning": "no peer was subscribed at the start"})}


# --------------------------------------------------------------------------- central
def _parse_adv(data: bytes) -> dict[str, Any]:
    name = None
    uuids: list[str] = []
    i = 0
    while i < len(data):
        ln = data[i]
        if ln == 0 or i + 1 + ln > len(data):
            break
        t, body = data[i + 1], data[i + 2 : i + 1 + ln]
        if t in (0x08, 0x09):
            name = body.decode(errors="replace")
        elif t in (0x02, 0x03):
            uuids += [f"{int.from_bytes(body[j:j+2], 'little'):04X}" for j in range(0, len(body) - 1, 2)]
        elif t in (0x06, 0x07):
            uuids += [body[j : j + 16][::-1].hex() for j in range(0, len(body) - 15, 16)]
        i += 1 + ln
    return {"name": name, "service_uuids": uuids}


async def central_scan(central_id: str, duration_s: float = 3.0) -> dict[str, Any]:
    duration_s = max(0.1, min(float(duration_s), 60.0))
    async with LAB.lock:
        emu = LAB.get(central_id, "central")
    found: dict[str, dict[str, Any]] = {}
    by_addr = {e.profile.get("_addr"): e.id for e in LAB.devices.values() if e.role == "peripheral"}

    def on_adv(adv: Any) -> None:
        addr = str(adv.address)[:17]
        row = found.setdefault(addr, {"address": addr, "device_id": by_addr.get(addr), "rssi": adv.rssi, "adv_hex": "", "name": None, "service_uuids": []})
        row["rssi"] = adv.rssi
        raw = bytes(adv.data_bytes)
        if adv.is_scan_response:
            row["scan_response_hex"] = raw.hex()
        else:
            row["adv_hex"] = raw.hex()
        info = _parse_adv(raw)
        row["name"] = info["name"] or row["name"]
        row["service_uuids"] = sorted(set(row["service_uuids"]) | set(info["service_uuids"]))

    emu.device.on("advertisement", on_adv)
    try:
        await emu.device.start_scanning(active=True)
        await asyncio.sleep(duration_s)
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"scan failed: {exc}") from exc
    finally:
        with contextlib.suppress(Exception):
            await emu.device.stop_scanning()
        emu.device.remove_listener("advertisement", on_adv)
    emu.scan_results = list(found.values())
    return {"central_id": central_id, "duration_s": duration_s, "devices": emu.scan_results}


async def central_connect(central_id: str, peripheral_id: str) -> dict[str, Any]:
    from bumble.device import Peer

    async with LAB.lock:
        c = LAB.get(central_id, "central")
        p = LAB.get(peripheral_id, "peripheral")
        if peripheral_id in c.peers:
            raise LabError(f"{central_id} is already connected to {peripheral_id}")
        if not p.advertising:
            raise LabError(f"{peripheral_id} is not advertising; call adv_start first")
    try:
        conn = await c.device.connect(p.device.random_address, timeout=CONNECT_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"connect failed: {type(exc).__name__}: {exc}") from exc
    async with LAB.lock:
        c.peers[peripheral_id] = Peer(conn)
        c.last_peer = peripheral_id
        conn.on("disconnection", lambda *_a, cc=c, pid=peripheral_id: cc.peers.pop(pid, None))
    await asyncio.sleep(0)
    return {
        "central_id": central_id, "peripheral_id": peripheral_id, "connection_handle": conn.handle,
        "role": "central", "peer_address": str(conn.peer_address)[:17], "transport": "LE",
        "interval": getattr(conn.parameters, "connection_interval", None),
    }


def _peer(c: Emu, peripheral_id: str | None) -> tuple[str, Any]:
    pid = peripheral_id or c.last_peer
    if not pid or pid not in c.peers:
        raise LabError(f"{c.id} is not connected" + (f" to {peripheral_id}" if peripheral_id else "") + "; call central_connect")
    return pid, c.peers[pid]


async def _ensure_discovered(peer: Any) -> None:
    if not peer.services:
        try:
            await asyncio.wait_for(peer.discover_all(), CONNECT_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001
            raise LabError(f"GATT discovery failed: {type(exc).__name__}: {exc}") from exc


async def central_discover(central_id: str, peripheral_id: str | None = None) -> dict[str, Any]:
    async with LAB.lock:
        c = LAB.get(central_id, "central")
        pid, peer = _peer(c, peripheral_id)
    await _ensure_discovered(peer)
    services = []
    for s in peer.services:
        services.append({
            "uuid": short_uuid(s.uuid), "handle": s.handle, "end_handle": s.end_group_handle,
            "characteristics": [
                {"uuid": short_uuid(ch.uuid), "handle": ch.handle, "properties": _props_list(ch.properties),
                 "descriptors": [short_uuid(d.type) for d in ch.descriptors]}
                for ch in s.characteristics
            ],
        })
    return {"central_id": central_id, "peripheral_id": pid, "services": services}


async def _remote_char(c: Emu, uuid: str, peripheral_id: str | None, index: int) -> tuple[str, Any]:
    pid, peer = _peer(c, peripheral_id)
    await _ensure_discovered(peer)
    key = ukey(uuid)
    matches = [ch for s in peer.services for ch in s.characteristics if ukey(ch.uuid) == key]
    if not matches:
        raise LabError(f"peer {pid} has no characteristic {uuid} (run central_discover to see what it exposes)")
    if index >= len(matches):
        raise LabError(f"peer {pid} has only {len(matches)} instance(s) of {uuid}")
    return pid, matches[index]


async def central_read(central_id: str, uuid: str, peripheral_id: str | None = None, index: int = 0) -> dict[str, Any]:
    async with LAB.lock:
        c = LAB.get(central_id, "central")
    pid, ch = await _remote_char(c, uuid, peripheral_id, index)
    try:
        v = await asyncio.wait_for(ch.read_value(), CONNECT_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"read failed: {type(exc).__name__}: {exc}") from exc
    return {"central_id": central_id, "peripheral_id": pid, "uuid": uuid, "value_hex": bytes(v).hex(), "len": len(v)}


async def central_write(central_id: str, uuid: str, value_hex: str, with_response: bool | None = None,
                        peripheral_id: str | None = None, index: int = 0) -> dict[str, Any]:
    async with LAB.lock:
        c = LAB.get(central_id, "central")
    pid, ch = await _remote_char(c, uuid, peripheral_id, index)
    value = hex_to_bytes(value_hex)
    if with_response is None:
        with_response = bool(ch.properties & Characteristic.Properties.WRITE)
    try:
        await asyncio.wait_for(ch.write_value(value, with_response=with_response), CONNECT_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"write failed: {type(exc).__name__}: {exc}") from exc
    return {"central_id": central_id, "peripheral_id": pid, "uuid": uuid, "len": len(value), "with_response": with_response}


async def central_subscribe(central_id: str, uuid: str, peripheral_id: str | None = None, index: int = 0) -> dict[str, Any]:
    async with LAB.lock:
        c = LAB.get(central_id, "central")
    pid, ch = await _remote_char(c, uuid, peripheral_id, index)

    def on_value(value: bytes) -> None:
        c.notification_count += 1
        c.notifications.append({"seq": c.notification_count, "t": round(time.time(), 3), "from": pid, "uuid": uuid, "value_hex": bytes(value).hex()})

    try:
        await asyncio.wait_for(ch.subscribe(on_value), CONNECT_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"subscribe failed: {type(exc).__name__}: {exc}") from exc
    c.subscriptions.add((pid, ukey(uuid)))
    return {"central_id": central_id, "peripheral_id": pid, "uuid": uuid, "subscribed": True}


async def central_notifications(central_id: str, limit: int = 50, clear: bool = False) -> dict[str, Any]:
    async with LAB.lock:
        c = LAB.get(central_id, "central")
        items = list(c.notifications)[-max(1, limit):]
        total = c.notification_count
        if clear:
            c.notifications.clear()
        return {"central_id": central_id, "total_received": total, "returned": len(items), "notifications": items}


# --------------------------------------------------------------------------- A2DP
async def central_a2dp_connect(central_id: str, peripheral_id: str) -> dict[str, Any]:
    """Open a BR/EDR link and run AVDTP discover/configure/open/start as a source."""
    async with LAB.lock:
        c = LAB.get(central_id, "central")
        p = LAB.get(peripheral_id, "peripheral")
        if p.avdtp_protocol is None and not p.device.classic_enabled:
            raise LabError(f"{peripheral_id} has no a2dp_sink in its profile")
        if c.a2dp_source.get("stream") is not None:
            raise LabError(f"{central_id} already has an A2DP stream; close it first")
    try:
        conn = await c.device.connect(p.device.public_address, transport=PhysicalTransport.BR_EDR, timeout=CONNECT_TIMEOUT_S)
        proto = await avdtp.Protocol.connect(conn)
        endpoints = list(await proto.discover_remote_endpoints())
        sink_ep = proto.find_remote_sink_by_codec(avdtp.AVDTP_AUDIO_MEDIA_TYPE, a2dp.A2DP_SBC_CODEC_TYPE)
        if sink_ep is None:
            raise LabError(f"peer exposes {len(endpoints)} endpoint(s) but no free SBC sink")
        remote = next(cap for cap in sink_ep.capabilities if isinstance(cap, avdtp.MediaCodecCapabilities))
        info = remote.media_codec_information
        if not isinstance(info, SBC):
            info = SBC.from_bytes(remote.service_capabilities_bytes[2:])
        chosen = SBC(
            SBC.SamplingFrequency.SF_44100 if info.sampling_frequency & SBC.SamplingFrequency.SF_44100 else _highest(info.sampling_frequency),
            SBC.ChannelMode.JOINT_STEREO if info.channel_mode & SBC.ChannelMode.JOINT_STEREO else _highest(info.channel_mode),
            _highest(info.block_length), _highest(info.subbands),
            SBC.AllocationMethod.LOUDNESS if info.allocation_method & SBC.AllocationMethod.LOUDNESS else _highest(info.allocation_method),
            info.minimum_bitpool_value, info.maximum_bitpool_value,
        )
        source = proto.add_source(avdtp.MediaCodecCapabilities(avdtp.AVDTP_AUDIO_MEDIA_TYPE, a2dp.A2DP_SBC_CODEC_TYPE, chosen), None)
        stream = await proto.create_stream(source, sink_ep)
        await stream.start()
    except LabError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"A2DP setup failed: {type(exc).__name__}: {exc}") from exc
    c.a2dp_source = {"protocol": proto, "stream": stream, "peripheral_id": peripheral_id, "seq": 0, "sent": 0}
    await asyncio.sleep(0.05)
    return {"central_id": central_id, "peripheral_id": peripheral_id, "avdtp_state": stream.state.name,
            "remote_endpoints": len(endpoints), "configured": _describe_config([avdtp.MediaCodecCapabilities(avdtp.AVDTP_AUDIO_MEDIA_TYPE, a2dp.A2DP_SBC_CODEC_TYPE, chosen)])}


async def central_a2dp_send(central_id: str, packets: int = 10, frames_per_packet: int = 5) -> dict[str, Any]:
    async with LAB.lock:
        c = LAB.get(central_id, "central")
    st = c.a2dp_source
    if not st.get("stream"):
        raise LabError(f"{central_id} has no A2DP stream; call central_a2dp_connect")
    if st["stream"].state != avdtp.State.STREAMING:
        raise LabError(f"stream is {st['stream'].state.name}, not STREAMING")
    packets = max(1, min(packets, 1000))
    for _ in range(packets):
        payload = bytes([frames_per_packet & 0x0F]) + (b"\x9c" + bytes(118)) * frames_per_packet
        st["stream"].send_media_packet(MediaPacket(2, 0, 0, 0, st["seq"], st["seq"] * 1024, 0x42540001, [], 96, payload))
        st["seq"] += 1
        st["sent"] += 1
    await asyncio.sleep(0.05)
    return {"central_id": central_id, "sent": packets, "note": "payloads are synthetic SBC-shaped bytes, not decodable audio"}


async def central_a2dp_control(central_id: str, action: str) -> dict[str, Any]:
    async with LAB.lock:
        c = LAB.get(central_id, "central")
    st = c.a2dp_source
    if not st.get("stream"):
        raise LabError(f"{central_id} has no A2DP stream")
    stream = st["stream"]
    try:
        if action == "suspend":
            await stream.stop()
        elif action == "start":
            await stream.start()
        elif action == "close":
            await stream.close()
            c.a2dp_source = {}
        else:
            raise LabError("action must be start, suspend or close")
    except LabError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise LabError(f"{action} failed: {type(exc).__name__}: {exc}") from exc
    await asyncio.sleep(0.05)
    return {"central_id": central_id, "action": action, "avdtp_state": stream.state.name}


_SUPPORT = (
    "Implemented over the local-link backend: AVDTP signalling (discover, get-capabilities, set-configuration, open, start, "
    "suspend, close) against an SBC sink endpoint, AVRCP target registered with the profile's supported events. "
    "Not implemented: audio decode, SDP browsing/pairing/encryption on the A2DP link, codecs other than SBC."
)


async def a2dp_status(device_id: str) -> dict[str, Any]:
    async with LAB.lock:
        emu = LAB.get(device_id)
        if emu.role == "peripheral":
            a = emu.a2dp
            has = emu.device.classic_enabled
            return {
                "device_id": device_id, "role": "peripheral", "sink_endpoint": has,
                "connected": a.connected, "state": a.state, "negotiated": a.configuration,
                "rtp_packets": a.rtp_packets, "rtp_bytes": a.rtp_bytes, "last_event": a.last_event,
                "recent_events": list(a.events)[-10:], "avrcp_target": emu.avrcp_protocol is not None,
                "support": _SUPPORT,
                **({} if has else {"note": "profile has no known a2dp_sink; no endpoint registered"}),
            }
        st = emu.a2dp_source
        s = st.get("stream")
        return {"device_id": device_id, "role": "central", "connected": s is not None,
                "state": s.state.name if s else "idle", "packets_sent": st.get("sent", 0),
                "peripheral_id": st.get("peripheral_id"), "support": _SUPPORT}
