// Auth + CORS + reverse proxy in front of `opencode serve`. Zero dependencies.
// Auth = "Authorization: Bearer <pairing code>". The page itself (GET /) is public static HTML.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function createServer({ upstream, code }) {
  const up = new URL(upstream), want = norm(code), fails = new Map();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
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
