const express = require('express');
const bcrypt = require('bcrypt');
const { getPool } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { rateLimit, byIpAndEmail } = require('../middleware/rateLimit');
const { fail } = require('../lib/http');
const { audit } = require('../lib/audit');
const { findUserByEmail, findUserById, publicUser, createSession } = require('../services/users');

const router = express.Router();

// Hash ficticio para que el tiempo de respuesta no revele si el correo existe (RNF-01).
const DUMMY_HASH = bcrypt.hashSync('clave-ficticia-para-tiempo-constante', 10);
const INVALID = 'Credenciales incorrectas. Verifica tus datos e intenta nuevamente.';

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyFn: byIpAndEmail });

router.post('/api/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return fail(res, 400, 'VALIDATION_ERROR', 'Ingresa tu correo y contraseña.');

  const user = await findUserByEmail(email);
  const valid = await bcrypt.compare(password, user && !user.anonimizado ? user.contrasena : DUMMY_HASH);
  if (!user || user.anonimizado || !valid) {
    audit(req, 'LOGIN_FALLIDO', 'usuario', user?.id_usuario ?? null, { email });
    return fail(res, 401, 'INVALID_CREDENTIALS', INVALID);
  }

  if (user['2FA_Activo'] === true || user.totp_secreto) {
    const { rows } = await getPool().query(
      'INSERT INTO retos_2fa (id_usuario) VALUES ($1) RETURNING id_reto, expira',
      [user.id_usuario]
    );
    return res.status(200).json({
      requires2FA: true,
      reto: rows[0].id_reto,
      expira: rows[0].expira,
      correo: user.correo,
      mensaje: 'Ingresa el código de 6 dígitos de tu app autenticadora.',
    });
  }

  const { token } = await createSession(user, req);
  audit({ ...req, user: { id_usuario: user.id_usuario } }, 'LOGIN', 'usuario', user.id_usuario);
  return res.status(200).json({ mensaje: 'Inicio de sesión exitoso', usuario: publicUser(user), token });
});

router.get('/api/me', auth, async (req, res) => {
  const user = await findUserById(req.user.id_usuario);
  return res.json({ usuario: publicUser(user) });
});

router.post('/api/logout', auth, async (req, res) => {
  await getPool().query("UPDATE sesiones_activas SET estado = 'revocada' WHERE id_sesion = $1", [req.user.sessionId]);
  audit(req, 'LOGOUT', 'sesion', req.user.sessionId);
  return res.json({ mensaje: 'Sesión cerrada exitosamente en el servidor.' });
});

module.exports = router;
