// Idempotent patcher: wires the Canva page into galaxydash. Run: node patch.js <tmpdir>
const fs = require('fs');
const path = require('path');
const DASH = '/opt/galaxydash';
const SRC = process.argv[2] || '.';
function backup(f){ const b=f+'.bak-canva'; if(fs.existsSync(f)&&!fs.existsSync(b)){ fs.copyFileSync(f,b); console.log('backup ->',path.basename(b)); } }

// 1) drop the three new files
fs.copyFileSync(path.join(SRC,'canva-routes.js'), path.join(DASH,'canva-routes.js'));
fs.copyFileSync(path.join(SRC,'canva.ejs'), path.join(DASH,'views','canva.ejs'));
fs.copyFileSync(path.join(SRC,'canva.js'), path.join(DASH,'public','js','canva.js'));
console.log('files: canva-routes.js, views/canva.ejs, public/js/canva.js');

// 2) nav link into header.ejs (after Prime Video Automation)
const HEADER = path.join(DASH,'views','partials','header.ejs');
let h = fs.readFileSync(HEADER,'utf8');
if (h.indexOf('CANVA_NAV_v1') < 0) {
  backup(HEADER);
  const anchor = 'Prime Video Automation</a>';
  const link = '\n    <a href="/canva" class="nav-item <%= path === \'/canva\' ? \'active\' : \'\' %>"><!--CANVA_NAV_v1--><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r="1.3"/><circle cx="17" cy="10.5" r="1.3"/><circle cx="8" cy="7" r="1.3"/><circle cx="6.5" cy="12.5" r="1.3"/><path d="M12 2C6.5 2 2 6 2 11c0 4 3 7 7 7 1 0 2-.6 2-1.6 0-1.4-1-1.5-1-2.4 0-1 .9-2 2-2h2c3 0 5-2 5-5 0-3.5-3.5-5-7-5Z"/></svg>Canva Education</a>';
  if (h.indexOf(anchor) >= 0) { h = h.replace(anchor, anchor + link); fs.writeFileSync(HEADER,h); console.log('nav link inserted after Prime Video Automation'); }
  else { console.log('WARN: Prime anchor not found — nav link NOT added (add manually)'); }
} else console.log('nav link already present — skipped');

// 3) require the routes in server.js (before app.listen)
const SERVER = path.join(DASH,'server.js');
let s = fs.readFileSync(SERVER,'utf8');
if (s.indexOf('canva-routes') < 0) {
  backup(SERVER);
  const line = "require('./canva-routes')(app, requireAuth); // CANVA_ROUTES_v1\n";
  const m = s.match(/\n[^\n]*app\.listen\s*\(/);
  if (m) { const at = s.indexOf(m[0]); s = s.slice(0,at+1) + line + s.slice(at+1); fs.writeFileSync(SERVER,s); console.log('routes wired before app.listen'); }
  else { s = s.replace(/\n?$/, '\n'+line); fs.writeFileSync(SERVER,s); console.log('routes appended at EOF (no app.listen match)'); }
} else console.log('routes already wired — skipped');

// 4) sanity: both edited files must still parse / exist
try { require('child_process').execSync('node --check '+SERVER, {stdio:'pipe'}); console.log('server.js syntax OK'); }
catch(e){ console.log('ERROR: server.js failed syntax check after patch:\n'+String(e.stderr||e.message)); process.exit(1); }
console.log('PATCH DONE');
