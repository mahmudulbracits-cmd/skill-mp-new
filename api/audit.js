const { redis, KEY, send, guard } = require('./_lib');
module.exports = async (req, res) => {
  try {
    const s = guard(req, res, { role: 'editor' }); if (!s) return;
    const rows = await redis(['LRANGE', KEY.audit, '0', '199']);
    send(res, 200, { items: rows.map(r => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean) });
  } catch (e) { send(res, 500, { error: e.message }); }
};
