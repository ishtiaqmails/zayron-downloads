// Canva Education dashboard — client logic. Talks to /canva/api/* (proxied to the engine).
var CV = { code:'', link:'', exp:null, allow:[], members:[], unknown:[], authSet:{}, scanMode:'unknown', allowPage:1, scanPage:1, PAGE:12, selected:{}, polling:false };

function cvGet(p){ return fetch('/canva/api'+p,{headers:{'Accept':'application/json'}}).then(function(r){return r.json();}).catch(function(e){return {ok:false,message:String(e)};}); }
function cvPost(p,b){ return fetch('/canva/api'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json();}).catch(function(e){return {ok:false,message:String(e)};}); }
function cvEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }
function cvToast(t){ var e=document.getElementById('cv-toast'); e.textContent=t; e.className='cv-toast show'; clearTimeout(window.__cvtt); window.__cvtt=setTimeout(function(){e.className='cv-toast';},1800); }
function cvCopy(t){ if(!t){cvToast('Nothing to copy');return;} navigator.clipboard.writeText(t).then(function(){cvToast('Copied');},function(){cvToast('Copy failed');}); }
function cvWhen(iso){ if(!iso)return '—'; try{return new Date(iso).toLocaleString();}catch(e){return iso;} }
function cvAccess(x){ if(!x.expires_at) return '<span style="color:#059669;font-weight:700;">permanent</span>'; var ms=new Date(x.expires_at).getTime()-Date.now(); if(ms<=0) return '<span style="color:#dc2626;font-weight:700;">expired</span>'; var days=Math.ceil(ms/86400000); return '<span style="color:#6b7280;">ends '+new Date(x.expires_at).toLocaleDateString()+' · '+days+'d</span>'; }

function cvLoadStatus(){ cvGet('/status').then(function(s){
  document.getElementById('cv-s-state').textContent = s.state==='active'?'Active':(s.state||'—');
  document.getElementById('cv-s-state').style.color = s.state==='active'?'#059669':'#c2410c';
  document.getElementById('cv-acct-line').textContent = 'Brand '+(s.brand||'—')+' · proxy '+(s.proxy||'none')+' · checked '+cvWhen(s.lastHeartbeat);
}); }

function cvTickExp(){ var el=document.getElementById('cv-exp'); if(!CV.exp){el.textContent='';return;}
  var ms=new Date(CV.exp).getTime()-Date.now();
  if(ms<=0){el.innerHTML='<span style="color:#dc2626;font-weight:700;">Expired — press “Refresh code now”.</span>';return;}
  var h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);
  el.innerHTML='Valid until <b>'+new Date(CV.exp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</b> · about '+(h>0?h+'h ':'')+m+'m left';
}
function cvLoadCode(refresh){
  var box=document.getElementById('cv-code'); box.textContent='…';
  if(refresh)cvToast('Refreshing code…');
  cvGet('/code'+(refresh?'?refresh=1':'')).then(function(c){
    if(!c.ok){ box.textContent='unavailable'; document.getElementById('cv-exp').textContent=c.message||''; document.getElementById('cv-s-code').textContent='—'; return; }
    CV.code=c.code; CV.link=c.joinLink; CV.exp=c.expiresAt;
    box.textContent=c.code; document.getElementById('cv-s-code').textContent=c.code; cvTickExp();
  });
}

function cvBuildMsg(){
  var email=(document.getElementById('cv-cust').value||'').trim().toLowerCase();
  if(!email||email.indexOf('@')<1){cvToast('Enter a valid email');return;}
  cvPost('/allow',{email:email,source:'manual',note:'dashboard'}).then(function(){
    var exp=CV.exp?new Date(CV.exp).toLocaleString():'(press “Refresh code now”)';
    var msg='Welcome to Canva Education 🎨\n\nIMPORTANT — join with THIS exact email: '+email+'\n\nHow to join:\n1) Open this link: '+CV.link+'\n   (or go to canva.com/class/join and type the code)\n2) Join code: '+CV.code+'\n3) Sign in or sign up using the email above — it must match, or you will be removed.\n\nCode valid until: '+exp+'\n\nOnce you join you get full Canva Pro / Education features. Enjoy!';
    document.getElementById('cv-msg').value=msg;
    document.getElementById('cv-cust').value='';
    cvToast('Added to list + message ready'); cvLoadAllow();
  });
}

