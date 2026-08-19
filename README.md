# vmhub

A unified MCP server for driving VMs. An AI agent uses it to create a VM, see its screen, click and type, move files, and clone repos. The agent does not need to know what runs inside the VM. It sees one interface: a VM it created, viewed remotely.

## What it is

One server. Many OS adapters. The server presents 22 `vm_*` tools. Each tool works the same way no matter what runs inside the VM: Hyprland, X11, Windows, macOS, or Android.

The server hides the machinery. The agent never touches Proxmox, never writes SSH config, never learns the difference between a Wayland compositor and a Windows desktop. It asks for a VM, waits for it to be ready, looks at the screen, acts, and releases the lease.

## Glossary

| Term | Meaning |
|---|---|
| **Adapter** | A module that translates `vm_*` tool calls into OS-specific actions (clicking, typing, screenshots). One adapter per OS family: Hyprland, X11, Windows, macOS, Android. |
| **Golden image** | A pre-built VM template in Proxmox. vmhub clones golden images to create working VMs. The agent never builds VMs from scratch. |
| **Stub** | An adapter that declares zero capabilities. It exists so the tool surface stays complete: every tool is present, but a stub returns `CAPABILITY_UNAVAILABLE` for tools it cannot serve. |
| **Lease** | A time-limited claim on a VM. Created by the agent, destroyed by the reaper when it expires or the agent releases it. |
| **Reaper** | The independent process that destroys expired leases and their VMs. It reads the database directly and works even when the control plane is down. |
| **Control plane (lite)** | The REST server that manages leases, templates, and VM state. Binds localhost in v1. |
| **MCP server** | The stdio server that agents talk to. It exposes the 22 `vm_*` tools and delegates to adapters and the control plane. |
| **Proxmox API token** | A scoped credential for the Proxmox REST API. vmhub uses tokens, never root passwords. |
| **CursorTouch** | An in-VM MCP server for Windows. The Windows adapter talks to it over HTTP to control the Windows desktop. |
| **Identity tag** | A Proxmox tag in the format `vmhub-<prefix>-<uuid>`. Used for identity-verified teardown. |

## Quickstart

Five steps from zero to a running vmhub.

### 1. Install dependencies

```sh
# Bun (JavaScript runtime)
curl -fsSL https://bun.sh/install | bash

# Doppler (secrets manager) — required for deploy/install.sh
curl -fsSL https://get.doppler.com | sh
doppler login
```

### 2. Clone and build

```sh
git clone https://github.com/Keylessboi/vmhub.git
cd vmhub
bun install
bun run build        # compiles dist/vmhub-mcp
bun run build:lite   # compiles dist/vmhub-lite
bun run build:reaper # compiles dist/vmhub-reaper
```

### 3. Configure environment

Copy the example env and fill in values:

```sh
cp .env.example .env
# Edit .env with your Proxmox host, token, etc.
```

**Critical**: `PVE_HOST` must include the port. Proxmox listens on 8006, not 443.

```
PVE_HOST=192.168.1.220:8006
```

For single-node setups, set three variables: `PVE_HOST`, `PVE_TOKEN_ID`, and `PVE_TOKEN`. Leave the `VMHUB_NODE_*` variables blank.

### 4. Start the servers

```sh
# Start the control plane (REST API, SQLite)
dist/vmhub-lite &

# Start the MCP server (stdio, talks to lite)
dist/vmhub-mcp
```

### 5. Wire into opencode

Add the vmhub MCP entry to your `opencode.json`. The file lives in your project root or `~/.config/opencode/`.

```jsonc
{
  "mcp": {
    "vmhub": {
      "type": "local",
      "command": ["/path/to/vmhub/dist/vmhub-mcp"],
      "environment": {
        "VMHUB_LITE_URL": "http://127.0.0.1:8787",
        "VMHUB_SCREENSHOT_DIR": "/home/you/Pictures/vmhub",
        "CURSORTOUCH_AUTH_KEY": "your-key-here"
      },
      "timeout": 30000
    }
  }
}
```

**Environment variables**:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VMHUB_LITE_URL` | Yes | `http://127.0.0.1:8787` | Where the MCP server finds lite |
| `VMHUB_SCREENSHOT_DIR` | No | `~/Pictures/vmhub` | Where screenshots are saved |
| `CURSORTOUCH_AUTH_KEY` | For Windows VMs | (empty) | Auth key for the in-VM CursorTouch server |

**Verify it works**:

Ask your agent to call `vm_list_templates`. If templates appear with capabilities, the connection is live.

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

- **One runtime credential**: a scoped Proxmox API token in `.env`. Never the root password. Never in git.
- **Per-lease secrets**: SSH keys and GitHub tokens are created for one VM, injected at clone time, and destroyed at teardown. They never live in golden images.
- **Identity-verified teardown**: the reaper matches the Proxmox tag `vmhub-<prefix>-<uuid>`. It never trusts a VMID.
- **No secrets in goldens. No public ports.** The control plane binds localhost in v1.

### Credential paths

vmhub supports two credential layouts for backward compatibility:

**Single-node** (most users): set three variables.

| Variable | Purpose |
|---|---|
| `PVE_HOST` | Proxmox host with port, e.g. `192.168.1.220:8006` |
| `PVE_TOKEN_ID` | Token ID, e.g. `vmhub@pve!automation` |
| `PVE_TOKEN` | Token secret value |

**Multi-node** (multiple Proxmox hosts): set `VMHUB_NODES` plus per-node variables.

| Variable | Purpose |
|---|---|
| `VMHUB_NODES` | Comma-separated node IDs, e.g. `DL360P,DL380G9` |
| `VMHUB_NODE_<ID>_BASE_URL` | Per-node host:port |
| `VMHUB_NODE_<ID>_TOKEN` | Per-node API token |

**Precedence**: per-node tokens win over `PVE_TOKEN` for their node. `PVE_TOKEN` serves as fallback for the default node. See `docs/setup.md` for details.

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

Wire into opencode (see Quickstart above for full setup):

```jsonc
{
  "mcp": {
    "vmhub": {
      "type": "local",
      "command": ["/path/to/vmhub/dist/vmhub-mcp"],
      "environment": {
        "VMHUB_LITE_URL": "http://127.0.0.1:8787",
        "VMHUB_SCREENSHOT_DIR": "/home/you/Pictures/vmhub",
        "CURSORTOUCH_AUTH_KEY": "your-key"
      },
      "timeout": 30000
    }
  }
}
```

**`CURSORTOUCH_AUTH_KEY`**: Required only for Windows VMs. This key authenticates the Windows adapter to the in-VM CursorTouch MCP server. Without it, Windows templates return a `CAPABILITY_UNAVAILABLE` error. For local setups, generate a random string and configure the same value inside the Windows golden image. For production, use a secrets manager (Doppler, Vault, etc.). See the glossary for details.

## Status

Phase 1–2 complete: shared contract, control plane (mock Proxmox), reaper with kill-test, and the unified MCP with a live Hyprland adapter. Phase 3 (real Proxmox, CursorTouch in-VM adapters, Android ADB, GitHub App tokens) is the server-integration milestone.

## Docs

- `docs/architecture.md`
- `docs/security.md`
- `docs/adapters.md`
- `docs/setup.md`

## License

MIT
