const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { ROL, requireRole, requireApproved } = require('../middleware/roles');
const { fail } = require('../lib/http');
const { audit } = require('../lib/audit');
const { sanitizeText } = require('../lib/sanitize');
const { saveFile, uploader, signFileUrl, DOCUMENT_TYPES } = require('../lib/files');
const { parseCoord, haversineKm, etaMinutes } = require('../lib/geo');
const realtime = require('../lib/realtime');
const { fetchWithTimeout } = require('../services/payments');
const S = require('../services/solicitudes');

const router = express.Router();
const db = () => getPool();
const techOnly = [auth, requireRole(ROL.TECNICO)];

// ───────────────────────── Disponibilidad y latido (RF-21, RNF-34) ─────────────────────────
function locationParams(body) {
  return { lat: parseCoord(body?.latitud, -90, 90), lng: parseCoord(body?.longitud, -180, 180) };
}

router.put('/api/tecnico/disponibilidad', ...techOnly, async (req, res, next) => {
  const disponible = req.body?.disponible === true;
  if (disponible && !req.user.aprobado) return requireApproved(req, res, next);
  const { lat, lng } = locationParams(req.body);
  const { rows } = await db().query(
    `UPDATE usuarios SET disponible = $1,
       ultimo_latido = CASE WHEN $1 THEN NOW() ELSE ultimo_latido END,
       latitud = COALESCE($2, latitud), longitud = COALESCE($3, longitud), ultima_conexion = NOW()
     WHERE id_usuario = $4 RETURNING disponible`,
    [disponible, lat, lng, req.user.id_usuario]
  );
  audit(req, disponible ? 'TECNICO_EN_LINEA' : 'TECNICO_FUERA_DE_LINEA', 'usuario', req.user.id_usuario);
  res.json({ disponible: rows[0].disponible, mensaje: disponible ? 'Estás en línea y recibirás solicitudes.' : 'Estás fuera de línea.' });
});

router.post('/api/tecnico/latido', ...techOnly, async (req, res) => {
  const { lat, lng } = locationParams(req.body);
  const { rows } = await db().query(
    `UPDATE usuarios SET ultimo_latido = NOW(), ultima_conexion = NOW(),
       latitud = COALESCE($1, latitud), longitud = COALESCE($2, longitud)
     WHERE id_usuario = $3 RETURNING disponible`,
    [lat, lng, req.user.id_usuario]
  );
  res.json({ ok: true, disponible: rows[0].disponible });
});

// RNF-43: ubicación en ruta; se reenvía al cliente del servicio en curso.
router.put('/api/usuarios/ubicacion', auth, async (req, res) => {
  const { lat, lng } = locationParams(req.body);
  if (lat == null || lng == null) return fail(res, 400, 'VALIDATION_ERROR', 'Coordenadas inválidas.');
  await db().query(
    `UPDATE usuarios SET latitud = $1, longitud = $2, ultima_conexion = NOW(),
       ultimo_latido = CASE WHEN id_rol = 2 THEN NOW() ELSE ultimo_latido END
     WHERE id_usuario = $3`,
    [lat, lng, req.user.id_usuario]
  );
  if (req.user.id_rol === ROL.TECNICO) {
    const { rows } = await db().query(
      "SELECT id_solicitud, id_usuario, latitud, longitud FROM solicitudes_servicio WHERE id_tecnico = $1 AND estado IN ('ASIGNADA', 'EN_CAMINO')",
      [req.user.id_usuario]
    );
    for (const s of rows) {
      const km = s.latitud != null ? haversineKm({ latitud: lat, longitud: lng }, { latitud: Number(s.latitud), longitud: Number(s.longitud) }) : null;
      realtime.emitToUser(s.id_usuario, 'tecnico.ubicacion', {
        id_solicitud: Number(s.id_solicitud), latitud: lat, longitud: lng,
        distancia_km: km == null ? null : Math.round(km * 10) / 10, eta_min: etaMinutes(km),
      });
    }
  }
  res.json({ mensaje: 'Ubicación actualizada.', ubicacion: { latitud: lat, longitud: lng } });
});

