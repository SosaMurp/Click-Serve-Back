const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getPool, withTransaction } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { fail } = require('../lib/http');
const { audit } = require('../lib/audit');
const { sanitizeText } = require('../lib/sanitize');
const { isPhoneMx, onlyDigits, maskClabe } = require('../lib/validators');
const { generateSecret, verifyTotp, otpauthUri } = require('../lib/totp');
const { saveFile, uploader } = require('../lib/files');
const { findUserById, publicUser } = require('../services/users');

const router = express.Router();

const PREFERENCIAS = ['notificaciones_push', 'notificaciones_email', 'notificaciones_sms', 'promociones', 'sonido'];

// RF-85/86: datos personales; solo se actualizan los campos enviados.
router.put('/api/usuarios/perfil', auth, async (req, res) => {
  const b = req.body || {};
  const updates = [];
  const values = [];
  const set = (column, value) => { values.push(value); updates.push(`${column} = $${values.length}`); };

  // Con la identidad verificada, el nombre queda ligado al INE revisado: cambiarlo permitiría
  // suplantar a otra persona o validar una cédula ajena. Solo soporte puede corregirlo.
  const locked = req.user.identidad_verificada;
  const identityLocked = () => fail(res, 409, 'IDENTITY_LOCKED', 'Tu nombre está ligado a tu identidad verificada. Si hay un error, escríbenos a soporte.', { field: 'nombre' });
  if (b.nombre !== undefined) {
    const nombre = sanitizeText(b.nombre, 100);
    if (!nombre) return fail(res, 400, 'VALIDATION_ERROR', 'El nombre no puede quedar vacío.', { field: 'nombre' });
    if (locked && nombre !== req.user.nombre) return identityLocked();
    set('nombre', nombre);
  }
  if (b.apellido !== undefined || b.apellidos !== undefined) {
    const apellido = sanitizeText(b.apellido ?? b.apellidos, 100);
    if (!apellido) return fail(res, 400, 'VALIDATION_ERROR', 'Los apellidos no pueden quedar vacíos.', { field: 'apellido' });
    if (locked && apellido !== req.user.apellido) return identityLocked();
    set('apellido', apellido);
  }
  if (b.telefono !== undefined) {
    if (!isPhoneMx(b.telefono)) return fail(res, 400, 'VALIDATION_ERROR', 'El teléfono debe tener 10 dígitos.', { field: 'telefono' });
    set('telefono', onlyDigits(b.telefono));
  }
  if (b.bio !== undefined) set('bio', sanitizeText(b.bio, 500) || null);

  if (updates.length === 0) return fail(res, 400, 'VALIDATION_ERROR', 'No enviaste datos para actualizar.');
  values.push(req.user.id_usuario);
  await getPool().query(`UPDATE usuarios SET ${updates.join(', ')}, fecha_actualizacion = NOW() WHERE id_usuario = $${values.length}`, values);
  audit(req, 'PERFIL_ACTUALIZADO', 'usuario', req.user.id_usuario, { campos: Object.keys(b) });
  return res.json({ mensaje: 'Datos guardados.', usuario: publicUser(await findUserById(req.user.id_usuario)) });
});

// RF-89: preferencias de notificaciones (lista blanca de claves booleanas).
router.put('/api/usuarios/preferencias', auth, async (req, res) => {
  const current = (await findUserById(req.user.id_usuario)).preferencias || {};
  const next = { ...current };
  for (const key of PREFERENCIAS) {
    if (typeof req.body?.[key] === 'boolean') next[key] = req.body[key];
  }
  await getPool().query('UPDATE usuarios SET preferencias = $1 WHERE id_usuario = $2', [JSON.stringify(next), req.user.id_usuario]);
  return res.json({ mensaje: 'Preferencias guardadas.', preferencias: next });
});

// RF-22: foto de perfil (multipart "foto"); acepta data URI por compatibilidad.
router.put('/api/usuarios/avatar', auth, uploader({ maxFiles: 1 }).single('foto'), async (req, res) => {
  let file = req.file;
  if (!file && typeof (req.body?.foto_perfil || req.body?.avatar) === 'string') {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(req.body.foto_perfil || req.body.avatar);
    if (m) file = { buffer: Buffer.from(m[2], 'base64'), mimetype: m[1].toLowerCase(), originalname: 'avatar.jpg' };
  }
  if (!file) return fail(res, 400, 'VALIDATION_ERROR', 'Selecciona una foto JPG, PNG o WEBP.');
  const id = await saveFile(getPool(), { owner: req.user.id_usuario, buffer: file.buffer, mime: file.mimetype, name: file.originalname, categoria: 'AVATAR' });
  await getPool().query('UPDATE usuarios SET foto_archivo = $1, fecha_actualizacion = NOW() WHERE id_usuario = $2', [id, req.user.id_usuario]);
  audit(req, 'AVATAR_ACTUALIZADO', 'usuario', req.user.id_usuario);
  return res.json({ mensaje: 'Foto actualizada.', usuario: publicUser(await findUserById(req.user.id_usuario)) });
});

