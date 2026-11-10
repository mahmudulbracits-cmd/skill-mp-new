const { redis, pipeline, KEY, send, guard, audit, diffDoc, histCmds } = require('./_lib');
const PIN = /^[A-Za-z0-9-]{1,40}$/;
const MAX_DOC = 80 * 1024, MAX_BATCH = 100;

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const s = guard(req, res); if (!s) return;
      const version = String(await redis(['GET', KEY.ver]) || '0');
      if (req.query.versionOnly) return send(res, 200, { version });
      const cursor = String(req.query.cursor || '0').replace(/\D/g, '') || '0';
      const [next, flat] = await redis(['HSCAN', KEY.emp, cursor, 'COUNT', '150']);
      const items = [];
      for (let i = 1; i < flat.length; i += 2) { try { items.push(JSON.parse(flat[i])); } catch (e) {} }
      return send(res, 200, { cursor: String(next), items, version });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (req.method === 'POST') {
      const s = guard(req, res, { role: 'editor', write: true }); if (!s) return;
      const docs = Array.isArray(body.docs) ? body.docs : [];
      if (!docs.length || docs.length > MAX_BATCH) return send(res, 400, { error: `Send between 1 and ${MAX_BATCH} profiles at a time.` });
      const note = String(body.note || '').slice(0, 120);
      const olds = await redis(['HMGET', KEY.emp, ...docs.map(d => String(d && d.pin || '_'))]);
      const cmds = [];
      for (const [i, d] of docs.entries()) {
        if (!d || typeof d !== 'object' || !PIN.test(String(d.pin || '')) || !String(d.name || '').trim()) return send(res, 400, { error: `Invalid profile (PIN ${d && d.pin}). PIN and name are required.` });
        const combined = String(d._combinedFrom || '').slice(0, 80); delete d._combinedFrom;
        const json = JSON.stringify({ ...d, pin: String(d.pin), updatedAt: new Date().toISOString(), updatedBy: s.n });
        if (json.length > MAX_DOC) return send(res, 400, { error: `Profile ${d.pin} is too large.` });
        cmds.push(['HSET', KEY.emp, String(d.pin), json]);
        let prev = null; try { prev = olds[i] ? JSON.parse(olds[i]) : null; } catch (e) {}
        cmds.push(...histCmds(String(d.pin), s, combined ? `Combined with ${combined} form` : note || (prev ? (docs.length > 1 ? 'Updated by import' : 'Edited') : (docs.length > 1 ? 'Added by import' : 'Added')), diffDoc(prev, d)));
      }
      cmds.push(['INCR', KEY.ver]);
      await pipeline(cmds);
      await audit(s, note ? 'bulk fix' : docs.length === 1 ? 'saved profile' : 'imported profiles', note ? note : docs.length === 1 ? `${docs[0].name} (${docs[0].pin})` : `${docs.length} profiles`);
      return send(res, 200, { saved: docs.length });
    }
    if (req.method === 'DELETE') {
      const s = guard(req, res, { role: 'editor', write: true }); if (!s) return;
      const pins = (Array.isArray(body.pins) ? body.pins : []).map(String).filter(p => PIN.test(p));
      if (!pins.length || pins.length > 600) return send(res, 400, { error: 'No valid PINs to delete.' });
      // Deleted profiles go to the recycle bin (sm:trash) for 30 days instead of being erased.
      const found = await redis(['HMGET', KEY.emp, ...pins]);
      const at = new Date().toISOString(), cmds = [];
      pins.forEach((p, i) => { if (found[i]) { let d = {}; try { d = JSON.parse(found[i]); } catch (e) {} cmds.push(['HSET', KEY.trash, p, JSON.stringify({ ...d, pin: p, deletedAt: at, deletedBy: s.n || '' })]); } });
      pins.forEach((p, i) => { if (found[i]) cmds.push(...histCmds(p, s, 'Moved to recycle bin')); });
      cmds.push(['HDEL', KEY.emp, ...pins], ['INCR', KEY.ver]);
      await pipeline(cmds);
      const names = pins.map((p, i) => { try { return JSON.parse(found[i]).name; } catch (e) { return ''; } });
      await audit(s, 'moved to recycle bin', pins.length === 1 ? `${names[0] || ''} (${pins[0]})` : `${pins.length} profiles`);
      return send(res, 200, { deleted: pins.length });
    }
    send(res, 405, { error: 'Method not allowed.' });
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
};