// Técnicos disponibles cerca (mapa del inicio). Coordenadas aproximadas (~1 km): sin datos de contacto.
router.get('/api/tecnicos/cercanos', auth, async (req, res) => {
  const lat = parseCoord(req.query.latitud, -90, 90) ?? 17.9583;
  const lng = parseCoord(req.query.longitud, -180, 180) ?? -102.2;
  const { rows } = await db().query(
    `SELECT u.id_usuario, u.nombre, u.latitud, u.longitud,
            (SELECT ROUND(AVG(q.puntuacion_tecnico)::numeric, 1) FROM calificaciones_servicio q WHERE q.id_tecnico = u.id_usuario AND q.puntuacion_tecnico IS NOT NULL) AS calificacion
     FROM usuarios u
     WHERE u.id_rol = 2 AND u.anonimizado = false AND u.identidad_verificada = true AND u.disponible = true
       AND u.ultimo_latido > NOW() - INTERVAL '90 seconds' AND u.latitud IS NOT NULL
     ORDER BY POWER(u.latitud - $1, 2) + POWER(u.longitud - $2, 2) LIMIT 20`,
    [lat, lng]
  );
  res.json({
    tecnicos: rows.map((r) => ({
      id_usuario: r.id_usuario,
      nombre: r.nombre,
      calificacion: r.calificacion,
      latitud: Math.round(Number(r.latitud) * 100) / 100,
      longitud: Math.round(Number(r.longitud) * 100) / 100,
    })),
  });
});

// ───────────────────────── Resumen del panel (RF-111) ─────────────────────────
router.get('/api/tecnico/resumen', ...techOnly, async (req, res) => {
  const me = req.user.id_usuario;
  const [stats, contadores] = await Promise.all([
    db().query(
      `SELECT u.disponible,
              COALESCE((SELECT ROUND(SUM(t.monto), 2) FROM transacciones t JOIN billetera_tecnico b ON b.id_billetera = t.id_billetera
                        WHERE b.id_usuario = $1 AND t.tipo = 'INGRESO' AND t.fecha >= date_trunc('week', NOW())), 0.00) AS ganancias_semana,
              (SELECT COUNT(*)::int FROM solicitudes_servicio s WHERE s.id_tecnico = $1 AND s.estado = 'FINALIZADA' AND s.fecha_finalizacion >= date_trunc('week', NOW())) AS servicios_semana,
              (SELECT COUNT(*)::int FROM solicitudes_servicio s WHERE s.id_tecnico = $1 AND s.estado = 'FINALIZADA') AS servicios_total,
              (SELECT ROUND(AVG(q.puntuacion_tecnico)::numeric, 1) FROM calificaciones_servicio q WHERE q.id_tecnico = $1 AND q.puntuacion_tecnico IS NOT NULL) AS calificacion,
              (SELECT COUNT(*)::int FROM calificaciones_servicio q WHERE q.id_tecnico = $1 AND q.puntuacion_tecnico IS NOT NULL) AS resenas,
              (SELECT saldo_actual FROM billetera_tecnico WHERE id_usuario = $1) AS saldo
       FROM usuarios u WHERE u.id_usuario = $1`,
      [me]
    ),
    S.techCounters(me),
  ]);
  const r = stats.rows[0];
  res.json({
    disponible: r.disponible,
    aprobado: req.user.aprobado,
    ganancias_semana: r.ganancias_semana,
    servicios_semana: r.servicios_semana,
    servicios_total: r.servicios_total,
    calificacion: r.calificacion,
    resenas: r.resenas,
    saldo: r.saldo || '0.0000',
    contadores,
  });
});

