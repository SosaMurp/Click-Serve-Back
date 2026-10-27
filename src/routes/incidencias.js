const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { fail, HttpError } = require('../lib/http');
const { audit } = require('../lib/audit');
const { sanitizeText } = require('../lib/sanitize');
const realtime = require('../lib/realtime');
const { sendPush } = require('../lib/push');
const S = require('../services/solicitudes');
const { todayMx } = require('../lib/dates');

const router = express.Router();

const TIPOS = ['NO_SE_PRESENTO', 'COBRO_INDEBIDO', 'MALA_CALIDAD', 'DANOS', 'SEGURIDAD', 'GARANTIA', 'OTRO'];
const PRIORIDAD = { SEGURIDAD: 'ALTA', NO_SE_PRESENTO: 'ALTA', DANOS: 'ALTA', COBRO_INDEBIDO: 'MEDIA', MALA_CALIDAD: 'MEDIA', GARANTIA: 'MEDIA', OTRO: 'BAJA' };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function participant(row, user) {
  return row && (row.id_usuario === user.id_usuario || row.id_tecnico === user.id_usuario);
}

// ───────────────────────── Incidencias (RF-56, RF-109/110) ─────────────────────────
router.post('/api/solicitudes/:id/incidencias', auth, async (req, res) => {
  const tipo = String(req.body?.tipo || '').toUpperCase();
  const descripcion = sanitizeText(req.body?.descripcion, 1500);
  if (!TIPOS.includes(tipo)) return fail(res, 400, 'VALIDATION_ERROR', 'Selecciona el tipo de problema.', { field: 'tipo' });
  if (descripcion.length < 10) return fail(res, 400, 'VALIDATION_ERROR', 'Cuéntanos qué pasó con al menos 10 caracteres.', { field: 'descripcion' });

  const out = await withTransaction(async (tx) => {
    const row = await S.findRow(req.params.id, tx, { lock: true });
    if (!participant(row, req.user)) throw new HttpError(404, 'NOT_FOUND', 'Solicitud no encontrada.');
    if (row.estado === 'CANCELADA') throw new HttpError(409, 'INVALID_STATE', 'La solicitud está cancelada.');
    if (row.estado === 'FINALIZADA' && tipo === 'GARANTIA' && (!row.garantia_hasta || row.garantia_hasta < todayMx())) {
      throw new HttpError(409, 'WARRANTY_EXPIRED', 'La garantía de 90 días de este servicio ya venció.');
    }
    const open = await tx.query("SELECT id_incidencia FROM incidencias WHERE id_solicitud = $1 AND estado = 'ABIERTA' AND tipo <> 'SEGURIDAD'", [row.id_solicitud]);
    if (open.rowCount) throw new HttpError(409, 'INCIDENT_OPEN', 'Ya hay un reporte abierto para este servicio.');

    const suspend = S.ACTIVE_STATES.includes(row.estado) && row.estado !== 'SUSPENDIDA';
    const inc = (await tx.query(
      `INSERT INTO incidencias (folio, id_solicitud, id_usuario, tipo, descripcion, prioridad, estado_previo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id_incidencia, folio, tipo, descripcion, prioridad, estado, fecha_creacion`,
      [S.folio('INC'), row.id_solicitud, req.user.id_usuario, tipo, descripcion, PRIORIDAD[tipo], row.estado]
    )).rows[0];
    if (suspend) {
      await tx.query("UPDATE solicitudes_servicio SET estado_previo = estado, estado = 'SUSPENDIDA' WHERE id_solicitud = $1", [row.id_solicitud]);
    }
    return { inc, row: await S.findRow(row.id_solicitud, tx) };
  });

  audit(req, 'INCIDENCIA_REPORTADA', 'incidencia', out.inc.id_incidencia, { tipo, folio: out.inc.folio });
  const other = out.row.id_usuario === req.user.id_usuario ? out.row.id_tecnico : out.row.id_usuario;
  S.notify(out.row, `Se reportó una incidencia (${out.inc.folio}). La orden está suspendida mientras se resuelve.`);
  sendPush(other, 'Orden suspendida', `Se reportó una incidencia en ${out.row.folio}.`);
  res.status(201).json({ mensaje: `Reporte ${out.inc.folio} registrado. La orden quedó suspendida.`, incidencia: out.inc, solicitud: S.shape(out.row, req.user) });
});

