const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getPool, withTransaction } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { rateLimit, byIpAndEmail } = require('../middleware/rateLimit');
const { fail } = require('../lib/http');
const { audit } = require('../lib/audit');
const { sanitizeText } = require('../lib/sanitize');
const { isEmail, isStrongPassword, isPhoneMx, onlyDigits } = require('../lib/validators');
const { verifyTotp } = require('../lib/totp');
const { sendCode, sendMail } = require('../lib/mailer');
const { saveFile, uploader, IMAGE_TYPES } = require('../lib/files');
const { signSession } = require('../lib/tokens');
const { findUserByEmail, findUserById, publicUser, createSession } = require('../services/users');
const { finishLogin } = require('../services/login');

const router = express.Router();

// Hash ficticio para que el tiempo de respuesta no revele si el correo existe (RNF-01).
const DUMMY_HASH = bcrypt.hashSync('clave-ficticia-para-tiempo-constante', 10);
const INVALID = 'Credenciales incorrectas. Verifica tus datos e intenta nuevamente.';
const WEAK = 'La contraseña debe tener al menos 8 caracteres, con mayúscula, minúscula y número.';
const MAX_CODE_ATTEMPTS = 5;

const minutes = (n) => n * 60 * 1000;
const loginLimiter = rateLimit({ windowMs: minutes(15), max: 10, keyFn: byIpAndEmail });
const codeLimiter = rateLimit({ windowMs: minutes(15), max: 10, keyFn: byIpAndEmail });
const sendLimiter = rateLimit({ windowMs: minutes(10), max: 4, keyFn: byIpAndEmail, message: 'Ya enviamos varios códigos. Espera unos minutos antes de pedir otro.' });
const registerLimiter = rateLimit({ windowMs: minutes(60), max: 10 });

const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const normEmail = (value) => String(value || '').trim().toLowerCase();

async function issueCode(db, idUsuario, tipo, canal = 'EMAIL') {
  await db.query(
    `UPDATE tokens_temporales SET estado_uso = 'expirado'
     WHERE id_usuario = $1 AND tipo_accion = $2 AND estado_uso IN ('sin usar', 'verificado')`,
    [idUsuario, tipo]
  );
  const code = newCode();
  await db.query(
    `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso, canal) VALUES ($1, $2, $3, 'sin usar', $4)`,
    [idUsuario, code, tipo, canal]
  );
  return code;
}

// Valida un código de un solo uso: vigente (15 min), sin usar y con máximo 5 intentos fallidos.
async function checkCode(db, idUsuario, tipo, code) {
  const { rows } = await db.query(
    `SELECT id_token, token, intentos FROM tokens_temporales
     WHERE id_usuario = $1 AND tipo_accion = $2 AND estado_uso = 'sin usar' AND fecha_expiracion > NOW()
     ORDER BY id_token DESC LIMIT 1`,
    [idUsuario, tipo]
  );
  const row = rows[0];
  if (!row) return null;
  const given = onlyDigits(code);
  const ok = given.length === row.token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.token));
  if (!ok) {
    await db.query(
      `UPDATE tokens_temporales SET intentos = intentos + 1,
         estado_uso = CASE WHEN intentos + 1 >= $2 THEN 'expirado' ELSE estado_uso END
       WHERE id_token = $1`,
      [row.id_token, MAX_CODE_ATTEMPTS]
    );
    return null;
  }
  return row.id_token;
}

function ageFrom(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return null;
  const birth = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (birth.getMonth() !== Number(m[2]) - 1) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday = now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

// Compatibilidad con la app anterior, que mandaba las fotos como data URI dentro del JSON.
function fileFromDataUri(value, name) {
  const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(value || ''));
  if (!m || !IMAGE_TYPES.includes(m[1].toLowerCase())) return null;
  const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buffer.length < 50) return null;
  return { buffer, mimetype: m[1].toLowerCase(), originalname: name };
}

// ───────────────────────── Inicio de sesión ─────────────────────────
router.post('/api/login', loginLimiter, async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return fail(res, 400, 'VALIDATION_ERROR', 'Ingresa tu correo y contraseña.');

  const user = await findUserByEmail(email);
  const valid = await bcrypt.compare(password, user && !user.anonimizado ? user.contrasena : DUMMY_HASH);
  if (!user || user.anonimizado || !valid) {
    audit(req, 'LOGIN_FALLIDO', 'usuario', user?.id_usuario ?? null, { email });
    return fail(res, 401, 'INVALID_CREDENTIALS', INVALID);
  }
  return finishLogin(req, res, user);
});

