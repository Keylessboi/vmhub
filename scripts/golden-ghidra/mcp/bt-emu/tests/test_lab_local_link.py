"""End-to-end tests on the local-link backend (no hardware, no kernel support)."""

import asyncio
import copy
import os
import struct

import pytest

from bt_emu_mcp import profiles, server as s
from bt_emu_mcp.lab import LAB


async def ok(coro):
    r = await coro
    assert r["ok"], r
    return r


async def make_pair(profile="generic-earbud"):
    bud = await ok(s.device_create(profile, role="peripheral"))
    phone = await ok(s.device_create("generic-earbud", role="central"))
    return bud["device_id"], phone["device_id"]


async def test_scan_connect_discover_read_subscribe_notify(tmp_path):
    log = await ok(s.hci_log_start(str(tmp_path / "lab.btsnoop")))
    bud, phone = await make_pair()
    await ok(s.adv_start(bud))

    scan = await ok(s.central_scan(phone, 1.0))
    found = [d for d in scan["devices"] if d["device_id"] == bud]
    assert found and found[0]["name"] == "Generic Earbud"
    assert "180F" in found[0]["service_uuids"]

    conn = await ok(s.central_connect(phone, bud))
    assert conn["peripheral_id"] == bud
    assert (await ok(s.list_devices()))["devices"][0]["connected_to"] == [phone]

    disc = await ok(s.central_discover(phone))
    by_uuid = {sv["uuid"]: sv for sv in disc["services"]}
    assert "180F" in by_uuid and "180A" in by_uuid
    assert [c["uuid"] for c in by_uuid["180F"]["characteristics"]] == ["2A19"]
    assert "notify" in by_uuid["180F"]["characteristics"][0]["properties"]

    battery = await ok(s.central_read(phone, "2A19"))
    assert battery["value_hex"] == "57"  # 87 %
    model = await ok(s.central_read(phone, "0x2A24"))
    assert bytes.fromhex(model["value_hex"]) == b"generic-earbud-1"

    await ok(s.central_subscribe(phone, "2A19"))
    n = await ok(s.gatt_notify(bud, "2A19", "40"))
    assert n["subscribers"] == 1
    await asyncio.sleep(0.2)
    got = await ok(s.central_notifications(phone))
    assert [x["value_hex"] for x in got["notifications"]] == ["40"]
    assert (await ok(s.gatt_read(bud, "2A19")))["value_hex"] == "40"

    # central write to a writable characteristic round-trips (head tracker control in the skeleton)
    dump = await ok(s.gatt_dump(bud))
    assert {sv["uuid"] for sv in dump["services"]} >= {"1800", "1801", "180F", "180A"}

    stop = await ok(s.hci_log_stop())
    assert stop["path"] == log["path"]
    header = open(stop["path"], "rb").read(16)
    assert header[:8] == b"btsnoop\0"
    version, datalink = struct.unpack(">LL", header[8:16])
    assert (version, datalink) == (1, 1002)  # BTSnoop v1, H4
    assert os.path.getsize(stop["path"]) > 100  # records were written
    assert len(stop["per_device"]) == 2
    for path in stop["per_device"].values():
        assert open(path, "rb").read(8) == b"btsnoop\0"


async def test_notifications_without_subscriber_report_it():
    bud, phone = await make_pair()
    r = await ok(s.gatt_notify(bud, "2A19", "10"))
    assert r["subscribers"] == 0 and "warning" in r


async def test_notify_script_and_scripted_frames():
    prof = profiles.load_profile("generic-earbud")
    prof = copy.deepcopy(prof)
    prof["id"] = "scripted"
    prof["gatt"]["services"].append({
        "uuid": "12345678-1234-5678-1234-56789abcdef0",
        "characteristics": [{
            "uuid": "12345678-1234-5678-1234-56789abcdef1", "properties": ["read", "notify"], "value_hex": "00",
            "notify_script": {"pattern_hex": "aa00bb", "interval_ms": 20, "repeat": 3, "counter": {"offset": 1}},
        }],
    })
    bud = (await ok(s.device_create(prof)))["device_id"]
    phone = (await ok(s.device_create("generic-earbud", role="central")))["device_id"]
    await ok(s.adv_start(bud))
    await ok(s.central_connect(phone, bud))
    u = "12345678-1234-5678-1234-56789abcdef1"
    await ok(s.central_subscribe(phone, u))
    await asyncio.sleep(0.5)
    frames = [x["value_hex"] for x in (await ok(s.central_notifications(phone, clear=True)))["notifications"]]
    assert frames == ["aa00bb", "aa01bb", "aa02bb"]

    r = await ok(s.send_scripted_notifications(bud, u, ["0102", "0304"], interval_ms=10, repeat=2))
    assert r["notifications_sent"] == 4
    await asyncio.sleep(0.2)
    frames = [x["value_hex"] for x in (await ok(s.central_notifications(phone)))["notifications"]]
    assert frames == ["0102", "0304", "0102", "0304"]


