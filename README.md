# vmhub

A unified MCP server for driving VMs. An AI agent uses it to create a VM, see its screen, click and type, move files, and clone repos. The agent does not need to know what runs inside the VM. It sees one interface: a VM it created, viewed remotely.

## What it is

One server. Many OS adapters. The server presents 22 `vm_*` tools. Each tool works the same way no matter what runs inside the VM: Hyprland, X11, Windows, macOS, or Android.

The server hides the machinery. The agent never touches Proxmox, never writes SSH config, never learns the difference between a Wayland compositor and a Windows desktop. It asks for a VM, waits for it to be ready, looks at the screen, acts, and releases the lease.

## The tool surface

| Tool | Purpose |
|---|---|
| `vm_list_templates` | What VMs can I create, and what can each one do? |
| `vm_capabilities` | What can this specific VM do? |
| `vm_health` | Is the server and its adapters alive? |
| `vm_lease_create` | Create a VM from a template. Returns immediately. |
| `vm_lease_status` | Poll readiness. Bounded wait. |
| `vm_lease_renew` | Push the expiry forward. |
| `vm_lease_release` | Tear down the VM and its secrets. |
| `vm_screenshot` | See the screen. Returns an image plus coordinates. |
| `vm_inspect` | Read the semantic element tree (for text-only models). |
| `vm_list_windows` | List open windows. |
| `vm_click` / `vm_type` / `vm_key` / `vm_paste` / `vm_drag` | Drive input. |
| `vm_launch` / `vm_focus` / `vm_close` | Manage apps and windows. |
| `vm_dispatch` | Validated escape hatch per adapter. |
| `vm_put_file` / `vm_get_file` | Move files in and out. |
| `vm_clone_repo` | Clone a repository into the VM. |

## How the capability matrix works

Each adapter declares what it can do. The server reads that declaration and answers two questions:

- Before creation: `vm_list_templates` shows each template's capabilities and availability.
- At runtime: `vm_capabilities` shows what the live VM can do.

A tool is never missing. If an adapter cannot serve a tool, the tool returns a typed `CAPABILITY_UNAVAILABLE` error. A stub adapter is visible as a stub, with a reason. Nothing is hidden.

## The parts

- `src/mcp/` — the unified MCP server. The only interface agents see.
- `src/lite/` — the control plane. Eight REST endpoints, SQLite state, Proxmox client.
- `src/reaper/` — the independent lease reaper. It runs on its own timer, reads its own database, and destroys expired VMs by identity tag. It does not depend on the control plane being alive. That independence is the point: VMs die even when the server that made them is dead.
- `adapters/` — one module per OS family. Each implements the same `DesktopAdapter` contract.
- `src/shared/` — the capability contract. All parts import from here.

## Security model

- One runtime credential: a scoped Proxmox API token in `.env`. Never the root password. Never in git.
- Per-lease secrets: SSH keys and GitHub tokens are created for one VM, injected at clone time, and destroyed at teardown. They never live in golden images.
- Identity-verified teardown: the reaper matches the Proxmox tag `vmhub-<prefix>-<uuid>`. It never trusts a VMID.
- No secrets in goldens. No public ports. The control plane binds localhost in v1.

## Build and test

```sh
bun install
bun test          # 76 tests
bun run typecheck
bun run build     # compiles dist/vmhub-mcp
bun run build:lite
bun run build:reaper
```

## Run

Start the control plane, then point an MCP client at the compiled server:

```sh
dist/vmhub-lite          # http://127.0.0.1:8787
dist/vmhub-mcp           # stdio MCP server
```

Wire into opencode:

```jsonc
"mcp": {
  "vmhub": {
    "type": "local",
    "command": ["/home/travis/Projects/vmhub/dist/vmhub-mcp"],
    "environment": {
      "VMHUB_LITE_URL": "http://127.0.0.1:8787",
      "VMHUB_SCREENSHOT_DIR": "/home/travis/Pictures/vmhub",
      "CURSORTOUCH_AUTH_KEY": "set-me" // from Doppler (proxmox/prd); windows adapter auth
    },
    "timeout": 30000
  }
}
```

## Status

Phase 1–2 complete: shared contract, control plane (mock Proxmox), reaper with kill-test, and the unified MCP with a live Hyprland adapter. Phase 3 (real Proxmox, CursorTouch in-VM adapters, Android ADB, GitHub App tokens) is the server-integration milestone.

## Docs

- `docs/architecture.md`
- `docs/security.md`
- `docs/adapters.md`
- `docs/setup.md`

## License

MIT