// ───────────────────────── Perfil público (RF-20) ─────────────────────────
router.get('/api/tecnicos/:id/perfil', auth, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db().query(
    `SELECT u.id_usuario, u.nombre, u.apellido, u.foto_archivo, u.bio, COALESCE(u.verificado_sep, false) AS verificado_sep,
            u.identidad_verificada, u.fecha_registro, u.disponible,
            (SELECT ROUND(AVG(q.puntuacion_tecnico)::numeric, 1) FROM calificaciones_servicio q WHERE q.id_tecnico = u.id_usuario AND q.puntuacion_tecnico IS NOT NULL) AS calificacion,
            (SELECT COUNT(*)::int FROM calificaciones_servicio q WHERE q.id_tecnico = u.id_usuario AND q.puntuacion_tecnico IS NOT NULL) AS resenas_total,
            (SELECT COUNT(*)::int FROM solicitudes_servicio f WHERE f.id_tecnico = u.id_usuario AND f.estado = 'FINALIZADA') AS trabajos,
            (SELECT COUNT(*)::int FROM auditoria a WHERE a.id_usuario = u.id_usuario AND a.accion = 'SOLICITUD_CANCELADA' AND a.detalle->>'por' = 'TECNICO') AS cancelaciones
     FROM usuarios u WHERE u.id_usuario = $1 AND u.id_rol = 2 AND u.anonimizado = false`,
    [id]
  );
  const t = rows[0];
  if (!t) return fail(res, 404, 'NOT_FOUND', 'Técnico no encontrado.');
  const [esp, port, certs, resenas] = await Promise.all([
    db().query(`SELECT c.codigo, c.nombre, e.estado FROM especialidades_tecnico e JOIN categorias_servicio c ON c.codigo = e.categoria WHERE e.id_usuario = $1 AND e.activa ORDER BY c.orden`, [id]),
    db().query('SELECT id_item, titulo, descripcion, id_archivo, fecha_creacion FROM portafolio_tecnico WHERE id_usuario = $1 ORDER BY id_item DESC LIMIT 12', [id]),
    db().query("SELECT tipo, descripcion, numero, estado FROM documentos_usuario WHERE id_usuario = $1 AND tipo IN ('CERTIFICACION', 'CEDULA') AND estado = 'APROBADO'", [id]),
    db().query(
      `SELECT q.puntuacion_tecnico AS puntuacion, q.comentario_cliente AS comentario, q.fecha_calificacion AS fecha, c.nombre AS cliente
       FROM calificaciones_servicio q JOIN usuarios c ON c.id_usuario = q.id_cliente
       WHERE q.id_tecnico = $1 AND q.puntuacion_tecnico IS NOT NULL ORDER BY q.fecha_calificacion DESC LIMIT 10`,
      [id]
    ),
  ]);
  const total = t.trabajos + t.cancelaciones;
  res.json({
    tecnico: {
      id_usuario: t.id_usuario,
      nombre: t.nombre,
      apellido: t.apellido,
      foto_url: t.foto_archivo ? signFileUrl(t.foto_archivo, 3600) : null,
      bio: t.bio,
      verificado_sep: t.verificado_sep,
      identidad_verificada: t.identidad_verificada === true,
      miembro_desde: t.fecha_registro,
      disponible: t.disponible,
      calificacion: t.calificacion,
      resenas_total: t.resenas_total,
      trabajos: t.trabajos,
      efectividad: total > 0 ? Math.round((t.trabajos / total) * 100) : null,
      especialidades: esp.rows,
      portafolio: port.rows.map((p) => ({ ...p, url: signFileUrl(p.id_archivo, 3600) })),
      certificaciones: certs.rows,
      resenas: resenas.rows,
    },
  });
});

// ───────────────────────── Especialidades y alertas (RF-23, RF-24) ─────────────────────────
async function listSpecialties(id) {
  const { rows } = await db().query(
    `SELECT e.id_especialidad, e.categoria, COALESCE(c.nombre, e.nombre) AS nombre, e.estado, e.activa
     FROM especialidades_tecnico e LEFT JOIN categorias_servicio c ON c.codigo = e.categoria
     WHERE e.id_usuario = $1 ORDER BY c.orden NULLS LAST, e.id_especialidad`,
    [id]
  );
  return rows;
}

router.get('/api/tecnico/especialidades', ...techOnly, async (req, res) => {
  res.json({ especialidades: await listSpecialties(req.user.id_usuario) });
});

router.post('/api/tecnico/especialidades', ...techOnly, async (req, res) => {
  const codigo = String(req.body?.categoria || '').toUpperCase();
  const cat = (await db().query('SELECT codigo, nombre FROM categorias_servicio WHERE codigo = $1', [codigo])).rows[0];
  if (!cat) return fail(res, 400, 'VALIDATION_ERROR', 'Selecciona una categoría válida.');
  const { rows } = await db().query(
    `INSERT INTO especialidades_tecnico (id_usuario, nombre, categoria, estado, activa)
     VALUES ($1, $2, $3, 'EN_REVISION', true)
     ON CONFLICT (id_usuario, nombre) DO UPDATE SET activa = true, categoria = EXCLUDED.categoria
     RETURNING id_especialidad, categoria, nombre, estado, activa`,
    [req.user.id_usuario, cat.nombre, cat.codigo]
  );
  audit(req, 'ESPECIALIDAD_AGREGADA', 'especialidad', rows[0].id_especialidad, { categoria: cat.codigo });
  res.status(201).json({ especialidad: rows[0] });
});

router.patch('/api/tecnico/especialidades/:id/toggle', ...techOnly, async (req, res) => {
  const { rows } = await db().query(
    `UPDATE especialidades_tecnico SET activa = $1 WHERE id_especialidad = $2 AND id_usuario = $3
     RETURNING id_especialidad, categoria, nombre, estado, activa`,
    [req.body?.activa === true, req.params.id, req.user.id_usuario]
  );
  if (!rows[0]) return fail(res, 404, 'NOT_FOUND', 'Especialidad no encontrada.');
  res.json({ especialidad: rows[0] });
});