// RNF-04: reto de 3 minutos con 3 intentos; al tercer fallo el reto se destruye.
router.post('/api/login/verify-2fa', async (req, res) => {
  const reto = String(req.body?.reto || '');
  const codigo = String(req.body?.codigo || req.body?.token || '');
  if (!/^[0-9a-f-]{36}$/i.test(reto)) {
    return fail(res, 400, 'TWO_FA_CHALLENGE_REQUIRED', 'Tu verificación expiró. Inicia sesión de nuevo.');
  }

  const result = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT r.id_reto, r.intentos, r.usado, r.expira, r.codigo_hash, u.id_usuario
       FROM retos_2fa r JOIN usuarios u ON u.id_usuario = r.id_usuario
       WHERE r.id_reto = $1 FOR UPDATE OF r`,
      [reto]
    );
    const row = rows[0];
    if (!row || row.usado || new Date(row.expira) < new Date() || row.intentos >= 3) {
      return { error: 'TWO_FA_LOCKED' };
    }
    const user = await findUserById(row.id_usuario, db);
    const ok = user.totp_secreto
      ? verifyTotp(user.totp_secreto, codigo)
      : Boolean(row.codigo_hash) && await bcrypt.compare(onlyDigits(codigo), row.codigo_hash);
    if (!ok) {
      const intentos = row.intentos + 1;
      await db.query('UPDATE retos_2fa SET intentos = $1, usado = $2 WHERE id_reto = $3', [intentos, intentos >= 3, reto]);
      return { error: intentos >= 3 ? 'TWO_FA_LOCKED' : 'TWO_FA_INVALID', restantes: 3 - intentos };
    }
    await db.query('UPDATE retos_2fa SET usado = true WHERE id_reto = $1', [reto]);
    const session = await createSession(user, req, db);
    return { user, token: session.token };
  });

  if (result.error === 'TWO_FA_LOCKED') {
    return fail(res, 401, 'TWO_FA_LOCKED', 'Se agotaron los intentos o el código expiró. Inicia sesión de nuevo.');
  }
  if (result.error) {
    return fail(res, 400, 'TWO_FA_INVALID', `Código incorrecto. Te quedan ${result.restantes} intento(s).`, { restantes: result.restantes });
  }
  return res.json({ mensaje: 'Inicio de sesión exitoso con 2FA', usuario: publicUser(result.user), token: result.token });
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

// ───────────────────────── Registro y verificación ─────────────────────────
const registroUpload = uploader({ maxFiles: 3 }).fields([
  { name: 'ine_frente', maxCount: 1 },
  { name: 'ine_reverso', maxCount: 1 },
  { name: 'rostro', maxCount: 1 },
]);

router.post('/api/register', registerLimiter, registroUpload, async (req, res) => {
  const b = req.body || {};
  const email = normEmail(b.email);
  const nombre = sanitizeText(b.nombre, 100);
  const apellido = sanitizeText(b.apellidos ?? b.apellido, 100);
  const telefono = onlyDigits(b.telefono);
  const fecha = String(b.fechaNacimiento || b.fecha_nacimiento || '').trim();
  const password = String(b.password || '');
  const perfil = String(b.perfil ?? '1').toLowerCase();
  const idRol = perfil === '2' || perfil === 'tecnico' ? 2 : 1;

  if (!nombre || !apellido) return fail(res, 400, 'VALIDATION_ERROR', 'Escribe tu nombre y apellidos.');
  if (!isEmail(email)) return fail(res, 400, 'VALIDATION_ERROR', 'Escribe un correo electrónico válido.', { field: 'email' });
  if (!isPhoneMx(telefono)) return fail(res, 400, 'VALIDATION_ERROR', 'El teléfono debe tener 10 dígitos.', { field: 'telefono' });
  if (!isStrongPassword(password)) return fail(res, 400, 'WEAK_PASSWORD', WEAK, { field: 'password' });
  const age = ageFrom(fecha);
  if (age == null) return fail(res, 400, 'VALIDATION_ERROR', 'Selecciona una fecha de nacimiento válida.', { field: 'fechaNacimiento' });
  if (age < 18) return fail(res, 400, 'UNDERAGE', 'Debes ser mayor de edad para usar Click & Serve.', { field: 'fechaNacimiento' });
  if (!['true', '1', 'si', 'sí', true].includes(typeof b.acepta_privacidad === 'string' ? b.acepta_privacidad.toLowerCase() : b.acepta_privacidad)) {
    return fail(res, 400, 'CONSENT_REQUIRED', 'Debes aceptar el aviso de privacidad y los términos para crear tu cuenta.');
  }

  const files = {
    INE_FRENTE: req.files?.ine_frente?.[0] || fileFromDataUri(b.ine_frente || b.url_ine_front, 'ine_frente.jpg'),
    INE_REVERSO: req.files?.ine_reverso?.[0] || fileFromDataUri(b.ine_reverso || b.url_ine_rev, 'ine_reverso.jpg'),
    ROSTRO: req.files?.rostro?.[0] || fileFromDataUri(b.foto_rostro || b.rostro || b.referencia_facial, 'rostro.jpg'),
  };
  if (!files.INE_FRENTE || !files.INE_REVERSO || !files.ROSTRO) {
    return fail(res, 400, 'DOCUMENTS_REQUIRED', 'Fotografía el frente y reverso de tu INE y tu rostro para verificar tu identidad.');
  }

  const hash = await bcrypt.hash(password, 10);
  let created;
  try {
    created = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO usuarios (nombre, apellido, telefono, correo, fecha_nacimiento, contrasena, id_rol,
                               estado, estado_cuenta, identidad_verificada, biometria_estado, consentimiento_privacidad)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente', 'pendiente', false, 'pendiente', NOW())
         RETURNING id_usuario, nombre, correo, telefono`,
        [nombre, apellido, telefono, email, fecha, hash, idRol]
      );
      const user = rows[0];
      for (const [tipo, file] of Object.entries(files)) {
        const idArchivo = await saveFile(db, { owner: user.id_usuario, buffer: file.buffer, mime: file.mimetype, name: file.originalname, categoria: tipo === 'ROSTRO' ? 'ROSTRO' : 'INE' });
        await db.query('INSERT INTO documentos_usuario (id_usuario, tipo, id_archivo) VALUES ($1, $2, $3)', [user.id_usuario, tipo, idArchivo]);
      }
      const code = await issueCode(db, user.id_usuario, 'registro');
      return { user, code };
    });
  } catch (error) {
    if (error.code === '23505') {
      return fail(res, 409, 'USER_EXISTS', 'Este correo ya está registrado. Inicia sesión o recupera tu contraseña.');
    }
    throw error;
  }

  await sendCode({ canal: 'EMAIL', usuario: created.user, code: created.code, titulo: 'Verifica tu cuenta', texto: 'Ingresa este código en la app para activar tu cuenta.' });
  audit({ ...req, user: { id_usuario: created.user.id_usuario } }, 'REGISTRO', 'usuario', created.user.id_usuario, { rol: idRol });
  return res.status(201).json({ mensaje: 'Cuenta creada. Te enviamos un código de verificación a tu correo.', id_usuario: created.user.id_usuario });
});