async def test_central_write_updates_peripheral():
    prof = copy.deepcopy(profiles.load_profile("pixel-buds-pro-2"))
    bud = (await ok(s.device_create(prof, name="Test Buds", address="F1:F2:F3:F4:F5:77")))["device_id"]
    phone = (await ok(s.device_create("generic-earbud", role="central")))["device_id"]
    await ok(s.adv_start(bud))
    await ok(s.central_connect(phone, bud))
    ctl = "8584cbb5-2d58-45a3-ab9d-583e0958b067"
    assert (await ok(s.central_read(phone, ctl)))["value_hex"] == "0000"
    await ok(s.central_write(phone, ctl, "0300"))
    assert (await ok(s.gatt_read(bud, ctl)))["value_hex"] == "0300"
    ver = await ok(s.central_read(phone, "b4eb9919-a910-46a2-a9dd-fec2525196fd"))
    assert bytes.fromhex(ver["value_hex"]).startswith(b"#AndroidHeadTracker#2.0#2")


async def test_skeleton_device_reports_unknowns():
    r = await ok(s.device_create("soundcore-q30"))
    assert r["skeleton"] and r["unknown_fields"] > 0
    assert r["name"] == "soundcore  Q30"
    r = await ok(s.device_create("pixel-buds-pro-2", address="F1:F2:F3:F4:F5:78"))
    assert r["unknown_fields"] > 20
    assert any("advertising block empty/unknown" in n for n in r["notes"])
    assert any("service_data 184E skipped" in n for n in r["notes"])


async def test_errors_are_clean():
    r = await s.adv_start("nope")
    assert r["ok"] is False and "no such device" in r["error"]
    bud, phone = await make_pair()
    r = await s.central_connect(phone, bud)
    assert r["ok"] is False and "adv_start" in r["error"]
    r = await s.gatt_read(bud, "FFFF")
    assert r["ok"] is False and "no characteristic" in r["error"]
    r = await s.device_create("generic-earbud", role="toaster")
    assert r["ok"] is False
    r = await s.hci_log_stop()
    assert r["ok"] is False
    r = await s.adv_set_data(bud, "00" * 40)
    assert r["ok"] is False and "31" in r["error"]


async def test_adv_set_data_changes_what_scanners_see():
    bud, phone = await make_pair()
    await ok(s.adv_set_data(bud, "02010605094d794244"))  # flags + name 'MyBD'
    await ok(s.adv_start(bud))
    scan = await ok(s.central_scan(phone, 1.0))
    assert scan["devices"][0]["name"] == "MyBD"


async def test_a2dp_sink_negotiates_sbc():
    bud, phone = await make_pair()
    st = await ok(s.a2dp_status(bud))
    assert st["sink_endpoint"] and not st["connected"]
    r = await ok(s.central_a2dp_connect(phone, bud))
    assert r["avdtp_state"] == "STREAMING"
    st = await ok(s.a2dp_status(bud))
    assert st["connected"] and st["state"] == "streaming"
    assert st["negotiated"]["codec"] == "SBC"
    assert st["negotiated"]["sampling_frequency"] == "SF_44100"
    assert st["negotiated"]["channel_mode"] == "JOINT_STEREO"
    assert st["avrcp_target"] is True
    await ok(s.central_a2dp_send(phone, packets=7))
    await asyncio.sleep(0.2)
    assert (await ok(s.a2dp_status(bud)))["rtp_packets"] == 7
    await ok(s.central_a2dp_control(phone, "suspend"))
    await asyncio.sleep(0.1)
    assert (await ok(s.a2dp_status(bud)))["state"] == "suspended"


async def test_device_remove_and_reset():
    bud, phone = await make_pair()
    await ok(s.device_remove(bud))
    assert [d["device_id"] for d in (await ok(s.list_devices()))["devices"]] == [phone]
    await ok(s.lab_reset())
    assert (await ok(s.list_devices()))["devices"] == []


async def test_duplicate_profile_gets_unique_address():
    a = await ok(s.device_create("generic-earbud"))
    b = await ok(s.device_create("generic-earbud"))
    assert a["address"] != b["address"] and any("already in use" in n for n in b["notes"])


@pytest.mark.skipif(os.access("/dev/vhci", os.R_OK | os.W_OK), reason="/dev/vhci is accessible here")
async def test_vhci_backend_fails_clearly_without_dev_vhci():
    r = await s.lab_create("vhci")
    assert r["ok"] is False and "/dev/vhci" in r["error"]
    assert LAB.backend == "local-link"
