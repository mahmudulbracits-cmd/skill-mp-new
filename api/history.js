const { redis, KEY, send, guard } = require('./_lib');
const PIN = /^[A-Za-z0-9-]{1,40}$/;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    const s = guard(req, res, { role: 'editor' }); if (!s) return;
    const pin = String(req.query.pin || '');
    if (!PIN.test(pin)) return send(res, 400, { error: 'Invalid PIN.' });
    const raw = (await redis(['LRANGE', KEY.hist + pin, '0', '49'])) || [];
    const items = []; raw.forEach(r => { try { items.push(JSON.parse(r)); } catch (e) {} });
    return send(res, 200, { items });
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
};
