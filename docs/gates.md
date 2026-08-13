# vmhub Phase-0 Gates — answers required from keylessboi

These three answers gate the server-integration phases (Phase 3+). The desktop
demo (mock control plane + live hyprland adapter) works WITHOUT them.

## Gate 1 — GitHub access (RESOLVED 2026-08-13: PULL-ONLY, incl. PRIVATE repos)

VMs need **pull-only** access to keylessboi's repos — **public AND private**.
Decision: a single **fine-grained PAT** scoped to Repository access
(keylessboi's repos, including private) + **Contents: Read-only**, stored in
Doppler as `GH_PULL_TOKEN`. VMs get it via cloud-init git credential helper.
Fine-grained PATs are UI-only to create — you create it once, pastes
into Doppler by reference. (Alternative per-repo: read-only deploy keys via
`gh repo deploy-key add`, scriptable, but per-repo.)

- [ ] You create a fine-grained PAT (Repository access: keylessboi's repos incl.
      private; Permissions: Contents Read-only)
- [ ] Store in Doppler: `doppler secrets set GH_PULL_TOKEN=<paste>`

## Gate 2 — Android (gates the Android adapter v1)

- [ ] Real Android device available (ADB over USB/network)? → if yes, the v1
      adapter is host-side ADB: zero infra, `adb shell input/screencap`.
- [ ] Emulator-only? → needs nested virtualization (KVM in a Linux VM) and
      ~8GB RAM per emulator. Deferred to a later tier; `redroid` (AOSP only,
      no GMS) may cover non-Play app testing without nested virt.
- [ ] iOS: requires a Mac host (simulator) or real device + Xcode. On this
      Gen8 there is no viable path — the adapter stays a documented
      `capabilities: []` stub.

## Gate 3 — iLO credentials (RESOLVED 2026-08-12)

The iLO account is **`ops`** (password in `~/.env` as `PASSWORD`).
The `.env` `USERNAME` value is NOT the iLO account — it caused every
`UnauthorizedLoginAttempt`. Authenticated successfully with `ops` (HTTP 201,
session token secured). No action needed.

See `docs/probe.md` for the full diagnostic sequence and lockout rules.

## Gate 4 — Proxmox storage (discovered during Phase 0)

The DL360p Gen8 has a Smart Array RAID controller. ZFS needs HBA/IT mode to
see individual disks. Verify/switch controller mode in SPP/BIOS before the
installer runs, then confirm `disk_list` in `bootstrap/proxmox-answers.dat`.

- [ ] Controller mode confirmed: `____________`
- [ ] Physical disk count: `____________`

## Gate 5 — Roblox Studio in VMs (RESOLVED 2026-08-13: UNBLOCKED)

keylessboi confirmed: **Roblox Studio runs fine in a VM; the anti-cheat applies to the
Roblox CLIENT only, not Studio.** The Windows VM family (`windows-11-24h2`,
CursorTouch) is therefore GO, not conditional. Build the Windows golden after
the base install; no GPU passthrough needed (WARP software rendering is
acceptable for Studio).
