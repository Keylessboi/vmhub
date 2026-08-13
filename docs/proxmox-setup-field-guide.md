# Proxmox install via iLO — complete field guide (every error we hit)

This document exists so another agent can install Proxmox on the DL360p Gen8
headlessly WITHOUT repeating the ~30 failures this session hit. It is the
complete battle log: every error, its root cause, and the fix that worked.

The software (vmhub) is already built and tested. This is ONLY about getting
Proxmox installed on the bare metal through the iLO remote console.

---

## The one-line summary

The iLO HTML5 console is driven through Playwright. Keyboard uses
`renderer.keyboard.send_vkey(code, down)`. Mouse uses
`renderer.keyboard.mouse_send(rx, ry, ax, ay, button, wheel)` where **ax,ay
are in a 0-3000 normalized space** (not pixels!). Clicks fail silently if you
use pixel coordinates. This single fact caused the most wasted time.

---

## 0. The iLO auth pattern (do not reinvent)

```bash
set -a; source ~/.env; set +a   # PASSWORD = iLO password, by reference
curl -k -s -m 30 -X POST -H "Content-Type: application/json" \
  -d "{\"UserName\":\"ops\",\"Password\":\"$PASSWORD\"}" \
  https://192.168.1.216/redfish/v1/SessionService/Sessions/ \
  -D /tmp/ilo_headers.txt -o /dev/null
TOKEN=$(grep -i x-auth-token /tmp/ilo_headers.txt | awk '{print $2}' | tr -d '\r')
printf '%s' "$TOKEN" > /tmp/ilo_token
```

**CRITICAL: the iLO account is `ops`, NOT the .env USERNAME.** The .env
USERNAME caused every `UnauthorizedLoginAttempt`. This was the first big
mystery.

---

## 1. ERROR: "UnauthorizedLoginAttempt" / login failures

**Symptom:** session POST returns `iLO.0.10.UnauthorizedLoginAttempt` or
`LoginAttemptDelayed`.

**Causes:**
1. Wrong username (see above — use `ops`).
2. **Login throttling**: iLO 4 grows a login delay after repeated attempts.
   Space logins out. Wait 30-60s between auth attempts. Use the patient-auth
   script pattern (retry loop with sleep).
3. **Session pool exhaustion**: "There are no more free sessions to connect
   to this iLO." — every Playwright login creates a WEB session that lingers.
   Redfish sessions are separate.

**Fix for pool exhaustion:**
```bash
# Clear Redfish sessions (keep your current token)
curl -k -s -H "X-Auth-Token: $TOKEN" \
  https://192.168.1.216/redfish/v1/SessionService/Sessions/ \
  | grep -o 'Sessions/[^/]*/' | while read s; do
    curl -k -s -X DELETE -H "X-Auth-Token: $TOKEN" "https://192.168.1.216/redfish/v1/$s"
  done
```
Web sessions (from Playwright browsers) expire on their own timeout (~30min)
or you can wait them out. **Minimize Playwright logins** — reuse one session.

---

## 2. ERROR: "ActionNotSupported" / empty Actions on VirtualMedia

**Symptom:** `POST .../VirtualMedia/2/Actions/VirtualMedia.InsertMedia` returns
`ActionNotSupported` on iLO 4 fw 2.82. The Redfish VirtualMedia resource shows
empty `Actions: {}`.

**Root cause:** fw 2.82's Redfish does NOT expose virtual-media insert actions.
URL-based scripted media only works through the **web UI** (vm.html page).

**Fix:** Use Playwright against `https://192.168.1.216/html/vm.html`:
- Floppy slot (`#floppy_upload`, `#floppy_bootnext`, `#insert_floppy`) = cidata
- Disc slot (`#disc_upload`, `#disc_bootnext`, `#insert_disc`) = Proxmox ISO
- Fill the URL, check boot-next, click insert.

**IMPORTANT: virtual media mounts DO NOT survive iLO power cycles.** After any
iLO reboot, re-mount both ISOs before booting. There's a script pattern in the
vmhub repo operations (docs/RUNBOOK.md).

---

## 3. ERROR: iLO never fetches the ISO (media shows "Connected" but boot fails)

**Symptom:** vm.html shows "Media Inserted: Scripted Media / Connected", but
the server boots to "Attempting Boot From CD-ROM" then falls to NIC/PXE.
The ISO server log shows NO requests from the iLO's IP.

