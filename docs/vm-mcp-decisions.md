# VM MCP adapters — research decisions (2026-08-13)

Decisions for the four supported golden VMs. Full research in session notes;
this file records the picks and the reasons, so a future session does not
re-litigate them.

## Windows — CursorTouch/Windows-MCP (v0.8.5, pinned)

- Repo: github.com/CursorTouch/Windows-MCP — 6.7k stars, Python, MIT, active
  (v0.8.5 released 2026-08-01; current `main` targets Python >=3.14).
- Transport: stdio, SSE (`/sse`), streamable-http (`/mcp/`). The golden runs
  `windows-mcp serve --transport streamable-http --host 0.0.0.0 --port 8000`
  with an auth key; the adapter connects to `http://<vm>:8000/mcp/` with
  `Authorization: Bearer <key>`.
- 20 tools cover screenshot, input, file transfer, exec.
- Install in golden: Python 3.13 + `uv tool install windows-mcp==0.8.5`,
  register as Scheduled Task, disable telemetry (`ANONYMIZED_TELEMETRY=false`).
- Watch-out: non-loopback HTTP bind refuses to start without auth (by design).

## Android — host-side ADB (base) + in-VM app (later upgrade)

- Base adapter: host-side ADB over the VM network. Verified working on
  Android-x86 on Proxmox: `setprop service.adb.tcp.port 5555; stop adbd;
  start adbd` then `adb connect <guest-ip>:5555`. No RSA prompt on x86
  builds (userdebug posture) — isolate the VM network.
- MCP adds ergonomics (element targeting via uiautomator, structured tools),
  not capability, for raw screenshot/input/exec. Skip MCP for the base path.
- Later upgrade: danielealbano/android-remote-control-mcp (254 stars, Kotlin
  APK in-VM, accessibility-tree + 10-100ms actions, headless ADB setup) when
  semantic UI automation is needed.

## X11 — agent-sh/computer-use-linux (+ thin shim)

- Repo: github.com/agent-sh/computer-use-linux — 393 stars, Rust, MIT, very
  active. npm `@agent-sh/computer-use-linux`.
- Real X11/EWMH backend (wmctrl + xprop), input via xdotool XTEST, AT-SPI
  accessibility tree for inspect. Supports Xfce/Openbox/Cinnamon/MATE goldens.
- 18 tools cover screenshot/click/type/key/drag/focus/list_windows/inspect.
  Missing: close, launch, exec — provide a thin shim (wmctrl -ic for close,
  spawn/xdg-open for launch, bash for exec) in the adapter.
- Deps in golden: wmctrl, xprop, xdotool, gnome-screenshot (or portal).
- Runner: zavora-ai/computer-use-mcp (30 stars) covers launch/exec natively
  but has no accessibility tree and a thin community — rejected as primary.
- File transfer stays in the vmhub agent layer (vm_put_file/vm_get_file),
  not the X11 MCP server.

## Hyprland — our own hyprland-mcp

- Use the existing compiled hyprland-mcp binary in the golden, reached over
  the VM's SSH transport (stdio). No change to the pick.

## Network requirements (2026-08-13, LO) — general-purpose platform, one mode

VMs serve many purposes: app testing, site testing, malware analysis, and
malware-capability testing (where spread across a given network is the point).
Malware is ONE mode, not the main one. The platform must be general-purpose
with network control as an available dial, and it must have a LEARNING CURVE:
basic app testing first, then network awareness, then isolation, then
controlled spread. Each layer builds on the last; nothing advanced is forced
on a simple use.

### Requirements
1. **WiFi option per VM.** Agents must be able to create a VM with WiFi
   enabled, not just ethernet. Means an emulated/paravirtual wireless NIC or
   an AP-mode segment the VM joins.
2. **Network isolation segments.** Agents need a way to run VMs on isolated
   segments so malware cannot touch the LAN (192.168.1.0/24) or the host
   management network. The existing vmbr1 NAT is NOT enough — a malware VM
   must not be able to reach the host at all, and must be able to be cut off
   from the internet entirely.
3. **Controlled spread.** Sometimes the scenario requires malware to spread
   across a *given* network: multiple VMs on the same isolated segment,
   sharing it deliberately. The capability matrix must let an agent create
   several VMs attached to one lab segment and let traffic flow between them.
4. **No-fail safety**: a lab network must be provably unable to reach the
   production LAN even if the VM is fully compromised. Design the segments
   with that invariant (no route, no bridge to vmbr0, no host gateway on the
   lab segment).

### Design direction (to be implemented)
- Add a `network` concept to the capability contract: `nat` (default, vmbr1),
  `isolated` (dedicated bridge per lab, VMs on it talk to each other, no
  uplink), `wifi` (isolated segment + virtual AP the VM joins), and later
  `lan` (explicit opt-in, only for legitimate reachability tests).
- A lab segment is a per-lease Proxmox bridge (vmbr1XX) with its own DHCP
  (dnsmasq instance bound to that bridge), no default route to the internet.
  NAT out = disabled for isolated segments.
- WiFi: either a host-side virtual AP (hostapd on a veth/bridge) the VM's
  wireless NIC joins, or a small "AP VM" on the segment. Decide after the
  base transport works.
- The reaper must tear down the whole segment (bridge + dnsmasq + any AP)
  when the lease dies, by the same identity tag doctrine.
- Learning-curve principle: `nat` is the default for every template (benign
  app/site testing works with zero network knowledge). `isolated` and `wifi`
  are explicit opt-in capabilities an agent requests when it needs them.
  Nothing about the simple path changes when advanced modes exist.
