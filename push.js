// Minimal Web Push (RFC 8291 / RFC 8188) — VAPID keys, aes128gcm encryption, delivery.
// Zero dependencies: only Node's built-in crypto + fetch.
// Subscriptions live on this computer (~/.openremote-push-subs.json), so pushes reach the
// phone even when the browser is closed — no hosted backend involved.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VAPID_FILE = path.join(require('os').homedir(), '.openremote-vapid.json');
const SUBS_FILE = path.join(require('os').homedir(), '.openremote-push-subs.json');
const TTL = 24 * 3600; // seconds — push services drop after this

// ── VAPID keypair ──────────────────────────────────────────────────
let vapid = null;
function loadVapid() {
  if (vapid) return vapid;
  try {
    const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    if (saved && saved.publicKey && saved.privateKeyJwk) { vapid = saved; return vapid; }
  } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ type: 'spki', format: 'jwk' });
  const privJwk = privateKey.export({ type: 'pkcs8', format: 'jwk' });
  // applicationServerKey = raw uncompressed point (0x04 || x || y), base64url
  vapid = {
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(pubJwk.x, 'base64url'),
      Buffer.from(pubJwk.y, 'base64url'),
    ]).toString('base64url'),
    privateKeyJwk: privJwk,
  };
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 }); } catch {}
  return vapid;
}

function vapidPrivateKey() {
  return crypto.createPrivateKey({ key: loadVapid().privateKeyJwk, format: 'jwk' });
}

const b64u = (s) => Buffer.from(String(s), 'base64url');
const toB64u = (b) => Buffer.from(b).toString('base64url');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const expand = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

// SPKI DER for a raw uncompressed P-256 point (0x04 || x || y)
function rawToSpki(raw) {
  const header = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  return Buffer.concat([header, raw]);
}

// ── VAPID JWT (ES256 / ieee-p1363) ────────────────────────────────
function vapidJwt(audience) {
  const h = toB64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = toB64u(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:openremote@localhost',
  })));
  const input = h + '.' + p;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: vapidPrivateKey(), dsaEncoding: 'ieee-p1363' });
  return input + '.' + toB64u(sig);
}

// ── aes128gcm encryption (RFC 8188 + 8291) ───────────────────────
function encryptPush(subscription, plaintext) {
  const uaPublic = b64u(subscription.keys.p256dh); // 65 bytes: 0x04 || x || y
  const authSecret = b64u(subscription.keys.auth);  // 16 bytes

  // ephemeral (application server) key pair
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ephJwk = eph.publicKey.export({ type: 'spki', format: 'jwk' });
  const asPublic = Buffer.concat([Buffer.from([4]), b64u(ephJwk.x), b64u(ephJwk.y)]);

  // ECDH(as_private, ua_public)
  const uaPubKey = crypto.createPublicKey({ key: rawToSpki(uaPublic), format: 'der', type: 'spki' });
  const ecdhSecret = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: uaPubKey });

  // RFC 8291 §3.4: PRK = HKDF-Extract(auth_secret, ecdh_secret)
  const prk = hmac(authSecret, ecdhSecret);
  // IKM = HKDF-Expand(PRK, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = expand(prk, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const prk2 = hmac(salt, ikm);
  const cek = expand(prk2, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = expand(prk2, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 body: salt(16) || rs(uint32 BE) || idlen(1) || keyid || ciphertext+tag
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const idLen = Buffer.from([asPublic.length]);
  return Buffer.concat([salt, rs, idLen, asPublic, ct]);
}

// ── delivery ───────────────────────────────────────────────────────
async function sendPush(subscription, payload) {
  let enc;
  try { enc = encryptPush(subscription, Buffer.from(JSON.stringify(payload))); }
  catch (e) { console.error('[push] encrypt failed:', e.message); return false; }

  const audience = new URL(subscription.endpoint).origin;
  let jwt;
  try { jwt = vapidJwt(audience); }
  catch (e) { console.error('[push] vapid sign failed:', e.message); return false; }

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'TTL': String(TTL),
    'Urgency': 'high',
    'Authorization': `vapid t=${jwt}, k=${loadVapid().publicKey}`,
  };

  try {
    const res = await fetch(subscription.endpoint, { method: 'POST', headers, body: enc });
    if (res.status === 404 || res.status === 410) { removeSubscription(subscription.endpoint); return false; }
    if (!res.ok) console.error('[push]', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (e) { console.error('[push] send failed:', e.message); return false; }
}

// ── subscription store (persistent, keyed by endpoint) ────────────
let subs = null;
function loadSubs() {
  if (subs) return subs;
  try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch { subs = {}; }
  if (!subs || typeof subs !== 'object') subs = {};
  return subs;
}
function saveSubs() { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs), { mode: 0o600 }); } catch {} }
function addSubscription(sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
  loadSubs();
  subs[sub.endpoint] = { endpoint: sub.endpoint, keys: sub.keys, added: Date.now() };
  saveSubs();
  return true;
}
function removeSubscription(endpoint) {
  loadSubs();
  if (subs[endpoint]) { delete subs[endpoint]; saveSubs(); }
}
function allSubscriptions() { return Object.values(loadSubs()); }

// send to every stored subscription
async function broadcast(payload) {
  const list = allSubscriptions();
  if (!list.length) return 0;
  const results = await Promise.allSettled(list.map((s) => sendPush(s, payload)));
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

module.exports = { loadVapid, addSubscription, removeSubscription, allSubscriptions, sendPush, broadcast, encryptPush };