function cvLoadAllow(){ cvGet('/allow').then(function(r){ CV.allow=(r.allow||[]); CV.allowPage=1; cvRenderAllow(); }); }
function cvRenderAllow(){
  var q=(document.getElementById('cv-allow-search').value||'').trim().toLowerCase();
  var rows=CV.allow.filter(function(x){return !q||x.email.indexOf(q)>=0||String(x.order_ref||'').toLowerCase().indexOf(q)>=0;});
  document.getElementById('cv-allow-count').textContent=CV.allow.length;
  cvPage(rows, 'cv-allow-body', 'cv-allow-pager', CV.allowPage, 5, function(np){CV.allowPage=np;cvRenderAllow();}, function(x){
    var src=x.source==='order'?'<span class="cv-pill order">order</span>':'<span class="cv-pill">manual</span>';
    return '<tr><td>'+cvEsc(x.email)+'</td><td>'+src+(x.order_ref?' '+cvEsc(x.order_ref):'')+'</td><td style="color:#9ca3af;">'+cvWhen(x.added_at)+'</td><td>'+cvAccess(x)+'</td><td style="text-align:right;"><button class="cv-btn danger sm" onclick="cvDelAllow(\''+cvEsc(x.email)+'\')">Remove</button></td></tr>';
  });
}
function cvAddAllow(){
  var email=(document.getElementById('cv-add-email').value||'').trim().toLowerCase();
  if(!email||email.indexOf('@')<1){cvToast('Enter a valid email');return;}
  cvPost('/allow',{email:email,source:'manual'}).then(function(){ document.getElementById('cv-add-email').value=''; cvToast('Added'); cvLoadAllow(); });
}
function cvDelAllow(email){
  if(!confirm('Remove '+email+' from your authorised list?\n(This does NOT remove them from the Canva team.)'))return;
  cvPost('/allow/remove',{email:email}).then(function(){ cvToast('Removed from list'); cvLoadAllow(); cvComputeUnknown(); });
}

function cvTab(mode){ CV.scanMode=mode; CV.scanPage=1;
  document.getElementById('cv-tab-unknown').className='cv-tab'+(mode==='unknown'?' active':'');
  document.getElementById('cv-tab-all').className='cv-tab'+(mode==='all'?' active':'');
  cvRenderScan();
}
function cvComputeUnknown(){
  var set={}; CV.allow.forEach(function(x){set[x.email]=1;});
  CV.unknown=CV.members.filter(function(m){return m.role==='MEMBER'&&m.email&&!set[m.email];});
  document.getElementById('cv-s-unknown').textContent=CV.unknown.length;
}
function cvScan(){
  var btn=document.getElementById('cv-scan-btn'); btn.disabled=true; btn.textContent='Scanning…';
  document.getElementById('cv-scan-meta').textContent='Reading the team live from Canva (about 20s)…';
  Promise.all([cvGet('/members'), cvGet('/allow')]).then(function(res){
    var mem=res[0], al=res[1]; btn.disabled=false; btn.textContent='Scan team now';
    if(!mem.ok){ document.getElementById('cv-scan-meta').textContent=mem.message||'Could not read team'; return; }
    CV.members=mem.members||[]; CV.allow=al.allow||[]; cvComputeUnknown();
    document.getElementById('cv-s-members').textContent=CV.members.length;
    document.getElementById('cv-scan-meta').innerHTML='Team <b>'+CV.members.length+'</b> · authorised <b>'+CV.allow.length+'</b> · not on list <b>'+CV.unknown.length+'</b>';
    CV.scanPage=1; cvRenderScan(); cvRenderAllow();
  });
}
function cvScanRows(){
  var q=(document.getElementById('cv-scan-search').value||'').trim().toLowerCase();
  var base=CV.scanMode==='all'?CV.members:CV.unknown;
  return base.filter(function(m){return !q||String(m.email||'').indexOf(q)>=0||String(m.name||'').toLowerCase().indexOf(q)>=0;});
}
function cvRenderScan(){
  cvPage(cvScanRows(), 'cv-scan-body', 'cv-scan-pager', CV.scanPage, 5, function(np){CV.scanPage=np;cvRenderScan();}, function(m){
    var owner=m.role==='OWNER';
    var role=owner?'<span class="cv-pill order">owner</span>':'<span class="cv-pill">member</span>';
    var e=cvEsc(m.email);
    var chk=owner?'':'<input type="checkbox" '+(CV.selected[m.email]?'checked':'')+' onclick="cvToggleRow(\''+e+'\',this)">';
    var act=owner?'<span style="color:#9ca3af;font-size:12px;">protected</span>'
      :'<button class="cv-btn safe sm" onclick="cvMarkSafe(\''+e+'\')">Keep</button> <button class="cv-btn danger sm" onclick="cvRemove(\''+e+'\',this)">Remove</button>';
    return '<tr><td>'+chk+'</td><td>'+e+'</td><td style="color:#6b7280;">'+cvEsc(m.name||'')+'</td><td>'+role+'</td><td style="text-align:right;white-space:nowrap;">'+act+'</td></tr>';
  });
  cvBulkBar();
}
function cvToggleRow(email,el){ if(el.checked)CV.selected[email]=1; else delete CV.selected[email]; cvBulkBar(); }
function cvCheckAll(el){ cvScanRows().filter(function(m){return m.role!=='OWNER';}).forEach(function(m){ if(el.checked)CV.selected[m.email]=1; else delete CV.selected[m.email]; }); cvRenderScan(); }
function cvSelectedEmails(){ return Object.keys(CV.selected); }
function cvBulkBar(){ var n=cvSelectedEmails().length; var bar=document.getElementById('cv-bulk'); if(!bar)return; if(n||CV.polling)bar.style.display='flex'; else bar.style.display='none'; var c=document.getElementById('cv-bulk-count'); if(c)c.textContent=n+' selected'; }
function cvBulkSafe(){ var em=cvSelectedEmails(); if(!em.length){cvToast('Tick some rows first');return;} Promise.all(em.map(function(e){return cvPost('/allow',{email:e,source:'manual',note:'kept (known)'});})).then(function(){ cvToast('Kept '+em.length+' — added to your list'); CV.selected={}; cvLoadAllow(); cvComputeUnknown(); cvRenderScan(); }); }
function cvBulkRemove(){ var em=cvSelectedEmails(); if(!em.length){cvToast('Tick some rows first');return;} if(!confirm('Approve removal of '+em.length+' member(s) from the Canva team?\nThe engine removes them one-by-one in the background — you don\'t have to wait.'))return; cvPost('/remove/batch',{emails:em}).then(function(r){ if(!r.ok){cvToast(r.message||'Could not queue');return;} cvToast('Approved — removing '+r.queued+' in the background'); CV.selected={}; cvRenderScan(); cvPollQueue(); }); }
function cvPollQueue(){ if(CV.polling)return; CV.polling=true; cvBulkBar();
  var tick=function(){ cvGet('/remove/status').then(function(s){ var line=document.getElementById('cv-queue-line'); if(!s.ok){CV.polling=false;cvBulkBar();return;} var c=s.counts||{}; var pending=(c.queued||0)+(c.working||0);
    if(line)line.innerHTML='Removing — working '+(c.working||0)+', waiting '+(c.queued||0)+', done '+(c.done||0)+(c.failed?(', failed '+c.failed):'');
    if(pending>0){ setTimeout(tick,5000); } else { CV.polling=false; cvToast('Background removal finished'); cvScan(); } }).catch(function(){CV.polling=false;}); };
  tick();
}
function cvMarkSafe(email){ cvPost('/allow',{email:email,source:'manual',note:'marked safe'}).then(function(){ cvToast('Marked safe — kept'); cvLoadAllow(); cvComputeUnknown(); cvRenderScan(); }); }
function cvRemove(email,btn){
  if(!confirm('Remove '+email+' from the Canva team? This frees their seat.'))return;
  btn.disabled=true; btn.textContent='Removing…'; cvToast('Removing — up to ~3 min…');
  cvPost('/remove',{email:email}).then(function(r){
    if(r.ok&&r.removed){ cvToast('Removed from team'); CV.members=CV.members.filter(function(m){return m.email!==email;}); cvComputeUnknown(); document.getElementById('cv-s-members').textContent=CV.members.length; }
    else { cvToast(r.message||'Remove failed'); btn.disabled=false; btn.textContent='Remove'; }
    cvRenderScan();
  });
}

