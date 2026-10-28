const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const { fail } = require('../lib/http');
const { audit } = require('../lib/audit');
const { providerEnabled, verifyIdToken } = require('../lib/oidc');
const { findUserByEmail } = require('../services/users');
const { finishLogin } = require('../services/login');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

const NAMES = { google: 'Google', apple: 'Apple' };

// Inicio con Google o Apple: el servidor valida el id_token. Con un correo registrado abre la sesión
// (respetando 2FA); con uno nuevo devuelve los datos para prellenar el registro, que sigue exigiendo
// la verificación de la INE.
function socialLogin(proveedor, field) {
  return async (req, res) => {
    if (!providerEnabled(proveedor)) {
      return fail(res, 404, 'PROVIDER_DISABLED', `El inicio con ${NAMES[proveedor]} no está disponible.`);
    }
    let payload;
    try {
      payload = await verifyIdToken(proveedor, req.body?.[field]);
    } catch {
      return fail(res, 401, 'INVALID_TOKEN', `No pudimos validar tu cuenta de ${NAMES[proveedor]}. Intenta de nuevo.`);
    }
    const email = String(payload.email || '').trim().toLowerCase();
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    if (!email || !verified) {
      return fail(res, 401, 'INVALID_TOKEN', `Tu cuenta de ${NAMES[proveedor]} no tiene un correo verificado.`);
    }

    const user = await findUserByEmail(email);
    if (user && !user.anonimizado) return finishLogin(req, res, user);

    audit(req, 'REGISTRO_SOCIAL_INICIADO', 'usuario', null, { proveedor, email });
    return res.json({
      requiere_registro: true,
      email,
      nombre: String(payload.given_name || req.body?.nombre || '').trim(),
      apellidos: String(payload.family_name || req.body?.apellidos || '').trim(),
    });
  };
}

router.post('/api/auth/google', limiter, socialLogin('google', 'id_token'));
router.post('/api/auth/apple', limiter, socialLogin('apple', 'identity_token'));

module.exports = router;
