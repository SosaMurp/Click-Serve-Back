const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { ROL, requireRole } = require('../middleware/roles');
const { fail, HttpError } = require('../lib/http');
const { audit } = require('../lib/audit');
const { sanitizeText } = require('../lib/sanitize');
const { saveFile, uploader, signFileUrl, DOCUMENT_TYPES } = require('../lib/files');
const realtime = require('../lib/realtime');
const S = require('../services/solicitudes');

const router = express.Router();
const db = () => getPool();

const CATEGORIAS = ['PAGOS', 'SERVICIO', 'CUENTA', 'SEGURIDAD', 'OTRO'];

function autoReply(ticket) {
  const plazo = ticket.prioridad === 'ALTA' ? 'de inmediato' : 'en un máximo de 24 horas';
  return `Hola, soy el asistente de soporte de Click & Serve. Registramos tu caso ${ticket.folio}. Un asesor te responderá ${plazo} por este mismo chat. Si estás en peligro, usa el botón SOS o llama al 911.`;
}

function shapeMessage(m) {
  return {
    id_mensaje: Number(m.id_mensaje),
    id_ticket: Number(m.id_ticket),
    id_emisor: m.id_emisor,
    es_asesor: m.es_asesor,
    mensaje: m.mensaje,
    adjunto_url: m.id_archivo ? signFileUrl(m.id_archivo) : null,
    adjunto_tipo: m.tipo_mime || null,
    fecha_envio: m.fecha_envio,
  };
}

async function insertMessage(tx, { idTicket, idEmisor, esAsesor, mensaje, file, owner }) {
  const idArchivo = file
    ? await saveFile(tx, { owner, buffer: file.buffer, mime: file.mimetype, name: file.originalname, categoria: 'SOPORTE' })
    : null;
  const { rows } = await tx.query(
    `INSERT INTO soporte_mensajes (id_ticket, id_emisor, es_asesor, mensaje, id_archivo) VALUES ($1, $2, $3, $4, $5)
     RETURNING id_mensaje, id_ticket, id_emisor, es_asesor, mensaje, id_archivo, fecha_envio`,
    [idTicket, idEmisor, esAsesor, mensaje, idArchivo]
  );
  await tx.query('UPDATE soporte_tickets SET fecha_actualizacion = NOW() WHERE id_ticket = $1', [idTicket]);
  return shapeMessage({ ...rows[0], tipo_mime: file?.mimetype });
}

async function createTicket(tx, { user, asunto, categoria, prioridad = 'MEDIA', estado = 'ABIERTO', idSolicitud = null, mensaje, file }) {
  // Si el folio aleatorio ya existe se genera otro; ON CONFLICT evita abortar la transacción.
  let ticket;
  for (let i = 0; i < 3 && !ticket; i += 1) {
    ticket = (await tx.query(
      `INSERT INTO soporte_tickets (folio, id_usuario, id_solicitud, asunto, categoria, prioridad, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (folio) DO NOTHING RETURNING *`,
      [S.folio('TCK'), user.id_usuario, idSolicitud, asunto, categoria, prioridad, estado]
    )).rows[0];
  }
  if (!ticket) throw new Error('No se pudo generar un folio único para el ticket');
  await insertMessage(tx, { idTicket: ticket.id_ticket, idEmisor: user.id_usuario, esAsesor: false, mensaje, file, owner: user.id_usuario });
  await insertMessage(tx, { idTicket: ticket.id_ticket, idEmisor: null, esAsesor: true, mensaje: autoReply(ticket) });
  return ticket;
}

async function ownTicket(id, user, tx = db()) {
  const { rows } = await tx.query('SELECT * FROM soporte_tickets WHERE id_ticket = $1 AND id_usuario = $2', [id, user.id_usuario]);
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Caso no encontrado.');
  return rows[0];
}