router.post('/api/verify-token', codeLimiter, async (req, res) => {
  const user = await findUserByEmail(req.body?.email);
  if (!user) return fail(res, 400, 'CODE_INVALID', 'Código incorrecto, expirado o ya utilizado.');
  const idToken = await checkCode(getPool(), user.id_usuario, 'registro', req.body?.token);
  if (!idToken) return fail(res, 400, 'CODE_INVALID', 'Código incorrecto, expirado o ya utilizado.');

  await getPool().query("UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1", [idToken]);
  await getPool().query("UPDATE usuarios SET estado_cuenta = 'Activo' WHERE id_usuario = $1", [user.id_usuario]);
  const fresh = await findUserById(user.id_usuario);
  const { token } = await createSession(fresh, req);
  return res.json({ mensaje: 'Cuenta verificada exitosamente y activada.', usuario: publicUser(fresh), token });
});

router.post('/api/resend-code', sendLimiter, async (req, res) => {
  const user = await findUserByEmail(req.body?.email);
  if (user && String(user.estado_cuenta).toLowerCase() === 'pendiente') {
    const code = await issueCode(getPool(), user.id_usuario, 'registro');
    await sendCode({ canal: 'EMAIL', usuario: user, code, titulo: 'Nuevo código de verificación', texto: 'Los códigos anteriores dejaron de ser válidos. Usa este:' });
  }
  return res.json({ mensaje: 'Si tu cuenta está pendiente de verificar, te enviamos un nuevo código.' });
});

// ───────────────────────── Recuperación (RF-04, RF-10) ─────────────────────────
const RECOVERY_SENT = 'Si los datos corresponden a una cuenta, enviamos un código de recuperación.';

