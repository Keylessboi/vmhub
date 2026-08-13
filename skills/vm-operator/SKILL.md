# vm-operator

Operate VMs through the vmhub MCP server. A VM is a machine you created,
viewed remotely, and will destroy when done. You never need to know what
runs inside it.

## When to use

Use this skill when a task needs:

- A clean environment for testing
- A desktop you can see, click, and type into
- A place to run code without touching the local machine
- A disposable machine with its own files and repos

## The mental model

A VM has three states in your workflow:

1. **Create** — pick a template, request a lease.
2. **Use** — look at its screen, act, move files.
3. **Release** — destroy it. This is mandatory, not optional.

Every VM you create has a lease with a hard expiry. If you do not release it,
the reaper destroys it for you. Release it yourself — it is cleaner and
faster.

## The workflow

### 1. See what you can create

Call `vm_list_templates`. It returns every template with its availability and
capabilities. A template marked `stub` or `unavailable` has a reason — read it.
Do not assume a stub will work.

### 2. Create a VM

Call `vm_lease_create` with:

- `template_id` — from the template list
- `ttl_ms` — how long you need it (keep it short)
- `owner` — who you are
- `request_id` — an idempotency key. If you retry with the same value, you get
  the same VM. Use a unique value per VM.

The call returns immediately with a VM id. It does not block.

### 3. Wait for it to be ready

Call `vm_lease_status` with the VM id and `wait_ms` (max 20000). It polls in
chunks. A ready VM has its guest agent up, network up, and tools verified.

If it times out, call again. If it keeps timing out, check `vm_health`.

### 4. Use the VM

**See the screen** — `vm_screenshot`. It returns an image plus a coordinate
mapping. If you are a text-only model, hand the returned file path to the
vision skill. Never guess what a screenshot shows.

**Read the UI** — `vm_inspect` returns a semantic element tree. Use it when
you need labels and structure instead of pixels.

**Act** — `vm_click` (pixel coordinates), `vm_type` (text), `vm_key` (chords),
`vm_drag`. Coordinates come from the screenshot mapping.

**Manage apps** — `vm_list_windows`, `vm_launch`, `vm_focus`, `vm_close`.

**Move files** — `vm_put_file` to send a file in, `vm_get_file` to pull one
out. Pull artifacts out BEFORE releasing the VM.

**Clone a repo** — `vm_clone_repo` with a repo URL and destination.

**Run commands** — `vm_exec` runs a command inside the VM.

### 5. Release the VM

Call `vm_lease_release` with the VM id. Always do this when done, even after
failures. If you cannot, the reaper will — but you should not rely on that.

## Capabilities

Each VM has capabilities. A capability tells you what the VM can do:

- `screenshot` — see the screen
- `inspect` — semantic element tree
- `click` / `type` / `key` / `paste` / `drag` — input
- `launch` / `focus` / `close` / `list_windows` — window control
- `put_file` / `get_file` / `clone_repo` — files and repos
- `exec` — run commands

A tool is never missing. If the VM cannot do something, the tool returns a
typed `CAPABILITY_UNAVAILABLE` error. That is not a bug — use a different
template or work around it.

## Error handling

vmhub errors are typed: `{code, message, retryable, hint, detail}`.

| code | meaning | action |
|---|---|---|
| `CAPABILITY_UNAVAILABLE` | the VM cannot do this | use a different template |
| `LEASE_EXPIRED` | the lease ran out | create a new lease |
| `BOOT_TIMEOUT` | the VM did not boot in time | tear down and retry once |
| `QUOTA_EXCEEDED` / `HOST_CAPACITY` | no room | wait, then retry |
| `NOT_FOUND` | the VM id is wrong | check the id |
| `DISK_FULL` | host disk is low | wait and retry later |

Follow the `hint` field: `teardown-then-retry`, `wait-then-retry`, or
`one-retry-then-report`.

## Rules

- Never shell out to control a VM. Use the vmhub tools.
- Never run `grim`, `hyprctl`, `xdotool`, or similar yourself.
- Release every VM you create.
- Pull artifacts before release.
- Keep `ttl_ms` as short as the task allows.
- Check `vm_capabilities` for a specific VM when unsure what it can do.
