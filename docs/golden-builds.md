# Golden VM build recipes (2026-08-14)

How each golden template was built, the gotchas, and what a fresh clone needs.

## Shared base: debian-13-golden (VMID 2030)

Built from the Debian 13 genericcloud image imported into the encrypted
`vmhub` pool. Requirements baked in:
- `ipconfig0: ip=dhcp` (lite overrides with a static IP at clone time)
- `qemu-guest-agent` installed + enabled (Proxmox agent control)
- cloud-init root + authorized_keys injected (SSH transport)
- `vga: virtio` for a real DRM device (serial-only VGA breaks desktops)

## hyprland-2404 (VMID 2050) — Hyprland desktop golden

Built from debian-13-golden. Critical learnings (all cost real time):

1. **CPU type MUST be `host`.** The default `kvm64` exposes a minimal CPU
   feature set. bun (even the -baseline build) OOM-thrashes under kvm64
   because it cannot JIT properly. `qm set <vmid> --cpu host` fixes it —
   the VM then sees the host E5-2670 v2's real features (avx, popcnt...).
2. **bun-compiled binaries do NOT run on this CPU.** The desktop's
   hyprland-mcp binary was compiled on an 11th-gen i3 (AVX2/AVX512) and
   dies with SIGILL on the E5 (pre-AVX2). Use the **bun-baseline** build:
   `curl -fsSL https://github.com/oven-sh/bun/releases/latest/download/
   bun-linux-x64-baseline.zip`, unzip to /usr/local/bin/bun-baseline.
3. **Run hyprland-mcp from source**, not the compiled binary:
   `/usr/local/bin/bun-baseline run src/index.ts` (source + node_modules
   copied into the VM at /opt/hyprland-mcp).
4. **Hyprland refuses to run as root.** Create `vmuser`, autologin on tty1
   (`/etc/systemd/system/getty@tty1.service.d/autologin.conf`), and a
   `.bash_profile` that `exec Hyprland` on tty1 login.
5. **The MCP server needs the session env** (launcher at
   /usr/local/bin/launch-hypr-mcp):
   ```
   export XDG_RUNTIME_DIR=/run/user/1000
   export HYPRLAND_INSTANCE_SIGNATURE=$(ls -t /run/user/1000/hypr/ | head -1)
   export WAYLAND_DISPLAY=wayland-1
   ```
6. **Hyprland config** at /home/vmuser/.config/hypr/hyprland.conf (minimal:
   no animations, border colors, wl-clipboard watch).

### Verified transport (the full adapter path)
Desktop → `ssh -T -o ProxyJump=root@192.168.1.220 root@<vm-ip>
/usr/local/bin/launch-hypr-mcp` → MCP stdio server → live Hyprland.
`tools/list` and `screenshot` both verified working (1280x800 PNG delivered).

## What lite must do at clone time (transport contract)
- Allocate static IP from 10.10.10.50+ pool → set `ipconfig0`
- Set the identity tag (reaper doctrine)
- The reaper must stop+destroy the VM and purge its disks (already done)

## Still to build (ISOs downloaded)
- windows-11-24h2: /tmp/win11.iso (5.1G) — CursorTouch v0.8.5 in-VM

## x11-2404 (VMID 2060) — X11 desktop golden (computer-use-linux)

Debian **trixie (13)** desktop golden: Xorg + openbox autologin on tty1 as
vmuser (no display manager, no GNOME Shell), **computer-use-linux v0.4.9** as
the in-VM MCP server, driven over SSH ProxyJump through the Proxmox host by
adapters/x11 (`adapters/x11/index.ts`). Built on the debian-13-golden base
above. **Re-templated 2026-08-15** from the repaired diag clone (full clone via
2602, see below) and now reconciler-managed (`desired/vms.json`).

Template facts: VMID **2060**, name `x11-2404`, tags `gitops`, ip
**10.10.10.63**, cpu `host`, **2 cores / 4GB**, scsi0
`vmhub:base-2060-disk-0` (independent full clone).

### The critical launcher/session fix (issue #3)

