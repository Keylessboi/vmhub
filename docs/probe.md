# iLO Probe — findings (Phase 0.1)

Probe date: 2026-08-12/13. Target: `https://192.168.1.216`, HPE iLO 4, firmware 2.82.

## Auth findings

| Endpoint | Basic auth | Session token | Result |
|---|---|---|---|
| `GET /redfish/v1/` (ServiceRoot) | anonymous | n/a | reachable, no auth needed (login display) |
| `POST /redfish/v1/SessionService/Sessions/` | n/a | returns `X-Auth-Token` | **HTTP 201 with correct account** |
| `GET /redfish/v1/Systems/1/` | rejected | required | needs `X-Auth-Token` header |
| `GET /redfish/v1/Managers/1/` | rejected | required | needs `X-Auth-Token` header |

**Key lesson:** the iLO 4 ServiceRoot answers anonymously (it is the login
display). Deeper endpoints enforce sessions. An `UnauthorizedLoginAttempt` on
the session POST means **wrong username/password or a locked account** — it is
NOT a session-flow bug.

**This box's account is `ops`**, password in `~/.env` as `PASSWORD`.
The earlier `USERNAME` value in `.env` is NOT the iLO account — it caused every
`UnauthorizedLoginAttempt`. Use `ops` (or `ILO_USERNAME` in `.env`).

## Lockout behavior

- `iLO.0.10.LoginAttemptDelayed` — rate limit; wait and retry, do not hammer.
- `iLO.0.10.UnauthorizedLoginAttempt` — bad creds or locked account; STOP, wait
  out `LoginFailureDelay`, verify creds via the web UI before retrying.
- Repeated failures grow the delay. The probe script (`scripts/ilo-probe.sh`)
  exits immediately on either message.

## Server inventory (as probed)

- Model: **HP ProLiant DL360p Gen8** (serial USE501J64C)
- CPU: 2 × Intel Xeon E5-2670 v2 @ 2.50GHz (8c/16t each = 32 threads)
- RAM: **128 GiB**
- Power: **Off**
- BIOS: P71, 2019-05-24
- Virtual media: slots 1 and 2 available, nothing mounted
- iLO services: SSH/SNMP/IPMI disabled, KVM + HTTPS enabled

## Notes for the Proxmox install

- The DL360p Gen8 uses a **Smart Array RAID controller**. ZFS needs the
  controller in **HBA/IT mode** to see individual disks. Verify and switch the
  controller mode (SPP/BIOS) BEFORE the installer runs, then confirm the
  `disk_list` in `bootstrap/proxmox-answers.dat`.
- iLO 4 Redfish (fw 2.82) does NOT expose the storage controller or disk
  inventory. That fact comes from the controller itself, not the BMC.
- Virtual media URL mount: serve the Proxmox ISO over HTTP on the LAN
  (`python3 -m http.server`), then
  `POST /redfish/v1/Managers/1/VirtualMedia/{1,2}/Actions/VirtualMedia.InsertMedia`
  with `{"Image":"http://<lan-ip>:8000/proxmox-ve_9.x.iso"}`.
  Verify the URL is reachable **from the iLO's network** — the iLO pulls it,
  not the desktop.
