const { createRemoteJWKSet, jwtVerify } = require('jose');

// Verificación de id_token de Google y Apple con las llaves públicas del proveedor (JWKS).
// Cada proveedor queda apagado mientras no exista su audiencia: GOOGLE_CLIENT_IDS (lista separada
// por comas: web, Android, iOS) o APPLE_BUNDLE_ID. Las URL de llaves se pueden cambiar para pruebas.
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

const PROVIDERS = {
  google: {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    jwksUrl: () => process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
    audience: () => list(process.env.GOOGLE_CLIENT_IDS),
  },
  apple: {
    issuer: 'https://appleid.apple.com',
    jwksUrl: () => process.env.APPLE_JWKS_URL || 'https://appleid.apple.com/auth/keys',
    audience: () => list(process.env.APPLE_BUNDLE_ID),
  },
};

const keySets = new Map();
function keySet(url) {
  if (!keySets.has(url)) keySets.set(url, createRemoteJWKSet(new URL(url)));
  return keySets.get(url);
}

function providerEnabled(name) {
  return PROVIDERS[name].audience().length > 0;
}

// Devuelve el payload si la firma, el emisor, la audiencia y la vigencia son válidos; si no, lanza.
async function verifyIdToken(name, token) {
  const p = PROVIDERS[name];
  const { payload } = await jwtVerify(String(token || ''), keySet(p.jwksUrl()), { issuer: p.issuer, audience: p.audience() });
  return payload;
}

module.exports = { providerEnabled, verifyIdToken };
