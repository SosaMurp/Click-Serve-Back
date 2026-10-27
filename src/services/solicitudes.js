const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { signFileUrl, signRequestImageUrl } = require('../lib/files');
const { haversineKm, etaMinutes } = require('../lib/geo');
const realtime = require('../lib/realtime');
const { sendPush } = require('../lib/push');

const ACTIVE_STATES = ['ASIGNADA', 'EN_CAMINO', 'EN_SITIO', 'ESPERANDO_APROBACION', 'EN_PROCESO', 'POR_CONFIRMAR', 'SUSPENDIDA'];
const CLOSED_STATES = ['FINALIZADA', 'CANCELADA'];

// Códigos de la app anterior → catálogo categorias_servicio.
const LEGACY_CATEGORIES = { TECH: 'COMPUTO', LUZ: 'ELECTRICIDAD', HOGAR: 'PLOMERIA' };

// Plantillas de tareas por categoría (RF-62) con protocolos STPS (RD-016) y NOM-001-SEDE (RD-015).
const COMMON_TASKS = [
  { descripcion: 'Revisar que el área de trabajo sea segura antes de empezar', norma: 'STPS' },
  { descripcion: 'Usar el equipo de protección personal adecuado', norma: 'STPS' },
];
const CATEGORY_TASKS = {
  ELECTRICIDAD: [
    { descripcion: 'Cortar la energía del circuito antes de intervenir', norma: 'NOM-001-SEDE' },
    { descripcion: 'Verificar conexión a tierra y polaridad', norma: 'NOM-001-SEDE' },
    { descripcion: 'Probar el circuito y no dejar conductores expuestos', norma: 'NOM-001-SEDE' },
  ],
  PLOMERIA: [
    { descripcion: 'Cerrar la llave de paso antes de intervenir' },
    { descripcion: 'Probar que no queden fugas al terminar' },
  ],
  COMPUTO: [
    { descripcion: 'Respaldar la información antes de intervenir el equipo' },
    { descripcion: 'Probar el equipo junto con el cliente al terminar' },
  ],
  CLIMATIZACION: [
    { descripcion: 'Desenergizar el equipo antes de abrirlo', norma: 'NOM-001-SEDE' },
    { descripcion: 'Verificar drenaje y funcionamiento al terminar' },
  ],
  LINEA_BLANCA: [
    { descripcion: 'Desconectar el aparato de la corriente' },
    { descripcion: 'Probar un ciclo completo al terminar' },
  ],
  CERRAJERIA: [{ descripcion: 'Confirmar con el cliente la propiedad del inmueble' }],
  PINTURA: [{ descripcion: 'Proteger muebles y pisos' }, { descripcion: 'Ventilar el área de trabajo' }],
  MECANICA: [
    { descripcion: 'Asegurar el vehículo (freno de mano y calzas)' },
    { descripcion: 'Probar el vehículo junto con el cliente' },
  ],
};

function taskTemplate(categoria) {
  return [...COMMON_TASKS, ...(CATEGORY_TASKS[categoria] || [])];
}

function folio(prefix) {
  return `${prefix}-${crypto.randomBytes(5).readUIntBE(0, 5).toString(36).toUpperCase().padStart(8, '0').slice(-8)}`;
}

// Importes: cadenas con hasta 2 decimales, positivas, ≤ 100,000. La aritmética la hace PostgreSQL.
function parseMoney(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!(n > 0) || n > 100000) return null;
  return s;
}

