# Golden VM build recipes (2026-08-14)

How each golden template was built, the gotchas, and what a fresh clone needs.

## Shared base: debian-13-golden (VMID 2030)

Built from the Debian 13 genericcloud image imported into the encrypted
`vmhub` pool. Requirements baked in:
- `ipconfig0: ip=dhcp` (lite overrides with a static IP at clone time)
- `qemu-guest-agent` installed + enabled (Proxmox agent control)
- cloud-init root + authorized_keys injected (SSH transport)
- `vga: virtio` for a real DRM device (serial-only VGA breaks desktops)

## hyprland-2404 (VMID 2070) — Hyprland desktop golden

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

## android (bliss-android16, VMID 2110) — Android-x86 9.0-r2 desktop golden

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

### Current live state (2026-08-14, verified against Proxmox)

The built VM exists as **bliss-android16 (VMID 2110)** but is still a plain VM —
it was NOT converted to a golden template (`qm template` never ran), so it is
not clonable and the MCP catalog marks `android` as unavailable. To finish:
stop the VM, `qm template 2110` (converts disks to `vmhub:base-2110-disk-*`),
then the live catalog will advertise it and `android` becomes provisionable.

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

Status: **in progress**. The build VM exists as `win11-builder` (VMID 2100,
running, not yet a golden template). The MCP catalog therefore marks `windows`
as unavailable until `qm template 2100` runs.

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

## macos-sequoia-15.7.9-1 (VMID 2120) — golden factory attempt (Track D, 2026-08-16)

Status: **BLOCKED at the boot gate — NOT a template yet.** The guest disk is
intact and contains the fully-installed macOS (15.7.9 / 24G830, Xcode 26.3,
iOS 26.3.1 runtime, idb) from the T4 probe. The probe's proven QEMU recipe
(8.2.5 + `pc-q35-4.2` + `-cpu host,kvm=on,vendor=GenuineIntel,+invtsc,
vmware-cpuid-freq=on`) is the ONLY environment this macOS boots under, and it
is not reproducible on this host right now. Full evidence below.

### VMID map (Vostro, `pve` node)

| VMID | Name | State | Notes |
|---|---|---|---|
| 2120 | macos-sequoia-15.7.9-1 | stopped, plain VM (NOT template) | adopted probe disk + OpenCore + OVMF/efidisk, 8 GiB / 4 cores |
| — | disk `local-lvm:vm-2120-disk-0` | 100 GiB thin LV | the T4 probe macOS disk, adopted (renamed from `probe-macos`) |
| — | disk `local-lvm:vm-2120-disk-3` | 64 MiB | OpenCore ESP, rebuilt from pristine sources |
| 101 | VM 101 | running (restored after temporary stop for RAM headroom) | — |
| 102 | emphatic | stopped (evicted — do NOT start) | — |

Golden id `macos-sequoia-15.7.9-1` and the frozen triple stay as pinned in
`scripts/golden-pins.json` (source of truth). Deterministic guest MAC:
`52:54:00:c9:18:27` (vmxnet3, recorded from the probe recipe and set on
net0).

### What IS baked into the guest (persists on the disk LV)

All applied over the live SSH channel (host port 2222) before the boot
regression, per the blinddriver doctrine (SSH text only, never pixels):

- **mac-control-mcp v0.8.1** installed at
  `/Applications/MacControlMCP.app/Contents/MacOS/MacControlMCP` (universal
  binary from AdelElo13/mac-control-mcp releases) and **re-signed** with
  `codesign -f -s - -i com.vmhub.agent -r '=designated => identifier
  "com.vmhub.agent"'` so its TCC identity is the stable `com.vmhub.agent`.
- **vmhub-axprobe** at `/usr/local/bin/vmhub-axprobe` (Swift TCC probe,
  source committed at `scripts/macos/vmhub-axprobe.swift`; subcommands
  `ax` / `screencap <png>`), signed with the same `com.vmhub.agent`
  designated requirement. Its designated requirement verified:
  `designated => identifier "com.vmhub.agent"`.
