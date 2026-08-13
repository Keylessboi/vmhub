# vmhub Phase-0 Gates — answers required from LO

These three answers gate the server-integration phases (Phase 3+). The desktop
demo (mock control plane + live hyprland adapter) works WITHOUT them.

## Gate 1 — GitHub write access (gates GitHub App token scopes)

Which repositories do VMs need **write** access to? VMs are signed into
`gh` as LO. The blessed mechanism is a GitHub App installation token
(scriptable, per-repo + per-permission scope, 1-hour auto-expiry, revocable).
The app's permissions must be scoped to exactly these repos.

- [ ] List the repos: `____________`
- [ ] Write access needed? yes/no → `____________`
- [ ] Read-only clone repos (deploy-key path instead): `____________`

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
