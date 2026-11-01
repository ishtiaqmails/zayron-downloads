// Canva Education dashboard routes — proxy to the local canva-engine (127.0.0.1:4010).
// Browser talks to galaxydash (behind requireAuth); galaxydash talks to the engine on
// localhost, which trusts localhost — so no token is exposed and port 4010 stays private.
const http = require('http');
const EHOST = '127.0.0.1', EPORT = 4010;
function engineReq(method, epath, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: EHOST, port: EPORT, path: epath, method, headers }, (resp) => {
      let b = ''; resp.on('data', d => b += d); resp.on('end', () => {
        try { resolve({ status: resp.statusCode || 500, json: JSON.parse(b || '{}') }); }
        catch (e) { resolve({ status: 502, json: { ok: false, message: 'bad engine response' } }); }
      });
    });
    r.on('error', (e) => resolve({ status: 502, json: { ok: false, message: 'engine unreachable: ' + e.message } }));
    r.setTimeout(240000, () => { try { r.destroy(); } catch (e) {} resolve({ status: 504, json: { ok: false, message: 'engine timeout' } }); });
    if (data) r.write(data); r.end();
  });
}
module.exports = function (app, requireAuth) {
  const pass = (res, r) => res.status(r.status || 200).json(r.json);
  app.get('/canva', requireAuth, (req, res) => res.render('canva', { path: '/canva' }));
  app.get('/canva/api/status',        requireAuth, async (req, res) => pass(res, await engineReq('GET', '/status')));
  app.get('/canva/api/code',          requireAuth, async (req, res) => pass(res, await engineReq('GET', req.query.refresh ? '/code/refresh' : '/code')));
  app.get('/canva/api/allow',         requireAuth, async (req, res) => pass(res, await engineReq('GET', '/allow')));
  app.post('/canva/api/allow',        requireAuth, async (req, res) => pass(res, await engineReq('POST', '/allow', req.body)));
  app.post('/canva/api/allow/remove', requireAuth, async (req, res) => pass(res, await engineReq('POST', '/allow/remove', req.body)));
  app.get('/canva/api/members',       requireAuth, async (req, res) => pass(res, await engineReq('GET', '/members')));
  app.get('/canva/api/reconcile',     requireAuth, async (req, res) => pass(res, await engineReq('GET', '/reconcile')));
  app.post('/canva/api/remove',       requireAuth, async (req, res) => pass(res, await engineReq('POST', '/remove', req.body)));
  app.post('/canva/api/remove/batch', requireAuth, async (req, res) => pass(res, await engineReq('POST', '/remove/batch', req.body)));
  app.get('/canva/api/remove/status', requireAuth, async (req, res) => pass(res, await engineReq('GET', '/remove/status')));
  app.get('/canva/api/reverify',      requireAuth, async (req, res) => pass(res, await engineReq('GET', '/reverify')));
  app.get('/canva/api/proxy/monitor', requireAuth, async (req, res) => pass(res, await engineReq('GET', '/proxy/monitor')));
  app.post('/canva/api/proxy/quota',  requireAuth, async (req, res) => pass(res, await engineReq('POST', '/proxy/quota', req.body)));
  app.post('/canva/api/proxy/reset',  requireAuth, async (req, res) => pass(res, await engineReq('POST', '/proxy/reset', req.body)));
  app.post('/canva/api/proxytest',    requireAuth, async (req, res) => pass(res, await engineReq('POST', '/proxytest', {})));
  app.get('/canva/api/botcfg',        requireAuth, async (req, res) => pass(res, await engineReq('GET', '/botcfg')));
  app.post('/canva/api/botcfg',       requireAuth, async (req, res) => pass(res, await engineReq('POST', '/botcfg', req.body)));
  app.post('/canva/api/resend',       requireAuth, async (req, res) => pass(res, await engineReq('POST', '/resend', req.body)));
  app.post('/canva/api/session/import', requireAuth, async (req, res) => pass(res, await engineReq('POST', '/session/import', req.body)));
  app.post('/canva/api/session/clear',  requireAuth, async (req, res) => pass(res, await engineReq('POST', '/session/clear', {})));
};