**Root cause: the desktop firewall (ufw) was blocking port 8010.** The iLO
fetches the ISO URL itself over the network; the desktop's `ufw` silently
dropped it. The iLO had NEVER contacted the server.

**Fix:**
```bash
sudo ufw allow 8010/tcp
```
Verify the ISO server answers range requests:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Range: bytes=0-1023" \
  http://192.168.1.164:8010/proxmox-ve_9.2-1.iso   # expect 206
```

**Also: python's http.server is NOT enough.** The 1.6GB ISO transfer breaks
`SimpleHTTPRequestHandler` (BrokenPipeError). Use the Range-aware Node server
in the repo (`scripts/iso-server.mjs`). The iLO fetches in parallel RANGE
requests; python's handler can't keep up.

---

## 4. The console: how to actually see and drive the installer

**Connect (Playwright, one session):**
```js
// login via #usernameInput/#passwordInput/#ID_LOGON in the login frame
const appFrame = page.frames().find(f => f.url().includes('application'));
await appFrame.evaluate(() => window.startHtml5Irc());
await page.waitForTimeout(18000); // renderer needs time
// verify:
await appFrame.evaluate(() => !!window.renderer?.keyboard?.send_vkey);
```

**Screenshot the video region for OCR/vision:**
```js
const box = await appFrame.evaluate(() => {
  const v = document.querySelector('#videoContainer, .videoContainer, canvas, video');
  const r = v.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.screenshot({ path: '/tmp/s.png', clip: box });
// OCR: tesseract /tmp/s.png /tmp/s --psm 6
```

**Keyboard — the REAL API:**
```js
const kb = window.renderer.keyboard;
kb.send_vkey('F9', true); kb.send_vkey('F9', false);  // key code string
```
Codes: 'Enter', 'Tab', 'ArrowDown', 'Escape', 'F9', 'F10', letter keys.

**Mouse — the TRICKY API:**
```js
// signature: mouse_send(rx, ry, ax, ay, button, wheel)
// rx,ry = relative deltas (clamped ±127); ax,ay = ABSOLUTE in 0-3000 space
kb.mouse_send(0, 0, ax, ay, 0, 0);  // move
kb.mouse_send(0, 0, ax, ay, 1, 0);  // press (button 1 = left)
kb.mouse_send(0, 0, ax, ay, 0, 0);  // release
```

**Coordinate conversion (the #1 source of silent click failures):**
The renderer maps the canvas to a **0-3000 normalized space**:
```
ax = Math.trunc(3000 * (pageX - canvasRect.x) / canvasRect.width)
ay = Math.trunc(3000 * (pageY - canvasRect.y) / canvasRect.height)
```
On this setup: canvas at page (400, 305.5), size 800x597. The installer's
"Next" button is at page ~(1165, 882) → normalized **(2868, 2896)**. Clicking
with raw pixels (979, 711) does NOTHING — you MUST normalize. This cost hours.

**Typing text — use REAL DOM events, not synthetic objects:**
```js
// dispatch real KeyboardEvents on the canvas element:
const evt = new KeyboardEvent('keydown', { key: ch, code, keyCode, bubbles: true });
canvas.dispatchEvent(evt);
// on_key calls evt.stopPropagation() — fake objects crash with TypeError
```

---

## 5. ERROR: "No video" on the console though the server is on

**Symptom:** console shows "No video" (gray frame + status bar) even though
Redfish says Power: On.

**Root cause:** on this Gen8 with memory errors, the board sometimes powers
but POST doesn't initialize video. The power-draw reading tells the truth:
- 0W for 90s+ = board not actually energizing
- ~110W then ~230W then ~150W = POST actually running

**Fix: force-cycle (ForceOff → wait 20s → On).** This reliably gets video out.
```bash
curl -k -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"ResetType":"ForceOff"}' .../Systems/1/Actions/ComputerSystem.Reset/
sleep 20
curl -k -X POST ... -d '{"ResetType":"On"}' ...  # same endpoint
```

---

## 6. Getting INTO RBSU (BIOS setup) — the reliable way

**Symptom:** F9 during POST is unreliable to time from the console.

**Fix: use the iLO web UI's "Boot to System RBSU" button** (boot_order.html):
```js
// at /html/boot_order.html
document.getElementById('rbsu_button').onclick();  // reboots into RBSU
```
This is deterministic — the iLO handles the boot-time injection. Pressing F9
manually during the POST window is a race you'll lose.

**In RBSU:** arrow keys navigate, Enter selects, F10 saves+exits.
- Boot order: put CD/DVD ROM first (IPL) so the installer ISO boots.
- POST Error Beep: System Options → Advanced Options → Power-On Options →
  POST Error Beep = Disabled (silences the beeping).

---

## 7. The installer wizard flow (as driven manually)

The unattended answer file may not auto-pick-up (EULA is interactive). Manual
drive sequence, click "Next" at normalized (2868, 2896) on each screen:

1. **EULA** → Enter/Next
2. **Target Harddisk** → confirm `/dev/sda`, click Next
3. **Location and Time Zone** → click Country field (norm 1732, 2332), type
   "United States" via DOM key events, click Next
4. Continue through: admin user/password, network, disk layout
   (the vmhub post-install expects ZFS — verify installer's disk layout matches
   bootstrap/proxmox-answers.dat)

**Modal dialogs:** clicking Next with an invalid field pops a message dialog
("Please select a country first.") with an OK button — click OK (center of the
dialog) to dismiss before retrying.

---

## 8. Environment facts that matter

- Desktop LAN IP: 192.168.1.164 (WiFi). iLO: 192.168.1.216 (dedicated mgmt).
- **The DL360p has TWO separate network connections.**
  1. The **iLO management port** — the BMC's own dedicated NIC (192.168.1.216).
     Always on, always reachable, even when the host is off.
  2. The **host onboard NICs** (4× RJ45 on the back) — the actual Proxmox
     server's LAN ports. **These need their OWN ethernet cable** to the
     switch/router. The iLO port is NOT the host's network.
  This caused a real stall: Proxmox installed and ran fine, but the host had
  no network because only the iLO port was wired. Check host-NIC link, not
  just the iLO, when the webUI doesn't appear.
- **The Proxmox host gets 192.168.1.220/24 — NOT .216.** The .216 address
  belongs to the iLO's dedicated management NIC. Setting the host to .216
  causes an IP conflict on the LAN. This was a real bug in the answer file.
- The iLO is on the same subnet; desktop firewall must allow 8010.
- Install target: `/dev/sda` (119.51 GiB Flash Drive) — keylessboi approved.
- RAM: 128GB installed, only 96GB detected (POST error 207 on both CPUs'
  "Socket 4" DIMM banks). keylessboi reseated RAM to fix — verify POST shows 128GB.
- Smart Array P420i: "No Drives Detected / 0 Logical Drives". A 1TB drive may
  exist — after install, check `lsblk`/`smartctl` and configure it for VM data.
- The box beeps during POST due to those errors; RBSU POST Error Beep = Disabled
  silences it.
- **Verify the webUI host is YOUR server before post-install.** A LAN scan for
  :8006 can find OTHER Proxmox boxes (a Dell Vostro 3681 at .153 was mistaken
  for the DL360p). Confirm via dmidecode (Manufacturer/Product) + CPU count
  before running anything against it.

## 9. Secrets handling (non-negotiable)

- iLO password: `$PASSWORD` from `~/.env`, by reference. NEVER echo it.
- Proxmox root pw: `$PVE_ROOT_PW` (also in Doppler project `proxmox`, config `prd`).
- Proxmox API token: created by post-install.sh, printed ONCE to console,
  you capture it into Doppler as `PVE_TOKEN`. The agent never reads it.
- Doppler: `doppler run --project proxmox --config prd -- <cmd>` injects
  secrets by reference. `doppler secrets set` from a filtered env file.
- NEVER commit secrets. `.env` gitignored. Only `.env.example` (names) ships.

---

## 10. The scripts that exist (recreate in /tmp/opencode if cleared)

- `ilo-auth-patient.sh` — auth with backoff for login throttling
- `ilo-capture.mjs` — connect console + screenshot video region
- `ilo-drive.mjs` — connect console + send a key sequence + screenshot
- `ilo-sendkey.mjs` — send one key via send_vkey
- `ilo-click-abs.mjs` — click at normalized coords via mouse_send
- `ilo-type2.mjs` — type text via real DOM KeyboardEvents
- `ilo-remount-standalone.mjs` — mount both ISOs via web UI
- `ilo-premount.sh` — remount + verify (run before every power-on)
- `ilo-poweron-check.sh` / `ilo-state2.sh` — power/draw/thermal monitors

The source of truth for the whole project: `docs/RUNBOOK.md` + this file in
the vmhub repo (`github.com/Keylessboi/vmhub`).
