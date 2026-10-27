const { getPool } = require('../db/pool');

// RNF-25/27: registro de acciones críticas con IP, user-agent y marca de tiempo UTC del servidor.
// Nunca interrumpe la operación principal: si falla, solo se informa en consola.
function audit(req, accion, entidad = null, idEntidad = null, detalle = null, db = getPool()) {
  return db
    .query(
      `INSERT INTO auditoria (id_usuario, accion, entidad, id_entidad, ip, user_agent, detalle)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req?.user?.id_usuario ?? null,
        accion,
        entidad,
        idEntidad == null ? null : String(idEntidad),
        req?.ip ?? null,
        req?.headers?.['user-agent']?.slice(0, 500) ?? null,
        detalle ? JSON.stringify(detalle) : null,
      ]
    )
    .catch((error) => console.error(`No se pudo auditar ${accion}:`, error.message));
}

module.exports = { audit };
