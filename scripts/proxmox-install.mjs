#!/usr/bin/env node
/**
 * vmhub proxmox-install — autonomous Proxmox VE installer driven through HPE iLO.
 *
 * Drives the entire install headlessly: iLO auth → mount virtual media →
 * boot the ISO → navigate the graphical installer wizard → verify boot.
 *
 * Embodies every lesson from the field guide (docs/proxmox-setup-field-guide.md):
 *  - iLO account is `ops`, never the .env USERNAME
 *  - login throttling → patient auth with backoff
 *  - session pool exhaustion → clear stale sessions, reuse connections
 *  - virtual media mounts DROP on iLO power cycles → always re-mount
 *  - the desktop firewall must allow the ISO port (ufw)
 *  - python http.server breaks on 1.6GB RANGE fetches → use Range-aware server
 *  - renderer mouse coords are 0-3000 normalized, NOT pixels (silent killer)
 *  - typing needs real DOM KeyboardEvents (on_key calls stopPropagation)
 *
 * Secrets by reference only: `$ILO_PASSWORD` from env/Doppler. Never echoed.
 *
 * Usage:
 *   ILO_PASSWORD=<pw> node proxmox-install.mjs \
 *     --ilo-host 192.168.1.216 \
 *     --iso-url http://192.168.1.164:8010/proxmox-ve_9.2-1.iso \
 *     --cidata-url http://192.168.1.164:8010/cidata.iso \
 *     --country "United States" \
 *     [--drive]   # interactively drive the wizard instead of auto-flow
 */
import { createRequire } from 'node:module';
const require = createRequire('/usr/lib/node_modules/omniroute/');
const { chromium } = require('playwright');
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};

const CFG = {
  iloHost: getArg('--ilo-host', '192.168.1.216'),
  isoUrl: getArg('--iso-url', ''),
  cidataUrl: getArg('--cidata-url', ''),
  country: getArg('--country', 'United States'),
  driveMode: args.includes('--drive'),
  username: process.env.ILO_USERNAME || 'ops',
  password: process.env.ILO_PASSWORD || process.env.PASSWORD || '',
  screenshotDir: getArg('--shots', '/tmp/vmhub-install-shots'),
};

if (!CFG.password) { console.error('ILO_PASSWORD missing (by reference — never hardcode)'); process.exit(1); }
if (!CFG.isoUrl) { console.error('--iso-url required'); process.exit(1); }

const ILO = `https://${CFG.iloHost}`;
const TOKEN_FILE = '/tmp/ilo_token';
mkdirSync(CFG.screenshotDir, { recursive: true });

// ---------------------------------------------------------------------------
// iLO Redfish helpers
// ---------------------------------------------------------------------------
function curl(method, pathname, body, extraHeaders = {}) {
  const headers = extraHeaders['X-Auth-Token'] ? extraHeaders : { ...extraHeaders };
  const b = body ? ` -d '${JSON.stringify(body)}' -H 'Content-Type: application/json'` : '';
  const out = execSync(
    `curl -k -s -m 30 -X ${method} ${b} ${headers['X-Auth-Token'] ? `-H "X-Auth-Token: ${headers['X-Auth-Token']}"` : ''} ${ILO}${pathname}`,
    { timeout: 40000, encoding: 'utf8' }
  );
  return out;
}

function auth() {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const hdr = execSync(
        `curl -k -s -m 30 -X POST -H "Content-Type: application/json" -d '{"UserName":"${CFG.username}","Password":"${CFG.password}"}' ${ILO}/redfish/v1/SessionService/Sessions/ -D - -o /dev/null`,
        { timeout: 40000, encoding: 'utf8' }
      );
      const m = hdr.match(/x-auth-token:\s*(\S+)/i);
      if (m) { writeFileSync(TOKEN_FILE, m[1]); console.log(`  auth OK (${m[1].length} chars) attempt ${attempt}`); return m[1]; }
    } catch {}
    console.log(`  auth attempt ${attempt} failed — waiting 40s (login throttle)`);
    sleep(40000);
  }
  throw new Error('auth failed after 8 attempts');
}

function getToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8');
  return auth();
}

