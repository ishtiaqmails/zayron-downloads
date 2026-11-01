// canva-engine v2 — Canva Education invite automation for the reseller bot.
// HEADFUL Chromium under Xvfb + persistent profile (passes Canva's risk/assess gate),
// reuses /opt/galaxybot chromium + built-in http. One active account.
// Endpoints (127.0.0.1:4010):
//   POST /session/import {cookies,[localStorage],[sessionStorage],[email]} -> {ok,state,message}
//   POST /session/clear                         -> {ok,state}
//   POST /login/start {email}                   -> {state:'awaiting_code'|'error'}
//   POST /login/code  {code}                    -> {state:'active'|'error'}
//   POST /invite      {customerEmail}           -> {ok, result:'sent'|'already_invited'|'needs_relogin'|'blocked'|'error', message}
//   POST /config      {brand?,proxy?}           -> {ok, brand, proxy}   (both changeable; proxy="" clears)
//   POST /proxytest                             -> {ok, egressIp, proxy}  (confirm residential exit IP)
//   GET  /status                                -> {email, state, brand, proxy, lastHeartbeat}
//   GET  /health                                -> {ok:true}
'use strict';
if (!process.env.DISPLAY) process.env.DISPLAY = ':99';   // headful needs an X display (Xvfb)
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteerBase = require('/opt/galaxybot/node_modules/puppeteer');
let puppeteer = puppeteerBase, STEALTH = false;
try {
  const { addExtra } = require('/opt/canva-engine/node_modules/puppeteer-extra');
  puppeteer = addExtra(puppeteerBase);
  puppeteer.use(require('/opt/canva-engine/node_modules/puppeteer-extra-plugin-stealth')());
  STEALTH = true;
} catch (e) { /* stealth plugin not installed; fall back to plain puppeteer */ }
const db = require('/opt/galaxybot/src/db');

const PORT = 4010, HOST = '127.0.0.1';
const SHOTS = '/opt/canva-engine/shots';
const PROFILE = '/opt/canva-engine/profile';                 // persistent, warmed profile
const DEFAULT_BRAND = 'BAHWa_MJHJI';                         // changeable via /config or CANVA_BRAND env
const ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEARTBEAT_MS = 3 * 60 * 60 * 1000; // every 3h
const INVITE_MIN_GAP_MS = 5000;          // pacing between invites (keep risk low)

