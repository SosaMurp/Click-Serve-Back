// Compatibilidad: el middleware real (con códigos AUTH_*) está en src/middleware/auth.js.
const { auth } = require('../src/middleware/auth');

module.exports = auth;
