// lion-engine — Lion OTT / bqpanel.com IPTV automation for the reseller bot.
// HEADFUL Chromium under Xvfb + persistent profile (passes Cloudflare), through the
// IPRoyal residential proxy. Reuses /opt/galaxybot chromium, DB and 2captcha service.
//
// Strategy (money-conscious): log in ONCE, persist the session, keep it warm with a
// quiet keep-alive so it almost never expires. 2captcha solves Turnstile only when the
// session genuinely dies (rare) — fully hands-off, near-zero cost.
//
// Endpoints (127.0.0.1:4011 — localhost trusted; others need the admin token):
//   GET  /health                               -> {ok:true}
//   GET  /status                               -> {state, credits, proxy, lastHeartbeat}
//   POST /config {panel_user?,panel_pass?,proxy?,base_url?,bouquet?} -> {ok,...}
//   POST /session/import {cookies,[localStorage],[sessionStorage]}   -> {ok,state}
//   POST /login                                -> {ok,state}   (force a fresh login via 2captcha)
//   GET  /credits                              -> {ok, credits}
//   POST /create {package,[username]}          -> {ok, username, password, expiry, m3u_url, package}
//   POST /renew  {username, package}           -> {ok, username, expiry}
//   GET  /search?username=                     -> {ok, found, line:{username,password,expiry,status,m3u_url}}
//   POST /proxytest                            -> {ok, egressIp}
'use strict';
if (!process.env.DISPLAY) process.env.DISPLAY = ':99';   // headful needs an X display (Xvfb)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteerBase = require('/opt/galaxybot/node_modules/puppeteer');
let CHROME_PATH = null; try { CHROME_PATH = puppeteerBase.executablePath(); } catch (e) {}
// Cloudflare's JS challenge detects automation via the CDP Runtime.enable leak, which
// puppeteer-extra-stealth does NOT patch. rebrowser-puppeteer-core patches it. We drive the
// SAME Chromium the bot already has (executablePath) so there is no extra download.
let puppeteer = puppeteerBase, STEALTH = false, REBROWSER = false;
try {
  const { addExtra } = require('/opt/lion-engine/node_modules/puppeteer-extra');
  let base = puppeteerBase;
  try { base = require('/opt/lion-engine/node_modules/rebrowser-puppeteer-core'); REBROWSER = true; } catch (e) {}
  puppeteer = addExtra(base);
  puppeteer.use(require('/opt/lion-engine/node_modules/puppeteer-extra-plugin-stealth')());
  STEALTH = true;
} catch (e) { /* fall back to plain puppeteer */ }
const db = require('/opt/galaxybot/src/db');
let captcha = null;
try { captcha = require('/opt/galaxybot/src/services/captchaService'); } catch (e) { /* set later */ }
let axios = null;
try { axios = require('/opt/galaxybot/node_modules/axios'); } catch (e) { try { axios = require('axios'); } catch (_) {} }

const PORT = 4011, HOST = '0.0.0.0';
const BASE = process.env.LION_BASE || 'https://bqpanel.com';
const M3U_HOST = 'http://line.liondnscloud.ru/get.php';
const SHOTS = '/opt/lion-engine/shots';
const PROFILE = '/opt/lion-engine/profile';
const ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const KEEPALIVE_MS = 4 * 60 * 1000;   // warm the session every 4 min so it never goes stale

// Package catalog — option value -> meaning/cost. Verified live on the create form.
const PKG = {
  trial: { id: '10', label: '1 Day', cds: 0,   days: 1 },
  m1:    { id: '6',  label: '1 Month',  cds: 0.1, days: 30 },
  m3:    { id: '7',  label: '3 Months', cds: 0.3, days: 90 },
  m6:    { id: '8',  label: '6 Months', cds: 0.6, days: 180 },
  y1:    { id: '9',  label: '1 Year',   cds: 1,   days: 365 },
};
// resolve a caller's package request (key | id | '1m'/'month'/'1 year' | days) -> PKG entry
function resolvePkg(p) {
  if (p == null) return null;
  const s = String(p).trim().toLowerCase();
  if (PKG[s]) return { key: s, ...PKG[s] };
  for (const k in PKG) if (PKG[k].id === s) return { key: k, ...PKG[k] };
  if (/^(trial|1\s*day|day|12\s*h)/.test(s)) return { key: 'trial', ...PKG.trial };
  if (/(^|[^0-9])1\s*(m|mo|month)/.test(s) || s === '1m' || s === 'month') return { key: 'm1', ...PKG.m1 };
  if (/3\s*(m|mo|month)/.test(s) || s === '3m') return { key: 'm3', ...PKG.m3 };
  if (/6\s*(m|mo|month)/.test(s) || s === '6m') return { key: 'm6', ...PKG.m6 };
  if (/(1\s*(y|yr|year))|12\s*(m|mo|month)/.test(s) || s === '1y' || s === 'year') return { key: 'y1', ...PKG.y1 };
  const n = parseInt(s, 10);
  if (!isNaN(n)) { if (n <= 1) return { key: 'trial', ...PKG.trial }; if (n <= 45) return { key: 'm1', ...PKG.m1 }; if (n <= 135) return { key: 'm3', ...PKG.m3 }; if (n <= 270) return { key: 'm6', ...PKG.m6 }; return { key: 'y1', ...PKG.y1 }; }
  return null;
}

