// Training records API (L&D). Shares the Skill Map sign-in, roles and audit log.
// Collections are Redis hashes: one field per record, so a single edit never rewrites everything.
const { redis, pipeline, KEY, send, guard, audit } = require('./_lib');

const T = { sess: 'tr:sess', att: 'tr:att', ind: 'tr:ind', emp: 'tr:emp', plan: 'tr:plan', prog: 'tr:prog', course: 'tr:course', settings: 'tr:settings', ver: 'tr:ver', bin: 'tr:bin', hist: 'tr:h:' };
const COLLS = ['sess', 'att', 'ind', 'emp', 'plan', 'prog', 'course'];
const ID = /^[A-Za-z0-9._-]{1,60}$/;
const MAX_ITEM = { sess: 40 * 1024, att: 300 * 1024, ind: 8 * 1024, emp: 2 * 1024, plan: 8 * 1024, prog: 24 * 1024, course: 16 * 1024 };
const MAX_ITEMS = 1500, MAX_SETTINGS = 120 * 1024, CHUNK = 400 * 1024;
const LABEL = { sess: 'sessions', att: 'attendance lists', ind: 'individual trainings', emp: 'employee records', plan: 'plan items', prog: 'programmes', course: 'Academy courses' };

const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const toObj = flat => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) { const v = parse(flat[i + 1]); if (v !== null) o[flat[i]] = v; } return o; };
const keyOf = (coll, it) => String(coll === 'emp' ? it.pin : it.id || '');
const NAMES = { topic: 'topic', date: 'date', hours: 'hours', trainers: 'trainers', classType: 'format', category: 'category', kind: 'trainer type', feedbackCollected: 'feedback', links: 'evidence links', areas: 'skill areas', objective: 'objective', location: 'location', org: 'organisation', trainerDesig: 'trainer designation', profile: 'trainer profile',
  title: 'course', amount: 'amount', payStatus: 'payment', pin: 'PIN', name: 'name', desig: 'designation', dept: 'department', unit: 'unit', status: 'status', year: 'year', count: 'counts as training', type: 'training type', quarter: 'quarter', sessionId: 'linked session', nomPin: 'nominated by', email: 'email' };
// Plain-language list of what changed between two versions of a record.
function changed(o, n) {
  if (!o) return [];
  const keys = new Set([...Object.keys(o), ...Object.keys(n)].filter(k => !['updatedAt', 'updatedBy', 'manual', 'trainerPins', 'flags', 'dateText'].includes(k)));
  const out = [];
  for (const k of keys) if (JSON.stringify(o[k] ?? '') !== JSON.stringify(n[k] ?? '')) {
    const sv = v => Array.isArray(v) ? v.join(', ') : (v && typeof v === 'object' ? '' : String(v ?? ''));
    const a = sv(o[k]), b = sv(n[k]);
    out.push(a.length < 40 && b.length < 40 && (a || b) && typeof n[k] !== 'object' ? `${NAMES[k] || k}: ${a || 'none'} → ${b || 'none'}` : `${NAMES[k] || k} changed`);
  }
  return out.slice(0, 8);
}
const histCmd = (coll, id, s, action, changes) => [['LPUSH', T.hist + coll + ':' + id, JSON.stringify({ at: new Date().toISOString(), by: s.n || '', action, changes: changes || [] })], ['LTRIM', T.hist + coll + ':' + id, '0', '49']];

