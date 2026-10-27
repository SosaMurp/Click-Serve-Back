const { fail } = require('../lib/http');

// Limitador en memoria por ventana deslizante (RNF-01/06). En producción con varias instancias
// debe sustituirse por uno compartido (Redis); el contrato de respuesta es el mismo.
const buckets = new Map();

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now - entry.last > entry.windowMs) buckets.delete(key);
  }
}, 60 * 1000);
cleanup.unref();

function rateLimit({ windowMs, max, keyFn = (req) => req.ip, message }) {
  return (req, res, next) => {
    const key = `${req.baseUrl}${req.route?.path || req.path}|${keyFn(req)}`;
    const now = Date.now();
    const entry = buckets.get(key) || { hits: [], windowMs, last: now };
    entry.hits = entry.hits.filter((t) => now - t < windowMs);
    entry.last = now;
    if (entry.hits.length >= max) {
      buckets.set(key, entry);
      res.set('Retry-After', String(Math.ceil((windowMs - (now - entry.hits[0])) / 1000)));
      return fail(res, 429, 'RATE_LIMITED', message || 'Demasiados intentos. Espera unos minutos e intenta de nuevo.');
    }
    entry.hits.push(now);
    buckets.set(key, entry);
    return next();
  };
}

const byIpAndEmail = (req) => `${req.ip}|${String(req.body?.email || req.body?.correo || '').trim().toLowerCase()}`;

module.exports = { rateLimit, byIpAndEmail };