router.delete('/api/tecnico/especialidades/:id', ...techOnly, async (req, res) => {
  const del = await db().query('DELETE FROM especialidades_tecnico WHERE id_especialidad = $1 AND id_usuario = $2', [req.params.id, req.user.id_usuario]);
  if (!del.rowCount) return fail(res, 404, 'NOT_FOUND', 'Especialidad no encontrada.');
  res.json({ mensaje: 'Especialidad eliminada.' });
});

// ───────────────────────── Portafolio (RF-24) ─────────────────────────
router.get('/api/tecnico/portafolio', ...techOnly, async (req, res) => {
  const { rows } = await db().query('SELECT id_item, titulo, descripcion, id_archivo, fecha_creacion FROM portafolio_tecnico WHERE id_usuario = $1 ORDER BY id_item DESC', [req.user.id_usuario]);
  res.json({ portafolio: rows.map((p) => ({ ...p, url: signFileUrl(p.id_archivo, 3600) })) });
});

router.post('/api/tecnico/portafolio', ...techOnly, uploader({ maxFiles: 1 }).single('foto'), async (req, res) => {
  const titulo = sanitizeText(req.body?.titulo, 120);
  if (!req.file) return fail(res, 400, 'VALIDATION_ERROR', 'Agrega una foto del trabajo.');
  if (titulo.length < 3) return fail(res, 400, 'VALIDATION_ERROR', 'Escribe un título para el trabajo.', { field: 'titulo' });
  const item = await withTransaction(async (tx) => {
    const idArchivo = await saveFile(tx, { owner: req.user.id_usuario, buffer: req.file.buffer, mime: req.file.mimetype, name: req.file.originalname, categoria: 'PORTAFOLIO' });
    const { rows } = await tx.query(
      'INSERT INTO portafolio_tecnico (id_usuario, id_archivo, titulo, descripcion) VALUES ($1, $2, $3, $4) RETURNING id_item, titulo, descripcion, id_archivo, fecha_creacion',
      [req.user.id_usuario, idArchivo, titulo, sanitizeText(req.body?.descripcion, 500) || null]
    );
    return rows[0];
  });
  res.status(201).json({ item: { ...item, url: signFileUrl(item.id_archivo, 3600) } });
});

router.delete('/api/tecnico/portafolio/:id', ...techOnly, async (req, res) => {
  const { rows } = await db().query('DELETE FROM portafolio_tecnico WHERE id_item = $1 AND id_usuario = $2 RETURNING id_archivo', [req.params.id, req.user.id_usuario]);
  if (!rows[0]) return fail(res, 404, 'NOT_FOUND', 'Elemento no encontrado.');
  await db().query('DELETE FROM archivos WHERE id_archivo = $1', [rows[0].id_archivo]);
  res.json({ mensaje: 'Elemento eliminado.' });
});

// ───────────────────────── Documentos y cédula (RF-25, RD-001/003/005/007) ─────────────────────────
const DOC_TYPES = ['CEDULA', 'CERTIFICACION', 'COMPROBANTE_DOMICILIO', 'ANTECEDENTES'];

router.get('/api/tecnico/documentos', ...techOnly, async (req, res) => {
  const { rows } = await db().query(
    'SELECT id_documento, tipo, numero, descripcion, estado, id_archivo, fecha_creacion FROM documentos_usuario WHERE id_usuario = $1 ORDER BY id_documento',
    [req.user.id_usuario]
  );
  res.json({ documentos: rows.map((d) => ({ ...d, url: d.id_archivo ? signFileUrl(d.id_archivo) : null })) });
});

router.post('/api/tecnico/documentos', ...techOnly, uploader({ types: DOCUMENT_TYPES, maxFiles: 1, maxSizeMb: 8 }).single('archivo'), async (req, res) => {
  const tipo = String(req.body?.tipo || '').toUpperCase();
  if (!DOC_TYPES.includes(tipo)) return fail(res, 400, 'VALIDATION_ERROR', 'Selecciona el tipo de documento.');
  if (!req.file) return fail(res, 400, 'VALIDATION_ERROR', 'Adjunta el documento (foto o PDF).');
  const doc = await withTransaction(async (tx) => {
    const idArchivo = await saveFile(tx, { owner: req.user.id_usuario, buffer: req.file.buffer, mime: req.file.mimetype, name: req.file.originalname, categoria: 'DOCUMENTO' });
    const { rows } = await tx.query(
      `INSERT INTO documentos_usuario (id_usuario, tipo, id_archivo, numero, descripcion)
       VALUES ($1, $2, $3, $4, $5) RETURNING id_documento, tipo, numero, descripcion, estado, fecha_creacion`,
      [req.user.id_usuario, tipo, idArchivo, sanitizeText(req.body?.numero, 40) || null, sanitizeText(req.body?.descripcion, 150) || null]
    );
    return rows[0];
  });
  audit(req, 'DOCUMENTO_CARGADO', 'documento', doc.id_documento, { tipo });
  res.status(201).json({ mensaje: 'Documento recibido. Lo revisaremos en las próximas 48 horas.', documento: doc });
});

