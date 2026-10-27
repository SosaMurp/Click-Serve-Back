const { getPool } = require('../db/pool');
const { fail } = require('./http');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let lastCleanup = 0;

// RNF-32/33/35: exige Idempotency-Key (UUID v4) y repite la respuesta guardada durante 24 h,
// de modo que un doble toque o un reintento por latencia no ejecute la operación dos veces.
function idempotent(scope) {
  return async (req, res, next) => {
    const key = req.header('Idempotency-Key');
    if (!key || !UUID_V4.test(key)) {
      return fail(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Falta el identificador de la operación. Intenta de nuevo.');
    }
    const userId = Number(req.user?.id_usuario);
    const pool = getPool();

    if (Date.now() - lastCleanup > 10 * 60 * 1000) {
      lastCleanup = Date.now();
      pool.query("DELETE FROM idempotencia WHERE creado < NOW() - INTERVAL '24 hours'").catch(() => {});
    }

    const inserted = await pool.query(
      `INSERT INTO idempotencia (clave, id_usuario, alcance) VALUES ($1, $2, $3)
       ON CONFLICT (clave, id_usuario) DO NOTHING RETURNING clave`,
      [key, userId, scope]
    );

    if (inserted.rowCount === 0) {
      const { rows } = await pool.query(
        'SELECT alcance, status, cuerpo FROM idempotencia WHERE clave = $1 AND id_usuario = $2',
        [key, userId]
      );
      const previous = rows[0];
      if (!previous || previous.alcance !== scope) {
        return fail(res, 422, 'IDEMPOTENCY_KEY_REUSED', 'Este identificador ya se usó en otra operación.');
      }
      if (previous.status == null) {
        return fail(res, 409, 'REQUEST_IN_PROGRESS', 'La operación anterior sigue en proceso. Espera un momento.');
      }
      res.set('Idempotent-Replay', 'true');
      return res.status(previous.status).json(previous.cuerpo);
    }

    // Guarda la respuesta antes de enviarla para que un reintento inmediato la encuentre.
    // Solo se guardan los éxitos: un error (p. ej. tarjeta rechazada, 402) libera la clave para que
    // el reintento con otra tarjeta o con datos corregidos sí se ejecute.
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const store = status >= 400
        ? pool.query('DELETE FROM idempotencia WHERE clave = $1 AND id_usuario = $2', [key, userId])
        : pool.query('UPDATE idempotencia SET status = $1, cuerpo = $2 WHERE clave = $3 AND id_usuario = $4',
          [status, JSON.stringify(body ?? null), key, userId]);
      store
        .catch((error) => console.error('No se pudo registrar la respuesta idempotente:', error.message))
        .finally(() => sendJson(body));
      return res;
    };
    return next();
  };
}

module.exports = { idempotent, UUID_V4 };
