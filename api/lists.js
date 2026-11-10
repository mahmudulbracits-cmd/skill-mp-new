const { redis, pipeline, KEY, send, guard, audit } = require('./_lib');
const ID = /^[A-Za-z0-9_-]{1,40}$/, PIN = /^[A-Za-z0-9-]{1,40}$/;

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const s = guard(req, res); if (!s) return;
      const flat = (await redis(['HGETALL', KEY.lists])) || [];
      const items = [];
      for (let i = 1; i < flat.length; i += 2) { try { items.push(JSON.parse(flat[i])); } catch (e) {} }
      return send(res, 200, { items });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (req.method === 'POST') {
      const s = guard(req, res, { role: 'editor', write: true }); if (!s) return;
      const l = body.list || {};
      if (!ID.test(String(l.id || ''))) return send(res, 400, { error: 'Invalid list id.' });
      const name = String(l.name || '').trim().slice(0, 80);
      if (!name) return send(res, 400, { error: 'Give the shortlist a name.' });
      const pins = [...new Set((Array.isArray(l.pins) ? l.pins : []).map(String).filter(p => PIN.test(p)))].slice(0, 1000);
      const clean = { id: l.id, name, note: String(l.note || '').slice(0, 500), pins, createdAt: l.createdAt || new Date().toISOString(), createdBy: String(l.createdBy || s.n || '').slice(0, 80), updatedAt: new Date().toISOString(), updatedBy: s.n || '' };
      const existed = await redis(['HEXISTS', KEY.lists, l.id]);
      await pipeline([['HSET', KEY.lists, l.id, JSON.stringify(clean)], ['INCR', KEY.ver]]);
      await audit(s, existed ? 'updated shortlist' : 'created shortlist', `${name} (${pins.length} people)`);
      return send(res, 200, { saved: true });
    }
    if (req.method === 'DELETE') {
      const s = guard(req, res, { role: 'editor', write: true }); if (!s) return;
      if (!ID.test(String(body.id || ''))) return send(res, 400, { error: 'Invalid list id.' });
      const old = await redis(['HGET', KEY.lists, body.id]);
      await pipeline([['HDEL', KEY.lists, body.id], ['INCR', KEY.ver]]);
      let nm = body.id; try { nm = JSON.parse(old).name; } catch (e) {}
      await audit(s, 'deleted shortlist', nm);
      return send(res, 200, { deleted: true });
    }
    send(res, 405, { error: 'Method not allowed.' });
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
};