const BASE_SELECT = `
  SELECT s.id_solicitud, s.folio, s.id_usuario, s.id_tecnico, s.id_tecnico_propuesto, s.propuesto_hasta,
         s.categoria, cat.nombre AS categoria_nombre, s.descripcion, s.direccion, s.referencias,
         to_char(s.fecha_preferida, 'YYYY-MM-DD') AS fecha_preferida, to_char(s.hora_preferida, 'HH24:MI') AS hora_preferida,
         s.estado, s.estado_previo, COALESCE(s.estado_pago, 'PENDIENTE') AS estado_pago, s.fecha_creacion,
         s.fecha_asignacion, s.fecha_llegada, s.fecha_finalizacion, to_char(s.garantia_hasta, 'YYYY-MM-DD') AS garantia_hasta,
         s.monto_total, s.monto_cotizacion, s.detalles_cotizacion, s.cancelado_por, s.motivo_cancelacion,
         s.alerta_sos, s.latitud, s.longitud,
         c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.telefono AS cliente_telefono, c.foto_archivo AS cliente_foto,
         t.nombre AS tecnico_nombre, t.apellido AS tecnico_apellido, t.telefono AS tecnico_telefono,
         t.foto_archivo AS tecnico_foto, COALESCE(t.verificado_sep, false) AS tecnico_verificado_sep,
         t.latitud AS tecnico_latitud, t.longitud AS tecnico_longitud, t.ultima_conexion AS tecnico_ubicacion_fecha,
         ts.calificacion AS tecnico_calificacion, COALESCE(ts.trabajos, 0) AS tecnico_trabajos,
         cs.puntuacion_tecnico AS calificacion_al_tecnico, cs.comentario_cliente AS comentario_al_tecnico,
         cs.puntuacion_cliente AS calificacion_al_cliente, cs.comentario_tecnico AS comentario_al_cliente
  FROM solicitudes_servicio s
  JOIN usuarios c ON c.id_usuario = s.id_usuario
  LEFT JOIN usuarios t ON t.id_usuario = s.id_tecnico
  LEFT JOIN categorias_servicio cat ON cat.codigo = s.categoria
  LEFT JOIN calificaciones_servicio cs ON cs.id_solicitud = s.id_solicitud
  LEFT JOIN LATERAL (
    SELECT ROUND(AVG(q.puntuacion_tecnico)::numeric, 1) AS calificacion,
           (SELECT COUNT(*)::int FROM solicitudes_servicio f WHERE f.id_tecnico = s.id_tecnico AND f.estado = 'FINALIZADA') AS trabajos
    FROM calificaciones_servicio q WHERE q.id_tecnico = s.id_tecnico AND q.puntuacion_tecnico IS NOT NULL
  ) ts ON s.id_tecnico IS NOT NULL`;

function zonaAproximada(direccion) {
  const parts = String(direccion || '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(', ') : 'Lázaro Cárdenas';
}

// Vista de una solicitud según quién la consulta (RNF-03: PII del cliente solo para el técnico asignado).
function shape(row, viewer, extra = {}) {
  const isClient = row.id_usuario === viewer.id_usuario;
  const isAssigned = row.id_tecnico != null && row.id_tecnico === viewer.id_usuario;
  const active = ACTIVE_STATES.includes(row.estado);
  const out = {
    id_solicitud: Number(row.id_solicitud),
    folio: row.folio,
    categoria: row.categoria,
    categoria_nombre: row.categoria_nombre || 'Servicio general',
    descripcion: row.descripcion,
    fecha_preferida: row.fecha_preferida,
    hora_preferida: row.hora_preferida,
    estado: row.estado,
    estado_previo: row.estado_previo,
    estado_pago: row.estado_pago,
    fecha_creacion: row.fecha_creacion,
    fecha_asignacion: row.fecha_asignacion,
    fecha_llegada: row.fecha_llegada,
    fecha_finalizacion: row.fecha_finalizacion,
    garantia_hasta: row.garantia_hasta,
    monto_total: row.monto_total,
    monto_cotizacion: row.monto_cotizacion,
    cancelado_por: row.cancelado_por,
    motivo_cancelacion: row.motivo_cancelacion,
    alerta_sos: row.alerta_sos,
    id_tecnico: row.id_tecnico,
    tecnico_propuesto: row.id_tecnico_propuesto && row.propuesto_hasta && new Date(row.propuesto_hasta) > new Date() ? row.id_tecnico_propuesto : null,
    es_cliente: isClient,
    es_tecnico_asignado: isAssigned,
    calificacion_al_tecnico: row.calificacion_al_tecnico ?? null,
    comentario_al_tecnico: row.comentario_al_tecnico ?? null,
    calificacion_al_cliente: row.calificacion_al_cliente ?? null,
    comentario_al_cliente: row.comentario_al_cliente ?? null,
    ...extra,
  };

  if (isClient || isAssigned) {
    out.direccion = row.direccion;
    out.referencias = row.referencias;
    out.latitud = row.latitud == null ? null : Number(row.latitud);
    out.longitud = row.longitud == null ? null : Number(row.longitud);
  } else {
    out.zona = zonaAproximada(row.direccion);
    out.latitud_aprox = row.latitud == null ? null : Math.round(Number(row.latitud) * 100) / 100;
    out.longitud_aprox = row.longitud == null ? null : Math.round(Number(row.longitud) * 100) / 100;
  }

  if (!isClient) {
    out.cliente_nombre = row.cliente_nombre;
    out.cliente_apellido = isAssigned ? row.cliente_apellido : `${String(row.cliente_apellido || '').charAt(0)}.`;
    if (isAssigned && active) out.cliente_telefono = row.cliente_telefono;
  }

  if (row.id_tecnico) {
    out.tecnico = {
      id_usuario: row.id_tecnico,
      nombre: row.tecnico_nombre,
      apellido: row.tecnico_apellido,
      foto_url: row.tecnico_foto ? signFileUrl(row.tecnico_foto, 3600) : null,
      calificacion: row.tecnico_calificacion,
      trabajos: row.tecnico_trabajos,
      verificado_sep: row.tecnico_verificado_sep,
      telefono: isClient && active ? row.tecnico_telefono : undefined,
    };
    // Compatibilidad con los nombres planos que usaba la app anterior.
    out.tecnico_nombre = row.tecnico_nombre;
    out.tecnico_apellido = row.tecnico_apellido;
    if (isClient && row.estado === 'EN_CAMINO' && row.tecnico_latitud != null && row.latitud != null) {
      const km = haversineKm(
        { latitud: Number(row.tecnico_latitud), longitud: Number(row.tecnico_longitud) },
        { latitud: Number(row.latitud), longitud: Number(row.longitud) }
      );
      out.tecnico_ubicacion = {
        latitud: Number(row.tecnico_latitud),
        longitud: Number(row.tecnico_longitud),
        actualizado: row.tecnico_ubicacion_fecha,
        distancia_km: Math.round(km * 10) / 10,
        eta_min: etaMinutes(km),
      };
    }
  }
  return out;
}

async function findRow(id, db = getPool(), { lock = false } = {}) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return null;
  if (lock) {
    await db.query('SELECT 1 FROM solicitudes_servicio WHERE id_solicitud = $1 FOR UPDATE', [id]);
  }
  const { rows } = await db.query(`${BASE_SELECT} WHERE s.id_solicitud = $1`, [id]);
  return rows[0] || null;
}