router.get('/api/incidencias', auth, async (req, res) => {
  const { rows } = await getPool().query(
    `SELECT i.id_incidencia, i.folio, i.tipo, i.descripcion, i.prioridad, i.estado, i.resolucion, i.fecha_creacion, i.fecha_resolucion,
            s.id_solicitud, s.folio AS folio_solicitud
     FROM incidencias i LEFT JOIN solicitudes_servicio s ON s.id_solicitud = i.id_solicitud
     WHERE i.id_usuario = $1 OR s.id_usuario = $1 OR s.id_tecnico = $1
     ORDER BY i.fecha_creacion DESC LIMIT 100`,
    [req.user.id_usuario]
  );
  res.json({ incidencias: rows });
});

// RF-55: reasignar · RF-57: cancelar sin cargo (solo el cliente) · continuar: quien reportó retira su reporte.
router.post('/api/incidencias/:id/resolver', auth, async (req, res) => {
  const accion = String(req.body?.accion || '').toUpperCase();
  if (!['REASIGNAR', 'CANCELAR', 'CONTINUAR'].includes(accion)) return fail(res, 400, 'VALIDATION_ERROR', 'Acción no válida.');

  const out = await withTransaction(async (tx) => {
    const inc = (await tx.query('SELECT * FROM incidencias WHERE id_incidencia = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!inc) throw new HttpError(404, 'NOT_FOUND', 'Reporte no encontrado.');
    const row = await S.findRow(inc.id_solicitud, tx, { lock: true });
    const isClient = row?.id_usuario === req.user.id_usuario;
    const isReporter = inc.id_usuario === req.user.id_usuario;
    if (!row || (!isClient && !isReporter)) throw new HttpError(404, 'NOT_FOUND', 'Reporte no encontrado.');
    // Nadie cierra ni retira el reporte de la otra parte: una alerta SOS del técnico solo la atiende seguridad.
    if (!isReporter && (inc.tipo === 'SEGURIDAD' || accion === 'CONTINUAR')) {
      throw new HttpError(403, 'NOT_REPORTER', 'Solo quien hizo el reporte puede retirarlo; las alertas de seguridad las atiende el equipo de Click & Serve.');
    }
    if (!isClient && accion !== 'CONTINUAR') throw new HttpError(403, 'ROLE_FORBIDDEN', 'Solo el cliente puede reasignar o cancelar la orden.');
    if (row.estado_pago === 'PROCESANDO' && accion !== 'CONTINUAR') {
      throw new HttpError(409, 'PAYMENT_IN_PROGRESS', 'Hay un cobro en revisión para este servicio; soporte resolverá el reporte.');
    }
    if (inc.estado !== 'ABIERTA') throw new HttpError(409, 'INVALID_STATE', 'Este reporte ya fue resuelto.');
    if (row.estado !== 'SUSPENDIDA' && accion !== 'CONTINUAR') throw new HttpError(409, 'INVALID_STATE', 'La orden no está suspendida.');

    const previousTech = row.id_tecnico;
    if (accion === 'REASIGNAR') {
      await tx.query(
        `UPDATE solicitudes_servicio SET estado = 'PENDIENTE', estado_previo = NULL, id_tecnico = NULL, fecha_asignacion = NULL,
           fecha_llegada = NULL, monto_cotizacion = NULL, monto_total = NULL WHERE id_solicitud = $1`,
        [row.id_solicitud]
      );
      await tx.query("UPDATE cotizaciones_servicio SET estado = 'CANCELADA' WHERE id_solicitud = $1 AND estado IN ('ENVIADA', 'ACEPTADA')", [row.id_solicitud]);
      await tx.query("DELETE FROM conceptos_cotizacion WHERE id_solicitud = $1 AND tipo = 'EXTRA'", [row.id_solicitud]);
      await tx.query('DELETE FROM tareas_servicio WHERE id_solicitud = $1', [row.id_solicitud]);
      if (previousTech) {
        await tx.query('INSERT INTO solicitudes_descartadas (id_solicitud, id_tecnico) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id_solicitud, previousTech]);
      }
    } else if (accion === 'CANCELAR') {
      await tx.query(
        `UPDATE solicitudes_servicio SET estado = 'CANCELADA', estado_previo = NULL, cancelado_por = 'CLIENTE',
           motivo_cancelacion = $1, estado_pago = 'NO_APLICA' WHERE id_solicitud = $2`,
        [`Cancelada sin cargo por la incidencia ${inc.folio}`, row.id_solicitud]
      );
    } else if (row.estado === 'SUSPENDIDA') {
      await tx.query('UPDATE solicitudes_servicio SET estado = COALESCE(estado_previo, $2), estado_previo = NULL WHERE id_solicitud = $1', [row.id_solicitud, inc.estado_previo || 'ASIGNADA']);
    }
    await tx.query("UPDATE incidencias SET estado = 'RESUELTA', resolucion = $1, fecha_resolucion = NOW() WHERE id_incidencia = $2", [accion, inc.id_incidencia]);
    return { inc, previousTech, row: await S.findRow(row.id_solicitud, tx) };
  });

  audit(req, 'INCIDENCIA_RESUELTA', 'incidencia', out.inc.id_incidencia, { accion });
  const avisos = {
    REASIGNAR: 'El cliente pidió otro técnico para esta orden.',
    CANCELAR: 'El cliente canceló la orden por la incidencia reportada.',
    CONTINUAR: 'Se retiró el reporte; la orden continúa.',
  };
  if (out.previousTech) realtime.emitToUser(out.previousTech, 'solicitud.actualizada', { id_solicitud: Number(out.row.id_solicitud), estado: out.row.estado, aviso: avisos[accion] });
  realtime.emitToUser(out.row.id_usuario, 'solicitud.actualizada', { id_solicitud: Number(out.row.id_solicitud), estado: out.row.estado });
  res.json({ mensaje: 'Reporte resuelto.', solicitud: S.shape(out.row, req.user) });
});

// ───────────────────────── Reprogramación (RF-63/64, RF-124/125) ─────────────────────────
const RESCHEDULABLE = ['PENDIENTE', 'ASIGNADA', 'EN_CAMINO'];

function parseSchedule(body) {
  const fecha = String(body?.fecha || '');
  const hora = String(body?.hora || '').slice(0, 5);
  if (!ISO_DATE.test(fecha) || fecha < todayMx()) throw new HttpError(400, 'VALIDATION_ERROR', 'Elige una fecha de hoy en adelante.', { field: 'fecha' });
  if (!HHMM.test(hora)) throw new HttpError(400, 'VALIDATION_ERROR', 'Elige una hora válida.', { field: 'hora' });
  return { fecha, hora, motivo: sanitizeText(body?.motivo, 300) || null };
}

async function createProposal(tx, row, userId, schedule, idAnterior = null) {
  await tx.query("UPDATE reprogramaciones SET estado = 'CANCELADA' WHERE id_solicitud = $1 AND estado = 'PENDIENTE'", [row.id_solicitud]);
  const { rows } = await tx.query(
    `INSERT INTO reprogramaciones (id_solicitud, propuesta_por, fecha, hora, motivo, id_anterior)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id_reprogramacion, id_solicitud, propuesta_por, to_char(fecha, 'YYYY-MM-DD') AS fecha, to_char(hora, 'HH24:MI') AS hora, motivo, estado, fecha_creacion`,
    [row.id_solicitud, userId, schedule.fecha, schedule.hora, schedule.motivo, idAnterior]
  );
  return rows[0];
}

function otherParty(row, userId) {
  return row.id_usuario === userId ? row.id_tecnico : row.id_usuario;
}

router.post('/api/solicitudes/:id/reprogramaciones', auth, async (req, res) => {
  const schedule = parseSchedule(req.body);
  const out = await withTransaction(async (tx) => {
    const row = await S.findRow(req.params.id, tx, { lock: true });
    if (!participant(row, req.user)) throw new HttpError(404, 'NOT_FOUND', 'Solicitud no encontrada.');
    if (!row.id_tecnico) throw new HttpError(409, 'INVALID_STATE', 'Aún no hay técnico asignado; cambia la fecha desde los detalles de la solicitud.');
    if (!RESCHEDULABLE.includes(row.estado)) throw new HttpError(409, 'INVALID_STATE', 'Solo se puede reprogramar antes de que el técnico llegue.');
    return { row, prop: await createProposal(tx, row, req.user.id_usuario, schedule) };
  });
  const to = otherParty(out.row, req.user.id_usuario);
  realtime.emitToUser(to, 'reprogramacion.propuesta', { id_solicitud: Number(out.row.id_solicitud), reprogramacion: out.prop });
  sendPush(to, 'Propuesta de nuevo horario', `${req.user.nombre} propone ${out.prop.fecha} a las ${out.prop.hora}.`, { id_solicitud: Number(out.row.id_solicitud) });
  audit(req, 'REPROGRAMACION_PROPUESTA', 'solicitud', out.row.id_solicitud, schedule);
  res.status(201).json({ mensaje: 'Propuesta enviada. Te avisaremos cuando respondan.', reprogramacion: out.prop });
});

router.patch('/api/reprogramaciones/:id', auth, async (req, res) => {
  const respuesta = String(req.body?.respuesta || '').toUpperCase();
  if (!['ACEPTAR', 'RECHAZAR', 'CANCELAR'].includes(respuesta)) return fail(res, 400, 'VALIDATION_ERROR', 'Respuesta no válida.');
  const counter = respuesta === 'RECHAZAR' && req.body?.contrapropuesta ? parseSchedule(req.body.contrapropuesta) : null;

  const out = await withTransaction(async (tx) => {
    const prop = (await tx.query('SELECT * FROM reprogramaciones WHERE id_reprogramacion = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!prop) throw new HttpError(404, 'NOT_FOUND', 'Propuesta no encontrada.');
    const row = await S.findRow(prop.id_solicitud, tx, { lock: true });
    if (!participant(row, req.user)) throw new HttpError(404, 'NOT_FOUND', 'Propuesta no encontrada.');
    if (prop.estado !== 'PENDIENTE') throw new HttpError(409, 'INVALID_STATE', 'Esta propuesta ya fue respondida.');
    const mine = prop.propuesta_por === req.user.id_usuario;
    if (respuesta === 'CANCELAR' ? !mine : mine) {
      throw new HttpError(403, 'FORBIDDEN', respuesta === 'CANCELAR' ? 'Solo quien propuso puede retirarla.' : 'No puedes responder tu propia propuesta.');
    }

    let contrapropuesta = null;
    if (respuesta === 'ACEPTAR') {
      await tx.query(
        `UPDATE solicitudes_servicio SET fecha_preferida = $1, hora_preferida = $2,
           estado = CASE WHEN estado = 'EN_CAMINO' THEN 'ASIGNADA' ELSE estado END WHERE id_solicitud = $3`,
        [prop.fecha, prop.hora, row.id_solicitud]
      );
      await tx.query("UPDATE reprogramaciones SET estado = 'ACEPTADA', fecha_respuesta = NOW() WHERE id_reprogramacion = $1", [prop.id_reprogramacion]);
    } else {
      await tx.query('UPDATE reprogramaciones SET estado = $1, fecha_respuesta = NOW() WHERE id_reprogramacion = $2', [respuesta === 'CANCELAR' ? 'CANCELADA' : 'RECHAZADA', prop.id_reprogramacion]);
      if (counter) contrapropuesta = await createProposal(tx, row, req.user.id_usuario, counter, prop.id_reprogramacion);
    }
    return { prop, row: await S.findRow(row.id_solicitud, tx), contrapropuesta };
  });

  const to = otherParty(out.row, req.user.id_usuario);
  const avisos = {
    ACEPTAR: `Se confirmó el nuevo horario: ${out.row.fecha_preferida} a las ${out.row.hora_preferida}.`,
    RECHAZAR: out.contrapropuesta ? `Te proponen otro horario: ${out.contrapropuesta.fecha} a las ${out.contrapropuesta.hora}.` : 'Rechazaron el cambio de horario; se mantiene la cita original.',
    CANCELAR: 'Se retiró la propuesta de cambio de horario.',
  };
  S.notify(out.row, avisos[respuesta]);
  sendPush(to, 'Reprogramación', avisos[respuesta], { id_solicitud: Number(out.row.id_solicitud) });
  audit(req, `REPROGRAMACION_${respuesta}`, 'solicitud', out.row.id_solicitud);
  res.json({ mensaje: avisos[respuesta], solicitud: S.shape(out.row, req.user), contrapropuesta: out.contrapropuesta });
});

module.exports = router;
