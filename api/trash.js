const { redis, pipeline, KEY, send, guard, audit, histCmds } = require('./_lib');
const PIN = /^[A-Za-z0-9-]{1,40}$/;
const KEEP_MS = 30 * 24 * 3600 * 1000;

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const s = guard(req, res, { role: 'editor' }); if (!s) return;
      const flat = (await redis(['HGETALL', KEY.trash])) || [];
      const items = [], expired = [];
      for (let i = 0; i < flat.length; i += 2) {
        try {
          const d = JSON.parse(flat[i + 1]);
          if (d.deletedAt && Date.now() - new Date(d.deletedAt).getTime() > KEEP_MS) expired.push(flat[i]);
          else items.push({ pin: flat[i], name: d.name, dept: d.dept, desig: d.desig, deletedAt: d.deletedAt, deletedBy: d.deletedBy });
        } catch (e) {}
      }
      if (expired.length) await redis(['HDEL', KEY.trash, ...expired]);
      return send(res, 200, { items });
    }
    if (req.method === 'POST') {
      const s = guard(req, res, { role: 'editor', write: true }); if (!s) return;
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const pins = (Array.isArray(body.pins) ? body.pins : []).map(String).filter(p => PIN.test(p)).slice(0, 600);
      if (!pins.length) return send(res, 400, { error: 'No valid PINs.' });
      if (body.action === 'restore') {
        const found = await redis(['HMGET', KEY.trash, ...pins]);
        const cmds = [], names = [];
        pins.forEach((p, i) => {
          if (!found[i]) return;
          let d; try { d = JSON.parse(found[i]); } catch (e) { return; }
          delete d.deletedAt; delete d.deletedBy;
          names.push(d.name);
          cmds.push(['HSET', KEY.emp, p, JSON.stringify({ ...d, pin: p, updatedAt: new Date().toISOString(), updatedBy: s.n })]);
          cmds.push(...histCmds(p, s, 'Restored from recycle bin'));
        });
        if (!cmds.length) return send(res, 404, { error: 'Not in the recycle bin.' });
        cmds.push(['HDEL', KEY.trash, ...pins], ['INCR', KEY.ver]);
        await pipeline(cmds);
        await audit(s, 'restored', names.length === 1 ? `${names[0]} (${pins[0]})` : `${names.length} profiles`);
        return send(res, 200, { restored: names.length });
      }
      if (body.action === 'purge') {
        await redis(['HDEL', KEY.trash, ...pins]);
        await audit(s, 'deleted for good', pins.length === 1 ? `PIN ${pins[0]}` : `${pins.length} profiles`);
        return send(res, 200, { purged: pins.length });
      }
      return send(res, 400, { error: 'Unknown action.' });
    }
    send(res, 405, { error: 'Method not allowed.' });
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
};
