const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const { fail } = require('../lib/http');
const { uploader } = require('../lib/files');
const { sanitizeText } = require('../lib/sanitize');
const { signTicket, readTicket, registroKey, sha256 } = require('../lib/ine/ticket');
const { verifyIne } = require('../services/ineVerifier');

const router = express.Router();
// Cada foto que toma la app es un intento; en web el disparo es automático, así que el margen es amplio.
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

// RF-25: la app manda cada lado de la INE al tomar la foto, antes de crear la cuenta (por eso es pública).
// Si pasa, devuelve un ticket firmado y ligado a esa imagen, que POST /api/register exige.
router.post('/api/ine/verificar', limiter, uploader({ maxFiles: 1, maxSizeMb: 10 }).single('foto'), async (req, res) => {
  const b = req.body || {};
  const lado = b.lado === 'reverso' ? 'reverso' : b.lado === 'frente' ? 'frente' : null;
  if (!lado) return fail(res, 400, 'VALIDATION_ERROR', 'Indica qué lado de la credencial es.');
  if (!req.file) return fail(res, 400, 'VALIDATION_ERROR', 'Toma la foto de tu credencial.');
  const registro = {
    nombre: sanitizeText(b.nombre, 100),
    apellidos: sanitizeText(b.apellidos, 100),
    fecha_nacimiento: String(b.fecha_nacimiento || '').slice(0, 10),
  };
  if (!registro.nombre || !registro.apellidos || !/^\d{4}-\d{2}-\d{2}$/.test(registro.fecha_nacimiento)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Primero escribe tu nombre, apellidos y fecha de nacimiento.');
  }

  let frente = null;
  if (lado === 'reverso') {
    frente = readTicket(b.ticket_frente);
    if (!frente || frente.lado !== 'frente' || frente.persona !== registroKey(registro)) {
      return fail(res, 400, 'FRONT_REQUIRED', 'Primero toma la foto del frente de tu credencial.');
    }
  }

  const r = await verifyIne({ buffer: req.file.buffer, lado, registro, frente });
  const body = { ok: r.ok, lado, comprobaciones: r.comprobaciones, motivo: r.motivo, datos: r.datos };
  if (r.ok) {
    body.ticket = signTicket({
      lado,
      hash: sha256(req.file.buffer),
      persona: registroKey(registro),
      curp: lado === 'frente' ? r.datos.curp : frente.curp,
      fecha_nacimiento: lado === 'frente' ? r.datos.fecha_nacimiento : frente.fecha_nacimiento,
      sexo: lado === 'frente' ? r.datos.sexo : frente.sexo,
      comprobaciones: r.comprobaciones.map(({ id, ok }) => ({ id, ok })),
    });
  }
  return res.json(body);
});

module.exports = router;