The original golden leased but was undrivable: every session-bus feature died
with permission errors. Two stacked bugs:

1. The X session ran on a **private dbus bus**. `.bash_profile` ran
   `eval "$(dbus-launch --sh-syntax)"`, which put the X session
   (startx → xinit → openbox) on a random `/tmp/dbus-*` bus that no external
   process could reach.
2. The old launcher used `su -s /bin/bash vmuser -c "..."`, which
   **preserves the root SSH shell's `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`**
   (su does not reset the environment). computer-use-linux, running as vmuser,
   then connected to root's private bus and hit `Operation not permitted`/EPERM
   on every session-bus call: no AT-SPI, no portals, and gnome-screenshot
   failed with `failed to connect to session bus`.

The fix has four parts:

1. **`.bash_profile` no longer starts a private bus** (the dbus-launch line is
   commented out with a rationale). The login shell already has
   `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus` from pam_systemd, so
   the X session now inherits the **stable systemd user bus**.
2. **`/etc/vmhub-session.env`** (mode 0600, root:root) pins the session env:
   ```
   export DISPLAY=:0
   export XAUTHORITY=/home/vmuser/.Xauthority
   export XDG_RUNTIME_DIR=/run/user/1000
   export XDG_SESSION_TYPE=x11
   export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
   ```
3. **`/usr/local/bin/launch-x11-mcp`** (mode 755) sources that env, then su's:
   ```bash
   #!/bin/bash
   set -a
   . /etc/vmhub-session.env
   set +a
   exec su -s /bin/bash vmuser -c "exec /usr/local/bin/computer-use-linux mcp"
   ```
4. **`/usr/local/bin/vmhub-exec`** (mode 755), the SSH exec/launch/close shim
   that adapters/x11 uses for exec/launch/close, sources the same env before
   running the command as vmuser, so `wmctrl` and GUI launches reach the real
   desktop. (Verified end-to-end: exit 0; no-arg exit 2.)

### Required packages

- `libglib2.0-bin` (2.84.4) + `dconf-service`: provide `gsettings`/dconf.
  The original golden shipped without them; that is why
  `toolkit-accessibility` could never be set.
- `wmctrl`, `xprop`, `xdotool`, `scrot`: already present; the X11/EWMH
  backend (wmctrl) and XTEST input (xdotool) work without the session bus.
- `xterm`, `lxpanel`, `zenity`: GTK apps autostarted so the AT-SPI tree and
  window list are non-empty (48-node tree, 3 windows verified).
- gnome-screenshot 41.0 is the screenshot backend (works via X11 fallback;
  ImageMagick `import` is NOT installed and not needed).

### Accessibility (openbox autostart)

`/home/vmuser/.config/openbox/autostart` (mode 755, vmuser) enables AT-SPI and
ensures a drivable desktop:

```bash
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export XDG_RUNTIME_DIR=/run/user/1000
mkdir -p "$HOME/.config/dconf"     # dconf needs its db dir before gsettings persists
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || true
gsettings set org.gnome.desktop.interface enable-animations false 2>/dev/null || true
xterm -T "agent-shell" &
lxpanel &
zenity --info --text="agent-shell" --title="agent-shell" &
```

**dconf gotcha:** gsettings silently fails to persist when `~/.config` is not
vmuser-owned or `~/.config/dconf/` does not exist
(`dconf-WARNING: failed to commit changes to dconf`). If the values stop
sticking, fix ownership (`chown -R vmuser:vmuser /home/vmuser/.config`) and the
dconf db dir.

### Pinned born-current refresh

`/usr/local/bin/vmhub-golden-refresh.sh` runs
`npm install -g @agent-sh/computer-use-linux@0.4.9` (**PINNED**; an earlier
unpinned `npm update -g` caused latent version drift), as oneshot systemd unit
`vmhub-golden-refresh.service`, and touches `/var/lib/vmhub-golden-refreshed`.
Clones run the born-current refresh at first boot. Keep the pin in sync with the
adapter when upgrading.

