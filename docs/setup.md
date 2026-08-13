# vmhub — current state and setup notes

## What exists today

The server is an HP ProLiant DL360p Gen8 (`192.168.1.220`), running Proxmox
VE 9.2.2. The iLO is reachable at `https://192.168.1.216` (account `ops`).
The OS runs from a 119.5G USB flash drive in the default LVM-thin layout.
The P420i RAID controller has no physical drives — a data drive must be
installed before VM storage exists (see `docs/storage-fde.md`).

The vmhub software is complete and tested. It lives in this repository,
`github.com/Keylessboi/vmhub`. It gives AI agents one interface for creating
and driving VMs. The agent never touches Proxmox. It sees a VM it created,
viewed remotely, and destroys when done.

## The state of the server

- **Installed**: Proxmox VE 9.2.2 on the flash drive, hostname `vmhub.lan`,
  static `192.168.1.220`. WebUI: `https://192.168.1.220:8006`.
- **RAM**: 125 GB visible (reseat fixed the earlier 96GB/207 errors). Verify
  the POST shows 128 GB if the beep returns.
- **Storage**: no internal disk. The P420i bays are empty. Install a drive
  and create a RAID-0 logical volume before building the VM-data pool.
- **Hardening applied**: sshd key-only (no passwords), pve-firewall allowlist
  (SSH + webUI from `192.168.1.0/24`), unattended-upgrades, no-subscription
  PVE repo. See `docs/RUNBOOK.md` §6.

## How to boot the installer (recovery path)

We mounted the Proxmox VE 9.2 ISO and the answer file as virtual media on
the iLO. To reinstall (for example, for LVM+LUKS full-disk encryption):

- Start the ISO server: `node scripts/iso-server.mjs bootstrap 8010`
- Allow port 8010 from the LAN: `sudo ufw allow 8010/tcp`
- The desktop must be reachable at `192.168.1.164` from the iLO.
- Mount the ISO as virtual media, reboot the host, and drive the installer
  manually (the answer file's unattended path was not reliable; see the field
  guide).

The answer file `bootstrap/proxmox-answers.dat` configures: hostname
`vmhub.lan`, network from DHCP, root password from `PVE_ROOT_PW` in `~/.env`.

After install, `bootstrap/post-install.sh` must run on the host. It:
- creates the `vmbr1` NAT bridge for test VMs
- creates an encrypted ZFS pool on the largest non-root, non-removable disk
  (aes-256-gcm, keyfile at `/etc/zfs/keys/vmhub.key`, auto-loaded at boot)
- creates the scoped `vmhub@pve` API token

## The design, in brief

Three parts, one contract.

- `src/mcp/` — the unified MCP server. Twenty-two `vm_*` tools. The only
  interface agents see.
- `src/lite/` — the control plane. Eight REST endpoints, SQLite state,
  Proxmox client (mock until the server exists).
- `src/reaper/` — the independent lease reaper. Destroys expired VMs by
  identity tag, never by VMID. Runs even when the control plane is dead.

All three import the capability contract from `src/shared/types.ts`. That
file is the single source of truth for what a VM can do.

Security: one scoped Proxmox token in `.env`. Per-lease secrets, destroyed at
teardown. No secrets in goldens. The control plane binds localhost.

Reboot survival: systemd units in `deploy/systemd/`. Lite restarts on boot,
the reaper sweeps 60 seconds after boot. `deploy/install.sh` installs all of
it.

## Docs

- `docs/architecture.md` — how the three parts fit
- `docs/storage-fde.md` — why ZFS, not btrfs; how encryption works
- `docs/reboot-survival.md` — the reboot contract
- `docs/probe.md` — iLO findings and the auth story
- `docs/gates.md` — the open questions that gate Phase 3
- `skills/vm-operator/` — how agents use the 22 tools

## The one open gate

Phase 3 (real Proxmox integration) is blocked on the data drive. The server
runs, but the P420i has no physical drives. Install a drive, create a RAID-0
logical volume, run `post-install.sh` to build the encrypted pool, then the
rest is scripted.
