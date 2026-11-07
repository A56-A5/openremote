#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createServer } = require('../server');
const push = require('../push');

const argv = process.argv.slice(2);
const cmd = ['start', 'tui', 'code', 'stop'].includes(argv[0]) ? argv.shift() : 'start';
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const WEB_PORT = +flag('port', 8080), OC_PORT = +flag('oc-port', 4096);
const DIR = path.resolve(flag('dir', process.cwd()));
const OC = `http://127.0.0.1:${OC_PORT}`, win = process.platform === 'win32';

// cloudflared: PATH first (system install), then ~/.local/bin (what install.sh puts there)
const which = (b) => {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, b);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
};
const CF_NAME = win ? 'cloudflared.exe' : 'cloudflared';
const CLOUDFLARED = which(CF_NAME) || (() => {
  const p = path.join(os.homedir(), '.local', 'bin', CF_NAME);
  return fs.existsSync(p) ? p : CF_NAME;
})();

// persistent config: 8-char pairing code (typed once on the phone) + your hosted page URL
const cfgFile = path.join(os.homedir(), '.openremote.json');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
if (!cfg.code || flag('new-code', false)) cfg.code = Array.from({ length: 8 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
if (flag('site', false) && flag('site', false) !== true) cfg.site = flag('site');
cfg.site = cfg.site || 'https://openremote-link.vercel.app';
fs.writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
const CODE = String(cfg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// public rendezvous topic derived from the code (the page computes the same hash)
const TOPIC = 'orl-' + crypto.createHash('sha256').update('orl:' + CODE).digest('hex').slice(0, 24);

const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const alive = () => new Promise(r => { const q = http.get(OC + '/session', s => { s.resume(); r(true); }); q.on('error', () => r(false)); q.setTimeout(1500, () => { q.destroy(); r(false); }); });
// is our own proxy already answering? 401 = alive (wrong/missing code), 200 = authenticated
const bridgeUp = () => new Promise(r => { const q = http.get(`http://127.0.0.1:${WEB_PORT}/api/session`, s => { s.resume(); r(s.statusCode === 200 || s.statusCode === 401); }); q.on('error', () => r(false)); q.setTimeout(1500, () => { q.destroy(); r(false); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PIDFILE = path.join(os.homedir(), '.openremote.pid');
const children = [];
const quit = () => { children.forEach(c => { try { c.kill(); } catch {} }); try { if (fs.readFileSync(PIDFILE, 'utf8') === String(process.pid)) fs.unlinkSync(PIDFILE); } catch {} process.exit(0); };
process.on('SIGINT', quit); process.on('SIGTERM', quit);

if (cmd === 'tui') spawn('opencode', ['attach', OC], { stdio: 'inherit', shell: win }).on('exit', c => process.exit(c || 0));
else if (cmd === 'code') console.log(CODE);
else if (cmd === 'stop') stopBridge();
else start().catch(e => { console.error(e.message); quit(); });

function stopBridge() {
  let pid = null;
  try { pid = +fs.readFileSync(PIDFILE, 'utf8'); } catch {}
  if (!pid || pid === process.pid) { console.log('bridge is not running'); process.exit(1); }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { console.error('could not signal pid ' + pid + ': ' + e.message); process.exit(1); }
  try { fs.unlinkSync(PIDFILE); } catch {}
  console.log('stopped bridge (pid ' + pid + ')');
  process.exit(0);
}

async function start() {
  // a second bridge would double-bind :WEB_PORT — if one is already answering, just bow out
  if (await bridgeUp()) { console.log(`openremote bridge already running on :${WEB_PORT}`); process.exit(0); }
  try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch {}
  if (await alive()) console.log(`✓ Reusing OpenCode server already running on :${OC_PORT}`);
  else {
    console.log(`… starting opencode serve in ${DIR}`);
    // visible when we were launched from a terminal window (the /openremote menu opens one);
    // still silent when launched detached in the background
    const oc = spawn('opencode', ['serve', '--port', String(OC_PORT), '--hostname', '127.0.0.1'],
      { cwd: DIR, stdio: process.stdout.isTTY ? ['ignore', 'inherit', 'inherit'] : 'ignore', shell: win });
    children.push(oc);
    oc.on('error', () => { console.error('Could not run `opencode`. Install it first: https://opencode.ai'); quit(); });
    for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
    if (!(await alive())) throw new Error('opencode serve did not start.');
  }
  startPromptWatcher();
  const srv = createServer({ upstream: OC, code: CODE, push });
  srv.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.log(`openremote bridge already running on :${WEB_PORT}`); process.exit(0); }
    console.error(e.message); quit();
  });
  srv.listen(WEB_PORT, flag('local', false) ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`\n📒 OpenRemote pairing code:  ${CODE}\n`);
    console.log(`📱 Phone: open ${cfg.site} and type the code (only needed once)`);
    lanIps().forEach(ip => console.log(`   same Wi-Fi: http://${ip}:${WEB_PORT}`));
    console.log(`💻 Computer, same session live:  opencode attach ${OC}   (project: ${DIR})\n`);
  });
  if (flag('no-tunnel', false)) return;
  const cf = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${WEB_PORT}`], { shell: win });
  children.push(cf);
  let done = false;
  const onData = d => {
    const m = !done && String(d).match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/);
    if (!m) return; done = true;
    const publish = () => fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', body: m[0] }).catch(() => console.log('⚠ could not reach ntfy.sh to announce the tunnel'));
    publish(); setInterval(publish, 20 * 60 * 1000);
    console.log(`🌍 Tunnel up: your phone finds it automatically from the code. No link to type.\n`);
  };
  cf.stdout.on('data', onData); cf.stderr.on('data', onData);
  cf.on('error', () => console.log(`ℹ cloudflared not found (looked on PATH and in ~/.local/bin) → same-Wi-Fi only. Re-run install.sh, or install it (free): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n`));
}

// poll OpenCode for pending prompts (permission requests + questions) and push to ntfy <topic>-p.
// the client subscribes via EventSource, which browsers don't throttle in background tabs —
// unlike the page's own setTimeout loop, which dies when the tab is unfocused.
function startPromptWatcher() {
  const seen = new Set();
  async function ocGet(p) {
    return new Promise(resolve => {
      const q = http.get(OC + p, s => {
        const chunks = [];
        s.on('data', c => chunks.push(c));
        s.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { resolve(null); } });
      });
      q.on('error', () => resolve(null));
      q.setTimeout(2000, () => { q.destroy(); resolve(null); });
    });
  }
  async function tick() {
    const [perms, qs] = await Promise.all([ocGet('/permission'), ocGet('/question')]);
    if (!perms && !qs) return;
    const prompts = [];
    for (const p of perms || []) {
      const id = String(p.id || '');
      if (id && !seen.has(id)) { seen.add(id); prompts.push({ id, title: (p.permission || p.title || 'Permission needed') + ' — OpenRemote', body: (p.patterns || []).join(', ') || 'OpenCode needs your permission' }); }
    }
    for (const q of qs || []) {
      const id = String(q.id || '');
      if (id && !seen.has(id)) { seen.add(id); const first = (q.questions || [])[0]?.question || 'OpenCode asks a question'; prompts.push({ id, title: `OpenCode needs you (${(q.questions || []).length} question${(q.questions || []).length > 1 ? 's' : ''})`, body: first }); }
    }
    // clean up resolved prompts so re-appearing ids notify again
    const current = new Set([...(perms || []), ...(qs || [])].map(x => String(x.id || '')));
    for (const id of seen) if (!current.has(id)) seen.delete(id);
    for (const p of prompts) {
      // 1) ntfy SSE — picked up by the page's EventSource while a tab is open (even unfocused)
      fetch('https://ntfy.sh/' + TOPIC + '-p', {
        method: 'POST',
        headers: { Title: p.title.slice(0, 250), Priority: 'high', Tags: 'bell' },
        body: p.body.slice(0, 500)
      }).catch(() => {});
      // 2) Web Push — delivered by the browser's push service even with the page closed
      push.broadcast({ title: p.title, body: p.body, tag: p.id, url: cfg.site || '/' }).catch(() => {});
    }
  }
  tick();
  setInterval(tick, 5000);
}
