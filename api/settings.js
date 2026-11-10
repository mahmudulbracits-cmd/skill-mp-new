const { redis, pipeline, KEY, send, guard, audit } = require('./_lib');
const MAX = 60 * 1024;

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const s = guard(req, res); if (!s) return;
      const raw = await redis(['GET', KEY.settings]);
      let settings = null; try { settings = raw ? JSON.parse(raw) : null; } catch (e) {}
      return send(res, 200, { settings });
    }
    if (req.method === 'PUT') {
      const s = guard(req, res, { role: 'editor', write: true }); if (!s) return;
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const st = body.settings;
      if (!st || typeof st !== 'object' || Array.isArray(st)) return send(res, 400, { error: 'No settings sent.' });
      if (st.families && !Array.isArray(st.families)) return send(res, 400, { error: 'Job families must be a list.' });
      const json = JSON.stringify({ ...st, updatedAt: new Date().toISOString(), updatedBy: s.n || '' });
      if (json.length > MAX) return send(res, 400, { error: 'Settings are too large.' });
      await pipeline([['SET', KEY.settings, json], ['INCR', KEY.ver]]);
      await audit(s, 'changed settings', 'Departments, job families, expectations or synonyms');
      return send(res, 200, { saved: true });
    }
    send(res, 405, { error: 'Method not allowed.' });
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
};
