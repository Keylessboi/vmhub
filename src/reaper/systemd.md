# vmhub-reaper — systemd install

The reaper is an independent lease reaper. It reads `leases.sqlite` directly
and talks to the Proxmox API directly (never through vmhub-lite) — so it keeps
working even if the lite service is down. It is safe to run every hour.

## Files

Two unit files. Install them as root:

```bash
sudo cp src/reaper/systemd/vmhub-reaper.service /etc/systemd/system/
sudo cp src/reaper/systemd/vmhub-reaper.timer    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vmhub-reaper.timer
```

## vmhub-reaper.service

```ini
[Unit]
Description=vmhub lease reaper — destroys expired VM leases (identity-verified)
# Reaping must never race the provisioning path. It reads the same SQLite DB
# and talks to Proxmox directly, but it never creates anything, so a plain
# After= is enough. Start after networking + storage are up.
After=network-online.target
Wants=network-online.target

[Service]
# One-shot: the timer fires it hourly, each run is a full sweep.
Type=oneshot
# The reaper must outlive a hung VM destroy. Its own per-lease operations
# have internal hard timeouts; this is the outer bound for the whole sweep.
TimeoutStartSec=30min

# --- environment ---
# All paths below are examples; point them at the real install.
# DB resolution order: VMHUB_DB, then <VMHUB_LEASE_DIR>/leases.sqlite, then
# ./leases/leases.sqlite (must be the SAME file vmhub-lite writes).
Environment=VMHUB_DB=/srv/vmhub/leases/leases.sqlite
Environment=VMHUB_LEASE_DIR=/srv/vmhub/leases
Environment=VMHUB_ARTIFACT_DIR=/srv/vmhub/artifacts
# The reaper refuses to tear down when the host has less than this % free,
# because it cannot safely update its bookkeeping on a full disk.
Environment=VMHUB_DISK_FULL_REFUSAL_PCT=15

# --- Proxmox credentials (scoped API token, NOT root password) ---
# Prefer a systemd credential or EnvironmentFile owned by root:root 0600.
EnvironmentFile=-/etc/vmhub/reaper.env

# Never write to the network home; keep the runtime dir local.
WorkingDirectory=/srv/vmhub
User=vmhub
Group=vmhub

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
# DB + scratch dirs must stay writable (reaper deletes lease files there).
ReadWritePaths=/srv/vmhub
ProtectHome=true
PrivateTmp=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
```

## vmhub-reaper.timer

```ini
[Unit]
Description=Run vmhub-reaper hourly

[Timer]
# First run 1 minute after boot, then every hour.
OnBootSec=1min
OnUnitActiveSec=1h
# Do not catch up a backlog of missed runs after a long downtime.
Persistent=false
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
```

## Operations

```bash
systemctl list-timers vmhub-reaper.timer     # next run?
systemctl start vmhub-reaper.service         # run a sweep now
journalctl -u vmhub-reaper.service -f        # watch a sweep
systemctl status vmhub-reaper.service        # last exit + output
```

## Guardrails (enforced in code, mirrored here)

| Guard | Enforced by |
| --- | --- |
| VM destroyed by tag `vmhub-<prefix>-<uuid>` + name prefix, never agent-supplied VMID | `src/reaper/index.ts` identity match |
| DRAINING: no destroy while an artifact has `in_flight=1` (vm_get_file transfer) | sweep skips lease, hard timeout per lease |
| 24 h hard cap on lease lifetime | `sweep()` destroys leases past `expires_at` / `max_lifetime_ms` |
| 15 % disk-full refusal | sweep aborts before destroy when free < `VMHUB_DISK_FULL_REFUSAL_PCT` |
| Deletes lease files + staged artifacts after VM destroy | `index.ts` removes scratch dir, artifact files, then clears DB rows |

## Security note

`reaper.env` (or systemd credentials) holds `PVE_TOKEN`. Use a **scoped** Proxmox
token with destroy-only privileges on `/vms` — the reaper should never be able
to create or clone, only read + stop + destroy. Keep the file `root:vmhub 0640`.