// Puede verla: el cliente dueño, el técnico asignado o propuesto, o un técnico si sigue PENDIENTE.
function canView(row, user) {
  if (!row) return false;
  if (row.id_usuario === user.id_usuario || row.id_tecnico === user.id_usuario) return true;
  if (Number(user.id_rol) === 2 && row.estado === 'PENDIENTE') return true;
  return false;
}

async function detail(row, viewer, db = getPool()) {
  const id = row.id_solicitud;
  const isParticipant = row.id_usuario === viewer.id_usuario || row.id_tecnico === viewer.id_usuario;
  const [imagenes, conceptos, cotizacion, tareas, evidencias, reprog, incidencia, pago] = await Promise.all([
    db.query('SELECT id_imagen FROM solicitud_imagenes WHERE id_solicitud = $1 ORDER BY id_imagen', [id]),
    db.query(
      `SELECT k.id_concepto, k.tipo, k.descripcion, k.monto, k.id_cotizacion
       FROM conceptos_cotizacion k
       LEFT JOIN cotizaciones_servicio q ON q.id_cotizacion = k.id_cotizacion
       WHERE k.id_solicitud = $1 AND (k.id_cotizacion IS NULL OR q.estado IN ('ENVIADA', 'ACEPTADA'))
       ORDER BY k.id_concepto`,
      [id]
    ),
    db.query(
      `SELECT id_cotizacion, monto_mano_obra, monto_materiales, monto_total, detalles, tiempo_estimado_minutos, estado, fecha_creacion
       FROM cotizaciones_servicio WHERE id_solicitud = $1 AND estado IN ('ENVIADA', 'ACEPTADA')
       ORDER BY id_cotizacion DESC LIMIT 1`,
      [id]
    ),
    isParticipant ? db.query('SELECT id_tarea, descripcion, origen, norma, completada, fecha_completada FROM tareas_servicio WHERE id_solicitud = $1 ORDER BY orden, id_tarea', [id]) : { rows: [] },
    isParticipant ? db.query('SELECT id_evidencia, tipo_evidencia, descripcion, id_archivo, fecha_subida FROM evidencias_servicio WHERE id_solicitud = $1 ORDER BY id_evidencia', [id]) : { rows: [] },
    isParticipant ? db.query(
      `SELECT id_reprogramacion, propuesta_por, to_char(fecha, 'YYYY-MM-DD') AS fecha, to_char(hora, 'HH24:MI') AS hora, motivo, estado, fecha_creacion
       FROM reprogramaciones WHERE id_solicitud = $1 AND estado = 'PENDIENTE' ORDER BY id_reprogramacion DESC LIMIT 1`,
      [id]
    ) : { rows: [] },
    isParticipant ? db.query(
      `SELECT id_incidencia, folio, tipo, descripcion, prioridad, estado, fecha_creacion, (id_usuario = $2) AS propia
       FROM incidencias WHERE id_solicitud = $1 AND estado = 'ABIERTA' ORDER BY id_incidencia DESC LIMIT 1`,
      [id, viewer.id_usuario]
    ) : { rows: [] },
    isParticipant ? db.query('SELECT monto, modo, referencia, estado, fecha, desglose FROM pagos WHERE id_solicitud = $1', [id]) : { rows: [] },
  ]);

  const cot = cotizacion.rows[0] || null;
  const isTech = row.id_tecnico === viewer.id_usuario;
  return shape(row, viewer, {
    imagenes: imagenes.rows.map((r) => ({ id: r.id_imagen, url: signRequestImageUrl(r.id_imagen) })),
    cotizacion: cot && {
      ...cot,
      conceptos: conceptos.rows.filter((k) => k.id_cotizacion === cot.id_cotizacion),
    },
    extras: conceptos.rows.filter((k) => k.tipo === 'EXTRA'),
    tareas: tareas.rows,
    evidencias: evidencias.rows.map((e) => ({ ...e, url: signFileUrl(e.id_archivo) })),
    reprogramacion: reprog.rows[0] ? { ...reprog.rows[0], propuesta_por_mi: reprog.rows[0].propuesta_por === viewer.id_usuario } : null,
    incidencia: incidencia.rows[0] || null,
    pago: pago.rows[0] ? { ...pago.rows[0], desglose: isTech ? pago.rows[0].desglose : undefined } : null,
  });
}

