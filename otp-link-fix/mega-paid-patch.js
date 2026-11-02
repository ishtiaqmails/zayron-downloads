const fs=require('fs'),cp=require('child_process'),os=require('os'),path=require('path');
const BOT=process.argv[2];
function rd(p){return fs.readFileSync(p,'utf8');}
function cnt(h,n){let i=0,c=0;while((i=h.indexOf(n,i))!==-1){c++;i+=n.length;}return c;}
function once(s,old,label){const n=cnt(s,old);if(n!==1){console.error('ABORT ['+label+'] found '+n+' (need 1) — nothing written');process.exit(2);}}
function validate(content,label){const t=path.join(os.tmpdir(),'_v'+process.pid+Math.random().toString(36).slice(2)+'.js');fs.writeFileSync(t,content);try{cp.execSync('node --check '+t,{stdio:'pipe'});fs.unlinkSync(t);}catch(e){try{fs.unlinkSync(t);}catch(_){}console.error('SYNTAX FAIL ['+label+']: '+String(e.stderr||e.message).split('\n').slice(0,3).join(' '));process.exit(4);}}

const W=BOT+'/src/services/webTrialWorker.js';
let w=rd(W);
once(w,'result = await iptvService.createPaidLine(job.panel_id, job.package_id);','worker paid call');
const wNew=w.replace('result = await iptvService.createPaidLine(job.panel_id, job.package_id);','result = await iptvService.createPaidLine(job.panel_id, job.package_id, job.type_label);');

const S=BOT+'/src/services/iptvService.js';
let s=rd(S);
const OLD='const createPaidLine = async (panelId, packageId, typeLabel) => {\n  return await createLine(panelId, String(packageId), false, typeLabel);\n};';
once(s,OLD,'createPaidLine');
const NEW='const createPaidLine = async (panelId, packageId, typeLabel) => {\n'+
"  // MEGA_WEBPAID_v1 — Mega is API-only; route paid lines through createMegaLine, not the dead browser path\n"+
"  if (panelId === 'mega') {\n"+
"    return await createMegaLine(panelId, String(packageId), 'Paid', typeLabel || 'Family', String(typeLabel || '').toLowerCase() === 'adult');\n"+
"  }\n"+
'  return await createLine(panelId, String(packageId), false, typeLabel);\n};';
const sNew=s.split(OLD).join(NEW);

const doCheck=!/mock/.test(BOT);
if(doCheck){ validate(wNew,'webTrialWorker'); validate(sNew,'iptvService'); }
fs.writeFileSync(W+'.bak-megapaid',w); fs.writeFileSync(W,wNew);
fs.writeFileSync(S+'.bak-megapaid',s); fs.writeFileSync(S,sNew);
console.log('MEGA PAID FIX applied'+(doCheck?' + node --check passed':' (mock: check skipped)'));
