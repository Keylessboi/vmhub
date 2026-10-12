# bt-emu-mcp

An MCP server that runs a **virtual Bluetooth lab** inside a disposable Linux VM, so Bluetooth software
(for example a spatial-audio app that talks to earbuds) can be tested without physical devices and without
any radio. Everything is software: Google's [Bumble](https://github.com/google/bumble) stack emulates the
controllers and devices; nothing is transmitted over the air.

## Install and run

```sh
/opt/re-venv/bin/pip install .            # from this directory; pulls bumble, mcp (>=1.28,<2), jsonschema
/opt/re-venv/bin/python -m bt_emu_mcp --host 0.0.0.0 --port 8087          # streamable HTTP, endpoint /mcp
/opt/re-venv/bin/python -m bt_emu_mcp --transport stdio                    # for a local MCP client
sudo cp systemd/bt-emu-mcp.service /etc/systemd/system/ && sudo systemctl enable --now bt-emu-mcp
```

The build backend is hatchling; on an offline VM install it first and use `pip install --no-build-isolation .`.
The bundled profiles are installed inside the package. Extra profile directories can be added with
`BT_EMU_PROFILES=/dir1:/dir2` (searched first).

Development: `python -m venv /tmp/btemu-venv && /tmp/btemu-venv/bin/pip install -e . pytest pytest-asyncio`,
then `/tmp/btemu-venv/bin/python -m pytest -q`.

## Backends

| backend | what it is | needs |
|---|---|---|
| `local-link` (default) | One Bumble virtual controller per device, joined by an in-process `LocalLink`. An emulated earbud and an emulated phone talk to each other inside the server process. | nothing (pure Python) |
| `vhci` | Each **peripheral** attaches to the kernel's virtual HCI (`/dev/vhci`, Bumble transport `vhci`), so the VM's own BlueZ sees a new controller and a nearby device it can scan, pair and connect to. | `modprobe hci_vhci`, and read/write access to `/dev/vhci` for the service user |

Select with `lab_create(backend=...)`. Under `vhci` only peripherals can be created (BlueZ is the central) and the
tools return a clear error if `/dev/vhci` is not accessible. **The `vhci` path has not been exercised** (no
`/dev/vhci` where this was written); it uses Bumble's stock `vhci` transport and `Device.from_config_with_hci`.
Central-side tools (`central_*`) operate only on local-link centrals.

## Tools

`list_profiles`, `load_profile`, `lab_create`, `lab_reset`, `device_create`, `device_remove`, `list_devices`,
`adv_start`, `adv_stop`, `adv_set_data`, `gatt_read`, `gatt_write`, `gatt_notify`, `gatt_dump`,
`central_scan`, `central_connect`, `central_discover`, `central_read`, `central_write`, `central_subscribe`,
`central_notifications`, `a2dp_status`, `hci_log_start`, `hci_log_stop`, `send_scripted_notifications`,
plus three extras that make A2DP testable: `central_a2dp_connect`, `central_a2dp_send`, `central_a2dp_control`.

Every tool returns a compact dict with `"ok": true`, or `{"ok": false, "error": "..."}`; no stack traces.
Characteristic UUIDs may be `2A19`, `0x2A19` or a full 128-bit UUID; `index` selects among duplicates.

Typical flow:

```
lab_create
device_create(profile="generic-earbud")                       -> p1
adv_start(p1)
device_create(profile="generic-earbud", role="central")       -> c2
central_scan(c2)  ->  central_connect(c2, p1)  ->  central_discover(c2)
central_read(c2, "2A19")                                      -> 57 (87 %)
central_subscribe(c2, "2A19");  gatt_notify(p1, "2A19", "40");  central_notifications(c2)
hci_log_start("/tmp/lab.btsnoop") ... hci_log_stop()
```

`hci_log_*` writes BTSnoop (v1, H4) files: the path you pass holds all devices interleaved, and
`<name>.<device_id>.btsnoop` files hold one controller each (use these in Wireshark; handles in the combined file
overlap because each virtual controller numbers its own connections).

### A2DP: what works

Over `local-link`, a peripheral whose profile has `a2dp_sink` registers an SBC sink endpoint with the profile's
capabilities, an SDP record and (if `avrcp` is present) an AVRCP target. `central_a2dp_connect` opens a BR/EDR link and
runs real AVDTP signalling (discover, get-capabilities, set-configuration, open, start); `a2dp_status` then reports the
negotiated SBC parameters, AVDTP state and RTP packet counts, and `central_a2dp_send` pushes synthetic RTP packets.
**Not implemented:** audio decoding, pairing/encryption on the A2DP link, SDP browsing tests, codecs other than SBC.
Under `vhci` the sink endpoint is registered too, but whether BlueZ negotiates with it is untested.

## Profile format

A profile is a JSON file validated by `bt_emu_mcp/profile.schema.json` (plus semantic checks: UUIDs parse, notify
scripts only on notify characteristics, bitpool ranges). Top level:

