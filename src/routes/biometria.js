const express = require('express');
const { randomUUID } = require('crypto');
const { getPool } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { fail } = require('../lib/http');
const { audit } = require('../lib/audit');
const { uploader } = require('../lib/files');
const realtime = require('../lib/realtime');
const { fetchWithTimeout } = require('../services/payments');

const router = express.Router();
const db = () => getPool();

router.post('/api/biometria/solicitar', auth, async (req, res) => {
  const { rows } = await db().query(
    `INSERT INTO verificaciones_biometricas (id_usuario, desafio, proveedor) VALUES ($1, $2, 'opencv')
     RETURNING id_verificacion, desafio, proveedor, estado, fecha_expiracion`,
    [req.user.id_usuario, randomUUID()]
  );
  res.status(201).json({ verificacion: rows[0] });
});

router.get('/api/biometria/:id', auth, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, 'NOT_FOUND', 'Verificación no encontrada.');
  const { rows } = await db().query(
    `SELECT id_verificacion, proveedor, estado, resultado, fecha_creacion, fecha_expiracion, fecha_resolucion
     FROM verificaciones_biometricas WHERE id_verificacion = $1 AND id_usuario = $2`,
    [req.params.id, req.user.id_usuario]
  );
  if (!rows[0]) return fail(res, 404, 'NOT_FOUND', 'Verificación no encontrada.');
  res.json({ verificacion: rows[0] });
});

// La referencia es la foto del rostro guardada en el registro; el cliente solo envía la captura en vivo.
// Si el servicio biométrico no responde en 5 s se informa "no disponible" y no se aprueba (RNF-36).
router.post(
  '/api/biometria/:id/compare',
  auth,
  uploader({ maxFiles: 2 }).fields([{ name: 'live_image', maxCount: 1 }, { name: 'reference_image', maxCount: 1 }]),
  async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, 'NOT_FOUND', 'Verificación no encontrada.');
    const live = req.files?.live_image?.[0];
    if (!live) return fail(res, 400, 'VALIDATION_ERROR', 'Toma la foto de tu rostro para compararla.');

    const ver = (await db().query(
      'SELECT id_verificacion, estado, fecha_expiracion FROM verificaciones_biometricas WHERE id_verificacion = $1 AND id_usuario = $2',
      [req.params.id, req.user.id_usuario]
    )).rows[0];
    if (!ver) return fail(res, 404, 'NOT_FOUND', 'Verificación no encontrada.');
    if (ver.estado !== 'solicitada' || new Date(ver.fecha_expiracion) < new Date()) {
      return fail(res, 409, 'VERIFICATION_EXPIRED', 'Esta verificación ya no es válida. Inicia una nueva.');
    }

    const ref = (await db().query(
      `SELECT a.contenido, a.tipo_mime, a.nombre FROM documentos_usuario d JOIN archivos a ON a.id_archivo = d.id_archivo
       WHERE d.id_usuario = $1 AND d.tipo IN ('ROSTRO', 'INE_FRENTE')
       ORDER BY (d.tipo = 'ROSTRO') DESC, d.id_documento DESC LIMIT 1`,
      [req.user.id_usuario]
    )).rows[0];
    if (!ref) return fail(res, 409, 'REFERENCE_MISSING', 'No tenemos una foto de referencia de tu registro. Contacta a soporte.');

    let model;
    try {
      const form = new FormData();
      form.append('reference_image', new Blob([ref.contenido], { type: ref.tipo_mime }), ref.nombre);
      form.append('live_image', new Blob([live.buffer], { type: live.mimetype }), live.originalname);
      const base = process.env.BIOMETRIC_SERVICE_URL || 'http://127.0.0.1:8000';
      const resp = await fetchWithTimeout(`${base}/compare`, { method: 'POST', body: form }, 5000);
      model = await resp.json().catch(() => ({}));
      if (!resp.ok) return fail(res, 422, 'BIOMETRIC_REJECTED', model.detail || 'No se pudo comparar el rostro. Toma la foto con buena luz y de frente.');
    } catch {
      return fail(res, 503, 'BIOMETRIC_UNAVAILABLE', 'El servicio de verificación facial no está disponible. Intenta más tarde.');
    }

    const aprobado = model.match === true;
    const estado = aprobado ? 'APROBADO' : 'RECHAZADO';
    const { rows } = await db().query(
      `UPDATE verificaciones_biometricas SET estado = $1, resultado = $2::jsonb, fecha_resolucion = NOW()
       WHERE id_verificacion = $3 RETURNING id_verificacion, estado, resultado, fecha_resolucion`,
      [estado, JSON.stringify(model), ver.id_verificacion]
    );
    // Solo registra el resultado biométrico. La referencia la subió la misma persona, así que una
    // coincidencia no prueba identidad: identidad_verificada solo la otorga la revisión del administrador.
    await db().query(
      'UPDATE usuarios SET biometria_estado = $1, fecha_actualizacion = NOW() WHERE id_usuario = $2',
      [aprobado ? 'verificada' : 'rechazada', req.user.id_usuario]
    );
    audit(req, `BIOMETRIA_${estado}`, 'verificacion', ver.id_verificacion, { distancia: model.distance });
    if (aprobado) realtime.emitToUser(req.user.id_usuario, 'biometria.verificada', { aviso: 'Confirmamos que tu rostro coincide con tu registro.' });
    res.json({ ...rows[0], match: aprobado, distance: model.distance, confidence: model.confidence });
  }
);

module.exports = router;