router.post('/api/request-recovery', sendLimiter, async (req, res) => {
  const canal = String(req.body?.canal || 'EMAIL').toUpperCase() === 'SMS' ? 'SMS' : 'EMAIL';
  const user = await findUserByEmail(req.body?.email);
  if (user && !user.anonimizado) {
    const code = await issueCode(getPool(), user.id_usuario, 'recuperacion', canal);
    try {
      await sendCode({ canal, usuario: user, code, titulo: 'Recupera tu contraseña', texto: 'Usa este código para crear una contraseña nueva.' });
    } catch (error) {
      if (error.code !== 'NO_PHONE') throw error;
    }
    audit({ ...req, user: { id_usuario: user.id_usuario } }, 'RECUPERACION_SOLICITADA', 'usuario', user.id_usuario, { canal });
  }
  return res.json({ mensaje: RECOVERY_SENT, canal });
});

router.post('/api/verify-recovery', codeLimiter, async (req, res) => {
  const user = await findUserByEmail(req.body?.email);
  const idToken = user ? await checkCode(getPool(), user.id_usuario, 'recuperacion', req.body?.token) : null;
  if (!idToken) return fail(res, 400, 'CODE_INVALID', 'Código incorrecto o expirado.');
  const resetToken = crypto.randomUUID();
  await getPool().query(
    "UPDATE tokens_temporales SET estado_uso = 'verificado', reset_token = $1, fecha_verificacion = NOW() WHERE id_token = $2",
    [resetToken, idToken]
  );
  return res.json({ mensaje: 'Código verificado. Crea tu nueva contraseña.', reset_token: resetToken });
});

router.post('/api/reset-password', codeLimiter, async (req, res) => {
  const newPassword = String(req.body?.newPassword || req.body?.password || '');
  if (!isStrongPassword(newPassword)) return fail(res, 400, 'WEAK_PASSWORD', WEAK);
  const user = await findUserByEmail(req.body?.email);
  if (!user) return fail(res, 403, 'RESET_NOT_VERIFIED', 'Verifica tu código de seguridad antes de cambiar la contraseña.');

  // reset_token siempre obligatorio: sin él, cualquiera que conozca el correo podría fijar la contraseña
  // durante los 10 minutos posteriores a que la persona verificó su código.
  const resetToken = String(req.body?.reset_token || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resetToken)) {
    return fail(res, 403, 'RESET_NOT_VERIFIED', 'Verifica tu código de seguridad antes de cambiar la contraseña.');
  }
  const { rows } = await getPool().query(
    `SELECT id_token FROM tokens_temporales
     WHERE id_usuario = $1 AND tipo_accion = 'recuperacion' AND estado_uso = 'verificado'
       AND fecha_verificacion > NOW() - INTERVAL '10 minutes'
       AND reset_token::text = $2
     ORDER BY id_token DESC LIMIT 1`,
    [user.id_usuario, resetToken.toLowerCase()]
  );
  if (!rows[0]) return fail(res, 403, 'RESET_NOT_VERIFIED', 'Verifica tu código de seguridad antes de cambiar la contraseña.');

  await withTransaction(async (db) => {
    await db.query(
      'UPDATE usuarios SET contrasena = $1, version_sesion = COALESCE(version_sesion, 1) + 1, fecha_actualizacion_contrasena = NOW() WHERE id_usuario = $2',
      [await bcrypt.hash(newPassword, 10), user.id_usuario]
    );
    await db.query("UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND estado = 'activa'", [user.id_usuario]);
    await db.query("UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1", [rows[0].id_token]);
  });
  audit({ ...req, user: { id_usuario: user.id_usuario } }, 'CONTRASENA_RESTABLECIDA', 'usuario', user.id_usuario);
  return res.json({ mensaje: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
});

// RF-09/RF-15: valida la contraseña actual y cierra las demás sesiones.
router.post('/api/update-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = await findUserById(req.user.id_usuario);
  if (!currentPassword || !(await bcrypt.compare(String(currentPassword), user.contrasena))) {
    return fail(res, 400, 'PASSWORD_INCORRECT', 'La contraseña actual no es correcta.');
  }
  if (!isStrongPassword(newPassword)) return fail(res, 400, 'WEAK_PASSWORD', WEAK);

  const version = (user.version_sesion || 1) + 1;
  await withTransaction(async (db) => {
    await db.query(
      'UPDATE usuarios SET contrasena = $1, version_sesion = $2, fecha_actualizacion_contrasena = NOW() WHERE id_usuario = $3',
      [await bcrypt.hash(String(newPassword), 10), version, user.id_usuario]
    );
    await db.query(
      "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND id_sesion <> $2 AND estado = 'activa'",
      [user.id_usuario, req.user.sessionId]
    );
  });
  audit(req, 'CONTRASENA_CAMBIADA', 'usuario', user.id_usuario);
  const token = signSession({ id_usuario: user.id_usuario, id_rol: user.id_rol, version_sesion: version, sessionId: req.user.sessionId });
  return res.json({ mensaje: 'Contraseña actualizada. Cerramos tus sesiones en otros dispositivos.', token });
});

