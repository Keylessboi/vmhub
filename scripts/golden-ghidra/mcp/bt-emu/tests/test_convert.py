import json

from bt_emu_mcp import convert, profiles

# Hand-written sample in the layout bluetoothctl's `list-attributes` prints (not captured from a device).
SAMPLE = """\
Primary Service (Handle 0x0001)
\t/org/bluez/hci0/dev_AA/service0001
\t00001801-0000-1000-8000-00805f9b34fb
\tGeneric Attribute Profile
Primary Service (Handle 0x0010)
\t/org/bluez/hci0/dev_AA/service0010
\t0000180f-0000-1000-8000-00805f9b34fb
\tBattery Service
Characteristic (Handle 0x0011)
\t/org/bluez/hci0/dev_AA/service0010/char0011
\t00002a19-0000-1000-8000-00805f9b34fb
\tBattery Level
Descriptor (Handle 0x0013)
\t/org/bluez/hci0/dev_AA/service0010/char0011/desc0013
\t00002902-0000-1000-8000-00805f9b34fb
\tClient Characteristic Configuration
Primary Service (Handle 0x0020)
\t/org/bluez/hci0/dev_AA/service0020
\t109b862f-50e3-45cc-8ea1-ac62de4846d1
\tVendor specific
Characteristic (Handle 0x0021)
\t/org/bluez/hci0/dev_AA/service0020/char0021
\te66dd173-b2ae-4f5a-ae16-0162af8038ae
\tVendor specific
"""


def test_bluetoothctl_capture_becomes_valid_skeleton(tmp_path):
    cap = convert.parse_bluetoothctl(SAMPLE)
    assert [s["uuid"] for s in cap["services"]] == ["1801", "180F", "109b862f-50e3-45cc-8ea1-ac62de4846d1"]
    values = {"2A19": {"properties": ["read", "notify"], "value_hex": "50"}}
    prof = convert.build_profile(cap, "x", "X", "AA:BB:CC:DD:EE:01", values)
    assert profiles.validate(prof) == []
    svcs = {s["uuid"]: s for s in prof["gatt"]["services"]}
    assert "1801" not in svcs
    batt = svcs["180F"]["characteristics"][0]
    assert batt["value_hex"] == "50" and "descriptors" not in batt
    vend = svcs["109b862f-50e3-45cc-8ea1-ac62de4846d1"]["characteristics"][0]
    assert vend["unknown_fields"] == ["properties", "value_hex"]
    assert len(profiles.find_unknowns(prof)) >= 4


def test_cli_roundtrip(tmp_path, capsys):
    f = tmp_path / "cap.txt"
    f.write_text(SAMPLE)
    assert convert.main([str(f), "--id", "x", "--name", "X"]) == 0
    prof = json.loads(capsys.readouterr().out)
    assert profiles.load_profile(prof)["id"] == "x"
