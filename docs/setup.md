# vmhub — current state and setup notes

> **New to vmhub?** Start with the [Quickstart](../README.md#quickstart) in
> the README. This document covers server-specific details and advanced config.

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

## Credential configuration

Two credential paths exist for backward compatibility.

### Single-node setup (most users)

Set three variables. Leave `VMHUB_NODE_*` blank.

| Variable | Required | Example |
|---|---|---|
| `PVE_HOST` | Yes | `192.168.1.220:8006` |
| `PVE_TOKEN_ID` | Yes | `vmhub@pve!automation` |
| `PVE_TOKEN` | Yes | (token secret from Proxmox) |

**Port required**: `PVE_HOST` must include `:8006`. Proxmox does not listen
on 443. Without the port, connections fail silently with a cryptic error.

### Multi-node setup

Set `VMHUB_NODES` to a comma-separated list of node IDs, then provide
per-node variables for each:

| Variable | Purpose |
|---|---|
| `VMHUB_NODES` | Comma-separated node IDs, e.g. `DL360P,DL380G9` |
| `VMHUB_NODE_<ID>_BASE_URL` | Per-node host:port |
| `VMHUB_NODE_<ID>_TOKEN` | Per-node API token |

**Precedence**: per-node tokens win over `PVE_TOKEN` for their node.
`PVE_TOKEN` serves as fallback for the default node. If both `PVE_TOKEN`
and a per-node token are set, the per-node token takes priority.

### CursorTouch auth (Windows VMs only)

`CURSORTOUCH_AUTH_KEY` authenticates the Windows adapter to the in-VM
CursorTouch MCP server. Required for Windows templates. For local setups,
generate a random string and configure the same value inside the golden
image. See `.env.example` for details.

See `.env.example` for the full variable list with required/optional markers.

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