### The gate (acceptance bar before re-templating)

`scripts/x11-golden-gate.sh <vm-ip>` runs in the exact launcher context
(`set -a; . /etc/vmhub-session.env; set +a; su -s /bin/bash vmuser -c "..."`)
and requires all 5 gates to pass:

1. doctor all-ok: at_spi_bus, toolkit_accessibility, x11 backend and readiness
   flags all true, 0 blockers
2. gsettings persisted: `toolkit-accessibility` == true
3. AT-SPI tree ≥ 3 nodes (48 verified: lxpanel, zenity)
4. windows ≥ 1 (3 verified: xterm, panel, zenity)
5. screenshot 3x deterministic: exit 0 each, 1920x1080, source gnome-screenshot

Both the repaired golden (T5, VM 2600) and a fresh smoke clone of the
re-templated 2060 (T6) passed with `OVERALL: PASS`. Run this gate on any
rebuilt/repaired golden before re-templating it.

### Critical learnings (all cost real time)

1. **su preserves the DBUS env it was started with.** `su -s /bin/bash vmuser -c
   "..."` from a root SSH shell keeps root's
   `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`. computer-use-linux then
   runs as vmuser against root's private bus and every session-bus call fails
   with `Operation not permitted`. The launcher MUST source
   `/etc/vmhub-session.env` before the `su`.
2. **Private dbus-launch bus vs the stable systemd user bus.** The original
   golden's `.bash_profile` `eval "$(dbus-launch --sh-syntax)"` hijacked the X
   session onto a random `/tmp/dbus-*` bus no external process could reach.
   Removing it lets the session inherit the stable systemd user bus
   `unix:path=/run/user/1000/bus` that pam_systemd already set for the login
   shell.
3. **Ready-vs-booted timing.** After power-on, SSH is reachable at +23s, Xorg
   starts at +25s, openbox at +27s: a ~4s pre-desktop window where SSH works but
   the desktop is not drivable. lite's lease readiness gate
   (`src/lite/readiness.ts`) probes `pgrep -x openbox` over the same ProxyJump
   SSH path, with a hard 120s bound (10s per-attempt timeout), so a lease flips
   to `ready` only when the desktop is actually up.
4. **dconf directory ownership.** gsettings silently fails to persist when
   `~/.config` is not vmuser-owned or `~/.config/dconf/` is missing (see the
   openbox autostart gotcha above).
5. **Portals deferred (not required).** xdg-desktop-portal is not installed;
   the doctor reports `org.freedesktop.portal.Desktop was not provided by any
   .service files` for every portal check. That is fine: gnome-screenshot's X11
   fallback and XTEST input cover the adapter's needs, so portals were
   deliberately left out.

### Verified transport (the full adapter path)

Desktop → `ssh -T -o ProxyJump=root@192.168.1.220 root@<vm-ip>
XDG_SESSION_TYPE=x11 /usr/local/bin/launch-x11-mcp` → MCP stdio server → live
computer-use-linux. `tools/list` and `screenshot` verified working (1920x1080
PNG delivered); the adapter composes the session env vars on the remote command
line so the in-VM server reaches the autologin Xorg+openbox session.

