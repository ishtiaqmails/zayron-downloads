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

const PORT = 4010, HOST = '0.0.0.0';   // bound public so the dashboard opens in a browser; non-local requests require the admin token
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
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS admin_token text`);
  await db.query(`INSERT INTO canva_account (id, state) VALUES (1, 'none') ON CONFLICT (id) DO NOTHING`);
  await db.query(`UPDATE canva_account SET admin_token=$1 WHERE id=1 AND (admin_token IS NULL OR admin_token='')`, [require('crypto').randomBytes(24).toString('hex')]);
  await db.query(`CREATE TABLE IF NOT EXISTS canva_allowlist (
    email text PRIMARY KEY,
    source text NOT NULL DEFAULT 'manual',      -- order|manual
    order_ref text,
    note text,
    added_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  await db.query(`ALTER TABLE canva_allowlist ADD COLUMN IF NOT EXISTS expires_at timestamptz`);  // order entries expire (1yr); manual = NULL = permanent
  await db.query(`ALTER TABLE canva_allowlist ADD COLUMN IF NOT EXISTS joined_at timestamptz`);    // set when the email actually appears in the team (join confirmed)
  await db.query(`ALTER TABLE canva_allowlist ADD COLUMN IF NOT EXISTS customer_phone text`);      // WhatsApp number for the order, so the bot can resend/remind
  await db.query(`ALTER TABLE canva_allowlist ADD COLUMN IF NOT EXISTS reminders_sent int NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE canva_allowlist ADD COLUMN IF NOT EXISTS last_sent_at timestamptz`);
  await db.query(`CREATE TABLE IF NOT EXISTS canva_outbox (
    id serial PRIMARY KEY,
    kind text NOT NULL DEFAULT 'resend',
    email text,
    phone text,
    status text NOT NULL DEFAULT 'queued',   -- queued|done|failed
    message text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    done_at timestamptz
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS canva_members (email text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT NOW())`);  // snapshot of who is in the team right now
  await db.query(`CREATE TABLE IF NOT EXISTS canva_remove_queue (
    email text PRIMARY KEY,
    status text NOT NULL DEFAULT 'queued',       -- queued|working|done|failed
    message text,
    queued_at timestamptz NOT NULL DEFAULT NOW(),
    done_at timestamptz
  )`);
  // proxy bandwidth tracking (IPRoyal residential quota)
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS proxy_bytes bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS proxy_since timestamptz`);
  await db.query(`ALTER TABLE canva_account ADD COLUMN IF NOT EXISTS proxy_quota_mb int NOT NULL DEFAULT 2048`);
  await db.query(`CREATE TABLE IF NOT EXISTS canva_proxy_log (
    id serial PRIMARY KEY,
    op text,
    at timestamptz NOT NULL DEFAULT NOW(),
    ms int,
    bytes bigint,
    egress text
  )`);
}
async function getAccount() { const r = await db.query('SELECT * FROM canva_account WHERE id=1'); return r.rows[0] || { state: 'none' }; }
async function getBrand() { if (process.env.CANVA_BRAND) return process.env.CANVA_BRAND; const a = await getAccount(); return (a && a.brand) || DEFAULT_BRAND; }
async function getProxyRaw() { if (process.env.CANVA_PROXY) return process.env.CANVA_PROXY; const a = await getAccount(); return (a && a.proxy) || ''; }
// ─── allowlist (authorized emails = paid orders + manual additions) ───
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
const TERM_DAYS = 365;  // paid Canva order = 1 year of access
async function listAllow() { const r = await db.query('SELECT email, source, order_ref, note, added_at, expires_at, joined_at, customer_phone FROM canva_allowlist ORDER BY added_at DESC'); return r.rows; }
// confirm joins: any allowlisted email that now appears in the team gets joined_at stamped (called on every members read — no extra bandwidth)
async function markJoins(members) { try { const emails = (members || []).map(m => normEmail(m.email)).filter(Boolean); if (!emails.length) return;
  try { await db.query("INSERT INTO canva_members(email,seen_at) SELECT unnest($1::text[]), NOW() ON CONFLICT(email) DO UPDATE SET seen_at=NOW()", [emails]); await db.query("DELETE FROM canva_members WHERE email <> ALL($1::text[])", [emails]); } catch (e) {}
  const r = await db.query('UPDATE canva_allowlist SET joined_at=NOW() WHERE joined_at IS NULL AND email = ANY($1::text[]) RETURNING email, customer_phone, source', [emails]); for (const row of r.rows) { if (row.source === 'order' && row.customer_phone) { try { await db.query("INSERT INTO canva_outbox(kind,email,phone,status) VALUES('joined',$1,$2,'queued')", [row.email, row.customer_phone]); } catch (e) {} } } } catch (e) { log('markJoins', e.message); } }
async function pendingJoinCount() { try { const r = await db.query("SELECT COUNT(*)::int n FROM canva_allowlist WHERE joined_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())"); return r.rows[0].n; } catch (e) { return 0; } }
// expiresAt: explicit ISO/Date, or undefined => auto (orders get now+TERM_DAYS, manual stays permanent/NULL)
async function addAllow(email, source, orderRef, note, expiresAt, customerPhone) { email = normEmail(email); if (!email || !email.includes('@')) return false; source = source || 'manual'; let exp = (expiresAt === undefined) ? (source === 'order' ? new Date(Date.now() + TERM_DAYS * 86400000) : null) : (expiresAt ? new Date(expiresAt) : null); const ph = customerPhone ? String(customerPhone).replace(/[^0-9]/g, '') : null; await db.query('INSERT INTO canva_allowlist(email,source,order_ref,note,expires_at,customer_phone) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(email) DO UPDATE SET source=EXCLUDED.source, order_ref=COALESCE(EXCLUDED.order_ref,canva_allowlist.order_ref), note=COALESCE(EXCLUDED.note,canva_allowlist.note), expires_at=EXCLUDED.expires_at, customer_phone=COALESCE(EXCLUDED.customer_phone,canva_allowlist.customer_phone)', [email, source, orderRef || null, note || null, exp, ph]); return true; }
// bot-delivery config lives in bot_settings (same DB); the dashboard toggles it, the bot reads it
async function getBotCfg() { const r = await db.query("SELECT key, value FROM bot_settings WHERE key = ANY($1::text[])", [['canva_enabled', 'canva_delivery_mode', 'canva_product_id']]); const m = {}; r.rows.forEach(x => m[x.key] = x.value); return { canva_enabled: String(m.canva_enabled || '0') === '1', canva_delivery_mode: m.canva_delivery_mode || 'vendor', canva_product_id: parseInt(m.canva_product_id || '0', 10) || 0 }; }
async function setBotCfg(b) { const up = (k, v) => db.query("INSERT INTO bot_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, String(v)]); if ('canva_enabled' in b) await up('canva_enabled', b.canva_enabled ? '1' : '0'); if ('canva_delivery_mode' in b) await up('canva_delivery_mode', b.canva_delivery_mode === 'engine' ? 'engine' : 'vendor'); if ('canva_product_id' in b) await up('canva_product_id', parseInt(b.canva_product_id, 10) || 0); return await getBotCfg(); }
// dashboard "Resend code" → queue a send the bot's scheduler will pick up (only the bot can send WhatsApp)
async function resendRequest(email) { email = normEmail(email); if (!email) return { ok: false, message: 'email required' }; const r = await db.query('SELECT customer_phone FROM canva_allowlist WHERE email=$1', [email]); const phone = r.rows[0] && r.rows[0].customer_phone; if (!phone) return { ok: false, message: 'No customer phone on file for this email — use “Give to a customer” to send it.' }; await db.query("INSERT INTO canva_outbox(kind,email,phone,status) VALUES('resend',$1,$2,'queued')", [email, phone]); return { ok: true, queued: email }; }
async function removeAllow(email) { await db.query('DELETE FROM canva_allowlist WHERE email=$1', [normEmail(email)]); return true; }
async function allowSet() { const r = await db.query('SELECT email FROM canva_allowlist WHERE expires_at IS NULL OR expires_at > NOW()'); return new Set(r.rows.map(x => normEmail(x.email))); }
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
  if ('code' in extra) { sets.push('code=$' + i); vals.push(extra.code); i++; }
  if ('heartbeat' in extra) { sets.push('last_heartbeat=NOW()'); }
  await db.query('UPDATE canva_account SET ' + sets.join(', ') + ' WHERE id=1', vals);
}

// ─── single-browser lock (persistent profile cannot be opened twice at once) ───
let LOCK = false;
async function lock(timeoutMs) { const d = Date.now() + (timeoutMs || 120000); while (LOCK) { if (Date.now() > d) throw new Error('engine busy'); await sleep(300); } LOCK = true; }
function unlock() { LOCK = false; const b = PENDING_BYTES; PENDING_BYTES = 0; const op = CURRENT_OP, ms = Date.now() - OP_T0; CURRENT_OP = 'engine'; if (b > 0) flushUsage(op, b, ms).catch(() => {}); }

// ─── proxy bandwidth accounting (every op runs under the lock, so bytes attribute to CURRENT_OP) ───
let PENDING_BYTES = 0, CURRENT_OP = 'engine', OP_T0 = Date.now(), LAST_EGRESS = null;
function markOp(op) { CURRENT_OP = op; OP_T0 = Date.now(); }  // call right after lock()
async function flushUsage(op, bytes, ms) {
  try {
    await db.query('UPDATE canva_account SET proxy_bytes = COALESCE(proxy_bytes,0) + $1, proxy_since = COALESCE(proxy_since, NOW()) WHERE id=1', [bytes]);
    await db.query('INSERT INTO canva_proxy_log(op, ms, bytes, egress) VALUES($1,$2,$3,$4)', [op, ms, bytes, LAST_EGRESS]);
    await db.query('DELETE FROM canva_proxy_log WHERE id < (SELECT COALESCE(MAX(id),0) - 300 FROM canva_proxy_log)');
  } catch (e) { log('flushUsage', e.message); }
}
async function proxyMonitor() {
  const a = await getAccount();
  const used = Number(a.proxy_bytes || 0), quotaMb = a.proxy_quota_mb || 2048, usedMb = used / 1048576;
  const rows = (await db.query('SELECT op, at, ms, bytes FROM canva_proxy_log ORDER BY id DESC LIMIT 60')).rows;
  let perDayMb = null, daysLeft = null;
  if (a.proxy_since) { const days = Math.max(0.05, (Date.now() - new Date(a.proxy_since).getTime()) / 86400000); const perDay = used / days; perDayMb = +(perDay / 1048576).toFixed(2); const remain = quotaMb * 1048576 - used; daysLeft = perDay > 0 ? +(remain / perDay).toFixed(1) : null; }
  return { ok: true, proxy: PROXY_CFG ? PROXY_CFG.server : null, egress: LAST_EGRESS, sessionLifetimeMin: 30, usedMb: +usedMb.toFixed(2), quotaMb, remainingMb: +(quotaMb - usedMb).toFixed(2), pct: +Math.min(100, quotaMb ? usedMb / quotaMb * 100 : 0).toFixed(1), since: a.proxy_since, perDayMb, daysLeft, log: rows };
}
async function proxySetQuota(mb) { mb = parseInt(mb, 10); if (!mb || mb < 1) return { ok: false, message: 'quota (MB) required' }; await db.query('UPDATE canva_account SET proxy_quota_mb=$1 WHERE id=1', [mb]); return { ok: true, quotaMb: mb }; }
async function proxyResetUsage() { await db.query('UPDATE canva_account SET proxy_bytes=0, proxy_since=NOW() WHERE id=1'); return { ok: true }; }

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
  // count real bytes-over-the-wire through the proxy (compressed transfer size)
  try { const cdp = await page.target().createCDPSession(); await cdp.send('Network.enable'); cdp.on('Network.loadingFinished', e => { PENDING_BYTES += (e.encodedDataLength || 0); }); } catch (e) { log('cdp bytes warn', e.message); }
  return page;
}
async function proxyTest() {
  await lock();
  markOp('proxy test');
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const body = await page.evaluate(() => document.body ? document.body.innerText : '');
    let ip = body; try { ip = (JSON.parse(body).ip) || body; } catch (e) {}
    LAST_EGRESS = String(ip).trim();
    return { ok: true, egressIp: LAST_EGRESS, proxy: PROXY_CFG ? PROXY_CFG.server : null };
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
// Detect the account's brand id from an /brands/<id>/ request fired on the People page (for account switching).
async function detectBrand(page) {
  let b = null;
  const h = (res) => { try { const m = res.url().match(/\/brands\/([A-Za-z0-9_-]{6,})\//); if (m) b = m[1]; } catch (e) {} };
  page.on('response', h);
  await page.goto('https://www.canva.com/settings/people', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  try { if (page.off) page.off('response', h); } catch (e) {}
  return b;
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
  markOp('session import');
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await restoreStorage(page, storage);
    if (!await isLoggedIn(page)) { await shot(page, 'import-notloggedin'); return { ok: false, state: 'error', message: 'Imported session is NOT logged in. Re-export canva.com cookies while logged in.' }; }
    let merged = storage;
    try { const fresh = await saveStorage(page); if (fresh.cookies && fresh.cookies.length) merged = { cookies: fresh.cookies, localStorage: Object.keys(fresh.localStorage || {}).length ? fresh.localStorage : storage.localStorage, sessionStorage: fresh.sessionStorage || storage.sessionStorage, savedAt: Date.now() }; } catch (e) {}
    let detectedBrand = null; try { detectedBrand = await detectBrand(page); } catch (e) {}
    const extra = { email: body.email || null, storage: merged };
    if (detectedBrand) extra.brand = detectedBrand;
    extra.code = null; // new account => clear cached code so it refetches
    await setState('active', extra);
    log('session imported + verified + profile warmed (cookies:' + norm.length + ', brand=' + (detectedBrand || '(kept)') + ')');
    return { ok: true, state: 'active', message: 'Session imported and verified — Canva is logged in.', brand: detectedBrand || null };
  } catch (e) { return { ok: false, state: 'error', message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}
async function sessionClear() { await setState('none', { email: null, storage: null }); return { ok: true, state: 'none' }; }

// ─── login state machine (fallback; import is the primary path) ───
let loginSession = null;
async function loginStart(email) {
  await lock(5 * 60 * 1000);
  markOp('login');
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
  markOp('invite');
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
let LAST_CONTROLS = [];  // last invite-dialog buttons seen (diagnostics for the regenerate control)
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
async function fetchCode(regen) {
  const acct = await getAccount();
  if (acct.state !== 'active' || !acct.storage_state) return { ok: false, message: 'No active Canva session' };
  await lock();
  markOp('code');
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await restoreStorage(page, acct.storage_state);
    if (!await isLoggedIn(page)) { await setState('needs_relogin'); return { ok: false, result: 'needs_relogin', message: 'Session expired — re-import needed' }; }
    if (!await openInviteDialog(page)) { await shot(page, 'code-nodialog'); return { ok: false, message: 'Could not open invite dialog' }; }
    let toCode = await clickDirect(page, 'via code', 20);
    if (!toCode) toCode = await clickByText(page, ['via code']);
    log('code: clicked via-code=' + toCode);
    // on an explicit refresh, try Canva's "reset/generate new code" control so the code actually changes
    let code = null, regenNet = [];
    if (regen) {
      const onResp = r => { try { const m = r.request().method(); const u = r.url(); if (m !== 'GET' && /canva\.com/.test(u) && /_ajax|graphql|invit|code|class|join|token|member|reset|refresh/i.test(u)) regenNet.push(m + ' ' + r.status() + ' ' + u.replace('https://www.canva.com', '').split('?')[0].slice(0, 90)); } catch (e) {} };
      page.on('response', onResp);
      try {
        const before = (await readCode(page, 8000).catch(() => null)) || ((await getAccount()).code || null);
        // 1) native click on the Refresh control (scrolls into view + real trusted click)
        const handles = await page.$$('[role=dialog] button, [aria-modal=true] button, [role=dialog] [role=button]');
        let clicked = false, clickedLbl = '';
        for (const h of handles) { const lbl = await page.evaluate(el => (((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || '')).toLowerCase()), h).catch(() => ''); if (/refresh|reset|regenerat|new code/.test(lbl)) { try { await h.click(); clicked = true; clickedLbl = lbl.trim().slice(0, 24); } catch (e) { log('regen click err ' + e.message); } break; } }
        log('regen: refresh-clicked=' + clicked + ' "' + clickedLbl + '"');
        await sleep(1500);
        // 2) if Canva pops a confirmation, click its confirm button (text button — not the icon)
        try { const confirmed = await page.evaluate(() => { const btns = [...document.querySelectorAll('[role=dialog] button,[aria-modal=true] button,[role=dialog] [role=button]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); for (const b of btns) { const t = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase(); if (/^(reset|generate|regenerate|new code|confirm|continue|got it|yes)\b/.test(t)) { (b.closest('button,[role=button]') || b).click(); return t.slice(0, 24); } } return ''; }); if (confirmed) log('regen: confirm "' + confirmed + '"'); } catch (e) {}
        // 3) wait until the code actually CHANGES from `before` (so we never read the stale one)
        for (let i = 0; i < 12 && !code; i++) { await sleep(1000); const cur = await readCode(page, 1500).catch(() => null); if (cur && cur !== before) code = cur; }
        log('regen: before=' + before + ' after=' + (code || '(unchanged)') + ' net=' + JSON.stringify(regenNet.slice(-12)));
      } catch (e) { log('regen err ' + e.message); }
      try { page.off('response', onResp); } catch (e) {}
    }
    try { LAST_CONTROLS = await page.evaluate(() => { const dlg = document.querySelector('[role=dialog],[aria-modal=true]'); const dialogText = dlg ? (dlg.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240) : ''; const ctrls = [...document.querySelectorAll('[role=dialog] button,[aria-modal=true] button,[role=dialog] [role=button],[role=dialog] a')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(e => ({ t: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24), a: (e.getAttribute('aria-label') || e.getAttribute('title') || '').slice(0, 24) })).filter(x => x.t || x.a).slice(0, 20); return { dialogText, ctrls }; }); } catch (e) { LAST_CONTROLS = {}; }
    if (regen) { try { LAST_CONTROLS.net = regenNet.slice(-14); } catch (e) {} }
    if (!code) code = await readCode(page, 15000);
    if (!code) { await shot(page, 'code-notfound'); return { ok: false, message: 'Code not found in dialog' }; }
    await setCode(code);
    log('code fetched: ' + code);
    return { ok: true, code, joinLink: JOIN_LINK, cached: false };
  } catch (e) { log('fetchCode error', e.message); return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}
// Return cached code if fresh (< 3.5h; Canva rotates every 4h), else fetch a new one. Always includes expiry.
const CODE_TTL_MS = 4 * 3600 * 1000;
async function getCode(forceFresh) {
  const a = await getAccount();
  const ageMs = a.code_at ? (Date.now() - new Date(a.code_at).getTime()) : Infinity;
  if (forceFresh || !a.code || ageMs >= 3.5 * 3600 * 1000) { let f; try { f = await fetchCode(forceFresh); } catch (e) { f = { ok: false, message: e.message }; } if (!f.ok && !a.code) return f; }
  const a2 = await getAccount();
  const codeAt = a2.code_at ? new Date(a2.code_at).getTime() : Date.now();
  const expiresAt = codeAt + CODE_TTL_MS;
  const validForMin = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  return { ok: true, code: a2.code, joinLink: JOIN_LINK, fetchedAt: new Date(codeAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), validForMin, controls: LAST_CONTROLS };
}

// ─── members read (full People list via search_brand_members, paginated by continuation) ───
async function fetchMembers() {
  const acct = await getAccount();
  if (acct.state !== 'active' || !acct.storage_state) return { ok: false, message: 'No active Canva session' };
  await lock();
  markOp('members');
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await restoreStorage(page, acct.storage_state);
    if (!await isLoggedIn(page)) { await setState('needs_relogin'); return { ok: false, result: 'needs_relogin', message: 'Session expired — re-import needed' }; }
    const members = await page.evaluate(async () => {
      const out = []; let cont = null; let guard = 0;
      do {
        const u = '/_ajax/profilesearch/search_brand_members?searchEmail=&projection=B&projection=C&projection=D&limit=50' + (cont ? ('&continuation=' + encodeURIComponent(cont)) : '');
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return { error: r.status };
        let t = await r.text(); const i = t.search(/[\[{]/); if (i > 0) t = t.slice(i);
        const j = JSON.parse(t);
        const res = j.results || [];
        for (const m of res) { const c = m.C || {}; const us = c.user || {}; out.push({ id: us.id || m.A || '', email: String(c.email || us.email || '').toLowerCase(), name: us.displayName || '', role: c.role || '', locked: !!c.locked }); }
        cont = j.continuation || null;
        if (res.length === 0) break;
      } while (cont && guard++ < 300);
      return out;
    });
    if (members && members.error) return { ok: false, message: 'members api status ' + members.error };
    log('members fetched: ' + members.length);
    await markJoins(members);
    return { ok: true, count: members.length, members };
  } catch (e) { log('fetchMembers error', e.message); return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}
// Report-only reconcile: who is in the team but NOT on the allowlist (never OWNER / non-members).
async function reconcile() {
  const mem = await fetchMembers();
  if (!mem.ok) return mem;
  const allow = await allowSet();
  const onlyMembers = mem.members.filter(m => m.role === 'MEMBER');
  const candidates = onlyMembers.filter(m => m.email && !allow.has(m.email));
  return { ok: true, total: mem.count, protectedNonMembers: mem.count - onlyMembers.length, authorizedEmails: allow.size, keep: mem.count - candidates.length, removeCandidates: candidates.map(c => ({ email: c.email, name: c.name, id: c.id })), mode: 'report-only' };
}

// ─── remove a member (search -> select -> trash -> confirm; captures the remove API) ───
async function removeMember(email) {
  email = normEmail(email);
  if (!email) return { ok: false, message: 'email required' };
  const acct = await getAccount();
  if (acct.state !== 'active' || !acct.storage_state) return { ok: false, message: 'No active Canva session' };
  await lock();
  markOp('remove');
  const browser = await launch();
  const netLog = []; let batchBody = null;
  try {
    const page = await newPage(browser);
    page.on('request', req => { try { if (req.method() === 'POST' && /memberships\/batch/i.test(req.url())) { const b = req.postData(); if (b) batchBody = b.slice(0, 900); } } catch (e) {} });
    page.on('response', async (res) => { try { const m = res.request().method(); const u = res.url(); if (m !== 'GET' && /\/_ajax\//.test(u) && /member|brand|remove|delete|revoke|membership|group/i.test(u)) netLog.push(m + ' ' + res.status() + ' ' + u.replace('https://www.canva.com', '').split('?')[0]); } catch (e) {} });
    await restoreStorage(page, acct.storage_state);
    if (!await isLoggedIn(page)) { await setState('needs_relogin'); return { ok: false, result: 'needs_relogin', message: 'Session expired' }; }
    await page.goto('https://www.canva.com/settings/people', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // confirm the member exists first (API)
    const existsBefore = await page.evaluate(async (email) => { try { const r = await fetch('/_ajax/profilesearch/search_brand_members?searchEmail=' + encodeURIComponent(email) + '&projection=B&projection=C&projection=D&limit=10', { credentials: 'include' }); let t = await r.text(); const i = t.search(/[\[{]/); if (i > 0) t = t.slice(i); const j = JSON.parse(t); return (j.results || []).some(m => m.C && String(m.C.email || '').toLowerCase() === email); } catch (e) { return null; } }, email);
    if (existsBefore === false) return { ok: false, result: 'not_found', message: 'Member not in team: ' + email };
    // WAIT until the People UI actually renders (search box present) — slow through the proxy
    let rendered = false;
    for (let i = 0; i < 30 && !rendered; i++) { await sleep(1000); rendered = await page.evaluate(() => [...document.querySelectorAll('input')].some(x => /search/i.test((x.getAttribute('placeholder') || '') + (x.getAttribute('aria-label') || ''))) ).catch(() => false); }
    log('remove: people UI rendered=' + rendered);
    // type email into the People search box to filter to just this member
    const typed = await page.evaluate(() => { const i = [...document.querySelectorAll('input')].find(x => { const ph = ((x.getAttribute('placeholder') || '') + ' ' + (x.getAttribute('aria-label') || '')).toLowerCase(); return /search/.test(ph) && /member|name|email/.test(ph); }); if (i) { i.focus(); return true; } return false; });
    if (typed) { await page.keyboard.type(email, { delay: 45 }); await sleep(4500); }
    // locate the member's row by its email cell, then click its checkbox (left edge) with a real mouse click
    const target = await page.evaluate((email) => {
      let cell = null;
      try { const snap = document.evaluate("//*[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'" + email + "')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); cell = snap.singleNodeValue; } catch (e) {}
      if (!cell) return null;
      let row = cell;
      for (let k = 0; k < 8; k++) { const r = row.getBoundingClientRect(); if (r.width > 500) break; if (!row.parentElement) break; row = row.parentElement; }
      const r = row.getBoundingClientRect();
      return { cx: Math.round(r.left + 22), cy: Math.round((r.top + r.bottom) / 2), rowW: Math.round(r.width) };
    }, email);
    const selected = !!target;
    if (target) { await page.mouse.click(target.cx, target.cy); }
    await sleep(2500);
    // dump + click the trash in the floating bulk-action bar (exclude left sidebar; trash is before the close X)
    const del = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button,[role=button]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top > (window.innerHeight - 190) && r.left > 300; });
      const bar = btns.map(b => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left), al: (b.getAttribute('aria-label') || '').slice(0, 24) }; });
      let clicked = 'none';
      if (btns.length >= 2) { btns[btns.length - 2].click(); clicked = 'idx' + (btns.length - 2) + '/' + btns.length; }
      else if (btns.length === 1) { btns[0].click(); clicked = 'idx0/1'; }
      return { clicked, bar };
    });
    await sleep(2500);
    await clickByText(page, ['remove from team', 'remove', 'delete', 'confirm', 'yes']);
    await sleep(3500);
    const existsAfter = await page.evaluate(async (email) => { try { const r = await fetch('/_ajax/profilesearch/search_brand_members?searchEmail=' + encodeURIComponent(email) + '&projection=B&projection=C&projection=D&limit=10', { credentials: 'include' }); let t = await r.text(); const i = t.search(/[\[{]/); if (i > 0) t = t.slice(i); const j = JSON.parse(t); return (j.results || []).some(m => m.C && String(m.C.email || '').toLowerCase() === email); } catch (e) { return null; } }, email);
    if (existsAfter === false) { log('member removed: ' + email); return { ok: true, removed: true, email, removeApi: netLog.slice(-10), batchBody }; }
    await shot(page, 'remove-failed');
    return { ok: false, removed: false, email, message: 'Remove did not take effect', debug: { typed, selected, del }, net: netLog.slice(-12), batchBody };
  } catch (e) { log('removeMember error', e.message); return { ok: false, message: e.message, net: netLog }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── approval-gated BULK removal: you approve a set on the dashboard; the engine removes them one-by-one in the background ───
let REMOVE_WORKER = false;
async function queueRemovals(emails) {
  const list = [...new Set((emails || []).map(normEmail).filter(e => e && e.includes('@')))];
  if (!list.length) return { ok: false, message: 'no valid emails' };
  for (const e of list) await db.query(`INSERT INTO canva_remove_queue(email,status,message,queued_at,done_at) VALUES($1,'queued',NULL,NOW(),NULL) ON CONFLICT(email) DO UPDATE SET status='queued', message=NULL, queued_at=NOW(), done_at=NULL`, [e]);
  runRemoveWorker();  // fire-and-forget
  return { ok: true, queued: list.length };
}
async function removeQueueStatus() {
  const rows = (await db.query(`SELECT email, status, message, queued_at, done_at FROM canva_remove_queue ORDER BY queued_at DESC LIMIT 200`)).rows;
  const c = (await db.query(`SELECT status, COUNT(*)::int n FROM canva_remove_queue GROUP BY status`)).rows.reduce((a, r) => (a[r.status] = r.n, a), {});
  return { ok: true, running: REMOVE_WORKER, counts: { queued: c.queued || 0, working: c.working || 0, done: c.done || 0, failed: c.failed || 0 }, rows };
}
async function runRemoveWorker() {
  if (REMOVE_WORKER) return; REMOVE_WORKER = true;
  log('remove worker: start');
  try {
    while (true) {
      const r = await db.query(`SELECT email FROM canva_remove_queue WHERE status='queued' ORDER BY queued_at ASC LIMIT 1`);
      if (!r.rows.length) break;
      const email = r.rows[0].email;
      await db.query(`UPDATE canva_remove_queue SET status='working' WHERE email=$1`, [email]);
      let res; try { res = await removeMember(email); } catch (e) { res = { ok: false, message: e.message }; }
      if (res && res.ok && (res.removed || res.result === 'not_found')) await db.query(`UPDATE canva_remove_queue SET status='done', message=$2, done_at=NOW() WHERE email=$1`, [email, res.result === 'not_found' ? 'already gone' : 'removed']);
      else await db.query(`UPDATE canva_remove_queue SET status='failed', message=$2, done_at=NOW() WHERE email=$1`, [email, (res && res.message) ? String(res.message).slice(0, 180) : 'failed']);
    }
  } catch (e) { log('remove worker error', e.message); }
  finally { REMOVE_WORKER = false; log('remove worker: idle'); }
}

// ─── re-verify the stored session (recover from a transient needs_relogin without re-importing) ───
async function reverify() {
  const acct = await getAccount();
  if (!acct.storage_state) return { ok: false, message: 'No stored session — import needed' };
  await lock();
  markOp('reverify');
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await restoreStorage(page, acct.storage_state);
    if (await isLoggedIn(page)) { const storage = await saveStorage(page); await setState('active', { storage, heartbeat: true }); log('reverify: active'); return { ok: true, state: 'active' }; }
    await setState('needs_relogin'); return { ok: false, state: 'needs_relogin', message: 'Stored session is not logged in — re-import needed' };
  } catch (e) { return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── heartbeat (skips if a browser op is in progress) ───
async function heartbeat() {
  const acct = await getAccount();
  if (acct.state !== 'active' || !acct.storage_state) return;
  if (LOCK) { log('hb skip (busy)'); return; }
  await lock();
  markOp('heartbeat');
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
function isLocal(req) { const a = String(req.socket.remoteAddress || ''); return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }

const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canva Control</title>
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#1a2230;--mut:#6b7488;--line:#e7eaf1;--brand:#5b4bff;--ok:#0e9f6e;--warn:#d97706;--danger:#e02424;--chip:#eef0f7}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5}
.wrap{max-width:860px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:20px;margin:6px 0 2px;font-weight:700}.sub{color:var(--mut);font-size:13px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(20,30,60,.04)}
.card h2{font-size:14px;letter-spacing:.02em;text-transform:uppercase;color:var(--mut);margin:0 0 14px;font-weight:600}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--chip);color:var(--mut)}
.badge.ok{background:#e7f6ef;color:var(--ok)}.badge.warn{background:#fdf2e3;color:var(--warn)}
.meta{color:var(--mut);font-size:13px}.meta b{color:var(--ink);font-weight:600}
.codebox{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:.06em;background:#f7f8fc;border:1px dashed #cdd3e4;border-radius:12px;padding:16px 18px;text-align:center;color:#2a2550}
.expire{font-size:13px;margin-top:8px}
input,textarea{font:inherit;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink)}
textarea{min-height:140px;resize:vertical;font-size:14px}
button{font:inherit;font-weight:600;cursor:pointer;border:0;border-radius:10px;padding:10px 14px;background:var(--brand);color:#fff}
button.ghost{background:#eef0f7;color:var(--ink)}button.sm{padding:6px 10px;font-size:13px}
button.danger{background:#fdecec;color:var(--danger)}button.safe{background:#e7f6ef;color:var(--ok)}
button:disabled{opacity:.5;cursor:default}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase}
.src{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--chip);color:var(--mut)}
.src.order{background:#e7f6ef;color:var(--ok)}
.grid2{display:grid;grid-template-columns:1fr auto;gap:10px}
.note{color:var(--mut);font-size:12px;margin-top:6px}
.empty{color:var(--mut);font-size:13px;padding:10px 0}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1a2230;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;transition:.2s;pointer-events:none}
.toast.show{opacity:1}
@media(max-width:560px){.codebox{font-size:26px}}
</style></head><body><div class="wrap">
<h1>Canva Education — Control Panel</h1>
<div class="sub">Join code, authorised customers, and team clean-up — all in one place.</div>

<div class="card"><h2>Account</h2>
 <div class="row" style="justify-content:space-between">
  <div class="row"><span>Status</span> <span id="acctState" class="badge">…</span>
   <span class="meta">Brand <b id="brand">…</b></span><span class="meta">Proxy <b id="proxy">…</b></span><span class="meta">Last check <b id="hb">…</b></span></div>
  <button class="ghost sm" onclick="recheck()">Re-check login</button></div>
</div>

<div class="card"><h2>Join code</h2>
 <div class="codebox" id="code">…</div>
 <div class="expire" id="codeMeta"></div>
 <div class="row" style="margin-top:12px">
  <button class="ghost sm" onclick="copy(CODE)">Copy code</button>
  <button class="ghost sm" onclick="copy(LINK)">Copy join link</button>
  <button class="sm" onclick="loadCode(true)">Refresh code now</button>
 </div>
 <input id="link" readonly style="margin-top:10px" value="">
</div>

<div class="card"><h2>Give code to a customer</h2>
 <div class="grid2">
  <input id="custEmail" placeholder="customer email (they must join with this exact email)">
  <button onclick="buildMsg()">Add + build message</button>
 </div>
 <div class="note">This also adds the email to your authorised list, so it is never auto-removed.</div>
 <textarea id="msg" style="margin-top:10px" placeholder="The ready-to-send message will appear here…"></textarea>
 <div class="row" style="margin-top:8px"><button class="ghost sm" onclick="copy(document.getElementById('msg').value)">Copy message</button></div>
</div>

<div class="card"><h2>Authorised emails <span class="meta" id="allowCount"></span></h2>
 <div class="grid2">
  <input id="addEmail" placeholder="email to authorise">
  <button class="ghost" onclick="addAllow()">Add</button>
 </div>
 <div class="note">Paid orders are added automatically by the bot. These people are never removed.</div>
 <table style="margin-top:12px"><thead><tr><th>Email</th><th>From</th><th>Added</th><th></th></tr></thead><tbody id="allowBody"><tr><td class="empty" colspan="4">Loading…</td></tr></tbody></table>
</div>

<div class="card"><h2>Team check — who is in the team but NOT on your list</h2>
 <div class="row"><button onclick="scan()">Scan team now</button><span class="meta" id="scanMeta"></span></div>
 <div class="note">If the auto-cleaner is off you can act here yourself: <b>Mark safe</b> adds them to your list, <b>Remove</b> takes them out of the team.</div>
 <table style="margin-top:12px"><thead><tr><th>Email</th><th>Name</th><th></th></tr></thead><tbody id="scanBody"><tr><td class="empty" colspan="3">Press “Scan team now”.</td></tr></tbody></table>
</div>

<div class="toast" id="toast"></div>
</div>
<script>
var TOKEN='__TOKEN__';var CODE='';var LINK='';var EXP=null;
function api(p,m,b){return fetch(p,{method:m||'GET',headers:{'x-admin-token':TOKEN,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json();});}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
function toast(t){var e=document.getElementById('toast');e.textContent=t;e.className='toast show';setTimeout(function(){e.className='toast';},1600);}
function copy(t){if(!t){return;}navigator.clipboard.writeText(t).then(function(){toast('Copied');});}
function fmtWhen(iso){if(!iso)return '—';try{return new Date(iso).toLocaleString();}catch(e){return iso;}}
function recheck(){toast('Checking…');api('/reverify').then(loadStatus);}
function loadStatus(){api('/status').then(function(s){var b=document.getElementById('acctState');b.textContent=s.state||'—';b.className='badge '+(s.state==='active'?'ok':'warn');document.getElementById('brand').textContent=s.brand||'—';document.getElementById('proxy').textContent=s.proxy||'none';document.getElementById('hb').textContent=fmtWhen(s.lastHeartbeat);});}
function tickExp(){if(!EXP){document.getElementById('codeMeta').textContent='';return;}var ms=new Date(EXP).getTime()-Date.now();var el=document.getElementById('codeMeta');if(ms<=0){el.innerHTML='<span style="color:var(--danger)">Expired — press Refresh code now</span>';return;}var h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);el.innerHTML='Valid until <b>'+new Date(EXP).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</b> · about '+(h>0?h+'h ':'')+m+'m left';}
function loadCode(refresh){document.getElementById('code').textContent='…';api('/code'+(refresh?'/refresh':'')).then(function(c){if(!c.ok){document.getElementById('code').textContent='unavailable';document.getElementById('codeMeta').textContent=c.message||'';return;}CODE=c.code;LINK=c.joinLink;EXP=c.expiresAt;document.getElementById('code').textContent=c.code;document.getElementById('link').value=c.joinLink;tickExp();});}
function buildMsg(){var email=(document.getElementById('custEmail').value||'').trim().toLowerCase();if(!email||email.indexOf('@')<1){toast('Enter a valid email');return;}api('/allow','POST',{email:email,source:'manual',note:'dashboard'}).then(function(){var exp=EXP?new Date(EXP).toLocaleString():'(press Refresh code)';var msg='Welcome to Canva Education 🎨\\n\\nIMPORTANT — join with THIS exact email: '+email+'\\n\\nHow to join:\\n1) Open this link: '+LINK+'\\n   (or go to canva.com/class/join and type the code)\\n2) Join code: '+CODE+'\\n3) Sign in or sign up using the email above — it must match, or you will be removed.\\n\\nCode valid until: '+exp+'\\n\\nOnce you join you get full Canva Pro / Education features. Enjoy!';document.getElementById('msg').value=msg;toast('Added + message ready');loadAllow();});}
function addAllow(){var email=(document.getElementById('addEmail').value||'').trim().toLowerCase();if(!email||email.indexOf('@')<1){toast('Enter a valid email');return;}api('/allow','POST',{email:email,source:'manual'}).then(function(){document.getElementById('addEmail').value='';toast('Added');loadAllow();});}
function delAllow(email){if(!confirm('Remove '+email+' from your authorised list? (This does not remove them from the team.)'))return;api('/allow/remove','POST',{email:email}).then(function(){toast('Removed from list');loadAllow();});}
function loadAllow(){api('/allow').then(function(r){var rows=(r.allow||[]);document.getElementById('allowCount').textContent='('+rows.length+')';var b=document.getElementById('allowBody');if(!rows.length){b.innerHTML='<tr><td class="empty" colspan="4">No authorised emails yet.</td></tr>';return;}b.innerHTML=rows.map(function(x){var src=(x.source==='order')?'<span class="src order">order</span>':'<span class="src">manual</span>';return '<tr><td>'+esc(x.email)+'</td><td>'+src+(x.order_ref?' <span class="meta">'+esc(x.order_ref)+'</span>':'')+'</td><td class="meta">'+fmtWhen(x.added_at)+'</td><td style="text-align:right"><button class="sm danger" onclick="delAllow(\\''+esc(x.email)+'\\')">Remove</button></td></tr>';}).join('');});}
function scan(){document.getElementById('scanMeta').textContent='Scanning… (can take ~20s)';document.getElementById('scanBody').innerHTML='<tr><td class="empty" colspan="3">Reading the team…</td></tr>';api('/reconcile').then(function(r){if(!r.ok){document.getElementById('scanMeta').textContent=r.message||'error';document.getElementById('scanBody').innerHTML='<tr><td class="empty" colspan="3">'+esc(r.message||'Could not read team')+'</td></tr>';return;}document.getElementById('scanMeta').innerHTML='Team: <b>'+r.total+'</b> · authorised: <b>'+r.authorizedEmails+'</b> · unknown: <b>'+r.removeCandidates.length+'</b>';var b=document.getElementById('scanBody');if(!r.removeCandidates.length){b.innerHTML='<tr><td class="empty" colspan="3">✅ Everyone in the team is on your authorised list.</td></tr>';return;}b.innerHTML=r.removeCandidates.map(function(c){var e=esc(c.email);return '<tr id="r_'+btoa(c.email).replace(/=/g,'')+'"><td>'+e+'</td><td class="meta">'+esc(c.name||'')+'</td><td style="text-align:right"><button class="sm safe" onclick="markSafe(\\''+e+'\\')">Mark safe</button> <button class="sm danger" onclick="removeMember(\\''+e+'\\',this)">Remove</button></td></tr>';}).join('');});}
function markSafe(email){api('/allow','POST',{email:email,source:'manual',note:'marked safe'}).then(function(){toast('Marked safe');loadAllow();scan();});}
function removeMember(email,btn){if(!confirm('Remove '+email+' from the Canva team? This frees their seat.'))return;btn.disabled=true;btn.textContent='Removing…';toast('Removing (up to ~3 min)…');api('/remove','POST',{email:email}).then(function(r){if(r.ok&&r.removed){toast('Removed from team');}else{toast(r.message||'Remove failed');btn.disabled=false;btn.textContent='Remove';}scan();});}
loadStatus();loadCode(false);loadAllow();setInterval(tickExp,30000);setInterval(loadStatus,60000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  const path = u.pathname;
  const token = u.searchParams.get('token') || req.headers['x-admin-token'] || '';
  try {
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    // auth gate: localhost (the bot) is trusted; every other client needs the admin token
    const authAcct = await getAccount();
    const ADMIN = authAcct.admin_token || '';
    const authed = isLocal(req) || (ADMIN && token === ADMIN);
    if (!authed) {
      if (req.method === 'GET' && path === '/admin') { res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end('<body style="font-family:sans-serif;padding:40px"><h3>Unauthorized</h3><p>Open this page with your admin token: <code>/admin?token=YOUR_TOKEN</code></p></body>'); }
      return send(res, 401, { error: 'unauthorized' });
    }
    if (req.method === 'GET' && path === '/admin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(ADMIN_HTML.replace('__TOKEN__', token || ADMIN)); }
    if (req.method === 'GET' && path === '/status') { const a = await getAccount(); return send(res, 200, { email: a.email || null, state: a.state, brand: (a && a.brand) || DEFAULT_BRAND, proxy: (a && a.proxy) ? 'set' : (process.env.CANVA_PROXY ? 'env' : null), stealth: STEALTH, lastHeartbeat: a.last_heartbeat || null }); }
    if (req.method === 'POST' && path === '/config') { const b = await readBody(req); if (!('brand' in b) && !('proxy' in b)) return send(res, 400, { ok: false, message: 'brand and/or proxy required' }); const extra = {}; if ('brand' in b) extra.brand = String(b.brand).trim(); if ('proxy' in b) extra.proxy = String(b.proxy).trim(); await setState((await getAccount()).state || 'none', extra); const a = await getAccount(); return send(res, 200, { ok: true, brand: a.brand || DEFAULT_BRAND, proxy: a.proxy ? 'set' : null }); }
    if (req.method === 'POST' && path === '/proxytest') { try { return send(res, 200, await proxyTest()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && path === '/reverify') { try { return send(res, 200, await reverify()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && (path === '/code' || path === '/code/refresh')) { try { return send(res, 200, await getCode(path.endsWith('refresh'))); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && path === '/members') { try { return send(res, 200, await fetchMembers()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && path === '/reconcile') { try { return send(res, 200, await reconcile()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && path === '/allow') { try { return send(res, 200, { ok: true, allow: await listAllow() }); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/allow') { const b = await readBody(req); if (!b.email) return send(res, 400, { ok: false, message: 'email required' }); const okk = await addAllow(b.email, b.source || 'manual', b.order_ref || null, b.note || null, undefined, b.customer_phone || null); let prejoined = false; if (okk && (b.source === 'order')) { try { const pj = await db.query("UPDATE canva_allowlist SET joined_at=NOW() WHERE email=$1 AND joined_at IS NULL AND EXISTS(SELECT 1 FROM canva_members WHERE email=$1) RETURNING 1", [normEmail(b.email)]); prejoined = pj.rows.length > 0; } catch (e) {} } return send(res, 200, { ok: okk, email: normEmail(b.email), prejoined }); }
    if (req.method === 'GET' && path === '/botcfg') { try { return send(res, 200, { ok: true, cfg: await getBotCfg() }); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/botcfg') { const b = await readBody(req); try { return send(res, 200, { ok: true, cfg: await setBotCfg(b) }); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/resend') { const b = await readBody(req); try { return send(res, 200, await resendRequest(b.email)); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/allow/remove') { const b = await readBody(req); if (!b.email) return send(res, 400, { ok: false, message: 'email required' }); await removeAllow(b.email); return send(res, 200, { ok: true, removed: normEmail(b.email) }); }
    if (req.method === 'POST' && path === '/remove') { const b = await readBody(req); if (!b.email) return send(res, 400, { ok: false, message: 'email required' }); try { return send(res, 200, await removeMember(b.email)); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/remove/batch') { const b = await readBody(req); try { return send(res, 200, await queueRemovals(b.emails || [])); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && path === '/remove/status') { try { return send(res, 200, await removeQueueStatus()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && path === '/proxy/monitor') { try { return send(res, 200, await proxyMonitor()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/proxy/quota') { const b = await readBody(req); try { return send(res, 200, await proxySetQuota(b.quotaMb)); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/proxy/reset') { try { return send(res, 200, await proxyResetUsage()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/session/import') { const b = await readBody(req); try { return send(res, 200, await sessionImport(b)); } catch (e) { return send(res, 200, { ok: false, state: 'error', message: e.message }); } }
    if (req.method === 'POST' && path === '/session/clear') { try { return send(res, 200, await sessionClear()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && path === '/login/start') { const b = await readBody(req); if (!b.email) return send(res, 400, { state: 'error', message: 'email required' }); try { return send(res, 200, await loginStart(String(b.email).trim())); } catch (e) { return send(res, 200, { state: 'error', message: e.message }); } }
    if (req.method === 'POST' && path === '/login/code') { const b = await readBody(req); if (!b.code) return send(res, 400, { state: 'error', message: 'code required' }); try { return send(res, 200, await loginCode(String(b.code).trim())); } catch (e) { return send(res, 200, { state: 'error', message: e.message }); } }
    if (req.method === 'POST' && path === '/invite') { const b = await readBody(req); if (!b.customerEmail) return send(res, 400, { ok: false, result: 'error', message: 'customerEmail required' }); return send(res, 200, await invite(String(b.customerEmail).trim())); }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 500, { error: e.message }); }
});

initDb().then(() => {
  server.listen(PORT, HOST, () => log('canva-engine v2 (headful) listening on http://' + HOST + ':' + PORT + ' DISPLAY=' + process.env.DISPLAY));
  setInterval(() => heartbeat().catch(e => log('hb throw', e.message)), HEARTBEAT_MS);
  runRemoveWorker().catch(e => log('remove worker boot', e.message));  // resume any queued removals after a restart
  // join watcher: checks every 2 min. Fast lane — a delivery/resend in the last 30 min polls every tick so joins confirm in ~2 min. Stale pending drops to a 20-min cadence to spare proxy GB. Nothing pending = no fetch.
  let LAST_SLOW_MEMBERS = 0;
  setInterval(async () => {
    try {
      if (LOCK) return;
      if (await pendingJoinCount() <= 0) return;
      const young = (await db.query("SELECT 1 FROM canva_allowlist WHERE source='order' AND joined_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) AND last_sent_at > NOW() - INTERVAL '30 minutes' LIMIT 1")).rows.length > 0;
      if (young || Date.now() - LAST_SLOW_MEMBERS > 20 * 60 * 1000) { await fetchMembers(); if (!young) LAST_SLOW_MEMBERS = Date.now(); }
    } catch (e) { log('join watcher', e.message); }
  }, 2 * 60 * 1000);
}).catch(e => { log('initDb failed', e.message); process.exit(1); });
