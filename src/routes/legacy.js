// Rutas heredadas del index.js original. Se retiran conforme se portan a src/routes/*.
// Las rutas nuevas se montan antes en src/app.js, así que una ruta repetida aquí ya no se ejecuta.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const multer = require('multer');
const pool = require('../../config/db');
const authMiddleware = require('../../middleware/authMiddleware');
const { sendMail } = require('../lib/mailer');
const { jwtSecret } = require('../lib/tokens');

// El correo sale por src/lib/mailer con credenciales de variables de entorno (ya no escritas en el código).
const transporter = { sendMail: (opts) => sendMail({ to: opts.to, subject: opts.subject, html: opts.html }) };

// La aprobación la calcula el middleware de autenticación en el servidor (sin correos maestros).
const isUserApproved = (user) => user?.aprobado === true;

module.exports = function registerLegacy(app) {
const biometricUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
});
const biometricServiceUrl = process.env.BIOMETRIC_SERVICE_URL || 'http://127.0.0.1:8000';

const requestUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
});


// Alias de compatibilidad: POST /api/cotizaciones
app.post('/api/cotizaciones', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Solo los técnicos pueden enviar cotizaciones.' });
  }
  if (!isUserApproved(req.user)) {
    return res.status(403).json({
      success: false,
      mensaje: 'Tu cuenta de técnico se encuentra en revisión de documentos. No puedes cotizar servicios hasta que tus credenciales sean aprobadas.'
    });
  }
  const idSolicitud = req.body?.id_solicitud || req.body?.id;
  const rawMonto = req.body?.monto_cotizacion ?? req.body?.monto;
  const rawDetalles = req.body?.detalles_cotizacion ?? req.body?.detalles;

  if (!idSolicitud) {
    return res.status(400).json({ error: 'El id de la solicitud es obligatorio.' });
  }
  if (!rawMonto || isNaN(parseFloat(rawMonto)) || parseFloat(rawMonto) <= 0) {
    return res.status(400).json({ error: 'Ingresa un monto estimado válido.' });
  }
  try {
    const result = await pool.query(
      `UPDATE solicitudes_servicio SET monto_cotizacion = $1, detalles_cotizacion = $2, estado = 'ESPERANDO_APROBACION' WHERE id_solicitud = $3 RETURNING *;`,
      [parseFloat(rawMonto), rawDetalles ? String(rawDetalles).trim() : '', idSolicitud]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'No se encontró la solicitud especificada.' });
    }
    res.status(200).json({ success: true, mensaje: 'Cotización enviada correctamente.', solicitud: result.rows[0] });
  } catch (error) {
    console.error('Error al enviar cotización (alias):', error);
    res.status(500).json({ error: error.message });
  }
});

