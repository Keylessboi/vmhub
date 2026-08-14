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
- x11 golden: computer-use-linux in-VM MCP

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