// ───────────────────────── Tickets (RF-107, RF-94) ─────────────────────────
router.post('/api/soporte/tickets', auth, uploader({ types: DOCUMENT_TYPES, maxFiles: 1, maxSizeMb: 8 }).single('adjunto'), async (req, res) => {
  const asunto = sanitizeText(req.body?.asunto, 150);
  const mensaje = sanitizeText(req.body?.mensaje, 2000);
  const categoria = CATEGORIAS.includes(String(req.body?.categoria || '').toUpperCase()) ? String(req.body.categoria).toUpperCase() : 'OTRO';
  if (asunto.length < 3) return fail(res, 400, 'VALIDATION_ERROR', 'Escribe el asunto de tu caso.', { field: 'asunto' });
  if (mensaje.length < 5) return fail(res, 400, 'VALIDATION_ERROR', 'Cuéntanos con más detalle qué necesitas.', { field: 'mensaje' });

  let idSolicitud = null;
  if (req.body?.id_solicitud) {
    const row = await S.findRow(req.body.id_solicitud);
    if (!row || (row.id_usuario !== req.user.id_usuario && row.id_tecnico !== req.user.id_usuario)) {
      return fail(res, 404, 'NOT_FOUND', 'Solicitud no encontrada.');
    }
    idSolicitud = row.id_solicitud;
  }
  const ticket = await withTransaction((tx) => createTicket(tx, {
    user: req.user, asunto, categoria, prioridad: categoria === 'SEGURIDAD' ? 'ALTA' : 'MEDIA', idSolicitud, mensaje, file: req.file,
  }));
  audit(req, 'TICKET_CREADO', 'ticket', ticket.id_ticket, { folio: ticket.folio, categoria });
  res.status(201).json({ mensaje: `Caso ${ticket.folio} registrado.`, ticket });
});

router.get('/api/soporte/tickets', auth, async (req, res) => {
  const { rows } = await db().query(
    `SELECT t.*, s.folio AS folio_solicitud,
            (SELECT mensaje FROM soporte_mensajes m WHERE m.id_ticket = t.id_ticket ORDER BY fecha_envio DESC LIMIT 1) AS ultimo_mensaje
     FROM soporte_tickets t LEFT JOIN solicitudes_servicio s ON s.id_solicitud = t.id_solicitud
     WHERE t.id_usuario = $1 ORDER BY t.fecha_actualizacion DESC LIMIT 100`,
    [req.user.id_usuario]
  );
  res.json({ tickets: rows });
});

router.get('/api/soporte/tickets/:id/mensajes', auth, async (req, res) => {
  const ticket = await ownTicket(req.params.id, req.user);
  const { rows } = await db().query(
    `SELECT m.*, a.tipo_mime FROM soporte_mensajes m LEFT JOIN archivos a ON a.id_archivo = m.id_archivo
     WHERE m.id_ticket = $1 ORDER BY m.fecha_envio, m.id_mensaje`,
    [ticket.id_ticket]
  );
  res.json({ ticket, mensajes: rows.map(shapeMessage) });
});

router.post('/api/soporte/tickets/:id/mensajes', auth, uploader({ types: DOCUMENT_TYPES, maxFiles: 1, maxSizeMb: 8 }).single('adjunto'), async (req, res) => {
  const ticket = await ownTicket(req.params.id, req.user);
  if (ticket.estado === 'CERRADO') return fail(res, 409, 'INVALID_STATE', 'Este caso está cerrado. Abre uno nuevo si lo necesitas.');
  const mensaje = sanitizeText(req.body?.mensaje, 2000) || null;
  if (!mensaje && !req.file) return fail(res, 400, 'VALIDATION_ERROR', 'El mensaje no puede estar vacío.');
  const saved = await withTransaction((tx) => insertMessage(tx, { idTicket: ticket.id_ticket, idEmisor: req.user.id_usuario, esAsesor: false, mensaje, file: req.file, owner: req.user.id_usuario }));
  realtime.emitToUser(req.user.id_usuario, 'soporte.mensaje', saved);
  res.status(201).json({ mensaje: saved });
});