const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

// Consulta al Registro Nacional de Profesionistas con timeout de 5 s (RNF-36). Nunca aprueba por formato.
// Solo con identidad verificada: el nombre contra el que se compara la cédula debe ser el del INE revisado.
router.post('/api/tecnicos/validar-cedula', ...techOnly, requireApproved, async (req, res) => {
  const cedula = String(req.body?.cedula || '').trim();
  if (!/^\d{7,8}$/.test(cedula)) return fail(res, 400, 'VALIDATION_ERROR', 'La cédula profesional tiene 7 u 8 dígitos.', { field: 'cedula' });
  const url = process.env.SEP_URL || 'https://www.cedulaprofesional.sep.gob.mx/cedula/buscaCedulaJson.action';

  let items;
  try {
    const body = new URLSearchParams({ json: JSON.stringify({ maxResult: '1000', nombre: '', paterno: '', materno: '', idCedula: cedula }) });
    const resp = await fetchWithTimeout(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 5000);
    if (!resp.ok) throw new Error(`SEP ${resp.status}`);
    items = (await resp.json()).items || [];
  } catch {
    await db().query(
      "INSERT INTO documentos_usuario (id_usuario, tipo, numero, descripcion) VALUES ($1, 'CEDULA', $2, 'Pendiente de validar con la SEP')",
      [req.user.id_usuario, cedula]
    );
    return fail(res, 503, 'SEP_UNAVAILABLE', 'El registro de la SEP no está disponible. Guardamos tu cédula para revisarla después.');
  }

  const nombre = normalize(req.user.nombre).split(/\s+/)[0];
  const apellido = normalize(req.user.apellido).split(/\s+/)[0];
  const match = items.find((it) => normalize(it.nombre).split(/\s+/).includes(nombre) && normalize(it.paterno) === apellido);
  if (!match) {
    return fail(res, 400, 'SEP_NO_MATCH', 'La cédula no coincide con tu nombre en el Registro Nacional de Profesionistas.');
  }
  await withTransaction(async (tx) => {
    await tx.query('UPDATE usuarios SET verificado_sep = true WHERE id_usuario = $1', [req.user.id_usuario]);
    await tx.query(
      "INSERT INTO documentos_usuario (id_usuario, tipo, numero, descripcion, estado) VALUES ($1, 'CEDULA', $2, $3, 'APROBADO')",
      [req.user.id_usuario, cedula, String(match.titulo || 'Cédula profesional').slice(0, 150)]
    );
  });
  audit(req, 'CEDULA_VALIDADA', 'usuario', req.user.id_usuario, { cedula });
  res.json({ verificado_sep: true, titulo: match.titulo || null, mensaje: 'Cédula validada con la SEP. Ya tienes la insignia de profesionista.' });
});

// ───────────────────────── Aprobación (para el panel de administrador) ─────────────────────────
router.patch('/api/admin/usuarios/:id/aprobar', auth, requireRole(ROL.ADMIN), async (req, res) => {
  const { rows } = await db().query(
    `UPDATE usuarios SET identidad_verificada = true, estado_cuenta = 'APROBADO', estado = 'APROBADO'
     WHERE id_usuario = $1 AND anonimizado = false RETURNING id_usuario`,
    [req.params.id]
  );
  if (!rows[0]) return fail(res, 404, 'NOT_FOUND', 'Usuario no encontrado.');
  await db().query("UPDATE documentos_usuario SET estado = 'APROBADO' WHERE id_usuario = $1 AND tipo IN ('INE_FRENTE', 'INE_REVERSO', 'ROSTRO')", [req.params.id]);
  audit(req, 'USUARIO_APROBADO', 'usuario', req.params.id);
  realtime.emitToUser(Number(req.params.id), 'cuenta.aprobada', { aviso: 'Tu cuenta fue aprobada. Ya puedes usar todas las funciones.' });
  res.json({ mensaje: 'Usuario aprobado.' });
});

module.exports = router;