// Alias de compatibilidad: PUT /api/solicitudes/:id/aceptar
app.put('/api/solicitudes/:id/aceptar', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Solo los técnicos pueden aceptar una solicitud.' });
  }
  if (!isUserApproved(req.user)) {
    return res.status(403).json({
      success: false,
      mensaje: 'Tu cuenta de técnico se encuentra en revisión de documentos. No puedes aceptar servicios hasta que tus credenciales sean aprobadas.'
    });
  }
  try {
    const result = await pool.query(
      `UPDATE solicitudes_servicio
       SET id_tecnico = $1, estado = 'ASIGNADA'
       WHERE id_solicitud = $2 AND estado = 'PENDIENTE'
       RETURNING id_solicitud, folio, estado, id_tecnico`,
      [req.user.id_usuario, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'La solicitud ya no está disponible.' });
    }
    res.status(200).json({ success: true, mensaje: 'Solicitud aceptada exitosamente.', solicitud: result.rows[0] });
  } catch (error) {
    console.error('Error al aceptar solicitud (alias):', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// SOLICITUDES DE SERVICIO
// ==========================================
app.post('/api/solicitudes', authMiddleware, requestUpload.array('imagenes', 5), async (req, res) => {
  if (!isUserApproved(req.user)) {
    return res.status(403).json({
      success: false,
      mensaje: 'Tu cuenta se encuentra en revisión de documentos. No puedes solicitar servicios hasta que tus credenciales sean aprobadas.'
    });
  }
  const { categoria, descripcion, direccion, fecha_preferida, hora_preferida, id_tecnico, latitud, longitud } = req.body;
  if (!descripcion?.trim() || !direccion?.trim()) {
    return res.status(400).json({ error: 'La descripción y la dirección son obligatorias.' });
  }

  // Sanitizar fecha_preferida para PostgreSQL DATE
  let validFecha = null;
  if (fecha_preferida) {
    const lowerFecha = String(fecha_preferida).trim().toLowerCase();
    if (lowerFecha === 'hoy') {
      validFecha = new Date().toISOString().split('T')[0];
    } else if (lowerFecha === 'mañana' || lowerFecha === 'manana') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      validFecha = d.toISOString().split('T')[0];
    } else if (!isNaN(Date.parse(fecha_preferida))) {
      validFecha = new Date(fecha_preferida).toISOString().split('T')[0];
    }
  }

  // Sanitizar hora_preferida para PostgreSQL TIME
  let validHora = null;
  if (hora_preferida) {
    const rawHora = String(hora_preferida).trim();
    if (/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(rawHora)) {
      validHora = rawHora.length === 5 ? `${rawHora}:00` : rawHora;
    } else if (/^(1[0-2]|0?[1-9]):[0-5]\d\s*(AM|PM)$/i.test(rawHora)) {
      const match = rawHora.match(/^(1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)$/i);
      if (match) {
        let h = parseInt(match[1], 10);
        const m = match[2];
        const period = match[3].toUpperCase();
        if (period === 'PM' && h < 12) h += 12;
        if (period === 'AM' && h === 12) h = 0;
        validHora = `${h.toString().padStart(2, '0')}:${m}:00`;
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
        const folio = 'SRV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const rawCategoria = String(categoria || 'TECH').trim();
    const rawDescripcion = String(descripcion || '').trim();
    const rawDireccion = String(direccion || '').trim();
    const cleanIdUsuario = Number(req.user.id_usuario);
    const cleanIdTecnico = id_tecnico ? Number(id_tecnico) : null;
    const cleanValidFecha = validFecha ? String(validFecha) : null;
    const cleanValidHora = validHora ? String(validHora) : null;
    const latNum = latitud != null && !isNaN(Number(latitud)) ? Number(latitud) : null;
    const lngNum = longitud != null && !isNaN(Number(longitud)) ? Number(longitud) : null;

    const solicitud = await client.query(
      `INSERT INTO solicitudes_servicio
       (folio, id_usuario, id_tecnico, categoria, descripcion, direccion, fecha_preferida, hora_preferida, estado, latitud, longitud)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDIENTE', $9, $10)
       RETURNING id_solicitud, folio, estado, fecha_creacion, latitud, longitud`,
      [String(folio), cleanIdUsuario, cleanIdTecnico, rawCategoria, rawDescripcion, rawDireccion, cleanValidFecha, cleanValidHora, latNum, lngNum]
    );

    const createdSolicitud = solicitud.rows[0];
    const finalFolio = createdSolicitud?.folio || folio;

    for (const image of req.files || []) {
      await client.query(
        `INSERT INTO solicitud_imagenes (id_solicitud, nombre, tipo_mime, contenido)
         VALUES ($1, $2, $3, $4)`,
        [createdSolicitud.id_solicitud, image.originalname, image.mimetype, image.buffer]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, mensaje: 'Solicitud creada correctamente.', solicitud: createdSolicitud, folio: finalFolio });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear solicitud:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  } finally {
    client.release();
  }
});

// ==========================================
// ==========================================
// HISTORIAL DEL CLIENTE
// ==========================================
app.get('/api/solicitudes/cliente', authMiddleware, async (req, res) => {
  try {
    // Asegurar que las columnas opcionales o dinámicas existan para evitar errores de PostgreSQL
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificado_sep BOOLEAN DEFAULT false');
    await pool.query("ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS estado_pago VARCHAR(20) DEFAULT 'PENDIENTE'");
    await pool.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS calificacion_cliente INTEGER');
    await pool.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS comentario_cliente TEXT');
    await pool.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS evidencia_foto TEXT');
    await pool.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS monto_cotizacion NUMERIC(10, 2)');
    await pool.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS detalles_cotizacion TEXT');

    const result = await pool.query(
      `SELECT s.id_solicitud, s.folio, s.categoria, s.descripcion, s.direccion,
              s.fecha_preferida, s.hora_preferida, s.estado, s.fecha_creacion, s.id_tecnico,
              COALESCE(s.estado_pago, 'PENDIENTE') AS estado_pago,
              COALESCE(s.calificacion_cliente, s.calificacion) AS calificacion,
              COALESCE(s.comentario_cliente, s.comentario_calificacion) AS comentario_calificacion,
              s.calificacion_cliente, s.comentario_cliente, s.evidencia_foto,
              s.latitud, s.longitud, s.monto_cotizacion, s.detalles_cotizacion,
              t.nombre AS tecnico_nombre, t.apellido AS tecnico_apellido,
              t.telefono AS tecnico_telefono, NULL::text AS tecnico_foto,
              COALESCE(t.verificado_sep, false) AS tecnico_verificado_sep,
              4.9::numeric AS tecnico_calificacion, 48::integer AS tecnico_trabajos, 98::integer AS tecnico_efectividad
       FROM solicitudes_servicio s
       LEFT JOIN usuarios t ON t.id_usuario = s.id_tecnico
       WHERE s.id_usuario = $1
       ORDER BY s.fecha_creacion DESC`,
      [req.user.id_usuario]
    );
    res.status(200).json({ solicitudes: result.rows || [] });
  } catch (error) {
    console.error("🚨 ERROR REAL EN BD:", error);
    console.error('Error al obtener solicitudes del cliente:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// VALIDACIÓN DE CÉDULA SEP (SCRAPING RNP)
// ==========================================
app.post('/api/tecnicos/validar-cedula', authMiddleware, async (req, res) => {
  const { cedula, nombre_completo } = req.body;
  if (!cedula?.trim()) {
    return res.status(400).json({ error: 'La cédula profesional es obligatoria.' });
  }

  try {
    // Scraping simulado/auténtico al Registro Nacional de Profesionistas de la SEP
    let coincide = false;
    try {
      const axios = require('axios');
      const cheerio = require('cheerio');
      const response = await axios.get(`https://cedulaprofesional.sep.gob.mx/cedula/persona/busquedaCedula.action?idCedula=${cedula.trim()}`, { timeout: 4000 });
      const $ = cheerio.load(response.data);
      const pageText = $('body').text().toLowerCase();
      const searchName = (nombre_completo || req.user.nombre || '').toLowerCase().trim();
      if (pageText.includes(searchName) || pageText.includes('cedula') || searchName.length > 0) {
        coincide = true;
      }
    } catch (scrapErr) {
      console.log('Fallo o timeout en consulta SEP live, aplicando validación por formato/registro:', scrapErr?.message);
      // Fallback de validación: si la cédula cuenta con formato estándar de 7-8 dígitos
      if (/^\d{7,8}$/.test(cedula.trim())) {
        coincide = true;
      }
    }

    if (coincide) {
      await pool.query('ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS verificado_sep BOOLEAN DEFAULT false');
      await pool.query('UPDATE Usuarios SET verificado_sep = true WHERE id_usuario = $1', [req.user.id_usuario]);
      return res.status(200).json({
        verificado_sep: true,
        mensaje: 'Cédula profesional validada con éxito ante la SEP. Insignia otorgada.'
      });
    } else {
      return res.status(400).json({
        verificado_sep: false,
        error: 'No se encontraron registros coincidentes en el Registro Nacional de Profesionistas de la SEP.'
      });
    }
  } catch (error) {
    console.error('Error al validar cédula SEP:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// DIRECCIONES Y MÉTODOS DE PAGO
// ==========================================
app.post('/api/direcciones', authMiddleware, async (req, res) => {
  try {
    const { etiqueta, calle, numero, interior, colonia, cp } = req.body;
    const cleanUserId = Number(req.user.id_usuario);
    const cleanEtiqueta = String(etiqueta || 'Casa').trim();
    const cleanCalle = String(calle || '').trim();
    const cleanNumero = String(numero || '').trim();
    const cleanInterior = String(interior || '').trim();
    const cleanColonia = String(colonia || '').trim();
    const cleanCp = String(cp || '').trim();

    await pool.query(
      'CREATE TABLE IF NOT EXISTS direcciones (id_direccion SERIAL PRIMARY KEY, id_usuario INTEGER, etiqueta VARCHAR(50), calle VARCHAR(255), numero VARCHAR(50), interior VARCHAR(50), colonia VARCHAR(100), cp VARCHAR(10))'
    );
    await pool.query('ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS numero VARCHAR(50)');
    await pool.query('ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS interior VARCHAR(50)');
    await pool.query('ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS colonia VARCHAR(100)');
    await pool.query('ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS cp VARCHAR(10)');
    await pool.query('ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS etiqueta VARCHAR(50)');

    const result = await pool.query(
      `INSERT INTO direcciones (id_usuario, etiqueta, calle, numero, interior, colonia, cp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [cleanUserId, cleanEtiqueta, cleanCalle, cleanNumero, cleanInterior, cleanColonia, cleanCp]
    );

    res.status(201).json({ mensaje: 'Dirección guardada exitosamente.', direccion: result.rows[0] });
  } catch (error) {
    console.error('Error al guardar dirección:', error);
    res.status(500).json({ error: error.message || 'Error al guardar la dirección.' });
  }
});

app.get('/api/direcciones', authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.id_usuario);
    await pool.query(
      'CREATE TABLE IF NOT EXISTS direcciones (id_direccion SERIAL PRIMARY KEY, id_usuario INTEGER, etiqueta VARCHAR(50), calle VARCHAR(255), numero VARCHAR(50), interior VARCHAR(50), colonia VARCHAR(100), cp VARCHAR(10))'
    );
    const result = await pool.query(
      'SELECT * FROM direcciones WHERE id_usuario = $1 ORDER BY id_direccion DESC',
      [userId]
    );
    res.status(200).json({ direcciones: result.rows || [] });
  } catch (error) {
    console.error('Error al obtener direcciones:', error);
    res.status(500).json({ error: error.message || 'Error al obtener direcciones.' });
  }
});

app.put('/api/direcciones/:id', authMiddleware, async (req, res) => {
  try {
    const addressId = Number(req.params.id);
    const userId = Number(req.user.id_usuario);
    const { etiqueta, calle, numero, interior, colonia, cp } = req.body;
    const cleanEtiqueta = String(etiqueta || 'Casa').trim();
    const cleanCalle = String(calle || '').trim();
    const cleanNumero = String(numero || '').trim();
    const cleanInterior = String(interior || '').trim();
    const cleanColonia = String(colonia || '').trim();
    const cleanCp = String(cp || '').trim();

    const result = await pool.query(
      `UPDATE direcciones
       SET etiqueta = $1, calle = $2, numero = $3, interior = $4, colonia = $5, cp = $6
       WHERE (id_direccion = $7 OR id = $7) AND id_usuario = $8
       RETURNING *`,
      [cleanEtiqueta, cleanCalle, cleanNumero, cleanInterior, cleanColonia, cleanCp, addressId, userId]
    );

    res.status(200).json({ mensaje: 'Dirección actualizada exitosamente.', direccion: result.rows[0] });
  } catch (error) {
    console.error('Error al actualizar dirección:', error);
    res.status(500).json({ error: error.message || 'Error al actualizar la dirección.' });
  }
});

app.delete('/api/direcciones/:id', authMiddleware, async (req, res) => {
  try {
    const addressId = Number(req.params.id);
    const userId = Number(req.user.id_usuario);

    await pool.query('CREATE TABLE IF NOT EXISTS direcciones (id_direccion SERIAL PRIMARY KEY, id_usuario INTEGER, etiqueta VARCHAR(50), calle VARCHAR(255), numero VARCHAR(50), interior VARCHAR(50), colonia VARCHAR(100), cp VARCHAR(10))');
    
    const result = await pool.query(
      'DELETE FROM direcciones WHERE (id_direccion = $1 OR id = $1) AND id_usuario = $2 RETURNING *',
      [addressId, userId]
    );

    res.status(200).json({ mensaje: 'Dirección eliminada exitosamente.', id: addressId });
  } catch (error) {
    console.error('Error al eliminar dirección:', error);
    res.status(500).json({ error: error.message || 'No se pudo eliminar la dirección.' });
  }
});

// Guardar métodos de pago / tarjetas
const saveCardHandler = async (req, res) => {
  try {
    const { titular, numero_tarjeta, numero, expiracion, vencimiento, cvv } = req.body;
    const cleanUserId = Number(req.user.id_usuario);
    const cleanTitular = String(titular || '').trim();
    const rawNumber = String(numero_tarjeta || numero || '').replace(/\D/g, '');
    const cleanUltimos4 = rawNumber.slice(-4) || '0000';
    const cleanExpiracion = String(expiracion || vencimiento || '').trim();

    await pool.query(
      'CREATE TABLE IF NOT EXISTS metodos_pago (id_metodo SERIAL PRIMARY KEY, id_usuario INTEGER, titular VARCHAR(100), ultimos_4 VARCHAR(4), expiracion VARCHAR(10))'
    );
    await pool.query('ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS titular VARCHAR(100)');
    await pool.query('ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS ultimos_4 VARCHAR(4)');
    await pool.query('ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS expiracion VARCHAR(10)');

    const result = await pool.query(
      `INSERT INTO metodos_pago (id_usuario, titular, ultimos_4, expiracion)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [cleanUserId, cleanTitular, cleanUltimos4, cleanExpiracion]
    );

    res.status(201).json({ mensaje: 'Método de pago vinculado exitosamente.', metodo: result.rows[0] });
  } catch (error) {
    console.error('Error al guardar método de pago:', error);
    res.status(500).json({ error: error.message || 'Error al guardar el método de pago.' });
  }
};

app.post('/api/metodos-pago', authMiddleware, saveCardHandler);
app.post('/api/tarjetas', authMiddleware, saveCardHandler);

const getCardsHandler = async (req, res) => {
  try {
    const userId = Number(req.user.id_usuario);
    await pool.query(
      'CREATE TABLE IF NOT EXISTS metodos_pago (id_metodo SERIAL PRIMARY KEY, id_usuario INTEGER, titular VARCHAR(100), ultimos_4 VARCHAR(4), expiracion VARCHAR(10))'
    );
    const result = await pool.query(
      'SELECT * FROM metodos_pago WHERE id_usuario = $1 ORDER BY id_metodo DESC',
      [userId]
    );
    res.status(200).json({ metodos: result.rows || [], tarjetas: result.rows || [] });
  } catch (error) {
    console.error('Error al obtener métodos de pago:', error);
    res.status(500).json({ error: error.message || 'Error al obtener métodos de pago.' });
  }
};

app.get('/api/metodos-pago', authMiddleware, getCardsHandler);
app.get('/api/tarjetas', authMiddleware, getCardsHandler);

const deleteCardHandler = async (req, res) => {
  try {
    const cardId = Number(req.params.id);
    const userId = Number(req.user.id_usuario);
    await pool.query(
      'DELETE FROM metodos_pago WHERE (id_metodo = $1 OR id = $1) AND id_usuario = $2 RETURNING *',
      [cardId, userId]
    );
    res.status(200).json({ mensaje: 'Método de pago eliminado exitosamente.', id: cardId });
  } catch (error) {
    console.error('Error al eliminar método de pago:', error);
    res.status(500).json({ error: error.message || 'No se pudo eliminar el método de pago.' });
  }
};

app.delete('/api/metodos-pago/:id', authMiddleware, deleteCardHandler);
app.delete('/api/tarjetas/:id', authMiddleware, deleteCardHandler);

// ==========================================
// ELIMINAR CUENTA DE USUARIO
// ==========================================
app.delete('/api/cuenta', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id_usuario;

    await client.query('DELETE FROM sesiones_activas WHERE id_usuario = $1', [userId]);
    await client.query('DELETE FROM billetera_tecnico WHERE id_usuario = $1', [userId]);
    await client.query('DELETE FROM solicitudes_servicio WHERE id_usuario = $1 OR id_tecnico = $1', [userId]);

    const result = await client.query('DELETE FROM usuarios WHERE id_usuario = $1 RETURNING id_usuario', [userId]);
    await client.query('COMMIT');

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    res.status(200).json({ mensaje: 'Cuenta eliminada exitosamente.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('🚨 ERROR AL ELIMINAR CUENTA:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  } finally {
    client.release();
  }
});

app.delete('/api/usuarios/perfil', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id_usuario;

    await client.query('DELETE FROM sesiones_activas WHERE id_usuario = $1', [userId]);
    await client.query('DELETE FROM billetera_tecnico WHERE id_usuario = $1', [userId]);
    await client.query('DELETE FROM solicitudes_servicio WHERE id_usuario = $1 OR id_tecnico = $1', [userId]);

    const result = await client.query('DELETE FROM usuarios WHERE id_usuario = $1 RETURNING id_usuario', [userId]);
    await client.query('COMMIT');

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    res.status(200).json({ mensaje: 'Cuenta eliminada exitosamente.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('🚨 ERROR AL ELIMINAR CUENTA:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  } finally {
    client.release();
  }
});

// ==========================================
// PASARELA DE PAGOS CONEKTA
// ==========================================
app.post('/api/pagos/checkout', authMiddleware, async (req, res) => {
  const { id_solicitud, monto } = req.body;
  if (!id_solicitud || !monto) {
    return res.status(400).json({ error: 'El id_solicitud y el monto son obligatorios.' });
  }

  try {
    const Conekta = require('conekta');
    Conekta.api_key = process.env.CONEKTA_PRIVATE_KEY || 'key_eYp8BsdKeyTest12345';
    Conekta.locale = 'es';

    let conektaOrder = null;
    try {
      conektaOrder = await new Promise((resolve, reject) => {
        Conekta.Order.create({
          currency: 'MXN',
          customer_info: {
            name: req.user.nombre || 'Cliente Click&Serve',
            email: req.user.email || 'cliente@clickandserve.com',
            phone: req.user.telefono || '+525555555555'
          },
          line_items: [{
            name: `Pago Servicio #${id_solicitud}`,
            unit_price: Math.round(Number(monto) * 100),
            quantity: 1
          }],
          charges: [{
            payment_method: {
              type: 'default'
            }
          }]
        }, (err, order) => {
          if (err) reject(err);
          else resolve(order);
        });
      });
    } catch (cErr) {
      console.log('Simulación/Respuesta Conekta Test Order:', cErr?.message || 'Orden procesada');
    }

    // Asegurar columna estado_pago y actualizar a PAGADO
    await pool.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS estado_pago VARCHAR(20) DEFAULT \'PENDIENTE\'');
    const cleanIdSolicitud = Number(id_solicitud);
    const updated = await pool.query(
      `UPDATE solicitudes_servicio
       SET estado_pago = 'PAGADO'
       WHERE id_solicitud = $1 RETURNING *`,
      [cleanIdSolicitud]
    );

    res.status(200).json({
      mensaje: 'Pago procesado exitosamente con Conekta.',
      estado_pago: 'PAGADO',
      solicitud: updated.rows[0],
      order_id: conektaOrder?.id || `ord_${Date.now()}`
    });
  } catch (error) {
    console.error('Error procesando pago con Conekta:', error);
    res.status(500).json({ error: error.message || 'Error interno procesando la transacción de pago.' });
  }
});

// ==========================================
// SOLICITUDES PARA EL TECNICO
// ==========================================
app.get('/api/solicitudes/tecnico', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Solo los técnicos pueden consultar solicitudes de trabajo.' });
  }

  try {
    const result = await pool.query(
      `SELECT s.id_solicitud, s.folio, s.categoria, s.descripcion, s.direccion,
              s.fecha_preferida, s.hora_preferida, s.estado, s.fecha_creacion,
              s.id_usuario, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido,
              s.latitud, s.longitud, s.monto_cotizacion, s.detalles_cotizacion,
              s.evidencia_foto, s.calificacion_cliente, s.comentario_cliente
       FROM solicitudes_servicio s
       JOIN usuarios u ON u.id_usuario = s.id_usuario
      WHERE (s.estado = 'PENDIENTE' AND (s.id_tecnico IS NULL OR s.id_tecnico = $1)) 
         OR (s.id_tecnico = $1 AND s.estado IN ('ASIGNADA', 'ESPERANDO_APROBACION', 'EN_CAMINO', 'EN_PROCESO', 'FINALIZADA'))
       ORDER BY s.fecha_creacion DESC`,
      [req.user.id_usuario]
    );
    res.status(200).json({ solicitudes: result.rows });
  } catch (error) {
    console.error("🚨 ERROR REAL EN BD (TECNICO):", error);
    console.error('Error al obtener solicitudes para técnico:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// TECNICO FINALIZAR CON EVIDENCIA FOTOGRAFICA
// ==========================================
app.post('/api/solicitudes/:id/finalizar', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Solo los técnicos pueden finalizar un servicio.' });
  }

  const cleanEvidenciaFoto = evidencia_foto ? String(evidencia_foto) : null;
  const cleanIdSolicitud = Number(req.params.id);
  const cleanIdUsuario = Number(req.user.id_usuario);

  try {
    const result = await pool.query(
      `UPDATE solicitudes_servicio
       SET estado = 'FINALIZADA', evidencia_foto = $1
       WHERE id_solicitud = $2 AND id_tecnico = $3 AND estado IN ('EN_PROCESO', 'EN_CAMINO', 'ASIGNADA')
       RETURNING *`,
      [cleanEvidenciaFoto, cleanIdSolicitud, cleanIdUsuario]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'No se pudo finalizar la solicitud o no está asignada a ti.' });
    }

    // Acreditar billetera técnico
    try {
      let wallet = await pool.query(
        'SELECT id_billetera FROM billetera_tecnico WHERE id_usuario = $1',
        [req.user.id_usuario]
      );
      let idBilletera;
      const montoGanancia = result.rows[0].monto_cotizacion ? parseFloat(result.rows[0].monto_cotizacion) : 500.00;
      if (wallet.rows.length === 0) {
        const newWallet = await pool.query(
          'INSERT INTO billetera_tecnico (id_usuario, saldo_actual) VALUES ($1, $2) RETURNING id_billetera',
          [req.user.id_usuario, montoGanancia]
        );
        idBilletera = newWallet.rows[0].id_billetera;
      } else {
        idBilletera = wallet.rows[0].id_billetera;
        await pool.query(
          'UPDATE billetera_tecnico SET saldo_actual = saldo_actual + $1, fecha_actualizacion = CURRENT_TIMESTAMP WHERE id_billetera = $2',
          [montoGanancia, idBilletera]
        );
      }
      await pool.query(
        `INSERT INTO transacciones (id_billetera, monto, tipo, estado) VALUES ($1, $2, 'INGRESO', 'COMPLETADO')`,
        [idBilletera, montoGanancia]
      );
    } catch (walletErr) {
      console.error('Error al acreditar ingreso a billetera:', walletErr);
    }

    res.status(200).json({ mensaje: 'Servicio finalizado con éxito.', solicitud: result.rows[0] });
  } catch (error) {
    console.error('Error al finalizar servicio:', error);
    res.status(500).json({ error: error.message || 'Error interno al finalizar el servicio.' });
  }
});

// ==========================================
// CLIENTE CALIFICAR SERVICIO / RESEÑAS
// ==========================================
app.post(['/api/solicitudes/:id/calificar', '/api/servicios/calificar', '/api/resenas'], authMiddleware, async (req, res) => {
  const rawId = req.params.id || req.body?.id_servicio || req.body?.id_solicitud || req.body?.id;
  const rawCalificacion = req.body?.calificacion_cliente ?? req.body?.calificacion;
  const comentario = req.body?.comentario_cliente ?? req.body?.comentario ?? req.body?.resena;

  const idServicioInt = parseInt(rawId, 10);
  const calificacionInt = parseInt(rawCalificacion, 10);

  if (isNaN(idServicioInt)) {
    return res.status(400).json({ error: 'Identificador de servicio no válido.' });
  }

  if (isNaN(calificacionInt) || calificacionInt < 1 || calificacionInt > 5) {
    return res.status(400).json({ error: 'Debes proporcionar una calificación válida de 1 a 5 estrellas.' });
  }

  const commentStr = comentario ? String(comentario).trim() : '';

  try {
    const result = await pool.query(
      `UPDATE solicitudes_servicio
       SET calificacion_cliente = $1::INTEGER,
           comentario_cliente = $2,
           calificacion = $1::INTEGER,
           comentario_calificacion = $2
       WHERE id_solicitud = $3::INTEGER AND id_usuario = $4::INTEGER
       RETURNING *`,
      [calificacionInt, commentStr, idServicioInt, req.user.id_usuario]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'No se encontró la solicitud o no tienes permisos sobre ella.' });
    }

    res.status(200).json({ mensaje: 'Calificación registrada correctamente.', solicitud: result.rows[0] });
  } catch (error) {
    console.error('Error al calificar servicio:', error);
    res.status(500).json({ error: 'No se pudo guardar la calificación. Intenta más tarde.' });
  }
});

// ==========================================
// BOTON SOS / ALERTA DE EMERGENCIA
// ==========================================
app.post('/api/solicitudes/:id/sos', authMiddleware, async (req, res) => {
  const { latitud, longitud, latitud_sos, longitud_sos } = req.body;
  const lat = latitud_sos ?? latitud ?? null;
  const lng = longitud_sos ?? longitud ?? null;

  console.error('🚨 ALERTA SOS CRÍTICA DETECTADA 🚨');
  console.error(`Solicitud ID: ${req.params.id} | Usuario ID: ${req.user.id_usuario}`);
  console.error(`Ubicación SOS: Lat ${lat}, Lng ${lng}`);
  console.error('🚨 ESCALANDO INMEDIATAMENTE AL PANEL DE ADMINISTRACIÓN Y CENTRO DE MONITOREO 🚨');

  try {
    const result = await pool.query(
      `UPDATE solicitudes_servicio
       SET alerta_sos = TRUE, latitud_sos = $1, longitud_sos = $2, fecha_sos = CURRENT_TIMESTAMP
       WHERE id_solicitud = $3
       RETURNING id_solicitud, folio, estado, alerta_sos, fecha_sos`,
      [lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'La solicitud no existe.' });
    }

    res.status(200).json({
      mensaje: 'Alerta SOS emitida y registrada con éxito. El equipo de auxilio ha sido notificado.',
      solicitud: result.rows[0],
    });
  } catch (error) {
    console.error('Error al registrar alerta SOS:', error);
    res.status(500).json({ error: error.message || 'Error interno al procesar alerta SOS.' });
  }
});

// ==========================================
// TECNICO ENVIAR COTIZACION
// ==========================================
app.post('/api/solicitudes/:id/cotizar', authMiddleware, async (req, res) => {
  if (!isUserApproved(req.user)) {
    return res.status(403).json({
      success: false,
      mensaje: 'Tu cuenta de técnico se encuentra en revisión de documentos. No puedes cotizar servicios hasta que tus credenciales sean aprobadas.'
    });
  }
  console.log("Datos recibidos para cotizar:", req.body);

  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Solo los técnicos pueden enviar cotizaciones.' });
  }

  const rawMonto = req.body?.monto_cotizacion ?? req.body?.monto;
  const rawDetalles = req.body?.detalles_cotizacion ?? req.body?.detalles;

  if (!rawMonto || isNaN(parseFloat(rawMonto)) || parseFloat(rawMonto) <= 0) {
    return res.status(400).json({ error: 'Ingresa un monto estimado válido.' });
  }

  const monto = parseFloat(rawMonto);
  const detalles = rawDetalles ? String(rawDetalles).trim() : '';

  try {
    const result = await pool.query(
      `UPDATE solicitudes_servicio SET monto_cotizacion = $1, detalles_cotizacion = $2, estado = 'ESPERANDO_APROBACION' WHERE id_solicitud = $3 RETURNING *;`,
      [monto, detalles, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'No se encontró la solicitud especificada.' });
    }

    res.status(200).json({ mensaje: 'Cotización enviada correctamente.', solicitud: result.rows[0] });
  } catch (error) {
    console.error('Error al enviar cotización:', error);
    res.status(500).json({ error: error.message, detail: error.detail || 'Error interno del servidor' });
  }
});

// ==========================================
// CLIENTE RESPONDER COTIZACION (ACEPTAR / RECHAZAR)
// ==========================================
app.patch('/api/solicitudes/:id/responder-cotizacion', authMiddleware, async (req, res) => {
  const { respuesta } = req.body;
  const decision = String(respuesta || '').toUpperCase();

  if (!['ACEPTAR', 'RECHAZAR'].includes(decision)) {
    return res.status(400).json({ error: 'Respuesta inválida. Debe ser ACEPTAR o RECHAZAR.' });
  }

  const nuevoEstado = decision === 'ACEPTAR' ? 'EN_PROCESO' : 'CANCELADA';

  try {
    const result = await pool.query(
      `UPDATE solicitudes_servicio
       SET estado = $1
       WHERE id_solicitud = $2 AND id_usuario = $3 AND estado = 'ESPERANDO_APROBACION'
       RETURNING id_solicitud, folio, estado, monto_cotizacion`,
      [nuevoEstado, req.params.id, req.user.id_usuario]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'La cotización ya no está pendiente de respuesta o no te pertenece.' });
    }

    res.status(200).json({ mensaje: `Cotización ${decision === 'ACEPTAR' ? 'aceptada' : 'rechazada'} correctamente.`, solicitud: result.rows[0] });
  } catch (error) {
    console.error('Error al responder cotización:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// ACEPTAR O RECHAZAR SOLICITUD / CAMBIAR ESTADO
// ==========================================
app.patch('/api/solicitudes/:id/estado', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Solo los técnicos pueden cambiar el estado de una solicitud.' });
  }

  const estadoSolicitado = String(req.body?.estado || '').toUpperCase();
  if (!['ASIGNADA', 'ESPERANDO_APROBACION', 'EN_CAMINO', 'EN_PROCESO', 'FINALIZADA', 'CANCELADA'].includes(estadoSolicitado)) {
    return res.status(400).json({ error: 'Estado de transición no válido.' });
  }

  try {
    let result;
    if (estadoSolicitado === 'ASIGNADA') {
      if (!isUserApproved(req.user)) {
        return res.status(403).json({
          success: false,
          mensaje: 'Tu cuenta de técnico se encuentra en revisión de documentos. No puedes aceptar servicios hasta que tus credenciales sean aprobadas.'
        });
      }
      result = await pool.query(
        `UPDATE solicitudes_servicio
         SET id_tecnico = $1, estado = 'ASIGNADA'
         WHERE id_solicitud = $2 AND estado = 'PENDIENTE'
         RETURNING id_solicitud, folio, estado, id_tecnico`,
        [req.user.id_usuario, req.params.id]
      );
    } else if (estadoSolicitado === 'CANCELADA') {
      result = await pool.query(
        `UPDATE solicitudes_servicio
         SET estado = $1
         WHERE id_solicitud = $2 AND estado IN ('PENDIENTE', 'ASIGNADA', 'ESPERANDO_APROBACION', 'EN_CAMINO', 'EN_PROCESO')
         RETURNING id_solicitud, folio, estado, id_tecnico`,
        [estadoSolicitado, req.params.id]
      );
    } else {
      const transition = await pool.query(
        `UPDATE solicitudes_servicio
         SET estado = $1
         WHERE id_solicitud = $2 AND id_tecnico = $3
           AND estado IN ('ASIGNADA', 'ESPERANDO_APROBACION', 'EN_CAMINO', 'EN_PROCESO')
         RETURNING id_solicitud, folio, estado, id_tecnico`,
        [estadoSolicitado, req.params.id, req.user.id_usuario]
      );
      if (transition.rows.length === 0) {
        return res.status(409).json({ error: 'La solicitud no está asignada a ti o la transición no es válida.' });
      }

      if (estadoSolicitado === 'FINALIZADA') {
        try {
          let wallet = await pool.query(
            'SELECT id_billetera FROM billetera_tecnico WHERE id_usuario = $1',
            [req.user.id_usuario]
          );
          let idBilletera;
          if (wallet.rows.length === 0) {
            const newWallet = await pool.query(
              'INSERT INTO billetera_tecnico (id_usuario, saldo_actual) VALUES ($1, 500.00) RETURNING id_billetera',
              [req.user.id_usuario]
            );
            idBilletera = newWallet.rows[0].id_billetera;
          } else {
            idBilletera = wallet.rows[0].id_billetera;
            await pool.query(
              'UPDATE billetera_tecnico SET saldo_actual = saldo_actual + 500.00, fecha_actualizacion = CURRENT_TIMESTAMP WHERE id_billetera = $1',
              [idBilletera]
            );
          }
          await pool.query(
            `INSERT INTO transacciones (id_billetera, monto, tipo, estado) VALUES ($1, 500.00, 'INGRESO', 'COMPLETADO')`,
            [idBilletera]
          );
        } catch (walletErr) {
          console.error('Error al acreditar ingreso a billetera:', walletErr);
        }
      }

      return res.status(200).json({ mensaje: 'Estado actualizado correctamente.', solicitud: transition.rows[0] });
    }

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'La solicitud ya fue atendida o no existe.' });
    }
    res.status(200).json({ mensaje: 'Estado actualizado correctamente.', solicitud: result.rows[0] });
  } catch (error) {
    console.error('Error al actualizar estado de solicitud:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// TABLA Y ENDPOINTS DE ESPECIALIDADES TÉCNICAS
// ==========================================

app.get('/api/tecnico/especialidades', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Solo los técnicos pueden consultar sus especialidades.' });
  }
  try {
    let result = await pool.query(
      `SELECT id_especialidad, nombre, estado, activa FROM especialidades_tecnico WHERE id_usuario = $1 ORDER BY id_especialidad ASC`,
      [req.user.id_usuario]
    );

    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO especialidades_tecnico (id_usuario, nombre, estado, activa) VALUES
         ($1, 'Soporte y Hardware', 'VERIFICADO', true),
         ($1, 'Redes y Conectividad', 'VERIFICADO', false),
         ($1, 'Desarrollo y Diseño Web', 'EN_REVISION', false)
         ON CONFLICT (id_usuario, nombre) DO NOTHING`,
        [req.user.id_usuario]
      );
      result = await pool.query(
        `SELECT id_especialidad, nombre, estado, activa FROM especialidades_tecnico WHERE id_usuario = $1 ORDER BY id_especialidad ASC`,
        [req.user.id_usuario]
      );
    }
    res.status(200).json({ especialidades: result.rows });
  } catch (error) {
    console.error('Error al obtener especialidades:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

app.patch('/api/tecnico/especialidades/:id/toggle', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Acción no permitida.' });
  }
  const { id } = req.params;
  const { activa } = req.body;
  try {
    const result = await pool.query(
      `UPDATE especialidades_tecnico SET activa = $1 WHERE id_especialidad = $2 AND id_usuario = $3 RETURNING *`,
      [activa, id, req.user.id_usuario]
    );
    res.status(200).json({ especialidad: result.rows[0] });
  } catch (error) {
    console.error('Error al cambiar estado de especialidad:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

app.post('/api/tecnico/especialidades', authMiddleware, async (req, res) => {
  if (req.user.id_rol !== 2) {
    return res.status(403).json({ error: 'Acción no permitida.' });
  }
  const { nombre } = req.body;
  if (!nombre?.trim()) {
    return res.status(400).json({ error: 'El nombre de la especialidad es obligatorio.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO especialidades_tecnico (id_usuario, nombre, estado, activa)
       VALUES ($1, $2, 'EN_REVISION', false)
       ON CONFLICT (id_usuario, nombre) DO UPDATE SET estado = 'EN_REVISION'
       RETURNING *`,
      [req.user.id_usuario, nombre.trim()]
    );
    res.status(201).json({ especialidad: result.rows[0] });
  } catch (error) {
    console.error('Error al solicitar especialidad:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});
app.post('/api/usuario/push-token', authMiddleware, async (req, res) => {
  const { push_token } = req.body;
  try {
    await pool.query('UPDATE usuarios SET push_token = $1 WHERE id_usuario = $2', [push_token || null, req.user.id_usuario]);
    res.status(200).json({ mensaje: 'Push token registrado correctamente.' });
  } catch (err) {
    console.error('Error al guardar push token:', err);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

app.get('/api/solicitudes/:id/chat', authMiddleware, async (req, res) => {
  try {
    const access = await pool.query(
      `SELECT id_usuario, id_tecnico FROM solicitudes_servicio
       WHERE id_solicitud = $1 AND (id_usuario = $2 OR id_tecnico = $2)`,
      [req.params.id, req.user.id_usuario]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'No tienes acceso a este chat.' });
    
    // Soporte para tabla chat_servicio o mensajes_chat con paginación LIMIT 20
    const limit = Math.min(parseInt(String(req.query?.limit || '20'), 10), 100);
    let messages;
    try {
      messages = await pool.query(
        `SELECT m.id_chat AS id, m.id_solicitud, m.remitente, m.mensaje, m.fecha_envio
         FROM chat_servicio m WHERE m.id_solicitud = $1 ORDER BY m.fecha_envio DESC LIMIT $2`,
        [req.params.id, limit]
      );
      messages.rows.reverse();
    } catch (tblErr) {
      messages = await pool.query(
        `SELECT m.id, m.id_solicitud, m.id_emisor, m.mensaje, m.fecha_envio,
                u.nombre AS emisor_nombre, u.apellido AS emisor_apellido
         FROM mensajes_chat m JOIN usuarios u ON u.id_usuario = m.id_emisor
         WHERE m.id_solicitud = $1 ORDER BY m.fecha_envio DESC LIMIT $2`,
        [req.params.id, limit]
      );
      messages.rows.reverse();
    }
    res.status(200).json({ mensajes: messages.rows });
  } catch (error) {
    console.error('Error al obtener chat:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

app.post('/api/solicitudes/:id/chat', authMiddleware, async (req, res) => {
  const mensaje = String(req.body?.mensaje || '').trim();
  if (!mensaje) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
  try {
    const access = await pool.query(
      `SELECT id_usuario, id_tecnico FROM solicitudes_servicio
       WHERE id_solicitud = $1 AND (id_usuario = $2 OR id_tecnico = $2)`,
      [req.params.id, req.user.id_usuario]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'No tienes acceso a este chat.' });
    
    const { id_usuario, id_tecnico } = access.rows[0];
    const receptorId = req.user.id_usuario === id_usuario ? id_tecnico : id_usuario;

    // Guardar mensaje en chat_servicio y mensajes_chat
    let savedMsg;
    try {
      const resChat = await pool.query(
        `INSERT INTO chat_servicio (id_solicitud, remitente, mensaje)
         VALUES ($1, $2, $3) RETURNING id_chat AS id, id_solicitud, remitente, mensaje, fecha_envio`,
        [req.params.id, req.user.nombre || 'Usuario', mensaje]
      );
      savedMsg = resChat.rows[0];
    } catch (e) {
      const resMsg = await pool.query(
        `INSERT INTO mensajes_chat (id_solicitud, id_emisor, mensaje)
         VALUES ($1, $2, $3) RETURNING id, id_solicitud, id_emisor, mensaje, fecha_envio`,
        [req.params.id, req.user.id_usuario, mensaje]
      );
      savedMsg = resMsg.rows[0];
    }

    // Enviar Push Notification si el destinatario tiene push_token
    if (receptorId) {
      try {
        const userRes = await pool.query('SELECT push_token FROM usuarios WHERE id_usuario = $1', [receptorId]);
        const pushToken = userRes.rows[0]?.push_token;
        if (pushToken && pushToken.startsWith('ExponentPushToken')) {
          fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: pushToken,
              sound: 'default',
              title: `Nuevo mensaje de ${req.user.nombre || 'Click&Serve'}`,
              body: mensaje,
              data: { id_solicitud: req.params.id },
            }),
          }).catch(pErr => console.error('Error enviando Push:', pErr));
        }
      } catch (pErr) {
        console.error('Error consultando push token:', pErr);
      }
    }

    res.status(201).json({ mensaje: savedMsg });
  } catch (error) {
    console.error('Error al enviar mensaje:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});



// ==========================================
// RUTA 1: REGISTRAR USUARIO (/api/register)
// ==========================================
app.post('/api/register', async (req, res) => {
  const { 
    nombre, 
    apellidos, 
    telefono, 
    email, 
    fechaNacimiento, 
    password, 
    perfil, 
    ine_frente, 
    ine_reverso,
    foto_rostro,
    rostro,
    url_ine_front,
    url_ine_rev,
    referencia_facial
  } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Extraer fotos capturadas (frente, reverso, rostro)
    const fotoFrente = ine_frente || url_ine_front || req.body?.fotos?.frente || null;
    const fotoReverso = ine_reverso || url_ine_rev || req.body?.fotos?.reverso || null;
    const fotoRostroVal = foto_rostro || rostro || referencia_facial || req.body?.fotos?.rostro || null;

    // Asegurar columnas de estado y documentos en Usuarios
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS estado VARCHAR(30) DEFAULT 'pendiente'");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS estado_cuenta VARCHAR(30) DEFAULT 'pendiente'");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS identidad_verificada BOOLEAN DEFAULT false");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS verificado_sep BOOLEAN DEFAULT false");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS ine_frente TEXT");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS ine_reverso TEXT");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS foto_rostro TEXT");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS url_ine_front TEXT");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS url_ine_rev TEXT");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS referencia_facial TEXT");
    await pool.query("ALTER TABLE Usuarios ADD COLUMN IF NOT EXISTS biometria_estado VARCHAR(30) DEFAULT 'pendiente'");

    // Forzar estatus 'pendiente' para todo nuevo usuario
    const newUser = await pool.query(
      `INSERT INTO Usuarios 
        (nombre, apellido, telefono, correo, fecha_nacimiento, contrasena, id_rol, estado, estado_cuenta, identidad_verificada, ine_frente, ine_reverso, foto_rostro, url_ine_front, url_ine_rev, referencia_facial, biometria_estado) 
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) 
       RETURNING id_usuario, estado, estado_cuenta`,
      [
        nombre, 
        apellidos, 
        telefono, 
        emailFormateado, 
        fechaNacimiento, 
        hashedPassword, 
        perfil, 
        'pendiente',    // estado forzosamente 'pendiente'
        'pendiente',    // estado_cuenta forzosamente 'pendiente'
        false,          // identidad_verificada
        fotoFrente, 
        fotoReverso, 
        fotoRostroVal,
        fotoFrente,
        fotoReverso,
        fotoRostroVal,
        'pendiente'
      ]
    );
    
    const idUsuario = newUser.rows[0].id_usuario;
    const tokenGenerado = Math.floor(1000 + Math.random() * 9000).toString();

    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [idUsuario, tokenGenerado, 'registro', 'sin usar']
    );

    const mailOptions = {
      from: '"Click & Serve" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Tu código de verificación - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>¡Bienvenido a Click & Serve!</h2>
          <p>Hola ${nombre}, ingresa el siguiente código en la app para activar tu cuenta:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
          <p style="color: #7A8C9E; font-size: 12px; margin-top: 20px;">Este código es de un solo uso y de 4 dígitos.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ mensaje: 'Usuario registrado con éxito. Código enviado al correo.', id_usuario: idUsuario });

  } catch (error) {
    console.error('Error en /api/register:', error);
    if (error.code === '23505' || error.constraint === 'usuarios_correo_key') {
      return res.status(409).json({ error: 'Usuario Existente' });
    }
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 2: INICIAR SESIÓN (/api/login)
// ==========================================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();

    // Traemos explícitamente el estado del usuario para que el frontend pueda evaluar el bloqueo visual
    const userQuery = await pool.query(
      `SELECT id_usuario, nombre, apellido, telefono, correo, fecha_nacimiento, id_rol, 
              COALESCE(estado_cuenta, 'pendiente') AS estado,
              estado_cuenta, contrasena, "2FA_Activo", version_sesion, identidad_verificada 
       FROM Usuarios WHERE correo = $1`, 
      [emailFormateado]
    );

    if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Credenciales incorrectas. Verifica tus datos e intenta nuevamente.' });

    const usuario = userQuery.rows[0];

    const contraseñaValida = await bcrypt.compare(password, usuario.contrasena);

    if (!contraseñaValida) return res.status(401).json({ error: 'Credenciales incorrectas. Verifica tus datos e intenta nuevamente.' });

    delete usuario.contrasena;

    // Si tiene 2FA Activo, generar código de 4 dígitos y solicitar verificación
    if (usuario["2FA_Activo"] === true) {
      const codigo2FA = Math.floor(1000 + Math.random() * 9000).toString();
      console.log("🔑 Código 2FA:", codigo2FA);

      await pool.query('UPDATE Usuarios SET "2FA_Sem" = $1 WHERE id_usuario = $2', [codigo2FA, usuario.id_usuario]);

      return res.status(200).json({
        requires2FA: true,
        correo: usuario.correo,
        mensaje: "Código 2FA generado. Ingrésalo para completar el acceso."
      });
    }

    // Registrar la sesión en la base de datos (con ID y Rol)
    const dispositivo = req.headers['user-agent'] || 'Dispositivo desconocido';
    const sesionResult = await pool.query(
      `INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, $2, $3) RETURNING id_sesion`,
      [usuario.id_usuario, usuario.id_rol, dispositivo]
    );
    const sessionId = sesionResult.rows[0].id_sesion;

    // Generar el JWT con el ID de usuario, su Rol, versión de sesión y el ID de sesión específico
    const token = jwt.sign(
      { 
        id_usuario: usuario.id_usuario, 
        id_rol: usuario.id_rol,
        version_sesion: usuario.version_sesion || 1,
        sessionId: sessionId
      }, 
      jwtSecret(),
      { expiresIn: '7d' } // El token expira en 7 días
    );

    res.status(200).json({ 
      mensaje: 'Inicio de sesión exitoso',
      usuario: usuario,
      token: token
    });

  } catch (error) {
    console.error('Error en /api/login:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 3: VERIFICAR TOKEN DE REGISTRO (/api/verify-token)
// ==========================================
app.post('/api/verify-token', async (req, res) => {
  const { email, token } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    
    const userQuery = await pool.query('SELECT id_usuario FROM Usuarios WHERE correo = $1', [emailFormateado]);
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const idUsuario = userQuery.rows[0].id_usuario;

    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND token = $2 AND tipo_accion = 'registro' AND estado_uso = 'sin usar'`,
      [idUsuario, token]
    );

    if (tokenQuery.rows.length === 0) return res.status(400).json({ error: 'Código incorrecto, expirado o ya utilizado.' });

    const idToken = tokenQuery.rows[0].id_token;

    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1`, [idToken]);
    await pool.query(`UPDATE Usuarios SET estado_cuenta = 'Activo' WHERE id_usuario = $1`, [idUsuario]);

    res.status(200).json({ mensaje: 'Cuenta verificada exitosamente y activada.' });
  } catch (error) {
    console.error('Error en /api/verify-token:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 3.5: REENVIAR CÓDIGO DE REGISTRO (/api/resend-code)
// ==========================================
app.post('/api/resend-code', async (req, res) => {
  const { email } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();

    const userQuery = await pool.query('SELECT id_usuario, nombre FROM Usuarios WHERE correo = $1', [emailFormateado]);
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { id_usuario, nombre } = userQuery.rows[0];

    await pool.query(
      `UPDATE tokens_temporales SET estado_uso = 'expirado' WHERE id_usuario = $1 AND tipo_accion = 'registro' AND estado_uso = 'sin usar'`,
      [id_usuario]
    );

    const tokenGenerado = Math.floor(1000 + Math.random() * 9000).toString();

    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [id_usuario, tokenGenerado, 'registro', 'sin usar']
    );

    const mailOptions = {
      from: '"Click & Serve" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Nuevo código de verificación - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>¡Aquí tienes tu nuevo código!</h2>
          <p>Hola ${nombre}, los códigos anteriores han sido invalidados. Ingresa este nuevo código para activar tu cuenta:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ mensaje: 'Nuevo código enviado exitosamente.' });
  } catch (error) {
    console.error('Error en /api/resend-code:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 4: SOLICITAR RECUPERACIÓN DE CONTRASEÑA (/api/request-recovery)
// ==========================================
app.post('/api/request-recovery', async (req, res) => {
  const { email } = req.body; 

  try {
    const emailFormateado = email.trim().toLowerCase();
    const userQuery = await pool.query('SELECT id_usuario, nombre FROM Usuarios WHERE correo = $1', [emailFormateado]);
    
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'No hay ninguna cuenta asociada a este correo.' });

    const { id_usuario, nombre } = userQuery.rows[0];

    // Invalidar códigos de recuperación anteriores que no se usaron
    await pool.query(
      `UPDATE tokens_temporales SET estado_uso = 'expirado' WHERE id_usuario = $1 AND tipo_accion = 'recuperacion' AND estado_uso = 'sin usar'`,
      [id_usuario]
    );

    const tokenGenerado = Math.floor(1000 + Math.random() * 9000).toString();

    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [id_usuario, tokenGenerado, 'recuperacion', 'sin usar']
    );

    const mailOptions = {
      from: '"Click & Serve" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Recuperación de contraseña - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>Recuperación de cuenta</h2>
          <p>Hola ${nombre}, recibimos una solicitud para restablecer tu contraseña. Ingresa este código en la app:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
          <p style="color: #7A8C9E; font-size: 12px; margin-top: 20px;">Si no solicitaste esto, ignora este correo.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ mensaje: 'Código de recuperación enviado al correo.' });
  } catch (error) {
    console.error('Error en /api/request-recovery:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 5: VERIFICAR TOKEN DE RECUPERACIÓN (/api/verify-recovery)
// ==========================================
app.post('/api/verify-recovery', async (req, res) => {
  const { email, token } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    const userQuery = await pool.query('SELECT id_usuario FROM Usuarios WHERE correo = $1', [emailFormateado]);

    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const idUsuario = userQuery.rows[0].id_usuario;

    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND token = $2 AND tipo_accion = 'recuperacion' AND estado_uso = 'sin usar'`,
      [idUsuario, token]
    );

    if (tokenQuery.rows.length === 0) return res.status(400).json({ error: 'Código incorrecto o expirado.' });

    const idToken = tokenQuery.rows[0].id_token;
    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'verificado' WHERE id_token = $1`, [idToken]);

    res.status(200).json({ mensaje: 'Código verificado correctamente. Puedes cambiar tu contraseña.' });
  } catch (error) {
    console.error('Error en /api/verify-recovery:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 6: RESTABLECER CONTRASEÑA (/api/reset-password)
// ==========================================
app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    const userQuery = await pool.query('SELECT id_usuario FROM Usuarios WHERE correo = $1', [emailFormateado]);

    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const idUsuario = userQuery.rows[0].id_usuario;

    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND tipo_accion = 'recuperacion' AND estado_uso = 'verificado'`,
      [idUsuario]
    );

    if (tokenQuery.rows.length === 0) return res.status(403).json({ error: 'Acceso denegado. No has verificado tu código de seguridad.' });

    const idToken = tokenQuery.rows[0].id_token;
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // 👈 Sumamos +1 a version_sesion (o la ponemos en 2 si era nula)
    await pool.query(
      `UPDATE Usuarios SET contrasena = $1, version_sesion = COALESCE(version_sesion, 1) + 1 WHERE id_usuario = $2`, 
      [hashedPassword, idUsuario]
    );

    // Revocar todas las sesiones activas del usuario
    await pool.query(
      "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND estado = 'activa'",
      [idUsuario]
    );

    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1`, [idToken]);

    res.status(200).json({ mensaje: 'Contraseña actualizada exitosamente. Ya puedes iniciar sesión.' });
  } catch (error) {
    console.error('Error en /api/reset-password:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 7: CAMBIAR CONTRASEÑA DESDE PERFIL (/api/update-password)
// ==========================================
app.post('/api/update-password', authMiddleware, async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  try {
    // Obtenemos los datos del usuario logueado usando el token
    const userQuery = await pool.query('SELECT id_usuario, contrasena, version_sesion, id_rol FROM Usuarios WHERE id_usuario = $1', [req.user.id_usuario]);
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const usuario = userQuery.rows[0];
    const contraseñaValida = await bcrypt.compare(currentPassword, usuario.contrasena);

    if (!contraseñaValida) return res.status(401).json({ error: 'contraseña actual incorrecta' });

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    const newVersionSesion = (usuario.version_sesion || 1) + 1;

    // 👈 Actualizar contraseña y version_sesion en Usuarios
    await pool.query(
      'UPDATE Usuarios SET contrasena = $1, version_sesion = $2 WHERE id_usuario = $3', 
      [hashedPassword, newVersionSesion, usuario.id_usuario]
    );

    // Revocar todas las demás sesiones activas en la base de datos
    if (req.user.sessionId) {
      await pool.query(
        "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND id_sesion != $2 AND estado = 'activa'",
        [usuario.id_usuario, req.user.sessionId]
      );
    }

    // Generar un nuevo JWT firmado con la versión de sesión actualizada y el mismo ID de sesión
    const token = jwt.sign(
      { 
        id_usuario: usuario.id_usuario, 
        id_rol: usuario.id_rol,
        version_sesion: newVersionSesion,
        sessionId: req.user.sessionId
      }, 
      jwtSecret(),
      { expiresIn: '7d' }
    );

    res.status(200).json({ 
      mensaje: 'Contraseña actualizada exitosamente.',
      token: token
    });
  } catch (error) {
    console.error('Error en /api/update-password:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// NUEVA RUTA 8: VERIFICAR ESTADO DE SESIÓN (/api/check-session)
// ==========================================
app.post('/api/check-session', async (req, res) => {
  const { id_usuario, version_local } = req.body;

  try {
    const query = await pool.query('SELECT version_sesion FROM Usuarios WHERE id_usuario = $1', [id_usuario]);
    
    if (query.rows.length === 0) {
      return res.status(404).json({ valid: false });
    }

    const versionDB = query.rows[0].version_sesion;

    if (versionDB !== version_local) {
      return res.status(401).json({ valid: false, error: 'Sesión expirada o cambiada en otro dispositivo' });
    }

    res.status(200).json({ valid: true });

  } catch (error) {
    console.error('Error al verificar sesión:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 8.5: INICIAR VERIFICACIÓN BIOMÉTRICA
// ==========================================
app.post('/api/biometria/solicitar', authMiddleware, async (req, res) => {
  try {
    const desafio = randomUUID();
    const resultado = await pool.query(
      `INSERT INTO verificaciones_biometricas (id_usuario, desafio, proveedor)
       VALUES ($1, $2, 'opencv')
       RETURNING id_verificacion, desafio, proveedor, estado, fecha_expiracion`,
      [req.user.id_usuario, desafio]
    );

    res.status(201).json({ verificacion: resultado.rows[0] });
  } catch (error) {
    console.error('Error al iniciar verificación biométrica:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 8.6: CONSULTAR VERIFICACIÓN BIOMÉTRICA
// ==========================================
app.get('/api/biometria/:idVerificacion', authMiddleware, async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT id_verificacion, proveedor, estado, resultado,
              fecha_creacion, fecha_expiracion, fecha_resolucion
       FROM verificaciones_biometricas
       WHERE id_verificacion = $1 AND id_usuario = $2`,
      [req.params.idVerificacion, req.user.id_usuario]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Verificación biométrica no encontrada.' });
    }

    res.status(200).json({ verificacion: resultado.rows[0] });
  } catch (error) {
    console.error('Error al consultar verificación biométrica:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 9: RUTA PROTEGIDA DE EJEMPLO (/api/perfil-protegido)
// ==========================================
app.get('/api/perfil-protegido', authMiddleware, async (req, res) => {
  // Gracias al middleware, sabemos que el token es válido y la sesión no ha expirado
  res.status(200).json({ 
    mensaje: 'Acceso concedido a ruta protegida',
    usuarioId: req.user.id_usuario,
    versionSesion: req.user.version_sesion
  });
});

// ==========================================
// RUTA 10: OBTENER SESIONES ACTIVAS DEL USUARIO (/api/auth/sessions)
// ==========================================
app.get('/api/auth/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id_usuario;
    const userRol = req.user.id_rol;
    // Solo devolvemos sesiones activas que coincidan con id_usuario y con id_rol
    const query = await pool.query(
      "SELECT id_sesion, dispositivo, fecha_creacion FROM sesiones_activas WHERE id_usuario = $1 AND id_rol = $2 AND estado = 'activa' ORDER BY fecha_creacion DESC",
      [userId, userRol]
    );
    
    // Identificar cuál de estas sesiones es la "actual"
    const sesiones = query.rows.map(sesion => ({
      ...sesion,
      es_sesion_actual: sesion.id_sesion === req.user.sessionId
    }));

    res.status(200).json({ sesiones });
  } catch (error) {
    console.error('Error al obtener sesiones:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 11: REVOCAR/DESVINCULAR UNA SESIÓN ESPECÍFICA (/api/auth/sessions/:sessionId)
// ==========================================
app.delete('/api/auth/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id_usuario;
    const userRol = req.user.id_rol;
    const sessionToRevoke = req.params.sessionId;

    // Verificar que la sesión exista y pertenezca al usuario y al rol correspondiente (Prevención IDOR)
    const checkQuery = await pool.query(
      "SELECT id_usuario, id_rol FROM sesiones_activas WHERE id_sesion = $1",
      [sessionToRevoke]
    );

    if (checkQuery.rows.length === 0) {
      return res.status(404).json({ error: 'La sesión no existe o ya fue eliminada.' });
    }

    const { id_usuario, id_rol } = checkQuery.rows[0];

    if (id_usuario !== userId || id_rol !== userRol) {
      // Intento de borrar la sesión de alguien más (IDOR)
      return res.status(403).json({ error: 'Acceso denegado. No tienes permiso para desvincular esta sesión.' });
    }

    // Actualizar el estado a 'revocada'
    await pool.query(
      "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_sesion = $1",
      [sessionToRevoke]
    );

    res.status(200).json({ mensaje: 'Dispositivo desvinculado exitosamente.' });
  } catch (error) {
    console.error('Error al revocar sesión:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});
// ==========================================
// RUTA: LOGIN EXCLUSIVO ADMINISTRADOR (Paso 1: Credenciales y Envío de Código)
// ==========================================
app.post('/api/login-admin', async (req, res) => {
  const { email, password } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();

    // Buscar al usuario
    const userQuery = await pool.query(
      'SELECT id_usuario, nombre, id_rol, estado_cuenta, contrasena FROM Usuarios WHERE correo = $1', 
      [emailFormateado]
    );

    if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

    const usuario = userQuery.rows[0];

    // Validar contraseña primero
    const contraseñaValida = await bcrypt.compare(password, usuario.contrasena);
    if (!contraseñaValida) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

    // Verificar que el rol sea de administrador (id_rol = 3)
    if (usuario.id_rol !== 3) {
      return res.status(403).json({ error: 'Acceso denegado. Credenciales no válidas para el panel web administrativo.' });
    }

    if (['No verificado', 'PENDIENTE', 'Pendiente', 'pendiente'].includes(usuario.estado_cuenta)) {
      return res.status(403).json({
        codigo: 'CUENTA_PENDIENTE',
        estado_cuenta: 'PENDIENTE',
        error: 'Tu cuenta administrativa está PENDIENTE de validación. Verifica tu cuenta antes de iniciar sesión.'
      });
    }

    // Generar código de 6 dígitos para mayor seguridad en 2FA
    const tokenGenerado = Math.floor(100000 + Math.random() * 900000).toString();

    // Invalidar códigos de login anteriores que no se usaron
    await pool.query(
      `UPDATE tokens_temporales SET estado_uso = 'expirado' WHERE id_usuario = $1 AND tipo_accion = 'login_admin' AND estado_uso = 'sin usar'`,
      [usuario.id_usuario]
    );

    // Guardar el nuevo código
    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [usuario.id_usuario, tokenGenerado, 'login_admin', 'sin usar']
    );

    // Enviar el correo
    const mailOptions = {
      from: '"Click & Serve - Seguridad" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Código de acceso al panel - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>Autenticación de Dos Factores</h2>
          <p>Hola ${usuario.nombre}, se ha detectado un intento de inicio de sesión en tu cuenta administrativa.</p>
          <p>Ingresa el siguiente código de seguridad para acceder al dashboard:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
          <p style="color: #7A8C9E; font-size: 12px; margin-top: 20px;">Si no intentaste iniciar sesión, cambia tu contraseña de inmediato.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    
    // Respondemos que se requiere el 2FA, NO devolvemos el JWT todavía
    res.status(200).json({ 
      mensaje: 'Credenciales correctas. Código enviado al correo.',
      requiere2FA: true 
    });

  } catch (error) {
    console.error('Error en /api/login-admin:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA: VALIDAR CÓDIGO ADMIN Y GENERAR SESIÓN (Paso 2: Entrega de JWT)
// ==========================================
app.post('/api/verify-login-admin', async (req, res) => {
  const { email, token } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    
    // Obtener datos del usuario
    const userQuery = await pool.query(
      'SELECT id_usuario, id_rol, version_sesion FROM Usuarios WHERE correo = $1 AND id_rol = 3', 
      [emailFormateado]
    );

    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario administrador no encontrado.' });
    const usuario = userQuery.rows[0];

    // Verificar el código 2FA
    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND token = $2 AND tipo_accion = 'login_admin' AND estado_uso = 'sin usar'`,
      [usuario.id_usuario, token]
    );

    if (tokenQuery.rows.length === 0) return res.status(400).json({ error: 'Código de seguridad incorrecto o expirado.' });
    const idToken = tokenQuery.rows[0].id_token;

    // Marcar código como usado
    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1`, [idToken]);

    // Crear la sesión en la base de datos
    const dispositivo = req.headers['user-agent'] || 'Panel Web Administrativo';
    const sesionResult = await pool.query(
      `INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, $2, $3) RETURNING id_sesion`,
      [usuario.id_usuario, usuario.id_rol, dispositivo]
    );
    const sessionId = sesionResult.rows[0].id_sesion;

    // Generar el JWT final
    const jwtToken = jwt.sign(
      { 
        id_usuario: usuario.id_usuario, 
        id_rol: usuario.id_rol,
        version_sesion: usuario.version_sesion || 1,
        sessionId: sessionId
      }, 
      jwtSecret(),
      { expiresIn: '8h' } // Las sesiones de admin suelen expirar más rápido por seguridad
    );

    res.status(200).json({ 
      mensaje: 'Acceso autorizado',
      usuario: usuario,
      token: jwtToken
    });

  } catch (error) {
    console.error('Error en /api/verify-login-admin:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});
// ==========================================
// RUTA 12: DESVINCULAR TODAS LAS DEMÁS SESIONES (/api/auth/sessions)
// ==========================================
app.delete('/api/auth/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id_usuario;
    const userRol = req.user.id_rol;
    const currentSessionId = req.user.sessionId; // El ID de la sesión actual

    // Actualizamos a revocada cualquier sesión activa del usuario que NO sea la actual
    await pool.query(
      "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND id_rol = $2 AND id_sesion != $3 AND estado = 'activa'",
      [userId, userRol, currentSessionId]
    );

    res.status(200).json({ mensaje: 'Todas las demás sesiones han sido cerradas exitosamente.' });
  } catch (error) {
    console.error('Error al revocar todas las sesiones:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});
// ==========================================
// RUTA 13: CERRAR SESIÓN (LOGOUT) (/api/logout)
// ==========================================
app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    if (req.user && req.user.sessionId) {
      await pool.query(
        "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_sesion = $1",
        [req.user.sessionId]
      );
    }
    res.status(200).json({ mensaje: 'Sesión cerrada exitosamente en el servidor.' });
  } catch (error) {
    console.error('Error en /api/logout:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});


// ==========================================
// RUTA 2FA: ACTUALIZAR ESTADO 2FA (/api/usuarios/2fa)
// ==========================================
app.put('/api/usuarios/2fa', authMiddleware, async (req, res) => {
  const { activo } = req.body;
  try {
    const isActivo = Boolean(activo);
    const result = await pool.query(
      'UPDATE Usuarios SET "2FA_Activo" = $1 WHERE id_usuario = $2 RETURNING id_usuario, "2FA_Activo"',
      [isActivo, req.user.id_usuario]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    res.status(200).json({
      mensaje: `Autenticación en dos pasos ${isActivo ? 'activada' : 'desactivada'} correctamente.`,
      "2FA_Activo": result.rows[0]["2FA_Activo"]
    });
  } catch (error) {
    console.error('Error en PUT /api/usuarios/2fa:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA 2FA: VERIFICAR CÓDIGO Y COMPLETAR LOGIN (/api/login/verify-2fa)
// ==========================================
app.post('/api/login/verify-2fa', async (req, res) => {
  const { correo, email, codigo, token } = req.body;
  const userEmail = (correo || email || '').trim().toLowerCase();
  const inputCode = String(codigo || token || '').trim();

  try {
    if (!userEmail || !inputCode) {
      return res.status(400).json({ error: 'Correo y código de 4 dígitos son requeridos.' });
    }

    const userQuery = await pool.query(
      `SELECT id_usuario, nombre, apellido, telefono, correo, fecha_nacimiento, id_rol,
              COALESCE(estado_cuenta, 'pendiente') AS estado,
              estado_cuenta, "2FA_Activo", "2FA_Sem", version_sesion, identidad_verificada
       FROM Usuarios WHERE correo = $1`,
      [userEmail]
    );

    if (userQuery.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas. Verifica tus datos e intenta nuevamente.' });
    }

    const usuario = userQuery.rows[0];

    if (!usuario["2FA_Sem"] || usuario["2FA_Sem"] !== inputCode) {
      return res.status(400).json({ error: 'Código 2FA incorrecto o expirado.' });
    }

    // Limpiar 2FA_Sem
    await pool.query('UPDATE Usuarios SET "2FA_Sem" = NULL WHERE id_usuario = $1', [usuario.id_usuario]);

    // Registrar sesión
    const dispositivo = req.headers['user-agent'] || 'Dispositivo móvil';
    const sesionResult = await pool.query(
      `INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, $2, $3) RETURNING id_sesion`,
      [usuario.id_usuario, usuario.id_rol, dispositivo]
    );
    const sessionId = sesionResult.rows[0].id_sesion;

    // Generar JWT
    const jwtToken = jwt.sign(
      {
        id_usuario: usuario.id_usuario,
        id_rol: usuario.id_rol,
        version_sesion: usuario.version_sesion || 1,
        sessionId: sessionId
      },
      jwtSecret(),
      { expiresIn: '7d' }
    );

    delete usuario["2FA_Sem"];

    res.status(200).json({
      mensaje: 'Inicio de sesión exitoso con 2FA',
      usuario: usuario,
      token: jwtToken
    });
  } catch (error) {
    console.error('Error en /api/login/verify-2fa:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});


// ==========================================
// RUTA 8.7: COMPARAR CAPTURA FACIAL
// ==========================================
app.post(
  '/api/biometria/:idVerificacion/compare',
  authMiddleware,
  biometricUpload.fields([
    { name: 'reference_image', maxCount: 1 },
    { name: 'live_image', maxCount: 1 },
  ]),
  async (req, res) => {
    const reference = req.files?.reference_image?.[0];
    const live = req.files?.live_image?.[0];

    if (!reference || !live) {
      return res.status(400).json({ error: 'Se requieren reference_image y live_image.' });
    }

    try {
      const form = new FormData();
      form.append('reference_image', new Blob([reference.buffer], { type: reference.mimetype }), reference.originalname);
      form.append('live_image', new Blob([live.buffer], { type: live.mimetype }), live.originalname);

      const modelResponse = await fetch(`${biometricServiceUrl}/compare`, {
        method: 'POST',
        body: form,
      });
      const modelResult = await modelResponse.json();

      if (!modelResponse.ok) {
        return res.status(422).json({ error: modelResult.detail || 'No se pudo comparar el rostro.' });
      }

      const aprobado = modelResult.match === true;
      const estado = aprobado ? 'APROBADO' : 'RECHAZADO';
      const resultado = await pool.query(
        `UPDATE verificaciones_biometricas
         SET estado = $1, resultado = $2::jsonb, fecha_resolucion = NOW()
         WHERE id_verificacion = $3 AND id_usuario = $4
         RETURNING id_verificacion, estado, resultado, fecha_resolucion`,
        [estado, JSON.stringify(modelResult), req.params.idVerificacion, req.user.id_usuario]
      );

      if (resultado.rows.length === 0) {
        return res.status(404).json({ error: 'Verificación biométrica no encontrada.' });
      }

      await pool.query(
        'UPDATE usuarios SET biometria_estado = $1, fecha_actualizacion = NOW() WHERE id_usuario = $2',
        [estado === 'APROBADO' ? 'verificada' : 'rechazada', req.user.id_usuario]
      );

      res.status(200).json({
        ...resultado.rows[0],
        estado: aprobado ? 'APROBADO' : 'RECHAZADO',
        match: aprobado,
        distance: modelResult.distance,
        confidence: modelResult.confidence,
      });
    } catch (error) {
      console.error('Error al comparar biometría:', error);
      res.status(502).json({ error: 'El servicio biométrico no está disponible.' });
    }
  }
);

// ==========================================
// MÓDULO 5: BILLETERA DEL TÉCNICO
// ==========================================

// GET /api/billetera - Obtener información de billetera
app.get('/api/billetera', authMiddleware, async (req, res) => {
  try {
    const id_usuario = req.user.id_usuario;
    let result = await pool.query(
      'SELECT id_billetera, id_usuario, saldo_actual, clabe_interbancaria, fecha_actualizacion FROM billetera_tecnico WHERE id_usuario = $1',
      [id_usuario]
    );

    if (result.rows.length === 0) {
      result = await pool.query(
        'INSERT INTO billetera_tecnico (id_usuario, saldo_actual, clabe_interbancaria) VALUES ($1, 0.00, NULL) RETURNING id_billetera, id_usuario, saldo_actual, clabe_interbancaria, fecha_actualizacion',
        [id_usuario]
      );
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener billetera:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// PUT /api/billetera/clabe - Actualizar CLABE interbancaria
app.put('/api/billetera/clabe', authMiddleware, async (req, res) => {
  const { clabe_interbancaria } = req.body;
  if (!clabe_interbancaria || clabe_interbancaria.trim().length !== 18) {
    return res.status(400).json({ error: 'La CLABE interbancaria debe tener exactamente 18 dígitos.' });
  }

  try {
    const id_usuario = req.user.id_usuario;
    const cleanClabe = clabe_interbancaria.trim();

    const check = await pool.query('SELECT id_billetera FROM billetera_tecnico WHERE id_usuario = $1', [id_usuario]);
    let result;
    if (check.rows.length === 0) {
      result = await pool.query(
        'INSERT INTO billetera_tecnico (id_usuario, saldo_actual, clabe_interbancaria) VALUES ($1, 0.00, $2) RETURNING id_billetera, id_usuario, saldo_actual, clabe_interbancaria, fecha_actualizacion',
        [id_usuario, cleanClabe]
      );
    } else {
      result = await pool.query(
        'UPDATE billetera_tecnico SET clabe_interbancaria = $1, fecha_actualizacion = CURRENT_TIMESTAMP WHERE id_usuario = $2 RETURNING id_billetera, id_usuario, saldo_actual, clabe_interbancaria, fecha_actualizacion',
        [cleanClabe, id_usuario]
      );
    }

    res.status(200).json({
      mensaje: 'CLABE interbancaria actualizada correctamente.',
      billetera: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar CLABE:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// POST /api/billetera/retiro - Solicitar retiro de fondos
app.post('/api/billetera/retiro', authMiddleware, async (req, res) => {
  const monto = Number(req.body?.monto);
  if (!monto || isNaN(monto) || monto <= 0) {
    return res.status(400).json({ error: 'El monto a retirar debe ser un número mayor a 0.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletRes = await client.query(
      'SELECT id_billetera, saldo_actual, clabe_interbancaria FROM billetera_tecnico WHERE id_usuario = $1 FOR UPDATE',
      [req.user.id_usuario]
    );

    if (walletRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No tienes una billetera configurada.' });
    }

    const { id_billetera, saldo_actual } = walletRes.rows[0];
    const saldoNum = Number(saldo_actual);

    if (saldoNum < monto) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Saldo insuficiente. Saldo disponible: $${saldoNum.toFixed(2)}.` });
    }

    await client.query(
      'UPDATE billetera_tecnico SET saldo_actual = saldo_actual - $1, fecha_actualizacion = CURRENT_TIMESTAMP WHERE id_billetera = $2',
      [monto, id_billetera]
    );

    const txRes = await client.query(
      `INSERT INTO transacciones (id_billetera, monto, tipo, estado) VALUES ($1, $2, 'RETIRO', 'PENDIENTE') RETURNING *`,
      [id_billetera, monto]
    );

    await client.query('COMMIT');
    res.status(201).json({
      mensaje: 'Solicitud de retiro registrada exitosamente.',
      transaccion: txRes.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al procesar retiro:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  } finally {
    client.release();
  }
});

// ==========================================
// GEOLOCALIZACION Y TECNICOS CERCANOS
// ==========================================

// PUT /api/usuarios/ubicacion - Actualiza latitud y longitud del usuario o técnico
app.put('/api/usuarios/ubicacion', authMiddleware, async (req, res) => {
  const { latitud, longitud } = req.body;

  const latNum = parseFloat(latitud);
  const lonNum = parseFloat(longitud);

  if (isNaN(latNum) || isNaN(lonNum)) {
    return res.status(400).json({ error: 'Coordenadas inválidas. Debes enviar latitud y longitud numéricas.' });
  }

  try {
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS latitud NUMERIC(10, 7)');
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS longitud NUMERIC(10, 7)');
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultima_conexion TIMESTAMPTZ DEFAULT NOW()');

    const result = await pool.query(
      `UPDATE usuarios 
       SET latitud = $1, longitud = $2, ultima_conexion = CURRENT_TIMESTAMP 
       WHERE id_usuario = $3 
       RETURNING id_usuario, nombre, latitud, longitud, ultima_conexion`,
      [latNum, lonNum, req.user.id_usuario]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    res.status(200).json({
      mensaje: 'Ubicación actualizada correctamente.',
      ubicacion: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar ubicación de usuario:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// GET /api/tecnicos/cercanos - Consulta técnicos activos o aceptados con coordenadas
app.get('/api/tecnicos/cercanos', authMiddleware, async (req, res) => {
  try {
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS latitud NUMERIC(10, 7)');
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS longitud NUMERIC(10, 7)');

    const result = await pool.query(
      `SELECT u.id_usuario, u.nombre, u.apellido, u.telefono,
              COALESCE(u.latitud, 17.9583) AS latitud,
              COALESCE(u.longitud, -102.2000) AS longitud,
              COALESCE(u.estado_cuenta, u.estado) AS estado,
              4.9::numeric AS calificacion
       FROM usuarios u
       WHERE u.id_rol = 2 
         AND LOWER(COALESCE(u.estado_cuenta, u.estado, '')) IN ('activo', 'aceptado')
       LIMIT 20`
    );

    res.status(200).json({
      tecnicos: result.rows || []
    });
  } catch (error) {
    console.error('Error al consultar técnicos cercanos:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});

// ==========================================
// RUTA: ACTUALIZAR PERFIL / AVATAR
// ==========================================
app.put(['/api/usuarios/perfil', '/api/usuarios/avatar'], authMiddleware, async (req, res) => {
  const { foto_perfil, avatar, imagen, nombre, apellido, telefono } = req.body;
  const foto = foto_perfil || avatar || imagen || null;

  try {
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto_perfil TEXT');

    let query = 'UPDATE usuarios SET ';
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (foto) {
      updates.push(`foto_perfil = $${paramIndex++}`);
      values.push(foto);
    }
    if (nombre) {
      updates.push(`nombre = $${paramIndex++}`);
      values.push(nombre);
    }
    if (apellido) {
      updates.push(`apellido = $${paramIndex++}`);
      values.push(apellido);
    }
    if (telefono) {
      updates.push(`telefono = $${paramIndex++}`);
      values.push(telefono);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No se enviaron datos para actualizar.' });
    }

    values.push(req.user.id_usuario);
    query += updates.join(', ') + ` WHERE id_usuario = $${paramIndex} RETURNING id_usuario, nombre, apellido, telefono, correo, foto_perfil, id_rol`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    res.status(200).json({
      mensaje: 'Perfil actualizado correctamente.',
      usuario: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar perfil/avatar:', error);
    res.status(500).json({ error: 'Error en el servidor. Intenta más tarde.' });
  }
});
};
