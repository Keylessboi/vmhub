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
- android-x86: /tmp/android-x86.iso (510M) — ADB-over-network
- x11 golden: computer-use-linux in-VM MCP
