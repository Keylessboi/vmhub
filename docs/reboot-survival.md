# vmhub — reboot survival contract

Everything in vmhub must come back after a reboot without a human in the loop.
This is not a nice-to-have: the reaper exists precisely because processes die
unexpectedly, and a reboot is the largest process death of all.

## What must survive a reboot

| Component | Survives reboot? | Mechanism |
|---|---|---|
| `vmhub-lite` (control plane) | yes | `vmhub-lite.service`, `Restart=always`, `WantedBy=multi-user.target` |
| `vmhub-reaper` (independent) | yes | `vmhub-reaper.service` (oneshot) + `vmhub-reaper.timer` `OnBootSec=1min` |
| Lease database | yes | `leases.sqlite` on disk under `/srv/vmhub/leases` — never in-memory |
| Staged artifacts | yes | `/srv/vmhub/artifacts` on disk |
| MCP server | yes | compiled binary `dist/vmhub-mcp`; opencode config points at it |
| iLO access | n/a | BMC is always-on; vmhub re-authenticates per session |

## The critical property: reaper independence

`vmhub-reaper.service` deliberately has **no `After=` dependency on
`vmhub-lite.service`**. The reaper reads the same `leases.sqlite` and talks to
Proxmox directly. If lite is dead, the reaper still destroys expired leases.
This is the whole point of the split.

The timer fires 60 seconds after boot (`OnBootSec=1min`). Any lease that was
mid-life during the reboot is re-evaluated within a minute. A VM whose lease
expired while the machine was down is destroyed before the day starts.

## What the install guarantees

`deploy/install.sh` (run as root) installs:

- binaries → `/usr/local/bin/`
- units → `/etc/systemd/system/`
- env files → `/etc/vmhub/*.env` (root-owned `0600`, never world-readable)
- data dirs → `/srv/vmhub/{leases,artifacts}`
- enables + starts lite and the reaper timer, and runs one sweep immediately

It is idempotent and never overwrites existing env files (secrets survive
re-deploys).

## Manual verify after any reboot

```bash
systemctl is-active vmhub-lite.service        # expect: active
systemctl list-timers vmhub-reaper.timer      # expect: next run within 1h
systemctl start vmhub-reaper.service && echo $?   # manual sweep, expect 0
journalctl -u vmhub-reaper.service -n 20      # last sweep output
```

## Reboot vs. the mock stage

During the mock stage (no Proxmox server yet), lite runs with empty
`PVE_*` env and uses `MockProxmox`. The same systemd units apply — nothing
about the reboot contract changes when the real server arrives; only the env
files gain credentials.

## Design notes

- `Persistent=false` on the timer: we do not want a backlog of missed sweeps
  after long downtime; one fresh sweep is correct.
- `RandomizedDelaySec=5min`: avoids stampedes if several hosts reboot together.
- `ProtectSystem=strict` + `ReadWritePaths=/srv/vmhub`: the reaper can delete
  lease files and staged artifacts but nothing else on the system.
- Binaries are compiled with `bun build --compile` (single-file executables):
  no node_modules on the host, no interpreter drift across reboots.