router.post('/api/usuario/push-token', auth, async (req, res) => {
  const token = String(req.body?.push_token || '').slice(0, 200) || null;
  await getPool().query('UPDATE usuarios SET push_token = $1 WHERE id_usuario = $2', [token, req.user.id_usuario]);
  return res.json({ mensaje: 'Push token registrado correctamente.' });
});

// ───────────────────────── 2FA con app autenticadora (RF-13, RNF-04) ─────────────────────────
router.post('/api/usuarios/2fa/iniciar', auth, async (req, res) => {
  const secreto = generateSecret();
  await getPool().query('UPDATE usuarios SET totp_pendiente = $1 WHERE id_usuario = $2', [secreto, req.user.id_usuario]);
  return res.json({ secreto, otpauth: otpauthUri(secreto, req.user.correo) });
});

router.post('/api/usuarios/2fa/confirmar', auth, async (req, res) => {
  const user = await findUserById(req.user.id_usuario);
  const { rows } = await getPool().query('SELECT totp_pendiente FROM usuarios WHERE id_usuario = $1', [user.id_usuario]);
  const pendiente = rows[0]?.totp_pendiente;
  if (!pendiente || !verifyTotp(pendiente, req.body?.codigo)) {
    return fail(res, 400, 'TWO_FA_INVALID', 'El código no coincide. Revisa la hora de tu teléfono e intenta de nuevo.');
  }
  await getPool().query(
    'UPDATE usuarios SET totp_secreto = totp_pendiente, totp_pendiente = NULL, "2FA_Activo" = true WHERE id_usuario = $1',
    [user.id_usuario]
  );
  audit(req, '2FA_ACTIVADO', 'usuario', user.id_usuario);
  return res.json({ mensaje: 'Verificación en dos pasos activada.', usuario: publicUser(await findUserById(user.id_usuario)) });
});

async function disable2fa(req, res) {
  const user = await findUserById(req.user.id_usuario);
  const byCode = user.totp_secreto && verifyTotp(user.totp_secreto, req.body?.codigo);
  const byPassword = req.body?.password && await bcrypt.compare(String(req.body.password), user.contrasena);
  if (!byCode && !byPassword) {
    return fail(res, 400, 'TWO_FA_INVALID', 'Confirma con el código de tu app autenticadora o con tu contraseña.');
  }
  await getPool().query('UPDATE usuarios SET totp_secreto = NULL, totp_pendiente = NULL, "2FA_Activo" = false WHERE id_usuario = $1', [user.id_usuario]);
  audit(req, '2FA_DESACTIVADO', 'usuario', user.id_usuario);
  return res.json({ mensaje: 'Verificación en dos pasos desactivada.', usuario: publicUser(await findUserById(user.id_usuario)), '2FA_Activo': false });
}

router.delete('/api/usuarios/2fa', auth, disable2fa);

// Ruta anterior: activar ya no es un interruptor, requiere configurar la app autenticadora.
router.put('/api/usuarios/2fa', auth, async (req, res) => {
  if (req.body?.activo) {
    return fail(res, 409, 'USE_TOTP_SETUP', 'Para activar la verificación en dos pasos, configura tu app autenticadora.');
  }
  return disable2fa(req, res);
});

// ───────────────────────── Derechos ARCO y baja (RF-16, RD-011) ─────────────────────────
router.get('/api/cuenta/exportar', auth, async (req, res) => {
  const id = req.user.id_usuario;
  const pool = getPool();
  const [direcciones, tarjetas, solicitudes, sesiones, movimientos] = await Promise.all([
    pool.query('SELECT etiqueta, calle, numero, interior, colonia, cp, ciudad, referencias FROM direcciones WHERE id_usuario = $1', [id]),
    pool.query('SELECT marca, ultimos_4, expiracion, predeterminada FROM metodos_pago WHERE id_usuario = $1', [id]),
    pool.query(
      `SELECT folio, categoria, descripcion, direccion, estado, fecha_creacion, monto_total, calificacion_cliente
       FROM solicitudes_servicio WHERE id_usuario = $1 OR id_tecnico = $1 ORDER BY fecha_creacion DESC`,
      [id]
    ),
    pool.query("SELECT dispositivo, fecha_creacion, estado FROM sesiones_activas WHERE id_usuario = $1 ORDER BY fecha_creacion DESC LIMIT 50", [id]),
    pool.query(
      `SELECT t.folio, t.tipo, t.concepto, t.monto, t.estado, t.fecha, b.clabe_interbancaria
       FROM transacciones t JOIN billetera_tecnico b ON b.id_billetera = t.id_billetera WHERE b.id_usuario = $1`,
      [id]
    ),
  ]);
  audit(req, 'DATOS_EXPORTADOS', 'usuario', id);
  return res.json({
    generado: new Date().toISOString(),
    usuario: publicUser(await findUserById(id)),
    direcciones: direcciones.rows,
    metodos_pago: tarjetas.rows,
    solicitudes: solicitudes.rows,
    sesiones: sesiones.rows,
    movimientos: movimientos.rows.map(({ clabe_interbancaria, ...m }) => ({ ...m, cuenta: maskClabe(clabe_interbancaria) })),
  });
});