// RF-113: elevar prioridad del caso.
router.post('/api/soporte/tickets/:id/escalar', auth, async (req, res) => {
  const ticket = await ownTicket(req.params.id, req.user);
  const updated = await withTransaction(async (tx) => {
    const { rows } = await tx.query("UPDATE soporte_tickets SET estado = 'ESCALADO', prioridad = 'ALTA', fecha_actualizacion = NOW() WHERE id_ticket = $1 RETURNING *", [ticket.id_ticket]);
    await insertMessage(tx, { idTicket: ticket.id_ticket, idEmisor: null, esAsesor: true, mensaje: 'Tu caso se escaló con prioridad alta. Un supervisor lo atenderá de inmediato.' });
    return rows[0];
  });
  audit(req, 'TICKET_ESCALADO', 'ticket', ticket.id_ticket);
  console.error(`CASO ESCALADO · ${ticket.folio} · usuario ${req.user.id_usuario}`);
  res.json({ mensaje: 'Caso escalado con prioridad alta.', ticket: updated });
});

// RF-113 desde el chat del servicio: ticket urgente + incidencia de seguridad.
router.post('/api/solicitudes/:id/escalar', auth, async (req, res) => {
  const motivo = sanitizeText(req.body?.motivo, 1000) || 'Escalación de seguridad desde el chat del servicio.';
  const out = await withTransaction(async (tx) => {
    const row = await S.findRow(req.params.id, tx, { lock: true });
    if (!row || (row.id_usuario !== req.user.id_usuario && row.id_tecnico !== req.user.id_usuario)) {
      throw new HttpError(404, 'NOT_FOUND', 'Solicitud no encontrada.');
    }
    const ticket = await createTicket(tx, {
      user: req.user, asunto: `Escalación de seguridad · ${row.folio}`, categoria: 'SEGURIDAD',
      prioridad: 'ALTA', estado: 'ESCALADO', idSolicitud: row.id_solicitud, mensaje: motivo,
    });
    let incidencia = (await tx.query(
      "SELECT id_incidencia, folio, tipo, prioridad, estado FROM incidencias WHERE id_solicitud = $1 AND tipo = 'SEGURIDAD' AND estado = 'ABIERTA'",
      [row.id_solicitud]
    )).rows[0];
    if (!incidencia) {
      incidencia = (await tx.query(
        `INSERT INTO incidencias (folio, id_solicitud, id_usuario, tipo, descripcion, prioridad, estado_previo)
         VALUES ($1, $2, $3, 'SEGURIDAD', $4, 'ALTA', $5) RETURNING id_incidencia, folio, tipo, prioridad, estado`,
        [S.folio('INC'), row.id_solicitud, req.user.id_usuario, motivo, row.estado]
      )).rows[0];
    }
    return { ticket, incidencia, row };
  });
  audit(req, 'ESCALACION_SEGURIDAD', 'solicitud', out.row.id_solicitud, { ticket: out.ticket.folio, incidencia: out.incidencia.folio });
  console.error(`ESCALACIÓN DE SEGURIDAD · ${out.row.folio} · ticket ${out.ticket.folio} · incidencia ${out.incidencia.folio}`);
  res.status(201).json({ mensaje: 'Escalamos tu caso con prioridad alta. El equipo de seguridad ya fue notificado.', ticket: out.ticket, incidencia: out.incidencia });
});

// Respuesta de un asesor (para el panel de administrador).
router.post('/api/admin/soporte/tickets/:id/mensajes', auth, requireRole(ROL.ADMIN), async (req, res) => {
  const mensaje = sanitizeText(req.body?.mensaje, 2000);
  if (!mensaje) return fail(res, 400, 'VALIDATION_ERROR', 'El mensaje no puede estar vacío.');
  const ticket = (await db().query('SELECT * FROM soporte_tickets WHERE id_ticket = $1', [req.params.id])).rows[0];
  if (!ticket) return fail(res, 404, 'NOT_FOUND', 'Caso no encontrado.');
  const saved = await withTransaction(async (tx) => {
    await tx.query("UPDATE soporte_tickets SET estado = CASE WHEN estado = 'ABIERTO' THEN 'EN_ATENCION' ELSE estado END WHERE id_ticket = $1", [ticket.id_ticket]);
    return insertMessage(tx, { idTicket: ticket.id_ticket, idEmisor: req.user.id_usuario, esAsesor: true, mensaje });
  });
  realtime.emitToUser(ticket.id_usuario, 'soporte.mensaje', saved);
  res.status(201).json({ mensaje: saved });
});

module.exports = router;
