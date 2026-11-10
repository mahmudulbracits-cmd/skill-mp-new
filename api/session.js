const { guard, send } = require('./_lib');
module.exports = async (req, res) => {
  const s = guard(req, res); if (!s) return;
  send(res, 200, { role: s.r, name: s.n, expires: s.e });
};
