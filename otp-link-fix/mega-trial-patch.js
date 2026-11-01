const fs=require('fs'),cp=require('child_process'),os=require('os'),path=require('path');
const BOT=process.argv[2];
function rd(p){return fs.readFileSync(p,'utf8');}
function cnt(h,n){let i=0,c=0;while((i=h.indexOf(n,i))!==-1){c++;i+=n.length;}return c;}
function once(s,old,label){const n=cnt(s,old);if(n!==1){console.error('ABORT ['+label+'] found '+n+' (need 1) — nothing written');process.exit(2);}}
function validate(content,label){const t=path.join(os.tmpdir(),'_v'+process.pid+Math.random().toString(36).slice(2)+'.js');fs.writeFileSync(t,content);try{cp.execSync('node --check '+t,{stdio:'pipe'});fs.unlinkSync(t);return true;}catch(e){try{fs.unlinkSync(t);}catch(_){}console.error('SYNTAX FAIL ['+label+']: '+String(e.stderr||e.message).split('\n').slice(0,3).join(' '));process.exit(4);}}

const W=BOT+'/src/services/webTrialWorker.js';
let w=rd(W);
once(w,'result = await iptvService.createTrialLine(job.panel_id, job.package_id);','worker call');
const wNew=w.replace('result = await iptvService.createTrialLine(job.panel_id, job.package_id);','result = await iptvService.createTrialLine(job.panel_id, job.package_id, job.type_label);');

const S=BOT+'/src/services/iptvService.js';
let s=rd(S);
const CRM='  // Standard CRM panels (Opplex, B1G) — auto-login non-captcha';
once(s,CRM,'CRM fallback');
const BRANCH=
"  // MEGA_WEBTRIAL_v1 — Mega is API-only (megaApi); route it here instead of the dead browser fallback\n"+
"  if (panelId === 'mega' || ptype === 'mega') {\n"+
"    const _mpkg = (!packageId || packageId === 'trial') ? (cfg.trialPackage || '13') : String(packageId);\n"+
"    return await createMegaLine(panelId, _mpkg, 'Trial', typeLabel || 'Family', String(typeLabel || '').toLowerCase() === 'adult');\n"+
"  }\n";
let s2=s.replace(CRM, BRANCH+CRM);
const RET='server: _r.dns, subscriptionId: _r.id, planLabel: planLabel,';
once(s2,RET,'mega return');
s2=s2.replace(RET,'server: _r.dns, expiry: _r.expiry, subscriptionId: _r.id, planLabel: planLabel,');

// mocks aren't standalone-valid, so only validate real files (BOT!=mock)
const doCheck = !/mock/.test(BOT);
if(doCheck){ validate(wNew,'webTrialWorker'); validate(s2,'iptvService'); }
fs.writeFileSync(W+'.bak-megatrial',w); fs.writeFileSync(W,wNew);
fs.writeFileSync(S+'.bak-megatrial',s); fs.writeFileSync(S,s2);
console.log('MEGA TRIAL FIX applied'+(doCheck?' + node --check passed':' (mock: skipped check)'));