const ACTIVE_STATES = ['ASIGNADA', 'EN_CAMINO', 'EN_SITIO', 'ESPERANDO_APROBACION', 'EN_PROCESO', 'POR_CONFIRMAR', 'SUSPENDIDA'];

// Baja con contraseña: anonimiza los datos personales y conserva los registros financieros sin identidad.
async function deleteAccount(req, res) {
  const password = req.body?.password;
  if (!password) return fail(res, 400, 'PASSWORD_REQUIRED', 'Escribe tu contraseña para confirmar la eliminación.');
  const user = await findUserById(req.user.id_usuario);
  if (!(await bcrypt.compare(String(password), user.contrasena))) {
    return fail(res, 400, 'PASSWORD_INCORRECT', 'La contraseña no es correcta.');
  }

  const pool = getPool();
  const activos = await pool.query(
    'SELECT COUNT(*)::int AS n FROM solicitudes_servicio WHERE (id_usuario = $1 OR id_tecnico = $1) AND estado = ANY($2)',
    [user.id_usuario, ACTIVE_STATES]
  );
  if (activos.rows[0].n > 0) {
    return fail(res, 409, 'ACTIVE_SERVICES', 'Tienes servicios en curso. Termínalos o cancélalos antes de eliminar tu cuenta.');
  }
  const saldo = await pool.query('SELECT saldo_actual FROM billetera_tecnico WHERE id_usuario = $1 AND saldo_actual > 0', [user.id_usuario]);
  if (saldo.rowCount > 0) {
    return fail(res, 409, 'BALANCE_PENDING', 'Aún tienes saldo en tu billetera. Retíralo antes de eliminar tu cuenta.');
  }

  await withTransaction(async (db) => {
    const id = user.id_usuario;
    await db.query(
      `UPDATE usuarios SET nombre = 'Usuario', apellido = 'eliminado', correo = $2, telefono = NULL,
         fecha_nacimiento = NULL, contrasena = $3, foto_archivo = NULL, foto_perfil = NULL, totp_secreto = NULL,
         totp_pendiente = NULL, "2FA_Activo" = false, preferencias = '{}'::jsonb, push_token = NULL,
         latitud = NULL, longitud = NULL, ine_frente = NULL, ine_reverso = NULL, foto_rostro = NULL,
         url_ine_front = NULL, url_ine_rev = NULL, referencia_facial = NULL, bio = NULL, disponible = false,
         estado_cuenta = 'Eliminado', anonimizado = true, version_sesion = COALESCE(version_sesion, 1) + 1
       WHERE id_usuario = $1`,
      [id, `eliminado+${id}.${crypto.randomUUID().slice(0, 8)}@clickserve.invalid`, await bcrypt.hash(crypto.randomUUID(), 4)]
    );
    await db.query("UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1", [id]);
    await db.query('DELETE FROM direcciones WHERE id_usuario = $1', [id]);
    await db.query('DELETE FROM metodos_pago WHERE id_usuario = $1', [id]);
    await db.query('DELETE FROM documentos_usuario WHERE id_usuario = $1', [id]);
    await db.query('DELETE FROM portafolio_tecnico WHERE id_usuario = $1', [id]);
    await db.query("DELETE FROM archivos WHERE id_propietario = $1 AND categoria IN ('AVATAR', 'INE', 'ROSTRO', 'DOCUMENTO', 'PORTAFOLIO')", [id]);
  });
  audit(req, 'CUENTA_ELIMINADA', 'usuario', user.id_usuario);
  return res.json({ mensaje: 'Tu cuenta fue eliminada y tus datos personales anonimizados.' });
}

router.delete('/api/cuenta', auth, deleteAccount);
router.delete('/api/usuarios/perfil', auth, deleteAccount);

module.exports = router;
