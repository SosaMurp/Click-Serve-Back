const jwt = require('jsonwebtoken');
const { isDevelopment } = require('./env');

let warned = false;

function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!isDevelopment()) throw new Error('JWT_SECRET es obligatorio fuera de desarrollo (NODE_ENV=development)');
  if (!warned) {
    warned = true;
    console.warn('AVISO: JWT_SECRET no está configurado; se usa una llave de desarrollo. Configúrala antes de publicar.');
  }
  return 'fallback_secret_key';
}

function signSession({ id_usuario, id_rol, version_sesion, sessionId }, expiresIn = '7d') {
  return jwt.sign({ id_usuario, id_rol, version_sesion: version_sesion || 1, sessionId }, jwtSecret(), { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret());
}

module.exports = { signSession, verifyToken, jwtSecret };