// ───────────────────────── Sesiones (RF-12) ─────────────────────────
router.get('/api/auth/sessions', auth, async (req, res) => {
  const { rows } = await getPool().query(
    `SELECT id_sesion, dispositivo, fecha_creacion FROM sesiones_activas
     WHERE id_usuario = $1 AND estado = 'activa' ORDER BY fecha_creacion DESC`,
    [req.user.id_usuario]
  );
  return res.json({ sesiones: rows.map((s) => ({ ...s, es_sesion_actual: s.id_sesion === req.user.sessionId })) });
});

router.delete('/api/auth/sessions/:sessionId', auth, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.sessionId)) return fail(res, 404, 'NOT_FOUND', 'La sesión no existe.');
  const result = await getPool().query(
    "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_sesion = $1 AND id_usuario = $2 AND estado = 'activa' RETURNING id_sesion",
    [req.params.sessionId, req.user.id_usuario]
  );
  if (!result.rowCount) return fail(res, 404, 'NOT_FOUND', 'La sesión no existe o ya fue cerrada.');
  audit(req, 'SESION_DESVINCULADA', 'sesion', req.params.sessionId);
  return res.json({ mensaje: 'Dispositivo desvinculado exitosamente.' });
});

router.delete('/api/auth/sessions', auth, async (req, res) => {
  await getPool().query(
    "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND id_sesion <> $2 AND estado = 'activa'",
    [req.user.id_usuario, req.user.sessionId]
  );
  audit(req, 'SESIONES_CERRADAS', 'usuario', req.user.id_usuario);
  return res.json({ mensaje: 'Cerramos todas tus demás sesiones.' });
});

router.post('/api/check-session', auth, (req, res) => res.json({ valid: true }));
router.get('/api/perfil-protegido', auth, (req, res) => res.json({ mensaje: 'Acceso concedido a ruta protegida', usuarioId: req.user.id_usuario, versionSesion: req.user.version_sesion }));

// ───────────────────────── Panel de administrador (sin cambios de contrato) ─────────────────────────
router.post('/api/login-admin', loginLimiter, async (req, res) => {
  const user = await findUserByEmail(req.body?.email);
  const valid = await bcrypt.compare(String(req.body?.password || ''), user ? user.contrasena : DUMMY_HASH);
  if (!user || !valid) return fail(res, 401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
  if (Number(user.id_rol) !== 3) {
    return fail(res, 403, 'ROLE_FORBIDDEN', 'Acceso denegado. Credenciales no válidas para el panel web administrativo.');
  }
  if (String(user.estado_cuenta).toLowerCase().startsWith('pendiente') || user.estado_cuenta === 'No verificado') {
    return res.status(403).json({ codigo: 'CUENTA_PENDIENTE', estado_cuenta: 'PENDIENTE', code: 'ACCOUNT_PENDING', error: 'Tu cuenta administrativa está PENDIENTE de validación.' });
  }
  const code = await issueCode(getPool(), user.id_usuario, 'login_admin');
  await sendMail({ to: user.correo, subject: 'Código de acceso al panel - Click & Serve', html: `<p>Tu código de acceso es <b>${code}</b>.</p>`, code });
  return res.json({ mensaje: 'Credenciales correctas. Código enviado al correo.', requiere2FA: true });
});

router.post('/api/verify-login-admin', codeLimiter, async (req, res) => {
  const user = await findUserByEmail(req.body?.email);
  if (!user || Number(user.id_rol) !== 3) return fail(res, 404, 'NOT_FOUND', 'Usuario administrador no encontrado.');
  const idToken = await checkCode(getPool(), user.id_usuario, 'login_admin', req.body?.token);
  if (!idToken) return fail(res, 400, 'CODE_INVALID', 'Código de seguridad incorrecto o expirado.');
  await getPool().query("UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1", [idToken]);
  const { rows } = await getPool().query(
    'INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, 3, $2) RETURNING id_sesion',
    [user.id_usuario, String(req.headers['user-agent'] || 'Panel Web Administrativo').slice(0, 255)]
  );
  const token = signSession({ ...user, sessionId: rows[0].id_sesion }, '8h');
  return res.json({ mensaje: 'Acceso autorizado', usuario: { id_usuario: user.id_usuario, id_rol: 3, version_sesion: user.version_sesion }, token });
});

module.exports = router;