try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(PROFILE, { recursive: true }); } catch (e) {}
const log = (...a) => console.log(new Date().toISOString(), '[canva]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── DB schema ───
async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS canva_account (
    id int PRIMARY KEY DEFAULT 1,
    email text,
    state text NOT NULL DEFAULT 'none',           -- none|awaiting_code|active|needs_relogin
    storage_state jsonb,
    brand text,
    proxy text,
    last_heartbeat timestamptz,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT canva_account_singleton CHECK (id = 1)
  )`);
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS brand text`);
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS proxy text`);
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS code text`);
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS code_at timestamptz`);
  await db.query(`INSERT INTO canva_account (id, state) VALUES (1, 'none') ON CONFLICT (id) DO NOTHING`);
}
async function getAccount() { const r = await db.query('SELECT * FROM canva_account WHERE id=1'); return r.rows[0] || { state: 'none' }; }
async function getBrand() { if (process.env.CANVA_BRAND) return process.env.CANVA_BRAND; const a = await getAccount(); return (a && a.brand) || DEFAULT_BRAND; }
async function getProxyRaw() { if (process.env.CANVA_PROXY) return process.env.CANVA_PROXY; const a = await getAccount(); return (a && a.proxy) || ''; }
// parse "http://user:pass@host:port" | "host:port" | "user:pass@host:port" -> {server,username,password} or null
function parseProxy(s) { s = String(s || '').trim(); if (!s) return null; try { const u = new URL(s.includes('://') ? s : 'http://' + s); return { server: u.protocol + '//' + u.host, username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') }; } catch (e) { return null; } }
let PROXY_CFG = null;
async function loadProxy() { PROXY_CFG = parseProxy(await getProxyRaw()); return PROXY_CFG; }
async function setState(state, extra) {
  extra = extra || {};
  const sets = ['state=$1', 'updated_at=NOW()']; const vals = [state]; let i = 2;
  if ('email' in extra) { sets.push('email=$' + i); vals.push(extra.email); i++; }
  if ('storage' in extra) { sets.push('storage_state=$' + i); vals.push(extra.storage ? JSON.stringify(extra.storage) : null); i++; }
  if ('brand' in extra) { sets.push('brand=$' + i); vals.push(extra.brand); i++; }
  if ('proxy' in extra) { sets.push('proxy=$' + i); vals.push(extra.proxy); i++; }
  if ('heartbeat' in extra) { sets.push('last_heartbeat=NOW()'); }
  await db.query('UPDATE canva_account SET ' + sets.join(', ') + ' WHERE id=1', vals);
}

// ─── single-browser lock (persistent profile cannot be opened twice at once) ───
let LOCK = false;
async function lock(timeoutMs) { const d = Date.now() + (timeoutMs || 120000); while (LOCK) { if (Date.now() > d) throw new Error('engine busy'); await sleep(300); } LOCK = true; }
function unlock() { LOCK = false; }

// ─── puppeteer helpers ───
async function launch() { await loadProxy(); const args = PROXY_CFG ? ARGS.concat('--proxy-server=' + PROXY_CFG.server) : ARGS; return puppeteer.launch({ headless: false, userDataDir: PROFILE, args, defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'] }); }
async function newPage(browser) {
  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();
  // puppeteer-extra-plugin-stealth (when loaded) applies comprehensive fingerprint evasions automatically.
  if (PROXY_CFG && (PROXY_CFG.username || PROXY_CFG.password)) { try { await page.authenticate({ username: PROXY_CFG.username, password: PROXY_CFG.password }); } catch (e) { log('proxy auth warn', e.message); } }
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await blockHeavy(page);
  return page;
}
async function proxyTest() {
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const body = await page.evaluate(() => document.body ? document.body.innerText : '');
    let ip = body; try { ip = (JSON.parse(body).ip) || body; } catch (e) {}
    return { ok: true, egressIp: String(ip).trim(), proxy: PROXY_CFG ? PROXY_CFG.server : null };
  } catch (e) { return { ok: false, message: e.message, proxy: PROXY_CFG ? PROXY_CFG.server : null }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}
async function shot(page, name) { try { const f = path.join(SHOTS, name + '-' + Date.now() + '.png'); await page.screenshot({ path: f }); log('screenshot', f); return f; } catch (e) { return null; } }
// Block heavy resources (images/media/fonts) to minimise proxy bandwidth — the invite UI does not need them.
async function blockHeavy(page) {
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'image' || t === 'media' || t === 'font') { req.abort().catch(() => { req.continue().catch(() => {}); }); }
      else { req.continue().catch(() => {}); }
    });
  } catch (e) { log('blockHeavy warn', e.message); }
}

async function clickByText(page, texts, opts) {
  opts = opts || {}; const sels = opts.sel || 'button, a, [role=button]';
  const wanted = texts.map(t => t.toLowerCase());
  const handle = await page.evaluateHandle((sels, wanted) => {
    const els = Array.from(document.querySelectorAll(sels));
    for (const el of els) {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (wanted.some(w => w === '' || t === w || t.includes(w))) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return el; }
    }
    return null;
  }, sels, wanted);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return false; }
  try { await el.click({ delay: 20 }); } catch (e) { try { await page.evaluate(n => n.click(), el); } catch (_) { await el.dispose(); return false; } }
  await el.dispose();
  return true;
}

// hydration-aware logged-in check (SPA settles after domcontentloaded).
// 40s because Canva loads slowly through a residential proxy.
async function isLoggedIn(page) {
  try {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const u = page.url();
      if (/\/(login|signup)(\/|\?|$)/i.test(u)) return false;
      const verdict = await page.evaluate(() => {
        const txt = ((document.body && document.body.innerText) || '');
        const title = document.title || '';
        if (/continue with email|log in to canva|enter your email|enter the code we sent/i.test(txt)) return 'out';
        if (document.querySelector('input[autocomplete="one-time-code"], input[name="username"]')) return 'out';
        if (document.querySelector('[data-testid*=profile],[aria-label*=Account i],[aria-label*=profile i],[data-testid*=home]')) return 'in';
        if (/create a design|your projects|recent designs|design spotlight|school team|set up canva education|give your students premium canva|set up your school team/i.test(txt)) return 'in';
        if (/\bprojects\b/i.test(txt) && /\btemplates\b/i.test(txt) && !/log in to canva/i.test(title)) return 'in';
        return 'wait';
      }).catch(() => 'wait');
      if (verdict === 'in') return true;
      if (verdict === 'out') return false;
      await sleep(1000);
    }
    return false;
  } catch (e) { return false; }
}

// ─── cookie import (session captured in the user's own clean-IP browser) ───
function _canvaDomain(d) { d = String(d || ''); const m = d.match(/[A-Za-z0-9.-]*canva\.com/i); if (m) return m[0]; const clean = d.replace(/[^A-Za-z0-9.-]/g, ''); return clean || '.canva.com'; }
function normCookie(c) {
  if (!c || !c.name) return null;
  const out = { name: String(c.name), value: String(c.value == null ? '' : c.value), domain: _canvaDomain(c.domain), path: c.path || '/' };
  if (c.secure != null) out.secure = !!c.secure;
  if (c.httpOnly != null) out.httpOnly = !!c.httpOnly;
  const exp = c.expirationDate || c.expires || c.expiry;
  if (exp && isFinite(Number(exp)) && Number(exp) > 0) out.expires = Math.floor(Number(exp));
  if (c.sameSite) { const x = String(c.sameSite).toLowerCase(); const m = x === 'no_restriction' ? 'None' : x === 'lax' ? 'Lax' : x === 'strict' ? 'Strict' : null; if (m) out.sameSite = m; }
  return out;
}

// ─── session storage save/restore ───
async function saveStorage(page) {
  const cookies = await page.cookies();
  const ls = await page.evaluate(() => { const o = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } } catch (e) {} return o; });
  const ss = await page.evaluate(() => { const o = {}; try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); } } catch (e) {} return o; });
  return { cookies, localStorage: ls, sessionStorage: ss, savedAt: Date.now() };
}
async function restoreStorage(page, storage) {
  if (!storage) return;
  if (Array.isArray(storage.cookies) && storage.cookies.length) { try { await page.setCookie(...storage.cookies); } catch (e) { log('setCookie warn', e.message); } }
  await page.goto('https://www.canva.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.evaluate((ls, ss) => {
    try { for (const k in ls) localStorage.setItem(k, ls[k]); } catch (e) {}
    try { for (const k in ss) sessionStorage.setItem(k, ss[k]); } catch (e) {}
  }, storage.localStorage || {}, storage.sessionStorage || {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
}

async function sessionImport(body) {
  let cookies = body.cookies;
  if (typeof cookies === 'string') { try { cookies = JSON.parse(cookies); } catch (e) { return { ok: false, state: 'error', message: 'cookies field is not valid JSON' }; } }
  if (cookies && Array.isArray(cookies.cookies)) cookies = cookies.cookies;
  if (!Array.isArray(cookies) || !cookies.length) return { ok: false, state: 'error', message: 'no cookies provided' };
  const norm = cookies.map(normCookie).filter(Boolean);
  let ls = body.localStorage; if (typeof ls === 'string') { try { ls = JSON.parse(ls); } catch (e) { ls = {}; } }
  let ss = body.sessionStorage; if (typeof ss === 'string') { try { ss = JSON.parse(ss); } catch (e) { ss = {}; } }
  const storage = { cookies: norm, localStorage: ls || {}, sessionStorage: ss || {}, savedAt: Date.now() };
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await restoreStorage(page, storage);
    if (!await isLoggedIn(page)) { await shot(page, 'import-notloggedin'); return { ok: false, state: 'error', message: 'Imported session is NOT logged in. Re-export canva.com cookies while logged in.' }; }
    let merged = storage;
    try { const fresh = await saveStorage(page); if (fresh.cookies && fresh.cookies.length) merged = { cookies: fresh.cookies, localStorage: Object.keys(fresh.localStorage || {}).length ? fresh.localStorage : storage.localStorage, sessionStorage: fresh.sessionStorage || storage.sessionStorage, savedAt: Date.now() }; } catch (e) {}
    await setState('active', { email: body.email || null, storage: merged });
    log('session imported + verified + profile warmed (cookies:' + norm.length + ')');
    return { ok: true, state: 'active', message: 'Session imported and verified — Canva is logged in.' };
  } catch (e) { return { ok: false, state: 'error', message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}
async function sessionClear() { await setState('none', { email: null, storage: null }); return { ok: true, state: 'none' }; }

// ─── login state machine (fallback; import is the primary path) ───
let loginSession = null;
async function loginStart(email) {
  await lock(5 * 60 * 1000);
  if (loginSession) { try { await loginSession.browser.close(); } catch (e) {} loginSession = null; }
  try {
    const browser = await launch();
    const page = await newPage(browser);
    loginSession = { browser, page, email, timer: setTimeout(async () => { try { await browser.close(); } catch (e) {} loginSession = null; unlock(); log('login auto-expired'); }, 5 * 60 * 1000) };
    log('login/start', email);
    await page.goto('https://www.canva.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    await clickByText(page, ['continue with email', 'log in with email', 'sign in with email']);
    await sleep(800);
    const typed = await (async () => { for (const s of ['input[name=username]', 'input[type=email]', 'input[name=email]', 'input[autocomplete=email]']) { const el = await page.$(s); if (el) { await el.click({ delay: 20 }).catch(() => {}); await el.type(email, { delay: 40 }); await el.dispose(); return true; } } return false; })();
    if (!typed) { await shot(page, 'login-start-noemailfield'); throw new Error('Could not find the email field'); }
    await sleep(300);
    if (!await clickByText(page, ['continue', 'next', 'log in', 'submit'])) { try { await page.keyboard.press('Enter'); } catch (e) {} }
    await sleep(2500);
    await shot(page, 'login-after-email');
    await setState('awaiting_code', { email });
    return { state: 'awaiting_code' };
  } catch (e) { if (loginSession) { try { clearTimeout(loginSession.timer); await loginSession.browser.close(); } catch (_) {} loginSession = null; } unlock(); await setState('none'); return { state: 'error', message: e.message }; }
}
async function loginCode(code) {
  if (!loginSession || !loginSession.page) throw new Error('No login in progress — start again from the dashboard.');
  const page = loginSession.page;
  try {
    log('login/code');
    const single = await page.$('input[autocomplete=one-time-code], input[name*=code i], input[inputmode=numeric]');
    if (single) { await single.click({ delay: 20 }).catch(() => {}); await single.type(code, { delay: 70 }); await single.dispose(); }
    else { const boxes = await page.$$('input[maxlength="1"]'); if (boxes.length >= code.length) { for (let i = 0; i < code.length; i++) await boxes[i].type(code[i], { delay: 70 }); } else { await page.keyboard.type(code, { delay: 70 }); } }
    await sleep(500);
    if (!await clickByText(page, ['continue', 'verify', 'log in', 'submit', 'done'])) { try { await page.keyboard.press('Enter'); } catch (e) {} }
    await sleep(3500);
    for (let i = 0; i < 2; i++) { if (await clickByText(page, ['skip for now', 'skip', 'maybe later', 'not now'])) await sleep(1500); }
    await sleep(1500);
    if (!await isLoggedIn(page)) { await shot(page, 'login-code-notloggedin'); return { state: 'error', message: 'Code submitted but not logged in — wrong/expired code?' }; }
    const storage = await saveStorage(page);
    await setState('active', { email: loginSession.email, storage });
    log('login OK — active');
    return { state: 'active' };
  } finally { if (loginSession) { try { clearTimeout(loginSession.timer); await loginSession.browser.close(); } catch (e) {} loginSession = null; } unlock(); }
}

// ─── invite (UI-driven; real browser passes assess, then fires create) ───
let lastInviteAt = 0;

async function listInvites(page, brand) {
  return await page.evaluate(async (brand) => {
    try {
      const u = '/_ajax/invitation/v2/brand/invitations?mode=BY_BRAND&limit=100&brand=' + encodeURIComponent(brand) + '&type=B';
      const r = await fetch(u, { headers: { accept: 'application/json' }, credentials: 'include' });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, data: await r.json() };
    } catch (e) { return { ok: false, error: String(e) }; }
  }, brand);
}
async function alreadyInvited(page, brand, target) {
  const res = await listInvites(page, brand);
  if (!res || !res.ok || !res.data) return false;
  const arr = Array.isArray(res.data.A) ? res.data.A : (Array.isArray(res.data) ? res.data : []);
  for (const e of arr) { if (e && typeof e === 'object') { for (const k in e) { const v = e[k]; if (typeof v === 'string' && v.toLowerCase() === target) return true; } } }
  return false;
}
const humanPause = () => sleep(400 + Math.floor(Math.random() * 700));
// Wait (lightweight) until a visible button matching rx exists.
async function waitForButton(page, rxSource, maxLen, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = await page.evaluate((rxSource, maxLen) => {
      const rx = new RegExp(rxSource, 'i');
      return [...document.querySelectorAll('button,[role=button]')].some(e => { const r = e.getBoundingClientRect(); const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim(); return r.width > 0 && r.height > 0 && rx.test(t) && t.length <= maxLen; });
    }, rxSource, maxLen).catch(() => false);
    if (found) return true;
    await sleep(1000);
  }
  return false;
}
// Trusted click (real mouse via CDP, isTrusted=true) with a humanised pre-move, on the smallest button matching rx.
async function clickExactTrusted(page, rxSource, maxLen) {
  const handle = await page.evaluateHandle((rxSource, maxLen) => {
    const rx = new RegExp(rxSource, 'i');
    const els = [...document.querySelectorAll('button,[role=button]')];
    let exact = els.find(e => { const r = e.getBoundingClientRect(); const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim(); return r.width > 0 && r.height > 0 && t.toLowerCase() === rxSource.replace(/[\^$]/g, '').toLowerCase(); });
    let best = exact || els.find(e => { const r = e.getBoundingClientRect(); const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim(); return r.width > 0 && r.height > 0 && rx.test(t) && t.length <= maxLen; });
    return best || null;
  }, rxSource, maxLen);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return false; }
  try { await el.hover(); } catch (e) {}   // move mouse to the target element itself (not a random point)
  try { await el.click({ delay: 50 + Math.floor(Math.random() * 70) }); } catch (e) { await el.dispose(); return false; }
  await el.dispose();
  return true;
}
// Reliable direct click (opening a dialog is not reCAPTCHA-gated) on the smallest button matching rx.
async function clickDirect(page, rxSource, maxLen) {
  return await page.evaluate((rxSource, maxLen) => {
    const rx = new RegExp(rxSource, 'i');
    const els = [...document.querySelectorAll('button,[role=button]')];
    let best = els.find(e => { const r = e.getBoundingClientRect(); const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim(); return r.width > 0 && r.height > 0 && t.toLowerCase() === rxSource.toLowerCase(); });
    if (!best) best = els.find(e => { const r = e.getBoundingClientRect(); const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim(); return r.width > 0 && r.height > 0 && rx.test(t) && t.length <= maxLen; });
    if (best) { (best.closest('button,[role=button]') || best).click(); return true; }
    return false;
  }, rxSource, maxLen).catch(() => false);
}
async function openInviteDialog(page) {
  const btn = await waitForButton(page, 'invite students', 40, 45000);
  log('inv: invite-students button present=' + btn);
  if (btn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await humanPause();
      const c = await clickDirect(page, 'invite students', 40);   // opening is not reCAPTCHA-gated; direct click lands reliably
      log('inv: clicked invite-students attempt ' + (attempt + 1) + ' = ' + c);
      if (await waitInviteField(page, 15000)) { log('inv: email field present=true'); return true; }
    }
    log('inv: email field present=false (after retries)');
    return false;
  }
  // fallback path: avatar -> Teams -> team -> Invite people
  await clickByText(page, [''], { sel: '[aria-label*=Account i],[aria-label*=profile i],header img,nav img' }).catch(() => {});
  await sleep(900);
  await clickByText(page, ['teams', 'team']); await sleep(900);
  await clickByText(page, ['invite people', 'invite members', 'invite students']); await sleep(1200);
  const field = await waitInviteField(page, 20000);
  log('inv: email field present=' + field);
  return field;
}
async function waitInviteField(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => !![...document.querySelectorAll('input')].find(i => { const r = i.getBoundingClientRect(); return r.width > 0 && (/^Enter email for person/i.test(i.getAttribute('aria-label') || '') || /^Enter email address/i.test(i.placeholder || '')); }));
    if (ok) return true;
    await sleep(700);
  }
  return false;
}
async function typeEmail(page, email) {
  const handle = await page.evaluateHandle(() => [...document.querySelectorAll('input')].find(x => /^Enter email for person/i.test(x.getAttribute('aria-label') || '') || /^Enter email address/i.test(x.placeholder || '')) || null);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return false; }
  try { await el.click({ delay: 40 }); } catch (e) {}   // real click to focus (trusted gesture)
  await el.dispose();
  await page.keyboard.type(email, { delay: 70 }); // real keystrokes so React registers + Send appears
  return true;
}
async function clickSend(page, ms) {
  if (!await waitForButton(page, 'send invitations', 30, ms)) return false;
  await humanPause();
  return await clickExactTrusted(page, 'send invitations', 30);
}
async function invite(customerEmail) {
  const gap = Date.now() - lastInviteAt; if (gap < INVITE_MIN_GAP_MS) await sleep(INVITE_MIN_GAP_MS - gap);
  lastInviteAt = Date.now();
  const acct = await getAccount();
  if (acct.state !== 'active' || !acct.storage_state) return { ok: false, result: 'needs_relogin', message: 'No active Canva session' };
  const brand = await getBrand();
  const target = String(customerEmail).trim().toLowerCase();
  await lock();
  const browser = await launch();
  let onResp = null;
  try {
    const t0 = Date.now(); const dt = () => Math.round((Date.now() - t0) / 1000) + 's';
    const page = await newPage(browser);
    await restoreStorage(page, acct.storage_state);
    log('inv[' + dt() + ']: restored, url=' + page.url());
    if (!await isLoggedIn(page)) { await shot(page, 'invite-loggedout'); await setState('needs_relogin'); return { ok: false, result: 'needs_relogin', message: 'Session expired — re-import needed' }; }
    log('inv[' + dt() + ']: logged in OK');
    try { if (await alreadyInvited(page, brand, target)) { log('already invited', target); return { ok: true, result: 'already_invited', message: 'Already invited: ' + customerEmail }; } } catch (e) {}
    log('inv[' + dt() + ']: dup-check done');
    let createOk = false, createBody = null, createSeen = false, assessInfo = null; const netLog = [];
    onResp = async (res) => { try { const u = res.url(); if (/_ajax|recaptcha|risk|assess|invitation/i.test(u)) netLog.push(res.status() + ' ' + res.request().method() + ' ' + u.replace('https://www.canva.com', '').split('?')[0]); if (/invitations\/create/.test(u)) { createSeen = true; const t = await res.text(); createBody = t; if (res.status() >= 200 && res.status() < 300 && t && t.toLowerCase().includes(target)) createOk = true; } else if (/requestriskscoring\/assess/.test(u)) { const t = await res.text().catch(() => ''); assessInfo = { status: res.status(), body: String(t || '').slice(0, 200) }; } } catch (e) {} };
    page.on('response', onResp);
    if (!await openInviteDialog(page)) { await shot(page, 'invite-nodialog'); const dbg = await page.evaluate(() => ({ url: location.href, title: document.title, buttons: [...new Set([...document.querySelectorAll('button,[role=button]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 40))].slice(0, 30) })).catch(() => null); return { ok: false, result: 'error', message: 'Could not open the invite dialog (button or email field not found)', detail: dbg }; }
    log('inv[' + dt() + ']: dialog opened');
    if (!await typeEmail(page, customerEmail.trim())) { await shot(page, 'invite-nofield'); return { ok: false, result: 'error', message: 'Email field not found' }; }
    log('inv[' + dt() + ']: email typed');
    await sleep(1800);
    const dlg = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')].filter(i => i.getBoundingClientRect().width > 0).map(i => ({ al: (i.getAttribute('aria-label') || '').slice(0, 30), ph: (i.placeholder || '').slice(0, 25), val: i.value || '' }));
      const sendBtn = [...document.querySelectorAll('button,[role=button]')].some(e => /send invitations?/i.test((e.innerText || '').replace(/\s+/g, ' ').trim()));
      const d = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].map(x => (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180))[0] || '';
      return { inputs: inputs.slice(0, 8), sendBtn, dialog: d };
    }).catch(() => null);
    log('inv[' + dt() + ']: dialogstate ' + JSON.stringify(dlg));
    const sent = await clickSend(page, 15000);
    log('inv[' + dt() + ']: send clicked=' + sent);
    if (!sent) { await shot(page, 'invite-nosend'); return { ok: false, result: 'error', message: 'Send invitations button did not appear (email invalid?)' }; }
    const deadline = Date.now() + 15000; let live = false;
    while (Date.now() < deadline && !createOk) {
      const hit = await page.evaluate(() => [...document.querySelectorAll('[aria-live],[role=status],[role=alert]')].map(n => (n.innerText || n.textContent || '')).join(' | ').toLowerCase());
      if (hit.includes('invitation sent') && hit.includes(target)) { live = true; break; }
      await sleep(400);
    }
    log('inv[' + dt() + ']: createOk=' + createOk + ' live=' + live + ' createSeen=' + createSeen + ' net=' + JSON.stringify(netLog.slice(-12)));
    if (createOk || live) { log('invite sent', target, createOk ? '(create 200)' : '(aria-live)'); return { ok: true, result: 'sent', message: 'Invitation sent to ' + customerEmail }; }
    await shot(page, 'invite-nosignal');
    if (!createSeen) return { ok: false, result: 'blocked', message: 'No create request fired — Canva risk gate (assess) did not clear.', detail: { assess: assessInfo, net: netLog.slice(-18), egress: PROXY_CFG ? PROXY_CFG.server : 'direct' } };
    return { ok: false, result: 'error', message: 'create fired but no success echo', detail: createBody ? String(createBody).slice(0, 200) : null };
  } catch (e) { log('invite error', e.message); return { ok: false, result: 'error', message: e.message }; }
  finally { try { if (onResp) page.off && page.off('response', onResp); } catch (e) {} try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── invite CODE (join-code delivery; NOT reCAPTCHA-gated — only opening the dialog + reading) ───
const JOIN_LINK = 'https://www.canva.com/class/join';
async function setCode(code) { await db.query('UPDATE canva_account SET code=$1, code_at=NOW(), updated_at=NOW() WHERE id=1', [code]); }
async function readCode(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].map(x => x.innerText || '').join(' '); return d || (document.body ? document.body.innerText : '') || ''; }).catch(() => '');
    const m = txt.match(/\b([A-Z0-9]{3})\s*-\s*([A-Z0-9]{3})\s*-\s*([A-Z0-9]{3})\b/);
    if (m) return (m[1] + '-' + m[2] + '-' + m[3]).toUpperCase();
    await sleep(800);
  }
  return null;
}
async function fetchCode() {
  const acct = await getAccount();
  if (acct.state !== 'active' || !acct.storage_state) return { ok: false, message: 'No active Canva session' };
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await restoreStorage(page, acct.storage_state);
    if (!await isLoggedIn(page)) { await setState('needs_relogin'); return { ok: false, result: 'needs_relogin', message: 'Session expired — re-import needed' }; }
    if (!await openInviteDialog(page)) { await shot(page, 'code-nodialog'); return { ok: false, message: 'Could not open invite dialog' }; }
    let toCode = await clickDirect(page, 'via code', 20);
    if (!toCode) toCode = await clickByText(page, ['via code']);
    log('code: clicked via-code=' + toCode);
    const code = await readCode(page, 15000);
    if (!code) { await shot(page, 'code-notfound'); return { ok: false, message: 'Code not found in dialog' }; }
    await setCode(code);
    log('code fetched: ' + code);
    return { ok: true, code, joinLink: JOIN_LINK, cached: false };
  } catch (e) { log('fetchCode error', e.message); return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}
// Return cached code if fresh (< 3.5h; Canva rotates every 4h), else fetch a new one.
async function getCode(forceFresh) {
  const a = await getAccount();
  const ageMs = a.code_at ? (Date.now() - new Date(a.code_at).getTime()) : Infinity;
  if (!forceFresh && a.code && ageMs < 3.5 * 3600 * 1000) return { ok: true, code: a.code, joinLink: JOIN_LINK, cached: true, ageMin: Math.round(ageMs / 60000) };
  return await fetchCode();
}

// ─── heartbeat (skips if a browser op is in progress) ───
async function heartbeat() {
  const acct = await getAccount();
  if (acct.state !== 'active' || !acct.storage_state) return;
  if (LOCK) { log('hb skip (busy)'); return; }
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await restoreStorage(page, acct.storage_state);
    if (await isLoggedIn(page)) { const storage = await saveStorage(page); await setState('active', { storage, heartbeat: true }); log('heartbeat OK'); }
    else { await setState('needs_relogin'); log('heartbeat: logged out -> needs_relogin'); }
  } catch (e) { log('heartbeat error', e.message); } finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── http server ───
function readBody(req) { return new Promise(res => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { res({}); } }); }); }
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/status') { const a = await getAccount(); return send(res, 200, { email: a.email || null, state: a.state, brand: (a && a.brand) || DEFAULT_BRAND, proxy: (a && a.proxy) ? 'set' : (process.env.CANVA_PROXY ? 'env' : null), stealth: STEALTH, lastHeartbeat: a.last_heartbeat || null }); }
    if (req.method === 'POST' && req.url === '/config') { const b = await readBody(req); if (!('brand' in b) && !('proxy' in b)) return send(res, 400, { ok: false, message: 'brand and/or proxy required' }); const extra = {}; if ('brand' in b) extra.brand = String(b.brand).trim(); if ('proxy' in b) extra.proxy = String(b.proxy).trim(); await setState((await getAccount()).state || 'none', extra); const a = await getAccount(); return send(res, 200, { ok: true, brand: a.brand || DEFAULT_BRAND, proxy: a.proxy ? 'set' : null }); }
    if (req.method === 'POST' && req.url === '/proxytest') { try { return send(res, 200, await proxyTest()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && (req.url === '/code' || req.url === '/code/refresh')) { try { return send(res, 200, await getCode(req.url.endsWith('refresh'))); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && req.url === '/session/import') { const b = await readBody(req); try { return send(res, 200, await sessionImport(b)); } catch (e) { return send(res, 200, { ok: false, state: 'error', message: e.message }); } }
    if (req.method === 'POST' && req.url === '/session/clear') { try { return send(res, 200, await sessionClear()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && req.url === '/login/start') { const b = await readBody(req); if (!b.email) return send(res, 400, { state: 'error', message: 'email required' }); try { return send(res, 200, await loginStart(String(b.email).trim())); } catch (e) { return send(res, 200, { state: 'error', message: e.message }); } }
    if (req.method === 'POST' && req.url === '/login/code') { const b = await readBody(req); if (!b.code) return send(res, 400, { state: 'error', message: 'code required' }); try { return send(res, 200, await loginCode(String(b.code).trim())); } catch (e) { return send(res, 200, { state: 'error', message: e.message }); } }
    if (req.method === 'POST' && req.url === '/invite') { const b = await readBody(req); if (!b.customerEmail) return send(res, 400, { ok: false, result: 'error', message: 'customerEmail required' }); return send(res, 200, await invite(String(b.customerEmail).trim())); }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 500, { error: e.message }); }
});

initDb().then(() => {
  server.listen(PORT, HOST, () => log('canva-engine v2 (headful) listening on http://' + HOST + ':' + PORT + ' DISPLAY=' + process.env.DISPLAY));
  setInterval(() => heartbeat().catch(e => log('hb throw', e.message)), HEARTBEAT_MS);
}).catch(e => { log('initDb failed', e.message); process.exit(1); });