```jsonc
{
  "schema_version": 1, "id": "generic-earbud", "name": "Generic Earbud",
  "address": "F1:F2:F3:F4:F5:01", "class_of_device": "0x240404", "appearance": "0x0941",
  "advertising":   { "flags": ["le_general_discoverable", "br_edr_not_supported"], "local_name": "...",
                     "service_uuids": ["180F"], "service_data": [{"uuid": "..", "data_hex": ".."}],
                     "manufacturer_data": {"company_id": 76, "data_hex": ".."}, "raw_hex": "optional verbatim payload" },
  "scan_response": { ...same shape... },
  "gatt": { "services": [ { "uuid": "180F", "characteristics": [
      { "uuid": "2A19", "properties": ["read", "notify"], "value_hex": "57",
        "descriptors": [ {"uuid": "2901", "value_hex": ".."} ],
        "notify_script": { "pattern_hex": "aa00bb", "interval_ms": 100, "repeat": 0, "counter": {"offset": 1} } } ] } ] },
  "a2dp_sink": { "codecs": [ { "type": "SBC", "sampling_frequencies": [44100, 48000], "channel_modes": ["joint_stereo"],
                               "block_lengths": [16], "subbands": [8], "allocation_methods": ["loudness"],
                               "min_bitpool": 2, "max_bitpool": 53 } ] },
  "avrcp": { "role": "target", "supported_events": ["PLAYBACK_STATUS_CHANGED", "VOLUME_CHANGED"] }
}
```

* `notify_script` starts when a peer subscribes and stops when it unsubscribes. `pattern_hex` is repeated every
  `interval_ms`; `frames_hex` replays a list instead; `counter.offset` replaces that byte with a running counter;
  `repeat: 0` means until unsubscribed. For one-off replays of captured frames use `send_scripted_notifications`.
* GAP (1800) and GATT (1801) services are added automatically; leave them out of profiles.
* Advertising is legacy (31 bytes max for data and for scan response) from a fixed address.
* **Unknowns.** Any field may be `{"unknown": true}` (optionally with `note`), and objects may list fields in
  `unknown_fields`. The emulator never invents data for them: it skips unknown advertising pieces, defaults unknown
  characteristic properties to `read`, leaves unknown values empty, and reports all of it in the `device_create`
  notes. `load_profile` lists every unknown path. `skeleton: true` marks incomplete profiles and `provenance` records
  where each filled-in value came from.
* `classic_info` is free-form, informational only (HID ids, RFCOMM services); it is not emulated.

### Bundled profiles

* `generic-earbud` - fully specified: Battery (180F), Device Information (180A), SBC A2DP sink, AVRCP target. No vendor claims.
* `pixel-buds-pro-2`, `soundcore-q30` - **skeletons** built only from the owner's own notes. Read the `provenance`
  block for exactly what is filled in and what still needs capture. The Pixel Buds skeleton does contain the Android
  head-tracker GATT service (service/characteristic UUIDs are AOSP's public ones) with the version and control values read
  from the real device; its input-report characteristic has no value because the real device never emitted a frame in any
  recorded session. Feed it with `send_scripted_notifications` using synthetic or later-captured frames.

## Capturing a real device's GATT database to build a faithful profile

1. **Connect the real device to a Linux box or phone you control.** Prefer an LE connection.
2. **GATT structure (what exists):**
   * Linux: `bluetoothctl`, then `connect <addr>`, `menu gatt`, `list-attributes <addr>` (text), and
     `select-attribute <path>` + `read` for each readable characteristic (note value bytes), `attribute-info` for flags
     (properties). BlueZ also caches the whole database under `/var/lib/bluetooth/<adapter>/cache/<addr>`.
   * Phone: nRF Connect for Mobile can discover and export a device's services and show properties and values.
     Transcribe or convert its export into the simple JSON shape below (its export format is not parsed directly).
3. **Advertising data and scan response:** `sudo btmon -w adv.snoop` while running `bluetoothctl scan on`; open in
   Wireshark or read the `LE Advertising Report` / `Scan Response` events in `btmon`'s text output. Copy the raw AD
   payload hex into `advertising.raw_hex` (and `scan_response.raw_hex`) to reproduce it byte for byte.
4. **Classic side (A2DP/AVRCP):** capture with `btmon -w`, filter `btavdtp` in Wireshark, and read the SBC codec
   capability bytes from the *Get Capabilities* response; copy them into `a2dp_sink.codecs`.
5. **Notification streams:** subscribe in `bluetoothctl` (`notify on`) or nRF Connect while the device streams, record
   the bytes (or `btmon`), and keep them as hex frames for `send_scripted_notifications`.

### Converting a capture

```sh
# bluetoothctl `list-attributes` text -> skeleton profile
python -m bt_emu_mcp.convert attrs.txt --id my-buds --name "My Buds" --address AA:BB:CC:DD:EE:FF \
       --values values.json > profiles/my-buds.json
# values.json: {"2A19": {"properties": ["read","notify"], "value_hex": "50"}, "<vendor uuid>": {...}}

# JSON in the simple shape (also this server's own gatt_dump output) -> profile
python -m bt_emu_mcp.convert dump.json --format json --id my-buds --name "My Buds" > profiles/my-buds.json
# dump.json: {"services":[{"uuid":"180F","characteristics":[{"uuid":"2A19","properties":["read","notify"],"value_hex":"50"}]}]}
```

The converter writes anything it could not take from the capture as `unknown_fields` (it never guesses), drops
1800/1801 and the 2902 CCCD, and validates the result. The `bluetoothctl` parser was written against the documented
layout of `list-attributes` (`Primary Service (Handle 0x..)` / `Characteristic (Handle 0x..)` blocks, each followed by
a D-Bus path and a UUID line) and tested on a hand-written sample, so check it against your BlueZ version. Then
fill in the remaining unknowns by hand and drop `"skeleton": true` when the profile is complete.

## Notes

* All devices share one event loop; state is a single module-level lab guarded by an `asyncio.Lock` that is never held
  across sleeps, so long replays and scans do not block other tools.
* Bumble logs to stderr (so `--transport stdio` stays clean). Use `--log-level DEBUG` for detail.
* Two devices created from the same profile get adjacent addresses automatically.
