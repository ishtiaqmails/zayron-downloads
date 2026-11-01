// canvaDelivery.js — Canva Education auto-delivery for the reseller bot.
// Delivers the join code to the customer after payment (in place of the vendor invite),
// handles on-demand resend keywords, and runs the join reminders + dashboard resend queue.
// All gated by bot_settings canva_enabled (default off) + canva_delivery_mode (engine|vendor).
const db = require('../db');
const http = require('http');
const logger = require('../utils/logger');
const { customerJid } = require('../utils/helpers');

const EHOST = '127.0.0.1', EPORT = 4010;
function engine(method, epath, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: EHOST, port: EPORT, path: epath, method, headers }, resp => {
      let b = ''; resp.on('data', d => b += d); resp.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({ ok: false, message: 'bad engine response' }); } });
    });
    r.on('error', e => resolve({ ok: false, message: e.message }));
    r.setTimeout(30000, () => { try { r.destroy(); } catch (e) {} resolve({ ok: false, message: 'engine timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function normPhone(p) { return String(p || '').replace(/[^0-9]/g, ''); }

async function cfg(key, def) { try { const r = await db.query("SELECT value FROM bot_settings WHERE key=$1", [key]); return r.rows.length ? r.rows[0].value : def; } catch (e) { return def; } }
async function isEnabled() { return String(await cfg('canva_enabled', '0')) === '1'; }
// auto-detect the Canva product: any vendor_invite product whose name mentions "Canva" — no manual ID needed
function isCanvaProduct(product) { return !!(product && product.delivery_type === 'vendor_invite' && /canva/i.test(String(product.name || ''))); }
async function isEngineOrder(product) { if (!(await isEnabled())) return false; return isCanvaProduct(product); }

function joinMsg(email, c) {
  let exp = '(reply "canva" for a fresh code)';
  if (c && c.expiresAt) {
    const d = new Date(c.expiresAt);
    const time = d.toLocaleString('en-US', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit', hour12: true });
    const date = d.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: '2-digit', year: 'numeric' });
    exp = time + ' · ' + date;
  }
  return [
    '🎨 *Canva Education — Activated*',
    '───────────',
    '',
    '👤 *Your email*',
    email,
    '',
    '🔑 *Join code*',
    '*' + ((c && c.code) || '') + '*',
    '',
    '📋 *How to join*',
    '1.  Open ' + ((c && c.joinLink) || 'https://www.canva.com/class/join'),
    '2.  Enter the code above',
    '3.  Sign in or sign up with your email above',
    '',
    '⚠️  Use that *exact* email — joining with any other email is removed automatically.',
    '',
    '⏳ *Code valid till:* ' + exp,
    '🔄 Code stopped working? Reply *canva* for a new one.',
    '',
    '✅ Full *Canva Pro* access for 1 year. Enjoy!'
  ].join('\n');
}

function joinedMsg(email, expiresAt) {
  let till = '';
  if (expiresAt) { const d = new Date(expiresAt); till = d.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: '2-digit', year: 'numeric' }); }
  return [
    '✅ *Canva Education — You’re in!*',
    '───────────',
    '',
    '🎉 ' + email + ' has joined successfully.',
    '',
    (till ? ('📅 *Active until:* ' + till + '  (1 year)') : '📅 *Active for 1 year*'),
    '',
    'You now have full *Canva Pro* features. Enjoy!'
  ].join('\n');
}

async function sendCodeTo(sock, jid, email, fresh) {
  const c = await engine('GET', fresh ? '/code/refresh' : '/code');
  if (!c.ok) { logger.error('canva code fetch failed', { err: c.message }); return { ok: false, message: c.message }; }
  await sock.sendMessage(jid, { text: joinMsg(email, c) });
  return { ok: true };
}

// called from inviteVendorService.notifyVendorForOrder when the order is a Canva engine order
async function deliver(sock, order, product) {
  let meta = {}; try { meta = JSON.parse(order.notes || '{}'); } catch (e) {}
  const emails = Array.isArray(meta.invite_emails) ? meta.invite_emails : [];
  if (!emails.length) return { ok: false, reason: 'no_emails' };
  const u = (await db.query('SELECT phone, lid FROM users WHERE id=$1', [order.user_id])).rows[0] || {};
  const jid = customerJid({ phone: u.phone, lid: u.lid }) || (normPhone(u.phone) + '@s.whatsapp.net');
  const phone = normPhone(u.phone);
  const prejoined = {};
  for (const e of emails) { const a = await engine('POST', '/allow', { email: e, source: 'order', order_ref: order.order_no, customer_phone: phone, note: 'bot order ' + order.order_no }); prejoined[String(e).trim().toLowerCase()] = !!(a && a.prejoined); }
  const c = await engine('GET', '/code');
  if (!c.ok) return { ok: false, reason: 'no_code', message: c.message };
  const yearLater = new Date(Date.now() + 365 * 86400000);
  for (const e of emails) { if (prejoined[String(e).trim().toLowerCase()]) await sock.sendMessage(jid, { text: joinedMsg(e, yearLater) }); else await sock.sendMessage(jid, { text: joinMsg(e, c) }); }
  const newMeta = Object.assign({}, meta, { invite_status: 'engine_delivered', invite_code: c.code, invite_delivered_at: new Date().toISOString(), invite_via: 'canva_engine' });
  try { await db.query('UPDATE orders SET notes=$1 WHERE id=$2', [JSON.stringify(newMeta), order.id]); } catch (e) {}
  try { await db.query('UPDATE canva_allowlist SET last_sent_at=NOW() WHERE email = ANY($1::text[])', [emails.map(x => String(x).trim().toLowerCase())]); } catch (e) {}
  logger.info('canva engine delivered', { order: order.order_no, emails: emails.length });
  try { const notif = require('./notificationService'); await notif.notifyOwner('🎨 *Canva order delivered (auto)*\n\n📦 Order: ' + order.order_no + '\n📧 Email: ' + emails.join(', ') + '\n✅ Code + join link sent to the customer.'); } catch (e) {}
  return { ok: true, delivered: emails.length };
}

// customer typed a keyword → resend a fresh code if they have a paid, not-yet-joined Canva order
async function maybeResendForText(sock, jid, phone, textLower) {
  if (!(await isEnabled())) return false;
  if (!['canva', 'canva code', 'get code', 'resend code', 'canva join', 'join code'].includes(textLower)) return false;
  const ph = normPhone(phone), suf = ph.slice(-10);
  // tolerant match: exact phone OR last-10-digits (handles country-code / LID differences)
  const r = await db.query("SELECT email, joined_at, expires_at FROM canva_allowlist WHERE (customer_phone=$1 OR right(customer_phone,10)=$2) AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY added_at DESC LIMIT 1", [ph, suf]);
  if (!r.rows.length) {
    // owner shortcut: let the owner pull the current code by texting "canva" (for testing / manual use)
    try { const ownerPhone = normPhone(require('../../config').owner.phone); if (ownerPhone && suf === ownerPhone.slice(-10)) { const c = await engine('GET', '/code'); if (c.ok) await sock.sendMessage(jid, { text: '🎨 *Canva join code*\n\n*' + (c.code || '') + '*\n' + (c.joinLink || 'https://www.canva.com/class/join') + '\n\n(Owner lookup — code rotates ~every 4h.)' }); return true; } } catch (e) {}
    return false;
  }
  const row = r.rows[0];
  if (row.joined_at) await sock.sendMessage(jid, { text: joinedMsg(row.email, row.expires_at) });
  else await sendCodeTo(sock, jid, row.email, true);
  return true;
}

// scheduler tick: (1) process dashboard "Resend" queue, (2) send join reminders (capped)
async function tick(sock) {
  if (!(await isEnabled())) return;
  try {
    const ob = (await db.query("SELECT id, kind, email, phone FROM canva_outbox WHERE status='queued' ORDER BY id ASC LIMIT 20")).rows;
    for (const row of ob) {
      const jid = normPhone(row.phone) + '@s.whatsapp.net';
      let r;
      if (row.kind === 'joined') { try { const er = (await db.query('SELECT expires_at FROM canva_allowlist WHERE email=$1', [row.email])).rows[0]; await sock.sendMessage(jid, { text: joinedMsg(row.email, er && er.expires_at) }); r = { ok: true }; } catch (e) { r = { ok: false }; } }
      else { r = await sendCodeTo(sock, jid, row.email, true); }
      await db.query('UPDATE canva_outbox SET status=$2, done_at=NOW() WHERE id=$1', [row.id, r.ok ? 'done' : 'failed']);
    }
  } catch (e) { logger.error('canva outbox', { err: e.message }); }
  try {
    const rows = (await db.query(
      "SELECT email, customer_phone FROM canva_allowlist WHERE source='order' AND joined_at IS NULL " +
      "AND customer_phone IS NOT NULL AND (expires_at IS NULL OR expires_at>NOW()) AND COALESCE(reminders_sent,0) < 3 " +
      "AND ( (COALESCE(reminders_sent,0)=0 AND (last_sent_at IS NULL OR last_sent_at < NOW()-INTERVAL '4 hours')) " +
      "   OR (COALESCE(reminders_sent,0)>=1 AND last_sent_at < NOW()-INTERVAL '20 hours') ) LIMIT 20"
    )).rows;
    if (rows.length) {
      const c = await engine('GET', '/code');
      if (c.ok) { for (const row of rows) { const jid = normPhone(row.customer_phone) + '@s.whatsapp.net'; await sock.sendMessage(jid, { text: '⏳ Reminder — you haven\'t joined Canva yet.\n\n' + joinMsg(row.email, c) }); await db.query('UPDATE canva_allowlist SET reminders_sent=COALESCE(reminders_sent,0)+1, last_sent_at=NOW() WHERE email=$1', [row.email]); } }
    }
  } catch (e) { logger.error('canva reminders', { err: e.message }); }
}

module.exports = { isEngineOrder, deliver, maybeResendForText, tick, sendCodeTo };
