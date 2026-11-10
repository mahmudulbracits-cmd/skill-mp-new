// Shared helpers for the Skill Map API (Vercel Node.js functions).
// Files starting with "_" inside /api are not exposed as routes.
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = { emp: 'sm:employees', ver: 'sm:version', audit: 'sm:audit', fail: 'sm:fail:', settings: 'sm:settings', trash: 'sm:trash', lists: 'sm:lists', hist: 'sm:hist:' };
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 8);
// Sessions slide forward while in use, but never last longer than this from sign-in.
const SESSION_MAX_HOURS = Number(process.env.SESSION_MAX_HOURS || 24);
const COOKIE = 'sm_session';

function assertConfig() {
  const missing = [];
  if (!REDIS_URL || !REDIS_TOKEN) missing.push('Redis (KV_REST_API_URL / KV_REST_API_TOKEN)');
  if (!process.env.VIEW_PASSCODE) missing.push('VIEW_PASSCODE');
  if (!process.env.EDIT_PASSCODE) missing.push('EDIT_PASSCODE');
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (32+ characters)');
  return missing;
}

async function redis(cmd) {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('Storage error: ' + (j.error || r.status));
  return j.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error('Storage error: ' + (j.error || r.status));
  const bad = j.find(x => x.error); if (bad) throw new Error('Storage error: ' + bad.error);
  return j.map(x => x.result);
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const b64u = buf => Buffer.from(buf).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest());
  return body + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const want = b64u(crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest());
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > Date.now() ? p : null; } catch (e) { return null; }
}
function readCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function setSession(res, payload) {
  const maxAge = SESSION_HOURS * 3600;
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(payload))}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`); }
function session(req) { return verify(readCookie(req, COOKIE)); }
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
// Every API call: config check, session check, CSRF header on writes.
function guard(req, res, { role = 'viewer', write = false } = {}) {
  const missing = assertConfig();
  if (missing.length) { send(res, 500, { error: 'Server is not configured. Missing: ' + missing.join(', ') }); return null; }
  if (write && req.headers['x-requested-with'] !== 'skillmap') { send(res, 403, { error: 'Request blocked.' }); return null; }
  const s = session(req);
  if (!s) { send(res, 401, { error: 'Not signed in.' }); return null; }
  if (role === 'editor' && s.r !== 'editor') { send(res, 403, { error: 'Only HR editors can do this.' }); return null; }
  // Sliding session: once half the session has passed, renew it (up to SESSION_MAX_HOURS after sign-in).
  const now = Date.now(), life = SESSION_HOURS * 3600 * 1000, issued = s.i || (s.e - life);
  if (s.e - now < life / 2 && now - issued < SESSION_MAX_HOURS * 3600 * 1000) setSession(res, { ...s, i: issued, e: Math.min(now + life, issued + SESSION_MAX_HOURS * 3600 * 1000) });
  return s;
}
async function audit(s, action, detail) {
  const entry = JSON.stringify({ at: new Date().toISOString(), by: s.n || 'Unnamed', role: s.r, action, detail });
  await pipeline([['LPUSH', KEY.audit, entry], ['LTRIM', KEY.audit, '0', '1999']]);
}
// Short, readable summary of what changed between two versions of a profile.
function diffDoc(o, n) {
  if (!o) return ['Profile created'];
  const ch = [], f = { name: 'Name', email: 'Email', dept: 'Department', desig: 'Designation', expBand: 'Experience' };
  for (const k of Object.keys(f)) if ((o[k] || '') !== (n[k] || '')) ch.push(`${f[k]}: ${o[k] || 'none'} → ${n[k] || 'none'}`);
  const om = {}, nm = {}; (o.skills || []).forEach(s => om[String(s.name).toLowerCase()] = s); (n.skills || []).forEach(s => nm[String(s.name).toLowerCase()] = s);
  const add = Object.keys(nm).filter(k => !om[k]), rem = Object.keys(om).filter(k => !nm[k]), lv = Object.keys(nm).filter(k => om[k] && om[k].level !== nm[k].level);
  if (add.length) ch.push(`+${add.length} skill${add.length > 1 ? 's' : ''} (${add.slice(0, 3).map(k => nm[k].name).join(', ')}${add.length > 3 ? '…' : ''})`);
  if (rem.length) ch.push(`−${rem.length} skill${rem.length > 1 ? 's' : ''} (${rem.slice(0, 3).map(k => om[k].name).join(', ')}${rem.length > 3 ? '…' : ''})`);
  if (lv.length) ch.push(`${lv.length} skill level${lv.length > 1 ? 's' : ''} changed`);
  for (const [k, l] of [['training', 'training entries'], ['education', 'education entries'], ['experience', 'jobs']]) if ((o[k] || []).length !== (n[k] || []).length) ch.push(`${l}: ${(o[k] || []).length} → ${(n[k] || []).length}`);
  if (!!o.unmapped !== !!n.unmapped) ch.push(n.unmapped ? 'Marked unmapped' : 'Survey data added');
  return ch.length ? ch : ['Saved with no changes'];
}
function histCmds(pin, s, action, changes) {
  const k = KEY.hist + pin;
  return [['LPUSH', k, JSON.stringify({ at: new Date().toISOString(), by: s.n || '', action, changes: changes || [] })], ['LTRIM', k, '0', '49']];
}
module.exports = { diffDoc, histCmds, redis, pipeline, KEY, safeEq, setSession, clearSession, session, clientIp, send, guard, audit, assertConfig, SESSION_HOURS };