- **Update freeze**: `softwareupdate --schedule off` is a no-op on this
  guest (daemon entitlement error — see deviations); the durable plist keys
  ARE set and persist in
  `/Library/Preferences/com.apple.SoftwareUpdate.plist`:
  `AutomaticDownload=0`, `AutomaticallyInstallMacOSUpdates=0`,
  `ConfigDataInstall=0`, `CriticalUpdateInstall=0`.
- **Power**: `pmset sleep 0 displaysleep 0 disablesleep 1` (persisted).
- **Auto-login**: verified already working (`autoLoginUser=vmhub`,
  `autoLoginUserLoggedIn=true`, `/etc/kcpassword` present, `who` shows a
  `console` session) — left untouched.
- **sshd**: `com.openssh.sshd => enabled` via launchctl, survives reboot
  (verified through the reboot performed during the bake).
- **Deterministic MAC** recorded: `52:54:00:c9:18:27`.

### NOT baked (blocked) — recorded per plan

- **TCC pre-grants (Accessibility / Screen Recording / AppleEvents): NOT
  applied.** The regrant script
  (`scripts/macos/vmhub-regrant-tcc.sh`, installed to
  `/usr/local/bin/vmhub-regrant-tcc.sh`) and the signed agent binary are
  ready; the grant insert requires SIP-rootless access to the user TCC db,
  which macOS blocks while SIP is on ("authorization denied" / "Operation
  not permitted" even as root). The plan is: set OpenCore NVRAM
  `csr-active-config=0x77` (SIP off), apply grants, restore SIP. The guest
  became unbootable before this could be executed.
- **qemu-ga**: skipped. macOS has no native virtio-serial driver;
  mav2287/qemu-guest-agent-for-macOS requires loading a kext (SIP /
  kext-signing risk on Sequoia) and the guest is unbootable. Not worth the
  risk; documented per plan.
- **Regrant script note**: validated through the identity-check + csreq
  stages on the live guest (the binary identity check passes for
  `com.vmhub.agent`); the sqlite insert requires SIP off (see above).
  `scripts/macos/vmhub-regrant-tcc.sh` is committed for the golden's
  regrant path.

### The blocker: the guest cannot be booted on this host right now

Two independent failures, both reproducible, both exhaustively tested:

**1. PVE QEMU 11.0.0 (the PVE wrapper's runtime) cannot boot this macOS.**
OpenCore loads from the imported ESP and hands off to Apple `boot.efi`,
which then executes a fail-trap spin: CPU pinned at one vCPU, zero serial
output, guest RIP frozen at a spin loop (`shl rdx,0x20; mov eax,eax;
or rax,rdx; cmp rax,r8; ja; pause; jmp` — a "return on check-pass else
hang" trap), never reaching the kernel. Ruled out by direct testing:
CPU line (`-cpu host` with/without the frozen `+invtsc,vmware-cpuid-freq`
flags), SMBIOS (Apple `iMacPro1,1`-style), machine type (`pve0` variant is
forced by PVE), PIT `lost_tick_policy`, Secure-Boot vs non-secure OVMF
(the `.secboot` and non-secure `OVMF_CODE_4M.fd` files are byte-identical),
vCPU count (1 and 4), OpenCore disk (freshly rebuilt from pristine EFI
sources), and RAM headroom (13 GiB free with VM 101 stopped). This
re-confirms the T4 probe finding ("PVE's QEMU 11.0.0 hangs…") and the
pinned `qemuVersion: 8.2.5`.

**2. The raw QEMU 8.2.5 probe path (the one working recipe) now has a
block-layer deadlock.** OVMF retries the OpenCore disk read (Boot0002)
three times, each attempt hanging ~2–3 min (main-loop spin, no `pread`
ever issued — confirmed by strace), then gives up. The same binary booted
this exact guest at probe time (2026-08-15 03:19); nothing changed by the
factory run restores it: removed the `nbd` kernel module, removed the VNC
password change (empty `$VNC_PASS` caused a separate main-loop spin), used
a pristine rebuilt OpenCore disk, pristine OVMF_VARS (md5-identical to
source), ruled out the OpenCore config content. The guest's own state is
not the cause (a fresh disk + firmware handoff to `boot.efi` under PVE
proves OpenCore + disk reads work under io_uring; the failure is
environmental).

### What was changed on the host (all reversible, all recorded)

- LV `probe-macos` renamed → `vm-2120-disk-0` (PVE volume naming; nothing
  references the old name).
- `dnsmasq` installed + configured for `vmbr1` DHCP
  (`/etc/dnsmasq.d/vmhub.conf`, range 10.10.10.50–200, router 10.10.10.1).
  This is the fleet's intended DHCP for cloned goldens (deterministic MAC
  → lease lookup) — left running deliberately.
- `gdb` installed (diagnostic only).
- VM 101 stopped temporarily for RAM headroom during testing, restarted
  afterward (`qm start 101`, status verified running).
- PVE `OVMF_CODE_4M.secboot.fd` temporarily swapped for the non-secure
  variant then restored (the two files are byte-identical; no net change).
- VM 2120 config kept as a plain VM (NOT templated — a template whose
  clones cannot boot would poison the catalog).

### Recovery path (next session)

1. Resolve the raw 8.2.5 block deadlock — prime suspect is host QEMU/KVM
   state accumulated over 45-day uptime; a host reboot (explicitly
   forbidden this run) or a reinstall of the source-built QEMU 8.2.5 is
   the likely fix.
2. Boot the guest under the proven 8.2.5 recipe, finish the bake:
   set OpenCore `csr-active-config=0x77` (SIP off), run
   `/usr/local/bin/vmhub-regrant-tcc.sh`, verify with
   `/usr/local/bin/vmhub-axprobe ax` + `screencap`, restore SIP, reboot,
   re-verify grants.
3. Only then `qm template 2120` + `qm clone` + boot-verify the clone.
   If PVE qemu 11 remains unable to boot macOS, the template's runtime
   must be the source-built 8.2.5 (documented PVE limitation on this
   host).

### Deviations from the frozen plan (all recorded)

1. **qemu-ga skipped** — no macOS virtio-serial driver; kext route is a
   SIP/signing risk and the guest is unbootable (recorded above).
2. **TCC grant deferred** — requires SIP-off write access; guest became
   unbootable first. Regrant tooling is committed and validated.
3. **softwareupdate --schedule off is a no-op on this guest build** — the
   daemon fails an entitlement check
   (`com.apple.private.softwareupdate.preferences` → "No such process");
   the durable plist keys are set instead and persist.
4. **OpenCore csr-active-config**: the base OpenCore.qcow2 ships
   `csr-active-config=0x0` (SIP on). The factory plan intended 0x77 for
   the regrant path; deferred with the TCC bake.
5. **PVE machine type**: `pc-q35-4.2` (frozen) does not exist in PVE's
   QEMU 11 (min supported q35 is 5.0); PVE also forces the `pve0`
   machine variant. Neither change produced a boot (see blocker #1).

### Follow-up: T10 boot-gate escalation (2026-08-16, after factory BLOCKED record)

Nine further boot attempts (8 recipes) all wedge at the identical 330-byte serial
point: `BdsDxe: starting Boot0002` then a guest TSC-deadline spin at RIP
`0x7d8ccfac` (rdtsc → combine → cmp deadline → pause → jmp), with the QEMU main
loop healthy (strace: ppoll cycling normally, one vCPU hammering KVM_RUN).

Attempted and ruled out:
- OpenCore source: original probe-time EFI tree (02:59) + config.plist (04:13),
  factory rebuild, raw vm-2120-disk-3, and preserved OpenCore.test.qcow2 (04:03)
  — all wedge identically (so NOT the OpenCore image).
- Disk source: original vm-2120-disk-0 AND the thin snapshot — dd reads both at
  2.2-3.5 GB/s (so NOT a block-device or thinpool issue; dmesg clean, pool 72%).
- aio: default, threads, unsafe-cache, io_uring (PVE) — wedge persists (so NOT
  the io_uring main-loop bug class; the strace shows ppoll healthy, no busy-spin).
- Chardevs: fresh monitor/serial sockets, -vnc none — wedge persists (so NOT a
  stale-socket/chardev spin).
- TSC frequency: forced tsc-frequency=2904000000 (measured host TSC 2904 MHz vs
  cpuinfo_max_freq 4300) — wedge persists.
- PVE/QEMU 11 documented PVE-9 Sequoia fix: `-cpu Haswell-noTSX,vendor=GenuineIntel,
  +invtsc,+hypervisor,kvm=on,vmware-cpuid-freq=on` + `ICH9-LPC.acpi-pci-hotplug-
  with-bridge-support=off` + `nec-usb-xhci.msi=off` via args (verified last -cpu
  wins in qm showcmd) — still 100% CPU spin, no guest SSH.

KEY OBSERVATION: guest TSC *does* advance (~2.9-3 GHz measured via register
sampling), yet the firmware deadline loop never exits — consistent with a wrong
TSC *frequency estimate* in the guest (CPUID 0x16 reports max 4.3 GHz; actual TSC
2904 MHz), which macOS boot.efi/OpenCore use for delay calibration. The probe
booted this exact disk at 03:19 under the identical 8.2.5 recipe; the host's
45-day uptime is the prime remaining suspect (factory agent's own conclusion:
"host QEMU/KVM state accumulated over 45-day uptime; a host reboot or reinstall
of source-built QEMU 8.2.5 is the likely fix").

NOT YET TRIED (all require user decision): host reboot (takes down VM 101 + PVE),
qemu 8.2.5 source rebuild, or converting the golden to a raw-8.2.5-process runtime
outside PVE (the probe model that worked).

### Follow-up 2: host reboot executed — does NOT clear the boot wedge (2026-08-16)

Per user approval, the Vostro host was rebooted (45-day uptime cleared, fresh KVM
state, VM101 onboot=1 preserved postgres, VM102 stays evicted, vmbr1 re-persisted
via provision-vostro.sh after reboot exposed it was never written to
/etc/network/interfaces).

RESULT: the macOS golden STILL does not boot. Decisive negatives recorded:

- Raw 8.2.5 path (the probe's proven recipe): after reboot, the block-layer
  deadlock (FAILURE 2, "no pread ever issued") is GONE — OVMF now gets past
  "BdsDxe: starting Boot0002". But the guest vCPU still enters the identical
  TSC-delay spin (thread-level 99.9%, RIP 0x7c509fef; pre-reboot RIP was
  0x7d8ccfac — same instruction pattern `shl rdx,0x20; or rax,rdx; cmp rcx,r12;
  jae; pause; jmp`).
- PVE/QEMU 11 + `-cpu host` + explicit `tsc-frequency=2904000000` (measured host
  TSC): still spins at the same RIP. The documented PVE-9 Haswell-noTSX recipe
  was already ruled out pre-reboot.
- CONFIRMED INDEPENDENT OF: host uptime (reboot cleared it), QEMU version
  (8.2.5 and 11.0.0), OpenCore image (4 variants), disk source (original + snap),
  aio backend, chardevs, and explicit tsc-frequency.

CONCLUSION: the wedge is a guest-side TSC-frequency contract failure that this
host's CPUID surface cannot satisfy for macOS — the guest reads a TSC frequency
estimate that makes its delay deadlines unreachable (deadline keeps re-adding
current TSC; initial deadline value is wrong). This is consistent with the
documented macOS-on-QEMU class where macOS's TSC calibration diverges from the
host's actual TSC rate (measured 2904 MHz vs CPUID 0x16 max 4300 MHz).

REMAINING OPTIONS (require user decision): (a) run the golden as a raw 8.2.5
process outside PVE using the probe's exact recipe with a patched/verified TSC
presentation (e.g. cpuid 0x16 override via OpenCore config — OpenCore can fix
TSC frequency in its config.plist), (b) modify the guest's OpenCore config.plist
to set the correct TSC frequency / disable TSC-based delay calibration, (c) a
different macOS version known to boot on this CPUID surface. The golden disk is
intact + snapshotted; VM 2120 reverted to factory state (stopped).