// Filtros del panel del técnico ($1 = id del técnico), compartidos por la lista y el resumen.
const TECH_WHERE = {
  nuevas: `s.estado = 'PENDIENTE'
    AND NOT EXISTS (SELECT 1 FROM solicitudes_descartadas d WHERE d.id_solicitud = s.id_solicitud AND d.id_tecnico = $1)
    AND (s.id_tecnico_propuesto IS NULL OR s.id_tecnico_propuesto = $1 OR s.propuesto_hasta < NOW())
    AND (s.categoria IS NULL
         OR NOT EXISTS (SELECT 1 FROM especialidades_tecnico e WHERE e.id_usuario = $1 AND e.categoria IS NOT NULL)
         OR EXISTS (SELECT 1 FROM especialidades_tecnico e WHERE e.id_usuario = $1 AND e.categoria = s.categoria AND e.activa))`,
  en_curso: `s.id_tecnico = $1 AND s.estado = ANY('{${ACTIVE_STATES.join(',')}}')`,
  historial: `s.id_tecnico = $1 AND s.estado IN ('FINALIZADA', 'CANCELADA')`,
};

async function techCounters(idTecnico, db = getPool()) {
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM solicitudes_servicio s WHERE ${TECH_WHERE.nuevas}) AS nuevas,
            (SELECT COUNT(*)::int FROM solicitudes_servicio s WHERE ${TECH_WHERE.en_curso}) AS en_curso,
            (SELECT COUNT(*)::int FROM solicitudes_servicio s WHERE ${TECH_WHERE.historial}) AS historial`,
    [idTecnico]
  );
  return rows[0];
}

function notify(row, aviso, { push } = {}) {
  const data = { id_solicitud: Number(row.id_solicitud), estado: row.estado, aviso };
  realtime.emitToUsers([row.id_usuario, row.id_tecnico], 'solicitud.actualizada', data);
  if (push) {
    for (const [userId, title] of push) sendPush(userId, title, aviso, data);
  }
}

module.exports = {
  ACTIVE_STATES, CLOSED_STATES, LEGACY_CATEGORIES, BASE_SELECT,
  TECH_WHERE, techCounters, taskTemplate, folio, parseMoney, shape, findRow, canView, detail, notify,
};
