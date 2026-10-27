const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { fail } = require('../lib/http');
const { sanitizeText } = require('../lib/sanitize');
const { parseCoord } = require('../lib/geo');

const router = express.Router();
const db = () => getPool();

// RF-101/102/103: domicilios del usuario con punto en el mapa y uno predeterminado.
function parseAddress(body) {
  const data = {
    etiqueta: sanitizeText(body?.etiqueta, 50) || 'Casa',
    calle: sanitizeText(body?.calle, 255),
    numero: sanitizeText(body?.numero, 50),
    interior: sanitizeText(body?.interior, 50) || null,
    colonia: sanitizeText(body?.colonia, 100),
    cp: sanitizeText(body?.cp, 10),
    ciudad: sanitizeText(body?.ciudad, 100) || 'Lázaro Cárdenas',
    referencias: sanitizeText(body?.referencias, 300) || null,
    latitud: parseCoord(body?.latitud, -90, 90),
    longitud: parseCoord(body?.longitud, -180, 180),
  };
  if (data.calle.length < 3) return { error: ['Escribe la calle.', 'calle'] };
  if (!data.numero) return { error: ['Escribe el número exterior.', 'numero'] };
  if (data.cp && !/^\d{5}$/.test(data.cp)) return { error: ['El código postal tiene 5 dígitos.', 'cp'] };
  return { data };
}

async function list(userId) {
  const { rows } = await db().query(
    'SELECT * FROM direcciones WHERE id_usuario = $1 ORDER BY predeterminada DESC, id_direccion DESC',
    [userId]
  );
  return rows;
}

router.get('/api/direcciones', auth, async (req, res) => {
  res.json({ direcciones: await list(req.user.id_usuario) });
});

router.post('/api/direcciones', auth, async (req, res) => {
  const { data, error } = parseAddress(req.body);
  if (error) return fail(res, 400, 'VALIDATION_ERROR', error[0], { field: error[1] });
  const direccion = await withTransaction(async (tx) => {
    const count = (await tx.query('SELECT COUNT(*)::int AS n FROM direcciones WHERE id_usuario = $1', [req.user.id_usuario])).rows[0].n;
    const makeDefault = count === 0 || req.body?.predeterminada === true;
    if (makeDefault) await tx.query('UPDATE direcciones SET predeterminada = false WHERE id_usuario = $1', [req.user.id_usuario]);
    const { rows } = await tx.query(
      `INSERT INTO direcciones (id_usuario, etiqueta, calle, numero, interior, colonia, cp, ciudad, referencias, latitud, longitud, predeterminada)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [req.user.id_usuario, data.etiqueta, data.calle, data.numero, data.interior, data.colonia, data.cp, data.ciudad, data.referencias, data.latitud, data.longitud, makeDefault]
    );
    return rows[0];
  });
  res.status(201).json({ mensaje: 'Dirección guardada.', direccion });
});

router.put('/api/direcciones/:id', auth, async (req, res) => {
  const { data, error } = parseAddress(req.body);
  if (error) {
    const exists = await db().query('SELECT 1 FROM direcciones WHERE id_direccion = $1 AND id_usuario = $2', [req.params.id, req.user.id_usuario]);
    if (!exists.rowCount) return fail(res, 404, 'NOT_FOUND', 'Dirección no encontrada.');
    return fail(res, 400, 'VALIDATION_ERROR', error[0], { field: error[1] });
  }
  const { rows } = await db().query(
    `UPDATE direcciones SET etiqueta = $1, calle = $2, numero = $3, interior = $4, colonia = $5, cp = $6, ciudad = $7,
       referencias = $8, latitud = COALESCE($9, latitud), longitud = COALESCE($10, longitud)
     WHERE id_direccion = $11 AND id_usuario = $12 RETURNING *`,
    [data.etiqueta, data.calle, data.numero, data.interior, data.colonia, data.cp, data.ciudad, data.referencias, data.latitud, data.longitud, req.params.id, req.user.id_usuario]
  );
  if (!rows[0]) return fail(res, 404, 'NOT_FOUND', 'Dirección no encontrada.');
  res.json({ mensaje: 'Dirección actualizada.', direccion: rows[0] });
});

router.patch('/api/direcciones/:id/predeterminada', auth, async (req, res) => {
  const ok = await withTransaction(async (tx) => {
    const own = await tx.query('SELECT 1 FROM direcciones WHERE id_direccion = $1 AND id_usuario = $2', [req.params.id, req.user.id_usuario]);
    if (!own.rowCount) return false;
    await tx.query('UPDATE direcciones SET predeterminada = (id_direccion = $1) WHERE id_usuario = $2', [req.params.id, req.user.id_usuario]);
    return true;
  });
  if (!ok) return fail(res, 404, 'NOT_FOUND', 'Dirección no encontrada.');
  res.json({ mensaje: 'Dirección principal actualizada.', direcciones: await list(req.user.id_usuario) });
});

router.delete('/api/direcciones/:id', auth, async (req, res) => {
  const removed = await withTransaction(async (tx) => {
    const { rows } = await tx.query('DELETE FROM direcciones WHERE id_direccion = $1 AND id_usuario = $2 RETURNING predeterminada', [req.params.id, req.user.id_usuario]);
    if (!rows[0]) return false;
    if (rows[0].predeterminada) {
      await tx.query(
        'UPDATE direcciones SET predeterminada = true WHERE id_direccion = (SELECT id_direccion FROM direcciones WHERE id_usuario = $1 ORDER BY id_direccion DESC LIMIT 1)',
        [req.user.id_usuario]
      );
    }
    return true;
  });
  if (!removed) return fail(res, 404, 'NOT_FOUND', 'Dirección no encontrada.');
  res.json({ mensaje: 'Dirección eliminada.', id: Number(req.params.id) });
});

module.exports = router;
