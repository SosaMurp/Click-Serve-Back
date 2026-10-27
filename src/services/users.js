const { getPool } = require('../db/pool');
const { signFileUrl } = require('../lib/files');
const { signSession } = require('../lib/tokens');
const { computeApproved } = require('../middleware/auth');

const USER_COLUMNS = `id_usuario, nombre, apellido, telefono, correo, fecha_nacimiento, id_rol, contrasena,
  estado_cuenta, identidad_verificada, verificado_sep, biometria_estado, version_sesion, "2FA_Activo",
  totp_secreto, disponible, preferencias, foto_archivo, foto_perfil, anonimizado, fecha_registro, bio,
  consentimiento_privacidad`;

async function findUserByEmail(email, db = getPool()) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM usuarios WHERE correo = $1`, [String(email || '').trim().toLowerCase()]);
  return rows[0] || null;
}

async function findUserById(id, db = getPool()) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM usuarios WHERE id_usuario = $1`, [id]);
  return rows[0] || null;
}

// Representación pública del usuario: nunca incluye contraseña, secretos ni documentos.
// Conserva los nombres que la app anterior usaba (estado, estado_cuenta, 2FA_Activo).
function publicUser(row) {
  if (!row) return null;
  const aprobado = computeApproved(row);
  return {
    id_usuario: row.id_usuario,
    nombre: row.nombre,
    apellido: row.apellido,
    telefono: row.telefono,
    correo: row.correo,
    fecha_nacimiento: row.fecha_nacimiento,
    id_rol: Number(row.id_rol),
    rol: Number(row.id_rol) === 2 ? 'tecnico' : Number(row.id_rol) === 3 ? 'admin' : 'cliente',
    estado: row.estado_cuenta || 'pendiente',
    estado_cuenta: row.estado_cuenta || 'pendiente',
    aprobado,
    identidad_verificada: row.identidad_verificada === true,
    verificado_sep: row.verificado_sep === true,
    biometria_estado: row.biometria_estado || 'pendiente',
    '2FA_Activo': row['2FA_Activo'] === true || Boolean(row.totp_secreto),
    disponible: row.disponible === true,
    preferencias: row.preferencias || {},
    foto_url: row.foto_archivo ? signFileUrl(row.foto_archivo, 3600) : null,
    bio: row.bio || null,
    fecha_registro: row.fecha_registro,
  };
}

async function createSession(user, req, db = getPool()) {
  const dispositivo = String(req.headers['user-agent'] || 'Dispositivo desconocido').slice(0, 255);
  const { rows } = await db.query(
    'INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, $2, $3) RETURNING id_sesion',
    [user.id_usuario, user.id_rol, dispositivo]
  );
  await db.query('UPDATE usuarios SET ultima_conexion = NOW() WHERE id_usuario = $1', [user.id_usuario]);
  const sessionId = rows[0].id_sesion;
  return { sessionId, token: signSession({ ...user, sessionId }) };
}

module.exports = { findUserByEmail, findUserById, publicUser, createSession, USER_COLUMNS };
