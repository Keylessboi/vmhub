# vmhub — current state and setup notes

## What exists today

The server is an HP ProLiant DL360p Gen8, currently powered off. The iLO is
reachable at `https://192.168.1.216` (account `ops`). The box has not yet been
installed with Proxmox.

The vmhub software is complete and tested. It lives in this repository,
`github.com/Keylessboi/vmhub`. It gives AI agents one interface for creating
and driving VMs. The agent never touches Proxmox. It sees a VM it created,
viewed remotely, and destroys when done.

## The state of the server

The board powers on and POSTs, but two things are wrong:

1. **Memory init errors on both CPUs** (`207-Memory initialization error on
   Processor 1/2 Socket 4`). Some DIMM slots on those banks do not initialize.
   The server still boots past them, but may not have access to all 128 GB.
   Reseat the DIMMs on Socket 4 of both processors before relying on full RAM.

2. **A 2021 IML record of a Smart Array controller failure in Slot 0**
   (`1719-A Drive Array Controller Failure`). A failed controller can halt
   POST or make the disks unavailable. If the installer cannot see disks,
   the controller is the reason. It may need reseating, HBA mode, or
   replacement.

The server beeps during POST because of these errors. To stop the beep:
enter RBSU (F9 at POST), find the POST-error beep setting, disable it.

## How to boot the installer

The Proxmox VE 9.2 ISO and the answer file are mounted as virtual media on
the iLO. When the server powers on, it should boot the ISO and install
unattended.

Requirements on the desktop side:

- The ISO server must run: `node scripts/iso-server.mjs bootstrap 8010`
- The firewall must allow port 8010 from the LAN:
  `sudo ufw allow 8010/tcp`
- The desktop must be reachable at `192.168.1.164` from the iLO.

The install is driven by `bootstrap/proxmox-answers.dat`:
- ZFS rpool, `compress=lz4`, `checksum=sha256`
- Hostname `vmhub.lan`, network from DHCP
- Root password from `PVE_ROOT_PW` in `~/.env`

After install, `bootstrap/post-install.sh` must run on the host. It:
- creates the `vmbr1` NAT bridge for test VMs
- creates an encrypted `rpool/vmhub` dataset (aes-256-gcm) with a server-side
  keyfile at `/etc/zfs/keys/vmhub.key`, auto-loaded at boot
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

Phase 3 (real Proxmox integration) is blocked on the server install. The
install is blocked on the two hardware issues above. Fix the memory errors
and the controller, and the rest is scripted.