try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(PROFILE, { recursive: true }); } catch (e) {}
const log = (...a) => console.log(new Date().toISOString(), '[lion]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── DB ───
async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS lion_account (
    id int PRIMARY KEY DEFAULT 1,
    state text NOT NULL DEFAULT 'none',          -- none|active|needs_relogin
    panel_user text,
    panel_pass text,
    storage_state jsonb,
    proxy text,
    base_url text,
    bouquet text NOT NULL DEFAULT 'all',         -- all | noadult  (which one-click bouquet set to apply on create)
    credits numeric,
    last_heartbeat timestamptz,
    admin_token text,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT lion_account_singleton CHECK (id = 1)
  )`);
  await db.query(`INSERT INTO lion_account (id, state) VALUES (1, 'none') ON CONFLICT (id) DO NOTHING`);
  await db.query(`UPDATE lion_account SET admin_token=$1 WHERE id=1 AND (admin_token IS NULL OR admin_token='')`, [crypto.randomBytes(24).toString('hex')]);
  // created/renewed lines — so the engine and dashboard have a record without re-reading the panel
  await db.query(`CREATE TABLE IF NOT EXISTS lion_lines (
    username text PRIMARY KEY,
    password text,
    package text,
    expiry text,
    order_ref text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
  )`);
}
async function getAccount() { const r = await db.query('SELECT * FROM lion_account WHERE id=1'); return r.rows[0] || { state: 'none' }; }
async function setAccount(fields) {
  const sets = ['updated_at=NOW()']; const vals = []; let i = 1;
  for (const k of ['state', 'panel_user', 'panel_pass', 'proxy', 'base_url', 'bouquet', 'credits']) {
    if (k in fields) { sets.push(`${k}=$${i}`); vals.push(fields[k]); i++; }
  }
  if ('storage' in fields) { sets.push(`storage_state=$${i}`); vals.push(fields.storage ? JSON.stringify(fields.storage) : null); i++; }
  if ('heartbeat' in fields) sets.push('last_heartbeat=NOW()');
  await db.query('UPDATE lion_account SET ' + sets.join(', ') + ' WHERE id=1', vals);
}
async function recordLine(l) {
  try {
    await db.query(`INSERT INTO lion_lines(username,password,package,expiry,order_ref,updated_at)
      VALUES($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(username) DO UPDATE SET password=COALESCE(EXCLUDED.password,lion_lines.password),
        package=COALESCE(EXCLUDED.package,lion_lines.package), expiry=COALESCE(EXCLUDED.expiry,lion_lines.expiry),
        order_ref=COALESCE(EXCLUDED.order_ref,lion_lines.order_ref), updated_at=NOW()`,
      [l.username, l.password || null, l.package || null, l.expiry || null, l.order_ref || null]);
  } catch (e) { log('recordLine', e.message); }
}

// ─── proxy ───
function parseProxy(s) { s = String(s || '').trim(); if (!s) return null; try { const u = new URL(s.includes('://') ? s : 'http://' + s); return { server: u.protocol + '//' + u.host, username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') }; } catch (e) { return null; } }
let PROXY_CFG = null;
async function loadProxy() { if (process.env.LION_PROXY) { PROXY_CFG = parseProxy(process.env.LION_PROXY); return PROXY_CFG; } const a = await getAccount(); PROXY_CFG = parseProxy(a.proxy || ''); return PROXY_CFG; }

// ─── single-browser lock (persistent profile can't open twice) ───
let LOCK = false;
async function lock(timeoutMs) { const d = Date.now() + (timeoutMs || 180000); while (LOCK) { if (Date.now() > d) throw new Error('engine busy'); await sleep(300); } LOCK = true; }
function unlock() { LOCK = false; }

// ─── browser ───
async function launch() { await loadProxy(); const args = PROXY_CFG ? ARGS.concat('--proxy-server=' + PROXY_CFG.server) : ARGS; const opts = { headless: false, userDataDir: PROFILE, args, defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'] }; if (CHROME_PATH) opts.executablePath = CHROME_PATH; return puppeteer.launch(opts); }
async function newPage(browser) {
  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();
  if (PROXY_CFG && (PROXY_CFG.username || PROXY_CFG.password)) { try { await page.authenticate({ username: PROXY_CFG.username, password: PROXY_CFG.password }); } catch (e) { log('proxy auth warn', e.message); } }
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  // hook Cloudflare's Turnstile so a challenge page exposes its params (sitekey/action/cData/pagedata)
  await page.evaluateOnNewDocument(() => {
    try {
      window.__cf = null; window.__cfCb = null; let real;
      const wrap = (ts) => { if (!ts || ts.__w) return ts; const orig = ts.render && ts.render.bind(ts); if (orig) { ts.render = (el, opts) => { try { window.__cf = { sitekey: opts.sitekey, action: opts.action, cData: opts.cData, chlPageData: opts.chlPageData, pagedata: opts.pagedata }; window.__cfCb = opts.callback; } catch (e) {} return orig(el, opts); }; } ts.__w = true; return ts; };
      Object.defineProperty(window, 'turnstile', { configurable: true, get() { return real; }, set(v) { real = wrap(v); } });
    } catch (e) {}
  }).catch(() => {});
  return page;
}
// ─── Cloudflare managed-challenge solver (reuses the bot's 2captcha key from bot_settings) ───
async function twocaptchaKey() { const r = await db.query("SELECT value FROM bot_settings WHERE key='twocaptcha_api_key'"); if (!r.rows[0]) throw new Error('2captcha key missing in bot_settings'); return r.rows[0].value; }
async function solveTurnstileParams(params, pageurl) {
  if (!axios) throw new Error('axios unavailable');
  const key = await twocaptchaKey();
  const body = new URLSearchParams({ key, json: '1', method: 'turnstile', sitekey: params.sitekey, pageurl, useragent: UA });
  if (params.action) body.set('action', params.action);
  if (params.cData) body.set('data', params.cData);
  const pd = params.chlPageData || params.pagedata; if (pd) body.set('pagedata', pd);
  const sub = await axios.post('https://2captcha.com/in.php', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
  if (sub.data.status !== 1) throw new Error('2captcha submit: ' + sub.data.request);
  const id = sub.data.request;
  await sleep(15000);
  for (let i = 0; i < 40; i++) {
    const r = await axios.get('https://2captcha.com/res.php', { params: { key, action: 'get', id, json: 1 }, timeout: 30000 });
    if (r.data.status === 1) return r.data.request;
    if (r.data.request !== 'CAPCHA_NOT_READY') throw new Error('2captcha: ' + r.data.request);
    await sleep(5000);
  }
  throw new Error('2captcha timeout');
}
async function challengedNow(page) { return await page.evaluate(() => { const t = (document.body && document.body.innerText) || ''; return /just a moment|performing security verification|checking your browser|verify you are human|attention required/i.test(t + ' ' + (document.title || '')); }).catch(() => false); }
// Clear a Cloudflare interstitial. bqpanel uses the JS fingerprint challenge (no captcha):
// rebrowser + headful + residential IP should pass it on its own, so we wait for it to clear.
// If a Turnstile widget ever appears, we solve it via 2captcha as a fallback.
async function passCloudflare(page) {
  if (!await challengedNow(page)) return true;
  log('cloudflare challenge — waiting for the browser to clear it');
  // Require a STABLE clear (3 consecutive clear checks ~4.5s) — a single clear check can be a
  // transient redirect state. Cloudflare may re-issue challenges; keep solving through them.
  let streak = 0;
  for (let i = 0; i < 70; i++) {
    await sleep(1500);
    if (!await challengedNow(page)) { if (++streak >= 3) { log('cloudflare cleared (stable)'); return true; } continue; }
    streak = 0;
    const p = await page.evaluate(() => window.__cf).catch(() => null);
    if (p && p.sitekey) {
      try { const token = await solveTurnstileParams(p, page.url()); await page.evaluate((tok) => { try { if (typeof window.__cfCb === 'function') window.__cfCb(tok); } catch (e) {} }, token); log('cloudflare turnstile solved'); }
      catch (e) { log('cf turnstile solve', e.message); }
    }
  }
  if (!await challengedNow(page)) return true;
  const cfd = await page.evaluate(() => ({ hasTurnstileGlobal: typeof window.turnstile !== 'undefined', frames: [...document.querySelectorAll('iframe')].map(f => f.src || '').slice(0, 5), cfDivs: [...document.querySelectorAll('.cf-turnstile, [data-sitekey]')].length, title: document.title, snippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160) })).catch(e => ({ err: e.message }));
  await shot(page, 'cf-stuck');
  const err = new Error('cloudflare JS challenge did not clear (browser still being flagged)');
  err.diag = cfd;
  throw err;
}
// navigate to a panel URL and clear any Cloudflare interstitial
async function gotoPanel(page, url, waitMs) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(waitMs || 2500); await passCloudflare(page); }
async function shot(page, name) { try { const f = path.join(SHOTS, name + '-' + Date.now() + '.png'); await page.screenshot({ path: f }); return f; } catch (e) { return null; } }

// click the first visible element whose text matches one of `texts`
async function clickByText(page, texts, sel) {
  sel = sel || 'button, a, [role=button], [role=menuitem], li';
  const wanted = texts.map(t => t.toLowerCase());
  const handle = await page.evaluateHandle((sel, wanted) => {
    const els = Array.from(document.querySelectorAll(sel));
    for (const el of els) {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (wanted.some(w => t === w || (w.length > 2 && t.includes(w)))) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return el; }
    }
    return null;
  }, sel, wanted);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return false; }
  try { await el.click({ delay: 20 }); } catch (e) { try { await page.evaluate(n => n.click(), el); } catch (_) { await el.dispose(); return false; } }
  await el.dispose();
  return true;
}

// ─── session persistence ───
function normCookie(c) {
  if (!c || !c.name) return null;
  const out = { name: String(c.name), value: String(c.value == null ? '' : c.value), domain: String(c.domain || '').replace(/[^A-Za-z0-9.-]/g, '') || 'bqpanel.com', path: c.path || '/' };
  if (c.secure != null) out.secure = !!c.secure;
  if (c.httpOnly != null) out.httpOnly = !!c.httpOnly;
  const exp = c.expirationDate || c.expires || c.expiry;
  if (exp && isFinite(Number(exp)) && Number(exp) > 0) out.expires = Math.floor(Number(exp));
  if (c.sameSite) { const x = String(c.sameSite).toLowerCase(); const m = x === 'no_restriction' ? 'None' : x === 'lax' ? 'Lax' : x === 'strict' ? 'Strict' : null; if (m) out.sameSite = m; }
  return out;
}
async function saveStorage(page) {
  const cookies = await page.cookies();
  const ls = await page.evaluate(() => { const o = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } } catch (e) {} return o; });
  const ss = await page.evaluate(() => { const o = {}; try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); } } catch (e) {} return o; });
  return { cookies, localStorage: ls, sessionStorage: ss, savedAt: Date.now() };
}
async function restoreStorage(page, storage) {
  if (!storage) return;
  if (Array.isArray(storage.cookies) && storage.cookies.length) { try { await page.setCookie(...storage.cookies); } catch (e) { log('setCookie warn', e.message); } }
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.evaluate((ls, ss) => {
    try { for (const k in ls) localStorage.setItem(k, ls[k]); } catch (e) {}
    try { for (const k in ss) sessionStorage.setItem(k, ss[k]); } catch (e) {}
  }, storage.localStorage || {}, storage.sessionStorage || {});
}

// ─── logged-in check ───
async function isLoggedIn(page) {
  try {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      const u = page.url();
      if (/\/login(\/|\?|$)/i.test(u)) return false;
      const verdict = await page.evaluate(() => {
        const txt = ((document.body && document.body.innerText) || '');
        if (/password/i.test(txt) && /log\s?in|sign\s?in/i.test(txt) && document.querySelector('input[type=password]')) return 'out';
        if (/CREDITS:/i.test(txt) || /M3U Line/i.test(txt) || /Dashboard/i.test(txt)) return 'in';
        return 'wait';
      }).catch(() => 'wait');
      if (verdict === 'in') return true;
      if (verdict === 'out') return false;
      await sleep(1000);
    }
    return false;
  } catch (e) { return false; }
}

// ─── login (Cloudflare Turnstile via 2captcha) — fallback path; warm session is primary ───
async function doLogin(page) {
  const acct = await getAccount();
  if (!acct.panel_user || !acct.panel_pass) throw new Error('panel credentials not set — POST /config {panel_user,panel_pass} first');
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await passCloudflare(page);   // clear the "Just a moment" interstitial; cf_clearance persists in the profile
  await sleep(2000);
  if (await isLoggedIn(page)) { const s = await saveStorage(page); await setAccount({ state: 'active', storage: s, heartbeat: true }); return true; }
  // diagnostics — capture exactly what the login page looks like through the proxy
  const diag = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map(i => ({ type: i.type, name: i.name || '', ph: i.placeholder || '' }));
    const buttons = [...document.querySelectorAll('button, input[type=submit]')].map(b => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 8);
    const skEl = document.querySelector('[data-sitekey]');
    const m = (document.documentElement.innerHTML || '').match(/sitekey["'\s:=]+([0-9a-zA-Z_-]{10,})/);
    return { url: location.href, title: document.title, inputs, buttons, sitekey: (skEl && skEl.getAttribute('data-sitekey')) || (m && m[1]) || null, cf: !!document.querySelector('.cf-turnstile, iframe[src*=turnstile], iframe[src*="challenges.cloudflare"]'), challenge: /just a moment|checking your browser|verify you are human|attention required/i.test(document.body.innerText || ''), snippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220) };
  }).catch(e => ({ err: e.message }));
  log('login diag', JSON.stringify(diag));
  // fill username + password (first text/email input, first password input)
  await page.evaluate((u, p) => {
    const setVal = (el, v) => { if (!el) return; const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const all = [...document.querySelectorAll('input')];
    const pass = all.find(x => x.type === 'password');
    const user = all.find(x => (x.type === 'text' || x.type === 'email') && x !== pass) || all.find(x => x !== pass);
    setVal(user, u); setVal(pass, p);
  }, acct.panel_user, acct.panel_pass);
  // solve Turnstile if present
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    const m = (document.documentElement.innerHTML || '').match(/sitekey["'\s:]+([0-9a-zA-Z_-]{10,})/);
    return m ? m[1] : null;
  });
  if (sitekey) {
    if (!captcha || !captcha.solveTurnstile) throw new Error('captchaService.solveTurnstile unavailable');
    log('solving Turnstile via 2captcha…', sitekey.slice(0, 10));
    const token = await captcha.solveTurnstile(sitekey, BASE + '/login');
    await page.evaluate((tok) => {
      const setResp = (name) => { let el = document.querySelector(`[name="${name}"]`); if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; (document.forms[0] || document.body).appendChild(el); } el.value = tok; el.dispatchEvent(new Event('input', { bubbles: true })); };
      setResp('cf-turnstile-response'); setResp('g-recaptcha-response');
      try { if (window.turnstile && typeof window.__cfCb === 'function') window.__cfCb(tok); } catch (e) {}
    }, token);
    await sleep(800);
  }
  // submit
  if (!await clickByText(page, ['login', 'log in', 'sign in', 'submit'], 'button, input[type=submit], [role=button]')) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  // wait for dashboard
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await passCloudflare(page).catch(() => {});   // a post-login CF check can appear
  const ok = await isLoggedIn(page);
  if (!ok) {
    await shot(page, 'login-fail');
    const post = await page.evaluate(() => ({ url: location.href, title: document.title, snippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220) })).catch(() => ({}));
    const err = new Error('login did not reach dashboard (check credentials / Turnstile)');
    err.diag = { before: diag, after: post };
    throw err;
  }
  const storage = await saveStorage(page);
  await setAccount({ state: 'active', storage, heartbeat: true });
  log('login OK, session persisted');
  return true;
}
// make sure we're logged in; restore persisted session first, log in only if needed
async function ensureLogin(page) {
  const acct = await getAccount();
  let storage = acct.storage_state;
  if (typeof storage === 'string') { try { storage = JSON.parse(storage); } catch (e) { storage = null; } }
  if (storage) { try { await restoreStorage(page, storage); } catch (e) {} }
  await page.goto(BASE + '/devices/m3u', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await passCloudflare(page).catch(() => {});   // clear interstitial if the cached clearance held but CF rechecked
  if (await isLoggedIn(page)) { const s = await saveStorage(page); await setAccount({ state: 'active', storage: s, heartbeat: true }); return true; }
  await setAccount({ state: 'needs_relogin' });
  return await doLogin(page);
}

// ─── read the current credits from the sidebar ───
async function readCredits(page) {
  return await page.evaluate(() => {
    const m = ((document.body && document.body.innerText) || '').match(/CREDITS:\s*([0-9]+(?:\.[0-9]+)?)/i);
    return m ? parseFloat(m[1]) : null;
  }).catch(() => null);
}

// ─── read a line row by username from the M3U list ───
async function readLineRow(page, username) {
  return await page.evaluate((uname) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const pick = (tr) => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim());
      // columns: STATUS | username | password | expire | seller | Link | Packages | online
      return { status: cells[0] || null, username: cells[1] || null, password: cells[2] || null, expiry: cells[3] || null, raw: cells.slice(0, 5) };
    };
    if (uname) { for (const tr of rows) { if ((tr.innerText || '').includes(uname)) return pick(tr); } return null; }
    return rows.length ? pick(rows[0]) : null;
  }, username || null).catch(() => null);
}

// ─── select a package via the Reka/Radix combobox (validated live) ───
// The native <select> is cosmetic and does NOT drive the Vue form; the real control is a
// [role=combobox] trigger that opens a [role=option] listbox, and it reacts to a full
// pointer-event sequence (pointerdown→mouseup→click), not a bare .click().
async function openPackageDropdown(page) {
  return await page.evaluate(() => {
    const fire = (el) => { const r = el.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2; for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) { const E = t.startsWith('pointer') ? PointerEvent : MouseEvent; el.dispatchEvent(new E(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 })); } };
    const cbs = [...document.querySelectorAll('[role=combobox]')];
    // the package trigger shows "Package" (or a chosen duration); skip the Country one ("Auto")
    let trig = cbs.find(c => { const t = (c.innerText || '').trim().toLowerCase(); return (t === 'package' || /month|year|day|trial/.test(t)) && t !== 'auto' && !/auto/.test(t); });
    if (!trig) trig = cbs.find(c => (c.innerText || '').trim().toLowerCase() !== 'auto');
    if (!trig) return false;
    if (trig.getAttribute('aria-expanded') !== 'true') fire(trig);
    return true;
  });
}
async function selectPackage(page, pkg) {
  const opened = await openPackageDropdown(page);
  if (!opened) return false;
  await sleep(700);
  const picked = await page.evaluate((want) => {
    const fire = (el) => { const r = el.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2; for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) { const E = t.startsWith('pointer') ? PointerEvent : MouseEvent; el.dispatchEvent(new E(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 })); } };
    const w = want.toLowerCase();
    const el = [...document.querySelectorAll('[role=option]')].find(o => (o.innerText || '').trim().toLowerCase().includes(w));
    if (!el) return false;
    fire(el);
    return true;
  }, pkg.label);
  await sleep(500);
  return picked;
}

// ─── create a line ───
async function createLine(opts) {
  opts = opts || {};
  const pkg = resolvePkg(opts.package);
  if (!pkg) return { ok: false, message: 'unknown package: ' + opts.package };
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await ensureLogin(page);
    await gotoPanel(page, BASE + '/devices/m3u/create', 2500);
    // username — the panel pre-fills a generated one. Keep it unless the caller supplied a username.
    // (Field is a typeless <input>, so match by IDL type, not the CSS [type=text] selector.)
    let username = (opts.username || '').trim();
    const existing = await page.evaluate(() => { const i = [...document.querySelectorAll('input')].find(x => x.type === 'text'); return i ? (i.value || '').trim() : ''; }).catch(() => '');
    if (!username) { username = existing || crypto.randomBytes(4).toString('hex'); }
    else {
      await page.evaluate((u) => {
        const i = [...document.querySelectorAll('input')].find(x => x.type === 'text'); if (!i) return;
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; d.call(i, u);
        i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
      }, username);
    }
    await sleep(400);
    // package
    const okPkg = await selectPackage(page, pkg);
    if (!okPkg) { await shot(page, 'create-nopkg'); throw new Error('could not select package'); }
    // bouquets — one-click set
    const acct = await getAccount();
    const bq = (acct.bouquet === 'noadult') ? ['all no adult', 'no adult'] : ['select all'];
    await clickByText(page, bq, 'button, [role=button]');
    await sleep(600);
    // save
    if (!await clickByText(page, ['save'], 'button, input[type=submit]')) { await shot(page, 'create-nosave'); throw new Error('could not find Save'); }
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(2500);
    // read the created line back from the list
    await gotoPanel(page, BASE + '/devices/m3u', 2000);
    const row = await readLineRow(page, username) || await readLineRow(page, null);
    if (!row || !row.username) { await shot(page, 'create-norow'); throw new Error('created, but could not read the new line — check the panel'); }
    const credits = await readCredits(page);
    const m3u = `${M3U_HOST}?username=${encodeURIComponent(row.username)}&password=${encodeURIComponent(row.password || '')}&type=m3u_plus`;
    await setAccount({ credits, heartbeat: true });
    await recordLine({ username: row.username, password: row.password, package: pkg.key, expiry: row.expiry, order_ref: opts.order_ref });
    log('created', row.username, pkg.key, 'exp', row.expiry, 'credits', credits);
    return { ok: true, username: row.username, password: row.password, expiry: row.expiry, status: row.status, package: pkg.key, m3u_url: m3u, credits };
  } catch (e) { return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── renew a line ───
async function renewLine(opts) {
  opts = opts || {};
  const username = (opts.username || '').trim();
  const pkg = resolvePkg(opts.package);
  if (!username) return { ok: false, message: 'username required' };
  if (!pkg) return { ok: false, message: 'unknown package: ' + opts.package };
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await ensureLogin(page);
    await gotoPanel(page, BASE + '/devices/m3u', 2000);
    // search to surface the row
    await page.evaluate((u) => {
      const s = document.querySelector('input[placeholder*="Search" i], input[type=search]');
      if (s) { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; d.call(s, u); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }
    }, username);
    await sleep(2500);
    const before = await readLineRow(page, username);
    if (!before) { await shot(page, 'renew-notfound'); throw new Error('line not found: ' + username); }
    // open the row ACTION (⋮) menu → Renew Subscription
    const openedMenu = await page.evaluate((u) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const tr = rows.find(r => (r.innerText || '').includes(u));
      if (!tr) return false;
      // the action trigger is the last cell's button (kebab)
      const btn = tr.querySelector('td:last-child button, td:last-child [role=button]') || Array.from(tr.querySelectorAll('button, [role=button]')).pop();
      if (btn) { btn.click(); return true; }
      return false;
    }, username);
    if (!openedMenu) { await shot(page, 'renew-nomenu'); throw new Error('could not open action menu'); }
    await sleep(900);
    if (!await clickByText(page, ['renew subscription', 'renew'], 'li, [role=menuitem], button, a, div, span')) { await shot(page, 'renew-noitem'); throw new Error('could not find Renew in the menu'); }
    await sleep(1200);
    // select package in the renew modal
    if (!await selectPackage(page, pkg)) { await shot(page, 'renew-nopkg'); throw new Error('could not select renew package'); }
    await sleep(400);
    if (!await clickByText(page, ['save'], 'button, input[type=submit]')) { await shot(page, 'renew-nosave'); throw new Error('could not find Save in renew modal'); }
    await sleep(3000);
    // re-read expiry
    await gotoPanel(page, BASE + '/devices/m3u', 2000);
    const after = await readLineRow(page, username);
    const credits = await readCredits(page);
    await setAccount({ credits, heartbeat: true });
    if (after) await recordLine({ username, password: after.password, package: pkg.key, expiry: after.expiry });
    log('renewed', username, pkg.key, 'exp', after && after.expiry, 'credits', credits);
    return { ok: true, username, expiry: after ? after.expiry : null, package: pkg.key, credits };
  } catch (e) { return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── search a line ───
async function searchLine(username) {
  username = (username || '').trim();
  if (!username) return { ok: false, message: 'username required' };
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await ensureLogin(page);
    await gotoPanel(page, BASE + '/devices/m3u', 2000);
    await page.evaluate((u) => {
      const s = document.querySelector('input[placeholder*="Search" i], input[type=search]');
      if (s) { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; d.call(s, u); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }
    }, username);
    await sleep(2500);
    const row = await readLineRow(page, username);
    const credits = await readCredits(page);
    await setAccount({ credits, heartbeat: true });
    if (!row) return { ok: true, found: false };
    const m3u = `${M3U_HOST}?username=${encodeURIComponent(row.username)}&password=${encodeURIComponent(row.password || '')}&type=m3u_plus`;
    return { ok: true, found: true, line: { username: row.username, password: row.password, expiry: row.expiry, status: row.status, m3u_url: m3u } };
  } catch (e) { return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── credits only (light) ───
async function getCredits() {
  await lock();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await ensureLogin(page);
    const credits = await readCredits(page);
    await setAccount({ credits, heartbeat: true });
    return { ok: true, credits };
  } catch (e) { return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── session import (capture the user's already-logged-in browser session) ───
async function sessionImport(body) {
  let cookies = body.cookies;
  if (typeof cookies === 'string') { try { cookies = JSON.parse(cookies); } catch (e) { return { ok: false, state: 'error', message: 'cookies not valid JSON' }; } }
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
    await page.goto(BASE + '/devices/m3u', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await passCloudflare(page).catch(() => {});
    if (!await isLoggedIn(page)) { await shot(page, 'import-notloggedin'); return { ok: false, state: 'error', message: 'Imported session is NOT logged in. Re-export bqpanel.com cookies while logged in.' }; }
    const fresh = await saveStorage(page);
    const credits = await readCredits(page);
    await setAccount({ state: 'active', storage: fresh, credits, heartbeat: true });
    log('session imported + verified (cookies:' + norm.length + ', credits ' + credits + ')');
    return { ok: true, state: 'active', message: 'Session imported — Lion panel is logged in.', credits };
  } catch (e) { return { ok: false, state: 'error', message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
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
  } catch (e) { return { ok: false, message: e.message }; }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// keep the session warm so it (almost) never expires → 2captcha rarely fires
async function keepAlive() {
  if (LOCK) return;
  await lock(30000).catch(() => { throw new Error('busy'); });
  const browser = await launch();
  try {
    const page = await newPage(browser);
    const acct = await getAccount();
    let storage = acct.storage_state; if (typeof storage === 'string') { try { storage = JSON.parse(storage); } catch (e) {} }
    if (storage) await restoreStorage(page, storage).catch(() => {});
    await page.goto(BASE + '/devices/m3u', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await passCloudflare(page).catch(() => {});
    if (await isLoggedIn(page)) {
      const fresh = await saveStorage(page); const credits = await readCredits(page);
      await setAccount({ state: 'active', storage: fresh, credits, heartbeat: true });
    } else {
      await setAccount({ state: 'needs_relogin' });
    }
  } catch (e) { log('keepAlive', e.message); }
  finally { try { await browser.close(); } catch (e) {} unlock(); }
}

// ─── HTTP ───
function readBody(req) { return new Promise(res => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { res({}); } }); }); }
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function isLocal(req) { const a = String(req.socket.remoteAddress || ''); return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }

const server = http.createServer(async (req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  const p = u.pathname;
  const token = u.searchParams.get('token') || req.headers['x-admin-token'] || '';
  try {
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    const acct = await getAccount();
    const ADMIN = acct.admin_token || '';
    if (!(isLocal(req) || (ADMIN && token === ADMIN))) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && p === '/status') { const a = await getAccount(); return send(res, 200, { state: a.state, credits: a.credits != null ? Number(a.credits) : null, proxy: a.proxy ? 'set' : (process.env.LION_PROXY ? 'env' : null), stealth: STEALTH, rebrowser: REBROWSER, hasCreds: !!(a.panel_user && a.panel_pass), bouquet: a.bouquet, lastHeartbeat: a.last_heartbeat || null }); }
    if (req.method === 'POST' && p === '/config') { const b = await readBody(req); const f = {}; for (const k of ['panel_user', 'panel_pass', 'proxy', 'base_url', 'bouquet']) if (k in b) f[k] = String(b[k]).trim(); if (!Object.keys(f).length) return send(res, 400, { ok: false, message: 'nothing to set' }); await setAccount(f); const a = await getAccount(); return send(res, 200, { ok: true, hasCreds: !!(a.panel_user && a.panel_pass), proxy: a.proxy ? 'set' : null, bouquet: a.bouquet }); }
    if (req.method === 'POST' && p === '/session/import') { const b = await readBody(req); try { return send(res, 200, await sessionImport(b)); } catch (e) { return send(res, 200, { ok: false, state: 'error', message: e.message }); } }
    if (req.method === 'POST' && p === '/login') { try { await lock(); const browser = await launch(); try { const page = await newPage(browser); await doLogin(page); return send(res, 200, { ok: true, state: 'active' }); } finally { try { await browser.close(); } catch (e) {} unlock(); } } catch (e) { return send(res, 200, { ok: false, message: e.message, diag: e.diag || null }); } }
    if (req.method === 'GET' && p === '/credits') { try { return send(res, 200, await getCredits()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && p === '/create') { const b = await readBody(req); try { return send(res, 200, await createLine(b)); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && p === '/renew') { const b = await readBody(req); try { return send(res, 200, await renewLine(b)); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'GET' && p === '/search') { try { return send(res, 200, await searchLine(u.searchParams.get('username'))); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    if (req.method === 'POST' && p === '/proxytest') { try { return send(res, 200, await proxyTest()); } catch (e) { return send(res, 200, { ok: false, message: e.message }); } }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 500, { error: e.message }); }
});

initDb().then(() => {
  server.listen(PORT, HOST, () => log('lion-engine listening on http://' + HOST + ':' + PORT + ' DISPLAY=' + process.env.DISPLAY));
  setInterval(() => keepAlive().catch(e => log('keepAlive throw', e.message)), KEEPALIVE_MS);
}).catch(e => { log('initDb failed', e.message); process.exit(1); });