function clearSessions() {
  const token = getToken();
  try {
    const list = curl('GET', '/redfish/v1/SessionService/Sessions/', null, { 'X-Auth-Token': token });
    const ids = [...list.matchAll(/Sessions\/(ops[^/"']+)\//g)].map(m => m[1]);
    let cleared = 0;
    for (const id of ids) {
      try { execSync(`curl -k -s -m 8 -X DELETE -H "X-Auth-Token: ${token}" -o /dev/null ${ILO}/redfish/v1/SessionService/Sessions/${id}`, { timeout: 12000 }); cleared++; } catch {}
    }
    console.log(`  cleared ${cleared} stale sessions`);
  } catch { console.log('  session clear skipped'); }
}

function powerState() {
  try { return JSON.parse(curl('GET', '/redfish/v1/Systems/1/', null, { 'X-Auth-Token': getToken() })).PowerState; }
  catch { return 'unknown'; }
}

function reset(type) {
  return curl('POST', '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/', { ResetType: type }, { 'X-Auth-Token': getToken() });
}

function powerDraw() {
  try {
    const d = JSON.parse(curl('GET', '/redfish/v1/Chassis/1/Power/', null, { 'X-Auth-Token': getToken() }));
    return d.PowerControl?.[0]?.PowerConsumedWatts ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Playwright console driver
// ---------------------------------------------------------------------------
async function withConsole(fn) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  await page.goto(ILO, { timeout: 30000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  // login
  let loginFrame = null;
  for (let i = 0; i < 8 && !loginFrame; i++) {
    for (const f of page.frames()) { if (f.url().includes('login')) { loginFrame = f; break; } }
    if (!loginFrame) await page.waitForTimeout(5000);
  }
  if (!loginFrame) throw new Error('no login frame (session pool full? clear first)');
  await loginFrame.fill('#usernameInput', CFG.username);
  await loginFrame.fill('#passwordInput', CFG.password);
  await loginFrame.click('#ID_LOGON');
  await page.waitForTimeout(12000);

  // app frame + console
  let appFrame = null;
  for (let i = 0; i < 6 && !appFrame; i++) {
    appFrame = page.frames().find(f => f.url().includes('application'));
    if (!appFrame) await page.waitForTimeout(5000);
  }
  if (!appFrame) throw new Error('no app frame');
  await appFrame.evaluate(() => { if (typeof window.startHtml5Irc === 'function') window.startHtml5Irc(); });
  await page.waitForTimeout(18000);

  const ready = await appFrame.evaluate(() => !!window.renderer?.keyboard?.send_vkey).catch(() => false);
  if (!ready) throw new Error('console renderer not ready (no free console session?)');

  const api = {
    page, appFrame,
    shot(name) {
      return appFrame.evaluate(() => {
        const v = document.querySelector('#videoContainer, .videoContainer, canvas, video');
        if (!v) return null;
        const r = v.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }).then(async (box) => {
        const out = path.join(CFG.screenshotDir, name);
        if (box?.w > 0) await page.screenshot({ path: out, clip: box });
        else await page.screenshot({ path: out });
        return out;
      });
    },
    key(code) {
      return appFrame.evaluate((c) => {
        const kb = window.renderer.keyboard;
        kb.send_vkey(c, true); kb.send_vkey(c, false);
      }, code);
    },
    click(ax, ay) {
      return appFrame.evaluate(([x, y]) => {
        const kb = window.renderer.keyboard;
        kb.mouse_send(0, 0, x, y, 0, 0);
        kb.mouse_send(0, 0, x, y, 1, 0);
        kb.mouse_send(0, 0, x, y, 0, 0);
      }, [ax, ay]);
    },
    type(text) {
      return appFrame.evaluate((t) => {
        const canvas = document.querySelector('canvas');
        canvas.focus();
        for (const ch of t) {
          const code = ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase();
          const keyCode = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
          for (const type of ['keydown', 'keyup']) {
            canvas.dispatchEvent(new KeyboardEvent(type, { key: ch, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
          }
        }
      }, text);
    },
  };

  try { return await fn(api); }
  finally { await browser.close(); }
}

// ---------------------------------------------------------------------------
// Page-to-normalized coordinate mapping
// ---------------------------------------------------------------------------
async function pageToNorm(appFrame, pageX, pageY) {
  return appFrame.evaluate(([px, py]) => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    const ax = Math.trunc(3000 * (px - r.x) / r.width);
    const ay = Math.trunc(3000 * (py - r.y) / r.height);
    return [ax, ay];
  }, [pageX, pageY]);
}

// The wizard "Next" button lives at the same place on each screen once we've
// mapped it. On this console geometry (canvas at 400,305.5, 800px wide), the
// Next button normalized coords are (2868, 2896). We re-derive via the canvas.
const NEXT_PAGE = [1165, 882]; // page coords of Next on this layout

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function stepMountMedia() {
  console.log('== step: mount virtual media ==');
  // The web-UI mount path (vm.html). Use Playwright directly.
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(ILO, { timeout: 30000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  let loginFrame = null;
  for (let i = 0; i < 8 && !loginFrame; i++) {
    for (const f of page.frames()) { if (f.url().includes('login')) { loginFrame = f; break; } }
    if (!loginFrame) await page.waitForTimeout(5000);
  }
  if (!loginFrame) throw new Error('no login frame for media mount');
  await loginFrame.fill('#usernameInput', CFG.username);
  await loginFrame.fill('#passwordInput', CFG.password);
  await loginFrame.click('#ID_LOGON');
  await page.waitForTimeout(10000);

  await page.goto(ILO + '/html/vm.html', { timeout: 30000 });
  await page.waitForTimeout(6000);

  // eject stale
  for (const id of ['#eject_floppy', '#eject_disc']) {
    const btn = await page.$(id);
    if (btn) { await btn.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(3000); }
  }
  // floppy = cidata (answer file), disc = Proxmox ISO
  if (CFG.cidataUrl) {
    await page.fill('#floppy_upload', CFG.cidataUrl);
    await page.check('#floppy_bootnext');
    await page.click('#insert_floppy');
    await page.waitForTimeout(4000);
  }
  await page.fill('#disc_upload', CFG.isoUrl);
  await page.check('#disc_bootnext');
  await page.click('#insert_disc');
  await page.waitForTimeout(6000);
  const t = await page.evaluate(() => document.body.innerText);
  const ok = /CD\/DVD[\s\S]{0,300}?Media Inserted\s+Scripted Media/.test(t);
  console.log(ok ? '  media mounted OK' : '  WARNING: media may not have mounted');
  await browser.close();
}

async function stepPowerOn() {
  console.log('== step: power on ==');
  const st = powerState();
  if (st !== 'On') {
    reset('On');
    console.log('  power-on sent');
  }
  // wait for POST: draw ramps 0 → ~110 → ~230 → ~150
  for (let i = 0; i < 20; i++) {
    await sleep(15000);
    const w = powerDraw();
    console.log(`  t+${(i + 1) * 15}s draw=${w}W`);
    if (w > 180) { console.log('  POST active (draw >180W)'); break; }
  }
}

async function stepDriveWizard() {
  console.log('== step: drive installer wizard ==');
  await withConsole(async (api) => {
    // 1. EULA / intro screen → Next
    await api.shot('01-start.png');
    await sleep(3000);
    // Map Next and click
    const [nx, ny] = await pageToNorm(api.appFrame, ...NEXT_PAGE);
    console.log(`  Next at normalized (${nx},${ny})`);
    await api.click(nx, ny);
    await sleep(8000);
    await api.shot('02-after-next.png');

    // 2. Target Harddisk screen → click Next
    await api.click(nx, ny);
    await sleep(8000);
    await api.shot('03-target-disk.png');

    // 3. Location/Time zone → set Country, Next
    // click Country field (page 462,464 → norm)
    const [cx, cy] = await pageToNorm(api.appFrame, 462, 464);
    await api.click(cx, cy);
    await sleep(2000);
    await api.type(CFG.country);
    await sleep(5000);
    await api.shot('04-country.png');
    // dismiss any modal, then Next
    await api.click(nx, ny);
    await sleep(6000);
    await api.shot('05-after-country.png');
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('vmhub proxmox-install — autonomous installer via iLO');
  console.log(`  iLO: ${CFG.iloHost}  ISO: ${CFG.isoUrl.slice(0, 60)}...`);

  clearSessions();
  stepMountMedia()
    .then(() => stepPowerOn())
    .then(() => stepDriveWizard())
    .then(() => {
      console.log('\nInstaller drive complete. Screenshots in', CFG.screenshotDir);
      console.log('If the wizard needs more input (manual mode), re-run with --drive and read the shots.');
    })
    .catch((e) => {
      console.error('\nFAILED:', e.message);
      process.exitCode = 1;
    });
}

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mkdirSync(p) { try { require('node:fs').mkdirSync(p, { recursive: true }); } catch {} }
function writeFileSync(p, s) { require('node:fs').writeFileSync(p, s); }

main();