Lease-level verification (issue #3 acceptance): two full E2E journeys over the
MCP surface, each `ready` in ~26s, with screenshot / inspect / list_windows /
exec / launch / close all green (T7).

## android-9-golden (VMID 2200) — Android-x86 9.0-r2 desktop golden

Built 2026-08-14 from android-x86_64-9.0-r2. Boots to a usable Android 9
desktop (setup wizard disabled) with ADB-over-network verified from the
Proxmox host (`adb connect 10.10.10.100:5555` → `device`).

### Critical learnings (each one cost real time)

1. **The ISO is 921 MiB, not 510M.** The original `/tmp/android-x86.iso`
   was a truncated download (510M) — its ISO9660 metadata pointed past the
   end of the file and isolinux died with `Failed to load ldlinux.c32`.
   Re-downloaded from sourceforge:
   `android-x86_64-9.0-r2.iso`, sha1 `1cc85b5ed7c830ff71aecf8405c7281a9c995aa0`.
   A valid ISO is the FIRST thing to check when isolinux fails.
2. **SeaBIOS + ISOLINUX cannot boot this ISO.** android-x86 9.0's isolinux
   path fails under SeaBIOS in QEMU. Must boot **UEFI/OVMF**:
   `qm set <vmid> --bios ovmf --efidisk0 vmhub:64,efitype=4m,pre-enrolled-keys=0`.
   `pre-enrolled-keys=1` enables Secure Boot and OVMF rejects the unsigned
   android-x86 bootloader with "Access Denied" — use `pre-enrolled-keys=0`.
3. **The "Installation" GRUB entry is 3rd** (`Down Down Enter` from the
   default `Live` entry; `savedefault` can persist the previous choice, so
   re-check the highlight). The GRUB menu is: Live / Live DEBUG mode /
   Installation / Advanced options. The DEBUG entry boots the same wizard —
   easy to mistake for a failed install.
4. **Installer = dialog TUI on the console.** Answer **Yes** to GPT (press
   `y` — dialog hotkey, the focus indicator is not reliable from OCR), then
   in cgdisk create:
   - partition 1: 260M, type `ef00` (EFI System / ESP)
   - partition 2: rest of disk, type `8300` (Linux filesystem)
   cgdisk quirks: cursor lands on the 1007 KiB gap between the GPT header
   and partition 1 — navigate to the big free space before `n`; `Write`
   needs `yes` typed. Note: the `M` in a size must be typed correctly
   (a broken keystroke made the ESP 260 sectors = 130 KiB — too small for
   GRUB). Install to partition **sda2** (the data partition), format ext4,
   **install EFI GRUB2**, **/system read-write = yes**. The installer itself
   formats sda1 as FAT32 for the ESP.
5. **DHCP does NOT work on vmbr1** (dnsmasq never answers DISCOVER — even a
   host-crafted DISCOVER from scapy on vmbr1 gets no OFFER). This is a host
   bridge/dnsmasq limitation; Android-x86 VMs must use a static IP (matches
   the "cloud-init static ipconfig0" pattern of the other goldens).
6. **The framework fights manual networking two ways, both worked around in
   `/system/etc/init.sh` (android-x86's boot hook):**
   - `init.sh` renames eth0 → `wifi_eth` and creates a virt_wifi `wlan0`
     (wired-as-WiFi). The WiFi stack never auto-connects (no saved
     networks) so the link stays down. Fix: set `VIRT_WIFI=0` at the top
     of `init.sh` so the rename/virt_wifi block is skipped.
   - The framework's `EthernetNetworkFactory` (regex `config_ethernet_iface_regex`
     = `eth\d`, verified in framework-res.apk) runs DHCP on eth0 and its
     provisioning can flush a manually-added address/routes. Fix: rename
     eth0 → `lan0` in early init (`setup_net()` in `init.sh`) so the
     factory never matches it, then apply the static config.
   - Android policy-routing (`ip rule` → `local_network` table, then
     `unreachable`) ignores the `main` table for unmarked sockets, so the
     static routes MUST also go into the `local_network` table.
7. **ADB-over-network persistence**: `service.adb.tcp.port=5555` appended
   to `/system/build.prop` — adbd then listens on tcp 5555 at every boot.
   `ro.adb.secure` is unset (insecure adbd) so no RSA authorization dialog.
8. **Setup wizard disabled** for clones: `ro.setupwizard.mode=DISABLED`
   in `/system/build.prop` (sed-replace from ENABLED).

### The boot hook (`/system/etc/init.sh`, /system is read-write)

Runs at every boot (called from `/init.android_x86_64.rc` with `init` /
`bootcomplete` args). Patched to add:

```sh
VIRT_WIFI=0  # skip the eth0->wifi_eth + virt_wifi block

function configure_static_net()
{
    local iface=lan0
    local ip=$(cat /data/local/network.conf 2>/dev/null | head -1)
    [ -z "$ip" ] && ip=10.10.10.100
    ip link set $iface up
    ip addr flush dev $iface 2>/dev/null
    ip addr add $ip/24 dev $iface
    ip route replace default via 10.10.10.1 dev $iface
    ip route replace $ip/24 dev $iface table local_network
    ip route replace default via 10.10.10.1 dev $iface table local_network
    setprop net.dns1 10.10.10.1
}

function setup_net()
{
    if [ -d /sys/class/net/eth0 ]; then
        ip link set eth0 down
        ip link set eth0 name lan0
    fi
    configure_static_net
}
```

`setup_net` is called from `do_init()` (early — before the framework starts),
`configure_static_net` is re-asserted at `do_bootcomplete()`.

### Verified from the Proxmox host (after a full reboot)

```
$ ping -c 2 10.10.10.100        # 0% loss
$ adb connect 10.10.10.100:5555 # connected
$ adb devices
10.10.10.100:5555   device
```

Template: VMID **2200**, `qm template` converted disks to
`vmhub:base-2200-disk-0` (16G) + `vmhub:base-2200-disk-2` (EFI vars).

### What a clone needs
- **A unique IP.** Either write it to `/data/local/network.conf`
  (e.g. `10.10.10.101`) before first boot, or edit `configure_static_net`'s
  default in `/system/etc/init.sh`.
- The clone is UEFI (OVMF) with Secure Boot off; boot disk is scsi0.
- ADB is ready immediately: `adb connect <clone-ip>:5555`.

### Gotchas not yet solved
- The Android "wifi" toggle shows no network (expected — no framework
  network; the static `lan0` serves raw IP connectivity for ADB).
- No guest agent (Android has none; `agent enabled=0`).

## windows-11-24h2 (VMID 2100 → golden) — build steps

1. **Create the VM** (hardware matters):
   - machine `q35`, BIOS `OVMF (UEFI)`, EFI disk with pre-enrolled keys
   - TPM State v2.0 (Win11 requirement), CPU `host`, 8 cores, 16GB
   - disk on **SATA** (NOT virtio-scsi — Windows has no native driver during
     install), 64GB, fully unallocated
   - network virtio on vmbr1
2. **Install Win11 Enterprise Evaluation** (manual):
   - boot ISO, at "Press any key to boot from CD" press once, then **stop
     pressing keys** — key-spam on reboot re-boots the ISO and causes the
     "computer restarted unexpectedly" error
   - disk screen: select **unallocated space → Next** (Windows creates its own
     EFI+MSR+Windows layout — do NOT pre-partition with diskpart; the earlier
     single-primary GPT layout caused the same restart-loop error)
3. **Local account**: vmhub / vmhub-admin-2026! / security answers "idk".
4. **Legal activation at this step** — operator action, not documented here.
5. **Virtio drivers**: attach `iso-store:iso/virtio-win.iso`, run
   `virtio-win-guest-tools.exe` (fast disk/net). Disable Windows firewall:
   `netsh advfirewall set allprofiles state off`. Drop `firewall=1` from net0.
6. **CursorTouch v0.8.5** (Windows-MCP):
   - `winget install Python.Python.3.13 --silent`, `pip install uv`,
     `uv tool install windows-mcp==0.8.5`
   - `windows-mcp auth --transport streamable-http --host 0.0.0.0 --port 8000`
     → writes `~/.windows-mcp/config.toml` with the auth key (capture it —
     it's the CursorTouch secret for the adapter)
   - serve on `0.0.0.0:8000` (non-loopback needs the auth key, by design):
     `windows-mcp serve --transport streamable-http --host 0.0.0.0 --port 8000`
   - adapter connects to `http://<vm-ip>:8000/mcp/` with `Bearer <key>`
   - set `ANONYMIZED_TELEMETRY=false` (cloned goldens shouldn't phone home)
7. **Convert to golden template** (after activation). The adapter
   (adapters/windows/index.ts) is wired for streamable-http + Bearer auth;
   set `CURSORTOUCH_AUTH_KEY` via Doppler/env.
