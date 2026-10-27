const express = require('express');
const { getPool } = require('../db/pool');
const { verifyFileSignature } = require('../lib/files');
const { fail } = require('../lib/http');

const router = express.Router();

// Entrega de archivos solo con URL firmada vigente (RNF-26). Sin firma no hay acceso, aunque se conozca el id.
router.get('/api/archivos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !verifyFileSignature(id, req.query.exp, req.query.sig)) {
    return fail(res, 403, 'FILE_LINK_EXPIRED', 'El enlace del archivo venció. Vuelve a abrirlo desde la app.');
  }
  const { rows } = await getPool().query('SELECT nombre, tipo_mime, contenido FROM archivos WHERE id_archivo = $1', [id]);
  if (!rows[0]) return fail(res, 404, 'NOT_FOUND', 'Archivo no encontrado.');
  res.set('Cache-Control', 'private, max-age=300');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(rows[0].nombre)}"`);
  return res.type(rows[0].tipo_mime).send(rows[0].contenido);
});

module.exports = router;
