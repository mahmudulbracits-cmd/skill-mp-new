const { clearSession, send } = require('./_lib');
module.exports = async (req, res) => { clearSession(res); send(res, 200, { ok: true }); };
