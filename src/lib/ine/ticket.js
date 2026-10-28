const crypto = require('crypto');
const { isDevelopment } = require('../env');
const { normalizeName } = require('./nombres');

// Ticket de verificación de la INE: lo emite POST /api/ine/verificar cuando una foto pasa todas las
// comprobaciones y lo exige POST /api/register. Va firmado (HMAC) y ligado al SHA-256 de la imagen,
// así no se puede verificar una foto y subir otra. Vence en 30 minutos.
const TTL_MS = 30 * 60 * 1000;

function secret() {
  const s = process.env.FILES_SECRET || process.env.JWT_SECRET;
  if (s) return s;
  if (!isDevelopment()) throw new Error('FILES_SECRET o JWT_SECRET es obligatorio fuera de desarrollo (NODE_ENV=development)');
  return 'click-serve-ine-desarrollo';
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

// Huella de los datos del registro con los que se verificó (nombre y fecha): si la persona los cambia
// después, el registro pide verificar de nuevo.
function registroKey({ nombre, apellidos, fecha_nacimiento }) {
  return sha256(`${normalizeName(`${nombre} ${apellidos}`)}|${String(fecha_nacimiento || '').slice(0, 10)}`);
}

function signTicket(payload, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + TTL_MS })).toString('base64url');
  return `${body}.${mac(body)}`;
}

function readTicket(token, now = Date.now()) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

module.exports = { signTicket, readTicket, registroKey, sha256 };