// Upstash limits a single request's size, so long command lists go in several pipelines.
async function chunked(cmds) {
  let batch = [], size = 0;
  for (const c of cmds) {
    const n = JSON.stringify(c).length;
    if (batch.length && size + n > CHUNK) { await pipeline(batch); batch = []; size = 0; }
    batch.push(c); size += n;
  }
  if (batch.length) await pipeline(batch);
}
function clean(coll, it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error('Each record must be an object.');
  const k = keyOf(coll, it);
  if (!ID.test(k)) throw new Error(`Invalid ${coll === 'emp' ? 'PIN' : 'ID'}: ${k || '(empty)'}`);
  if (coll === 'att' && !Array.isArray(it.rows)) throw new Error(`Attendance for ${k} needs a list of rows.`);
  const json = JSON.stringify(it);
  if (json.length > MAX_ITEM[coll]) throw new Error(`Record ${k} is too large.`);
  return [k, json];
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const s = guard(req, res); if (!s) return;
      if (req.query.versionOnly) return send(res, 200, { version: String(await redis(['GET', T.ver]) || '0') });
      if (req.query.hist) {
        const k = String(req.query.hist); if (!/^(sess|ind|emp|plan|prog|course):[A-Za-z0-9._-]{1,60}$/.test(k)) return send(res, 400, { error: 'Invalid record.' });
        const rows = await redis(['LRANGE', T.hist + k, '0', '49']);
        return send(res, 200, { items: (rows || []).map(parse).filter(Boolean) });
      }
      if (req.query.bin) {
        const s2 = guard(req, res, { role: 'editor' }); if (!s2) return;
        return send(res, 200, { items: Object.entries(toObj(await redis(['HGETALL', T.bin]))).map(([key, v]) => ({ key, ...v })) });
      }
      if (req.query.pin) {
        // One person's record, for the Skill Map profile. Includes old PINs that HR linked to this one.
        const pin = String(req.query.pin);
        const [sf, af, inf, st] = await pipeline([['HGETALL', T.sess], ['HGETALL', T.att], ['HGETALL', T.ind], ['GET', T.settings]]);
        const sess = toObj(sf), att = toObj(af), ind = toObj(inf), set = parse(st) || {};
        const alias = set.pinAlias || {}, pins = new Set([pin, ...Object.keys(alias).filter(k => alias[k] === pin)]);
        const out = [];
        for (const [id, a] of Object.entries(att)) {
          const r = (a.rows || []).find(r => pins.has(String(alias[r[0]] || r[0])) || pins.has(String(r[0])));
          const x = sess[id];
          if (r && x) out.push({ id, topic: x.topic, date: x.date, dateText: x.dateText, hours: Number(r[4] || x.hours || 0), category: x.category, classType: x.classType, kind: x.kind, trainers: x.trainers || [] });
        }
        const indv = Object.values(ind).filter(i => pins.has(String(alias[i.pin] || i.pin))).map(i => ({ id: i.id, title: i.title, type: i.type, kind: i.kind, year: i.year, count: i.count }));
        const trains = Object.values(sess).filter(x => (x.trainers || []).length && x.trainerPins && x.trainerPins.some(p => pins.has(String(p)))).map(x => ({ id: x.id, topic: x.topic, date: x.date }));
        out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
        return send(res, 200, { sessions: out, individual: indv, delivered: trains });
      }
      const [sf, af, inf, ef, pf, gf, cf, st, ver] = await pipeline([['HGETALL', T.sess], ['HGETALL', T.att], ['HGETALL', T.ind], ['HGETALL', T.emp], ['HGETALL', T.plan], ['HGETALL', T.prog], ['HGETALL', T.course], ['GET', T.settings], ['GET', T.ver]]);
      return send(res, 200, { sess: toObj(sf), att: toObj(af), ind: toObj(inf), emp: toObj(ef), plan: toObj(pf), prog: toObj(gf), course: toObj(cf), settings: parse(st) || {}, version: String(ver || '0') });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const s = guard(req, res, { role: 'editor', write: true }); if (!s) return;
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const act = String(body.action || '');

    if (act === 'put' || act === 'del') {
      const coll = String(body.coll || '');
      if (!COLLS.includes(coll)) return send(res, 400, { error: 'Unknown collection.' });
      const cmds = [];
      if (act === 'put') {
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length || items.length > MAX_ITEMS) return send(res, 400, { error: `Send between 1 and ${MAX_ITEMS} records at a time.` });
        const stamp = { updatedAt: new Date().toISOString(), updatedBy: s.n || '' };
        const keys = items.map(it => keyOf(coll, it || {}));
        // History is kept for hand edits and for imported sessions and courses (not for bulk employee-list refreshes).
        const track = coll !== 'att' && !(coll === 'emp' && body.quiet);
        const olds = track ? await redis(['HMGET', T[coll], ...keys.map(k => k || '_')]) : [];
        try {
          for (const [i, it] of items.entries()) {
            const rec = coll === 'emp' && !it.manual ? it : { ...it, ...stamp };
            const [k, json] = clean(coll, rec); cmds.push(['HSET', T[coll], k, json]);
            if (track) { const old = parse(olds[i]); const ch = changed(old, rec); if (!old || ch.length) cmds.push(...histCmd(coll, k, s, body.quiet ? (old ? 'Updated by import' : 'Added by import') : (old ? 'Edited' : 'Added'), ch)); }
            if (coll === 'att' && !body.quiet) cmds.push(...histCmd('sess', k, s, 'Attendance updated', [`${(it.rows || []).length} rows`].concat(body.note ? [String(body.note).slice(0, 120)] : [])));
          }
        } catch (e) { return send(res, 400, { error: e.message }); }
      } else {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => ID.test(x));
        if (!ids.length || ids.length > MAX_ITEMS) return send(res, 400, { error: 'No valid IDs to delete.' });
        // Deleted records go to the recycle bin (tr:bin) for 30 days instead of being erased.
        const [found, atts] = await pipeline([['HMGET', T[coll], ...ids], coll === 'sess' ? ['HMGET', T.att, ...ids] : ['GET', '_none']]);
        const at = new Date().toISOString();
        ids.forEach((id, i) => { if (!found[i]) return; cmds.push(['HSET', T.bin, coll + ':' + id, JSON.stringify({ coll, id, item: parse(found[i]), att: coll === 'sess' && atts ? parse(atts[i]) : null, deletedAt: at, deletedBy: s.n || '' })], ...histCmd(coll, id, s, 'Moved to recycle bin')); });
        cmds.push(['HDEL', T[coll], ...ids]);
        if (coll === 'sess') cmds.push(['HDEL', T.att, ...ids]);
      }
      cmds.push(['INCR', T.ver]);
      await chunked(cmds);
      if (!body.quiet) await audit(s, act === 'put' ? 'saved training data' : 'deleted training data', String(body.note || `${act === 'put' ? body.items.length : body.ids.length} ${LABEL[coll]}`).slice(0, 160));
      return send(res, 200, { ok: true });
    }

    if (act === 'settings') {
      const st = body.settings;
      if (!st || typeof st !== 'object' || Array.isArray(st)) return send(res, 400, { error: 'No settings sent.' });
      const json = JSON.stringify({ ...st, updatedAt: new Date().toISOString(), updatedBy: s.n || '' });
      if (json.length > MAX_SETTINGS) return send(res, 400, { error: 'Settings are too large.' });
      await pipeline([['SET', T.settings, json], ['INCR', T.ver]]);
      await audit(s, 'changed training settings', String(body.note || 'Links, trainer names or targets').slice(0, 160));
      return send(res, 200, { ok: true });
    }

    // Replace every record of the chosen years with the file's records (other years stay as they are).
    if (act === 'clearYears') {
      const years = (Array.isArray(body.years) ? body.years : []).map(String).filter(y => /^\d{4}$/.test(y));
      if (!years.length) return send(res, 400, { error: 'No years given.' });
      const [sf, inf] = await pipeline([['HGETALL', T.sess], ['HGETALL', T.ind]]);
      // Records created on the site (src: 'site') are never removed by a workbook import.
      const sIds = Object.entries(toObj(sf)).filter(([, v]) => years.includes(String(v.year)) && v.src !== 'site').map(([k]) => k);
      const iIds = Object.entries(toObj(inf)).filter(([, v]) => years.includes(String(v.year)) && v.src !== 'site').map(([k]) => k);
      const cmds = [];
      if (sIds.length) cmds.push(['HDEL', T.sess, ...sIds], ['HDEL', T.att, ...sIds]);
      if (iIds.length) cmds.push(['HDEL', T.ind, ...iIds]);
      cmds.push(['INCR', T.ver]);
      await chunked(cmds);
      return send(res, 200, { cleared: { sessions: sIds.length, individual: iIds.length } });
    }
    // Change a record's ID (sessions keep their attendance; plan items that point at the session follow it).
    if (act === 'rename') {
      const coll = String(body.coll || ''), from = String(body.from || ''), to = String(body.to || '');
      if (!['sess', 'ind'].includes(coll) || !ID.test(from) || !ID.test(to) || from === to) return send(res, 400, { error: 'Invalid ID.' });
      const [cur, taken, att, planF] = await pipeline([['HGET', T[coll], from], ['HEXISTS', T[coll], to], coll === 'sess' ? ['HGET', T.att, from] : ['GET', '_none'], coll === 'sess' ? ['HGETALL', T.plan] : ['GET', '_none']]);
      if (!cur) return send(res, 404, { error: `${from} was not found.` });
      if (taken) return send(res, 409, { error: `${to} is already used.` });
      const rec = { ...parse(cur), id: to }, cmds = [['HSET', T[coll], to, JSON.stringify(rec)], ['HDEL', T[coll], from]];
      if (coll === 'sess' && att) cmds.push(['HSET', T.att, to, att], ['HDEL', T.att, from]);
      if (coll === 'sess') Object.values(toObj(planF)).filter(p => p.sessionId === from).forEach(p => cmds.push(['HSET', T.plan, p.id, JSON.stringify({ ...p, sessionId: to })]));
      cmds.push(...histCmd(coll, to, s, 'ID changed', [`${from} → ${to}`]), ['INCR', T.ver]);
      await chunked(cmds);
      await audit(s, 'saved training data', `Changed ID ${from} to ${to}`);
      return send(res, 200, { ok: true });
    }
    if (act === 'restore' || act === 'purge') {
      const keys = (Array.isArray(body.keys) ? body.keys : []).map(String).filter(k => /^(sess|ind|emp|plan|prog|course):[A-Za-z0-9._-]{1,60}$/.test(k)).slice(0, 500);
      if (!keys.length) return send(res, 400, { error: 'Nothing selected.' });
      if (act === 'purge') { await chunked([['HDEL', T.bin, ...keys]]); await audit(s, 'emptied training recycle bin', `${keys.length} record${keys.length > 1 ? 's' : ''}`); return send(res, 200, { ok: true }); }
      const rows = await redis(['HMGET', T.bin, ...keys]), cmds = [], skipped = [];
      for (const [i, k] of keys.entries()) {
        const b = parse(rows[i]); if (!b || !b.item) continue;
        if (await redis(['HEXISTS', T[b.coll], b.id])) { skipped.push(b.id); continue; }
        cmds.push(['HSET', T[b.coll], b.id, JSON.stringify(b.item)]);
        if (b.coll === 'sess' && b.att) cmds.push(['HSET', T.att, b.id, JSON.stringify(b.att)]);
        cmds.push(['HDEL', T.bin, k], ...histCmd(b.coll, b.id, s, 'Restored from recycle bin'));
      }
      if (cmds.length) { cmds.push(['INCR', T.ver]); await chunked(cmds); }
      await audit(s, 'restored training data', `${keys.length - skipped.length} record${keys.length - skipped.length === 1 ? '' : 's'}`);
      return send(res, 200, { restored: keys.length - skipped.length, skipped });
    }
    if (act === 'importDone') {
      await audit(s, 'imported training workbook', String(body.note || '').slice(0, 160));
      return send(res, 200, { ok: true });
    }
    send(res, 400, { error: 'Unknown action.' });
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
};
