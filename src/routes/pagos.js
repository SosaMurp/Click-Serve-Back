const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { auth } = require('../middleware/auth');
const { ROL, requireRole } = require('../middleware/roles');
const { fail, HttpError } = require('../lib/http');
const { audit } = require('../lib/audit');
const { idempotent } = require('../lib/idempotency');
const { sanitizeText } = require('../lib/sanitize');
const { isValidClabe, bankFromClabe, maskClabe, onlyDigits } = require('../lib/validators');
const S = require('../services/solicitudes');

const router = express.Router();
const db = () => getPool();

const MARCAS = ['VISA', 'MASTERCARD', 'AMEX', 'CARNET'];
const MIN_WITHDRAWAL = '100.00';

// ───────────────────────── Métodos de pago (RF-66/67/68, RNF-02) ─────────────────────────
function shapeCard(row) {
  return {
    id_metodo: row.id_metodo,
    titular: row.titular,
    marca: row.marca || 'VISA',
    ultimos_4: row.ultimos_4,
    expiracion: row.expiracion,
    predeterminada: row.predeterminada === true,
  };
}

function isExpired(mmYY) {
  const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(String(mmYY || ''));
  if (!m) return true;
  const year = 2000 + Number(m[2]);
  const endOfMonth = new Date(year, Number(m[1]), 1);
  return endOfMonth <= new Date();
}

async function listCards(userId) {
  const { rows } = await db().query(
    'SELECT * FROM metodos_pago WHERE id_usuario = $1 AND token IS NOT NULL ORDER BY predeterminada DESC, id_metodo DESC',
    [userId]
  );
  return rows.map(shapeCard);
}

