const { getPool } = require('../db/pool');
const { verifyToken } = require('../lib/tokens');
const { fail } = require('../lib/http');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Aprobación decidida en el servidor (sin listas de correos maestros):
// cuenta activa/aprobada y, para técnicos, identidad verificada.
function computeApproved(row) {
  if (!row || row.anonimizado) return false;
  const estado = String(row.estado_cuenta || '').trim().toUpperCase();
  if (!['ACTIVO', 'APROBADO'].includes(estado)) return false;
  if (Number(row.id_rol) === 2) return row.identidad_verificada === true;
  return true;
}

// Valida el JWT contra la base: versión de sesión (cambio de contraseña) y sesión activa (desvinculación remota).
async function loadSessionUser(decoded) {
  if (!decoded?.id_usuario || !decoded.sessionId || !UUID.test(String(decoded.sessionId))) {
    return { error: 'AUTH_REVOKED' };
  }
  const { rows } = await getPool().query(
    `SELECT u.id_usuario, u.id_rol, u.nombre, u.apellido, u.correo, u.telefono, u.estado_cuenta,
            u.identidad_verificada, u.version_sesion, u.anonimizado,
            s.estado AS estado_sesion, s.id_rol AS rol_sesion
     FROM usuarios u
     LEFT JOIN sesiones_activas s ON s.id_sesion = $2 AND s.id_usuario = u.id_usuario
     WHERE u.id_usuario = $1`,
    [decoded.id_usuario, decoded.sessionId]
  );
  const row = rows[0];
  if (!row || row.anonimizado) return { error: 'AUTH_REVOKED' };
  if ((row.version_sesion || 1) !== (decoded.version_sesion || 1)) return { error: 'AUTH_REVOKED' };
  if (row.estado_sesion !== 'activa' || Number(row.rol_sesion) !== Number(row.id_rol)) return { error: 'AUTH_REVOKED' };

  return {
    user: {
      id_usuario: row.id_usuario,
      id_rol: Number(row.id_rol),
      sessionId: decoded.sessionId,
      version_sesion: row.version_sesion || 1,
      nombre: row.nombre,
      apellido: row.apellido,
      correo: row.correo,
      email: row.correo,
      telefono: row.telefono,
      estado_cuenta: row.estado_cuenta,
      identidad_verificada: row.identidad_verificada === true,
      verificado: row.identidad_verificada === true,
      aprobado: computeApproved(row),
    },
  };
}

const MESSAGES = {
  AUTH_REQUIRED: 'Inicia sesión para continuar.',
  AUTH_INVALID: 'Tu sesión no es válida. Inicia sesión de nuevo.',
  AUTH_REVOKED: 'Tu sesión terminó o fue cerrada desde otro dispositivo. Inicia sesión de nuevo.',
};

async function auth(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'AUTH_REQUIRED', MESSAGES.AUTH_REQUIRED);

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return fail(res, 401, 'AUTH_INVALID', MESSAGES.AUTH_INVALID);
  }

  const result = await loadSessionUser(decoded);
  if (result.error) return fail(res, 401, result.error, MESSAGES[result.error]);
  req.user = result.user;
  return next();
}

module.exports = { auth, loadSessionUser, computeApproved };
