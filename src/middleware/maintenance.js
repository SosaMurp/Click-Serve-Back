const { fail } = require('../lib/http');

// RNF-42: con MAINTENANCE=1 toda la API responde 503 y la app muestra la pantalla de mantenimiento.
function maintenance(req, res, next) {
  if (process.env.MAINTENANCE === '1' && req.path.startsWith('/api')) {
    res.set('Retry-After', '600');
    return fail(res, 503, 'MAINTENANCE', 'Click & Serve está en mantenimiento. Vuelve a intentarlo en unos minutos.');
  }
  return next();
}

module.exports = { maintenance };
