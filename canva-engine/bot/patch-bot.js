// Patches galaxybot for Canva engine delivery. Idempotent. Restores backups on any syntax failure.
// Run: node patch-bot.js <tmpdir-with-canvaDelivery.js>
const fs = require('fs'), path = require('path'), cp = require('child_process');
const BOT = '/opt/galaxybot', SRC = process.argv[2] || '.';
const touched = [];
function backup(f){ const b=f+'.bak-canva'; if(fs.existsSync(f)&&!fs.existsSync(b)) fs.copyFileSync(f,b); }
function restoreAll(){ for(const f of touched){ const b=f+'.bak-canva'; if(fs.existsSync(b)) fs.copyFileSync(b,f); } }

// 0) drop the service
const svc = path.join(BOT,'src/services/canvaDelivery.js');
fs.copyFileSync(path.join(SRC,'canvaDelivery.js'), svc);
console.log('service: src/services/canvaDelivery.js');

// 1) inviteVendorService — engine delivery hook
const inv = path.join(BOT,'src/services/inviteVendorService.js');
let iv = fs.readFileSync(inv,'utf8');
if(iv.indexOf('CANVA_HOOK_v1')<0){
  backup(inv); touched.push(inv);
  const anchor = "if (product.delivery_type !== 'vendor_invite') return { ok: false, reason: 'not_invite_product' };";
  const hook = anchor + "\n  try { const canvaDelivery = require('./canvaDelivery'); if (await canvaDelivery.isEngineOrder(product)) { const _r = await canvaDelivery.deliver(sock, order, product); return { ok: !!_r.ok, reason: _r.ok ? 'canva_engine' : (_r.reason || 'canva_failed'), canva: true }; } } catch (e) { logger.error('canva deliver hook', { err: e.message }); } /*CANVA_HOOK_v1*/";
  if(iv.indexOf(anchor)<0){ console.log('ABORT: inviteVendorService anchor not found'); process.exit(1); }
  iv = iv.replace(anchor, hook); fs.writeFileSync(inv,iv); console.log('inviteVendorService: engine hook inserted');
} else console.log('inviteVendorService: already hooked — skipped');

// 2) scheduler — canva tick
const sch = path.join(BOT,'src/scheduler/index.js');
let sc = fs.readFileSync(sch,'utf8');
if(sc.indexOf('canva tick registered')<0){
  backup(sch); touched.push(sch);
  const anchor = "require('../utils/logger').info('SMM status worker registered');";
  const add = anchor + "\n  // CANVA_TICK_v1 — resend queue + join reminders (inert unless canva_enabled=1)\n  setInterval(async () => { try { const sock = global.__botSock; if (!sock) return; await require('../services/canvaDelivery').tick(sock); } catch (e) { logger.error('canva tick', { err: e.message }); } }, 60000);\n  require('../utils/logger').info('canva tick registered');";
  if(sc.indexOf(anchor)<0){ console.log('ABORT: scheduler anchor not found'); restoreAll(); process.exit(1); }
  sc = sc.replace(anchor, add); fs.writeFileSync(sch,sc); console.log('scheduler: canva tick inserted');
} else console.log('scheduler: already has canva tick — skipped');

// 3) handler — keyword resend hook + engine-mode owner-alert guards
const hnd = path.join(BOT,'src/bot/handler.js');
let hd = fs.readFileSync(hnd,'utf8');
let hchanged = false;
backup(hnd); touched.push(hnd);
// 3a) keyword hook before first global 'back'
if(hd.indexOf('CANVA_KEYWORD_v1')<0){
  const lines = hd.split('\n');
  const idx = lines.findIndex(l => l.trim() === "if (textLower === 'back') {");
  if(idx < 0){ console.log('ABORT: handler back-anchor not found'); restoreAll(); process.exit(1); }
  const indent = (lines[idx].match(/^\s*/)||[''])[0];
  lines.splice(idx, 0, indent + "// CANVA_KEYWORD_v1 — paid Canva customer can reply for a fresh join code\n" + indent + "try { const _cd = require('../services/canvaDelivery'); if (await _cd.maybeResendForText(sock, jid, phone, textLower)) return; } catch (e) {}");
  hd = lines.join('\n'); hchanged = true; console.log('handler: keyword hook inserted');
} else console.log('handler: keyword hook present');
// 3b) suppress the old invite owner-alerts for Canva engine orders
if(hd.indexOf('CANVA_ENGINE_FLAG_v1')<0){
  const a1 = "  // INVITE_CONFIRM_BRANCH_v1 — vendor_invite products have a custom delivery flow (no stock)\n  if (data.deliveryType === 'vendor_invite') {";
  if(hd.indexOf(a1)<0){ console.log('ABORT: confirm-branch anchor not found'); restoreAll(); process.exit(1); }
  hd = hd.replace(a1, a1 + "\n    const _canvaEngine = await (async () => { try { return await require('../services/canvaDelivery').isEngineOrder({ id: data.productId, delivery_type: data.deliveryType, name: data.productName }); } catch (e) { return false; } })(); /*CANVA_ENGINE_FLAG_v1*/");
  const a2 = "      await notificationService.notifyOwner(_im);";
  if(hd.indexOf(a2)>=0) hd = hd.replace(a2, "      if (!_canvaEngine) await notificationService.notifyOwner(_im);");
  const a3 = "    // Owner alert: order placed\n    try {";
  if(hd.indexOf(a3)>=0) hd = hd.replace(a3, "    // Owner alert: order placed\n    if (!_canvaEngine) try {");
  hchanged = true; console.log('handler: engine-mode owner guards applied');
} else console.log('handler: owner guards present');
if(hchanged) fs.writeFileSync(hnd, hd);

// 4) syntax-check everything; restore on any failure
const checks = [svc, inv, sch, hnd];
for(const f of checks){ try { cp.execSync('node --check '+f, {stdio:'pipe'}); } catch(e){ console.log('SYNTAX FAIL: '+f+'\n'+String(e.stderr||e.message)); restoreAll(); process.exit(1); } }
console.log('all syntax OK');
console.log('PATCH DONE');
