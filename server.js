// Auth + CORS + reverse proxy in front of `opencode serve`. Zero dependencies.
// Auth = "Authorization: Bearer <pairing code>". The page itself (GET /) is public static HTML.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const push = require('./push');

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
};

const readBody = (req, limit = 64 * 1024) => new Promise((resolve) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size <= limit) chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => resolve(''));
});
const json = (res, obj, status = 200) => {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function createServer({ upstream, code }) {
  const up = new URL(upstream), want = norm(code), fails = new Map();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    const st = STATIC[url.pathname];
    if (st) {
      try {
        const body = fs.readFileSync(path.join(__dirname, 'public', st[0]));
        res.writeHead(200, { ...CORS, 'Content-Type': st[1], 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch { res.writeHead(404, CORS); return res.end('Not found'); }
    }

    if (url.pathname.startsWith('/api/')) {
      const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const f = fails.get(ip);
      if (f && f.n >= 8 && Date.now() - f.t < 600000) { res.writeHead(429, CORS); return res.end('Too many wrong codes. Wait 10 minutes.'); }
      const given = norm((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!given || !safeEq(given, want)) {
        fails.set(ip, { n: (f && Date.now() - f.t < 600000 ? f.n : 0) + 1, t: Date.now() });
        res.writeHead(401, CORS); return res.end('Wrong pairing code');
      }
      fails.delete(ip);

      // Web Push: the page registers a service worker, gets our VAPID key and hands us the
      // browser's subscription. Pushes then reach the phone even with the browser closed.
      if (url.pathname === '/api/push/key' || url.pathname === '/api/push/publicKey') {
        return json(res, { key: push.loadVapid().publicKey });
      }
      if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
        let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
        const sub = body && (body.subscription || body);
        return json(res, { ok: push.addSubscription(sub), devices: push.allSubscriptions().length });
      }
      if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
        let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
        if (body && body.endpoint) push.removeSubscription(body.endpoint);
        return json(res, { ok: true, devices: push.allSubscriptions().length });
      }
      if (url.pathname === '/api/push/test' && req.method === 'POST') {
        const sent = await push.broadcast({ title: 'OpenRemote', body: 'push notifications are working', tag: 'openremote-test', url: '/' });
        return json(res, { ok: sent > 0, sent });
      }

      const headers = { ...req.headers, host: up.host, 'accept-encoding': 'identity' };
      ['authorization', 'cookie', 'origin', 'referer'].forEach(k => delete headers[k]);
      const p = http.request({ host: up.hostname, port: up.port, path: req.url.slice(4), method: req.method, headers }, pr => {
        const h = { ...pr.headers };
        Object.keys(h).filter(k => k.startsWith('access-control-')).forEach(k => delete h[k]);
        res.writeHead(pr.statusCode, { ...h, ...CORS });
        pr.pipe(res);
      });
      p.on('error', () => { if (!res.headersSent) res.writeHead(502, CORS); res.end('OpenCode server unreachable'); });
      res.on('close', () => p.destroy());
      return req.pipe(p);
    }
    res.writeHead(404, CORS); res.end('Not found');
  });
}
module.exports = { createServer };