async function saveCard(req, res) {
  const b = req.body || {};
  if (b.numero_tarjeta || b.numero || b.cvv || b.cvc || b.card_number) {
    return fail(res, 400, 'PAN_NOT_ALLOWED', 'Por seguridad, la app debe tokenizar la tarjeta antes de enviarla.');
  }
  const token = String(b.token || '');
  const marca = String(b.marca || '').toUpperCase();
  const ultimos = String(b.ultimos_4 || '');
  const titular = sanitizeText(b.titular, 100);
  const expiracion = String(b.expiracion || b.vencimiento || '');
  if (!/^tok_[A-Za-z0-9_]{6,64}$/.test(token)) return fail(res, 400, 'VALIDATION_ERROR', 'No se pudo validar la tarjeta. Intenta de nuevo.');
  if (!MARCAS.includes(marca)) return fail(res, 400, 'VALIDATION_ERROR', 'Marca de tarjeta no soportada.');
  if (!/^\d{4}$/.test(ultimos)) return fail(res, 400, 'VALIDATION_ERROR', 'Datos de la tarjeta incompletos.');
  if (titular.length < 3) return fail(res, 400, 'VALIDATION_ERROR', 'Escribe el nombre del titular como aparece en la tarjeta.', { field: 'titular' });
  if (isExpired(expiracion)) return fail(res, 400, 'CARD_EXPIRED', 'La tarjeta está vencida o la fecha no es válida (MM/AA).', { field: 'expiracion' });

  const card = await withTransaction(async (tx) => {
    const count = (await tx.query('SELECT COUNT(*)::int AS n FROM metodos_pago WHERE id_usuario = $1 AND token IS NOT NULL', [req.user.id_usuario])).rows[0].n;
    if (count >= 5) throw new HttpError(409, 'CARD_LIMIT', 'Puedes guardar hasta 5 tarjetas.');
    const { rows } = await tx.query(
      `INSERT INTO metodos_pago (id_usuario, titular, ultimos_4, expiracion, token, marca, predeterminada)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id_usuario, titular, ultimos, expiracion, token, marca, count === 0]
    );
    return rows[0];
  });
  audit(req, 'TARJETA_AGREGADA', 'metodo_pago', card.id_metodo, { marca, ultimos_4: ultimos });
  return res.status(201).json({ mensaje: 'Tarjeta guardada.', metodo: shapeCard(card) });
}

router.post(['/api/metodos-pago', '/api/tarjetas'], auth, saveCard);

router.get(['/api/metodos-pago', '/api/tarjetas'], auth, async (req, res) => {
  const metodos = await listCards(req.user.id_usuario);
  res.json({ metodos, tarjetas: metodos });
});

router.patch('/api/metodos-pago/:id/predeterminada', auth, async (req, res) => {
  const ok = await withTransaction(async (tx) => {
    const own = await tx.query('SELECT 1 FROM metodos_pago WHERE id_metodo = $1 AND id_usuario = $2', [req.params.id, req.user.id_usuario]);
    if (!own.rowCount) return false;
    await tx.query('UPDATE metodos_pago SET predeterminada = (id_metodo = $1) WHERE id_usuario = $2', [req.params.id, req.user.id_usuario]);
    return true;
  });
  if (!ok) return fail(res, 404, 'NOT_FOUND', 'Tarjeta no encontrada.');
  return res.json({ mensaje: 'Tarjeta principal actualizada.', metodos: await listCards(req.user.id_usuario) });
});

router.delete(['/api/metodos-pago/:id', '/api/tarjetas/:id'], auth, async (req, res) => {
  const deleted = await withTransaction(async (tx) => {
    const { rows } = await tx.query('DELETE FROM metodos_pago WHERE id_metodo = $1 AND id_usuario = $2 RETURNING predeterminada', [req.params.id, req.user.id_usuario]);
    if (!rows[0]) return false;
    if (rows[0].predeterminada) {
      await tx.query(
        `UPDATE metodos_pago SET predeterminada = true WHERE id_metodo = (
           SELECT id_metodo FROM metodos_pago WHERE id_usuario = $1 AND token IS NOT NULL ORDER BY id_metodo DESC LIMIT 1)`,
        [req.user.id_usuario]
      );
    }
    return true;
  });
  if (!deleted) return fail(res, 404, 'NOT_FOUND', 'Tarjeta no encontrada.');
  audit(req, 'TARJETA_ELIMINADA', 'metodo_pago', req.params.id);
  return res.json({ mensaje: 'Tarjeta eliminada.', id: Number(req.params.id) });
});

// ───────────────────────── Billetera del técnico (RF-71/73/74/75/76/79, RD-014) ─────────────────────────
async function ensureWallet(userId, tx = db()) {
  const { rows } = await tx.query(
    `INSERT INTO billetera_tecnico (id_usuario, saldo_actual) VALUES ($1, 0)
     ON CONFLICT (id_usuario) DO UPDATE SET id_usuario = EXCLUDED.id_usuario
     RETURNING id_billetera, id_usuario, saldo_actual, clabe_interbancaria, banco, fecha_actualizacion`,
    [userId]
  );
  return rows[0];
}

// La CLABE completa nunca sale del servidor (RNF-09).
function shapeWallet(w) {
  const masked = maskClabe(w.clabe_interbancaria);
  return {
    id_billetera: w.id_billetera,
    saldo_actual: w.saldo_actual,
    clabe: masked,
    clabe_interbancaria: masked,
    banco: w.banco || (w.clabe_interbancaria ? bankFromClabe(w.clabe_interbancaria) : null),
    tiene_clabe: Boolean(w.clabe_interbancaria),
    minimo_retiro: MIN_WITHDRAWAL,
    fecha_actualizacion: w.fecha_actualizacion,
  };
}

router.get('/api/billetera', auth, requireRole(ROL.TECNICO), async (req, res) => {
  res.json(shapeWallet(await ensureWallet(req.user.id_usuario)));
});

router.put('/api/billetera/clabe', auth, requireRole(ROL.TECNICO), async (req, res) => {
  const clabe = onlyDigits(req.body?.clabe_interbancaria ?? req.body?.clabe);
  if (!isValidClabe(clabe)) {
    return fail(res, 400, 'INVALID_CLABE', 'La CLABE no es válida. Revisa los 18 dígitos.', { field: 'clabe' });
  }
  const banco = bankFromClabe(clabe) || 'Banco no identificado';
  await ensureWallet(req.user.id_usuario);
  const { rows } = await db().query(
    `UPDATE billetera_tecnico SET clabe_interbancaria = $1, banco = $2, fecha_actualizacion = NOW()
     WHERE id_usuario = $3 RETURNING id_billetera, id_usuario, saldo_actual, clabe_interbancaria, banco, fecha_actualizacion`,
    [clabe, banco, req.user.id_usuario]
  );
  audit(req, 'CLABE_ACTUALIZADA', 'billetera', rows[0].id_billetera, { banco, terminacion: clabe.slice(-4) });
  res.json({ mensaje: 'Cuenta de depósito guardada.', billetera: shapeWallet(rows[0]) });
});

router.post('/api/billetera/retiro', auth, requireRole(ROL.TECNICO), idempotent('billetera.retiro'), async (req, res) => {
  const monto = S.parseMoney(req.body?.monto);
  if (!monto) return fail(res, 400, 'VALIDATION_ERROR', 'Escribe un monto válido con máximo 2 decimales.', { field: 'monto' });

  const tx = await withTransaction(async (t) => {
    await ensureWallet(req.user.id_usuario, t);
    const w = (await t.query(
      `SELECT id_billetera, saldo_actual, clabe_interbancaria, banco, $2::numeric < $3::numeric AS bajo_minimo,
              saldo_actual < $2::numeric AS insuficiente
       FROM billetera_tecnico WHERE id_usuario = $1 FOR UPDATE`,
      [req.user.id_usuario, monto, MIN_WITHDRAWAL]
    )).rows[0];
    if (!w.clabe_interbancaria) throw new HttpError(400, 'CLABE_REQUIRED', 'Registra tu cuenta CLABE antes de retirar.');
    if (w.bajo_minimo) throw new HttpError(400, 'MIN_WITHDRAWAL', `El retiro mínimo es de $${MIN_WITHDRAWAL}.`);
    if (w.insuficiente) throw new HttpError(400, 'INSUFFICIENT_FUNDS', 'El monto supera tu saldo disponible.');
    await t.query('UPDATE billetera_tecnico SET saldo_actual = saldo_actual - $1::numeric, fecha_actualizacion = NOW() WHERE id_billetera = $2', [monto, w.id_billetera]);
    const { rows } = await t.query(
      `INSERT INTO transacciones (id_billetera, monto, tipo, estado, folio, concepto, clabe_destino, banco_destino)
       VALUES ($1, $2::numeric, 'RETIRO', 'EN_PROCESO', $3, 'RETIRO', $4, $5)
       RETURNING id_transaccion, folio, tipo, concepto, monto, estado, fecha`,
      [w.id_billetera, monto, S.folio('TRX'), maskClabe(w.clabe_interbancaria), w.banco || bankFromClabe(w.clabe_interbancaria)]
    );
    return rows[0];
  });
  audit(req, 'RETIRO_SOLICITADO', 'transaccion', tx.id_transaccion, { monto });
  res.status(201).json({ mensaje: 'Retiro solicitado. El depósito por SPEI llega en 1 a 2 días hábiles.', transaccion: tx });
});

router.get('/api/billetera/movimientos', auth, requireRole(ROL.TECNICO), async (req, res) => {
  const tipo = ['INGRESO', 'RETIRO'].includes(String(req.query.tipo || '').toUpperCase()) ? String(req.query.tipo).toUpperCase() : null;
  const { rows } = await db().query(
    `SELECT t.id_transaccion, t.folio, t.tipo, t.concepto, t.monto, t.estado, t.fecha, t.id_solicitud, s.folio AS folio_solicitud, cat.nombre AS categoria_nombre
     FROM transacciones t
     JOIN billetera_tecnico b ON b.id_billetera = t.id_billetera
     LEFT JOIN solicitudes_servicio s ON s.id_solicitud = t.id_solicitud
     LEFT JOIN categorias_servicio cat ON cat.codigo = s.categoria
     WHERE b.id_usuario = $1 AND ($2::text IS NULL OR t.tipo = $2)
     ORDER BY t.fecha DESC, t.id_transaccion DESC LIMIT 200`,
    [req.user.id_usuario, tipo]
  );
  res.json({ movimientos: rows });
});

router.get('/api/billetera/movimientos/:id', auth, requireRole(ROL.TECNICO), async (req, res) => {
  const { rows } = await db().query(
    `SELECT t.id_transaccion, t.folio, t.tipo, t.concepto, t.monto, t.estado, t.fecha, t.desglose,
            t.clabe_destino, t.banco_destino, s.folio AS folio_solicitud, cat.nombre AS categoria_nombre,
            u.nombre, u.apellido
     FROM transacciones t
     JOIN billetera_tecnico b ON b.id_billetera = t.id_billetera
     JOIN usuarios u ON u.id_usuario = b.id_usuario
     LEFT JOIN solicitudes_servicio s ON s.id_solicitud = t.id_solicitud
     LEFT JOIN categorias_servicio cat ON cat.codigo = s.categoria
     WHERE t.id_transaccion = $1 AND b.id_usuario = $2`,
    [req.params.id, req.user.id_usuario]
  );
  const t = rows[0];
  if (!t) return fail(res, 404, 'NOT_FOUND', 'Movimiento no encontrado.');
  res.json({
    comprobante: {
      id_transaccion: t.id_transaccion,
      folio: t.folio,
      tipo: t.tipo,
      concepto: t.concepto,
      monto: t.monto,
      estado: t.estado,
      fecha: t.fecha,
      beneficiario: `${t.nombre} ${t.apellido}`,
      cuenta_destino: t.clabe_destino,
      banco_destino: t.banco_destino,
      folio_solicitud: t.folio_solicitud,
      categoria_nombre: t.categoria_nombre,
      desglose: t.desglose,
    },
  });
});

module.exports = router;
