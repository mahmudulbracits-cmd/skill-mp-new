const { redis, pipeline, KEY, safeEq, setSession, clientIp, send, assertConfig, SESSION_HOURS } = require('./_lib');
const MAX_FAILS = 25, WINDOW = 900; // 25 wrong attempts per 15 minutes per network (the whole office can share one IP)

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const missing = assertConfig();
  if (missing.length) return send(res, 500, { error: 'Server is not configured. Missing: ' + missing.join(', ') });
  if (req.headers['x-requested-with'] !== 'skillmap') return send(res, 403, { error: 'Request blocked.' });
  const ip = clientIp(req), fkey = KEY.fail + ip;
  const fails = Number(await redis(['GET', fkey]) || 0);
  if (fails >= MAX_FAILS) return send(res, 429, { error: 'Too many wrong attempts. Try again in 15 minutes.' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const pass = String(body.passcode || '');
  const name = String(body.name || '').trim().slice(0, 60);
  let role = null;
  if (pass && safeEq(pass, process.env.EDIT_PASSCODE)) role = 'editor';
  else if (pass && safeEq(pass, process.env.VIEW_PASSCODE)) role = 'viewer';
  if (!role) {
    await pipeline([['INCR', fkey], ['EXPIRE', fkey, String(WINDOW)]]);
    return send(res, 401, { error: 'That passcode is not right.' });
  }
  if (!name) return send(res, 400, { error: 'Enter your name so changes can be traced.' });
  await redis(['DEL', fkey]);
  setSession(res, { r: role, n: name, i: Date.now(), e: Date.now() + SESSION_HOURS * 3600 * 1000 });
  send(res, 200, { role, name, hours: SESSION_HOURS });
};
