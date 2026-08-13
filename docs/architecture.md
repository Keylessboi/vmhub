# vmhub — architecture

## What this is

vmhub gives AI agents one interface for creating and driving VMs. The agent
sees a VM it created, viewed remotely. It never touches Proxmox, SSH config,
or the OS inside the VM. One MCP server, 22 tools, many OS adapters.

## The three parts

```
Agent (opencode)                 Host (desktop now, Proxmox host later)
┌──────────────────────┐         ┌──────────────────────────────────────┐
│ vmhub-mcp (stdio)    │         │ vmhub-lite (REST, SQLite)            │
│  └─ 22 vm_* tools    │◄─HTTP──►│   └─ ProxmoxClient (mock now, real later)
│  └─ adapters/        │         │ vmhub-reaper (independent, timer)    │
│     hyprland, x11,   │         │   └─ reads leases.sqlite directly    │
│     windows, macos,  │         │                                      │
│     android, ios     │         │ goldens/ leases/ artifacts/          │
└──────────────────────┘         └──────────────────────────────────────┘
```

### vmhub-mcp — the interface agents see

One stdio MCP server. It exposes 22 `vm_*` tools. Each tool is OS-agnostic:
the same `vm_screenshot` / `vm_click` / `vm_type` work whether the VM runs
Hyprland, Windows, or Android.

The server is a thin shell. Real work goes to the adapters and to
vmhub-lite. It never shells out to control a desktop.

### The adapters — one per OS family

Each adapter implements the `DesktopAdapter` contract from
`src/shared/types.ts` and declares its capabilities. The capability matrix is
the single machine-readable contract: `vm_list_templates` reports it before
creation, `vm_capabilities` reports it at runtime.

- **hyprland** — spawns the compiled hyprland-mcp binary as an MCP client and
  maps its tools into `vm_*` tools (verified exports, capability mapping table).
- **x11** — own driver (xdotool / import / xwininfo).
- **windows / macos** — connect to in-VM servers (CursorTouch pattern; wrap,
  never reimplement).
- **android** — host-side ADB (input / screencap / uiautomator).
- **ios** — honest stub, `capabilities: []`, with a reason.

A tool is never absent. An adapter that cannot serve a tool returns a typed
`CAPABILITY_UNAVAILABLE` error. Stubs are visible as stubs.

### vmhub-lite — the control plane

Eight REST endpoints over SQLite:

```
POST   /v1/leases              create (idempotent via request_id)
GET    /v1/leases/{id}         status
POST   /v1/leases/{id}/renew   extend
DELETE /v1/leases/{id}         release
GET    /v1/templates           catalog (availability + capabilities)
GET    /v1/vms                 all VMs
POST   /v1/artifacts           register a staged artifact
GET    /v1/artifacts/{id}      fetch artifact metadata
```

Guarantees:

- **Idempotency** — the same `request_id` returns the same lease. Agent
  retries are safe.
- **Disk-full refusal** — at 15% free it refuses destructive work.
- **Typed errors** — every failure is `{code, message, retryable, hint, detail}`.
- **Mock-first** — `MockProxmox` until the real server exists.

### vmhub-reaper — the independent lease reaper

A one-shot binary on a systemd timer. Every hour (and 60s after boot) it:

1. Reads `leases.sqlite` directly — not through vmhub-lite.
2. Finds expired leases (past `expiresAt` or the 24h hard cap).
3. Destroys each VM **by identity**: the Proxmox tag
   `vmhub-<prefix>-<uuid>` + name prefix. Never an agent-supplied VMID.
4. Deletes staged artifacts and the lease's scratch dir.
5. Clears the DB rows.

**The independence is the point.** The reaper works when vmhub-lite is dead.
It does not depend on the control plane being alive. Its unit has no
`After=` on lite's unit.

Draining: if a `vm_get_file` is in flight (artifact `inFlight=true`), the
reaper waits up to a hard timeout before destroying.

## The contract that holds it together

`src/shared/types.ts` is the single source of truth. It defines:

- `Capability` — the matrix (per-adapter).
- `DesktopAdapter` — the interface every adapter implements.
- `Vm`, `Lease`, `ReadinessReport` — the state shapes.
- `VmError` — the typed error contract.
- `Template` — the pre-create catalog.
- `ScreenshotResult` — pixels + coordinate mapping (the screen model).

Nothing outside `src/shared` defines a capability or error code. This is what
keeps three separate parts (mcp, lite, reaper) from drifting.

## Security model

- **One runtime credential** — a scoped Proxmox API token in `.env`. Never
  root password, never in git.
- **Per-lease secrets** — SSH keys and GitHub tokens per VM, injected at
  clone, destroyed at teardown. Never in goldens.
- **Identity-verified teardown** — tags, never VMIDs.
- **Control plane binds localhost** in v1. Auth ships with the second host.

## Reboot survival

All three binaries are systemd units. Lite restarts on boot. The reaper
sweeps 60s after boot. Lease state and artifacts are on disk. See
`docs/reboot-survival.md`.

## Status

Phases 1–2 complete and verified: contract, control plane, reaper with
kill-test, unified MCP with live hyprland adapter, 82 tests green, E2E lease
lifecycle + reaper sweep verified against the live stack.

Phase 3 (real Proxmox, in-VM adapters, GitHub App tokens) is the
server-integration milestone, gated on the Phase-0 hardware check.