// generic paginator: list, tbody id, pager id, page, colspan, onPage(fn), rowHtml(fn)
function cvPage(list, bodyId, pagerId, page, cols, onPage, rowFn){
  var body=document.getElementById(bodyId), pager=document.getElementById(pagerId);
  var total=list.length, pages=Math.max(1,Math.ceil(total/CV.PAGE)); if(page>pages)page=pages;
  var start=(page-1)*CV.PAGE, slice=list.slice(start,start+CV.PAGE);
  if(!total){ body.innerHTML='<tr><td class="cv-empty" colspan="'+cols+'">Nothing to show.</td></tr>'; pager.innerHTML=''; return; }
  body.innerHTML=slice.map(rowFn).join('');
  pager.innerHTML='Showing '+(start+1)+'–'+(start+slice.length)+' of '+total+' &nbsp; '
    +'<button class="cv-btn ghost sm" id="'+pagerId+'-prev" '+(page<=1?'disabled':'')+'>◀ Prev</button>'
    +' Page '+page+' / '+pages+' '
    +'<button class="cv-btn ghost sm" id="'+pagerId+'-next" '+(page>=pages?'disabled':'')+'>Next ▶</button>';
  var pv=document.getElementById(pagerId+'-prev'), nx=document.getElementById(pagerId+'-next');
  if(pv)pv.onclick=function(){onPage(page-1);}; if(nx)nx.onclick=function(){onPage(page+1);};
}

cvLoadStatus(); cvLoadCode(false); cvLoadAllow();
setInterval(cvTickExp, 30000); setInterval(cvLoadStatus, 60000);
