const { randomUUID } = require('crypto');
const { isDevelopment } = require('../lib/env');

// Tokens de prueba publicados por Conekta que representan rechazos.
const DECLINED_TEST_TOKENS = new Set(['tok_test_card_declined', 'tok_test_insufficient_funds', 'tok_test_card_expired']);

async function fetchWithTimeout(url, options, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// RNF-02: el backend solo recibe el token de la tarjeta. Con CONEKTA_PRIVATE_KEY cobra en Conekta;
// sin ella (desarrollo) registra un cargo de sandbox y respeta los tokens de rechazo de prueba.
// Fuera de desarrollo (NODE_ENV distinto de development/test) sin llave se niega el cobro: nunca se marca pagado un servicio que nadie cobró.
async function chargeCard({ token, amount, description, customer }) {
  const key = process.env.CONEKTA_PRIVATE_KEY;
  if (!key) {
    if (!isDevelopment()) {
      console.error('CONEKTA_PRIVATE_KEY no está configurada fuera de desarrollo: se rechazan los cobros.');
      return { ok: false, modo: 'CONEKTA', unavailable: true, motivo: 'Los pagos no están disponibles en este momento. Intenta más tarde.' };
    }
    if (DECLINED_TEST_TOKENS.has(token)) {
      return { ok: false, modo: 'SANDBOX', motivo: 'La tarjeta fue rechazada por el banco emisor.' };
    }
    return { ok: true, modo: 'SANDBOX', referencia: `sbx_${randomUUID().slice(0, 18)}` };
  }

  try {
    const res = await fetchWithTimeout('https://api.conekta.io/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/vnd.conekta-v2.1.0+json',
        'Content-Type': 'application/json',
        'Accept-Language': 'es',
      },
      body: JSON.stringify({
        currency: 'MXN',
        customer_info: { name: customer.nombre, email: customer.correo, phone: customer.telefono || '0000000000' },
        line_items: [{ name: description, unit_price: Math.round(Number(amount) * 100), quantity: 1 }],
        charges: [{ payment_method: { type: 'card', token_id: token } }],
      }),
    });
    // Un 5xx de Conekta no dice si la orden se creó: se trata como cobro incierto, no como rechazo.
    if (res.status >= 500) {
      return { ok: false, modo: 'CONEKTA', unavailable: true, uncertain: true, motivo: 'La pasarela de pago no confirmó el cobro.' };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.payment_status !== 'paid') {
      return { ok: false, modo: 'CONEKTA', motivo: body?.details?.[0]?.message || 'El pago fue rechazado.' };
    }
    return { ok: true, modo: 'CONEKTA', referencia: body.id };
  } catch (error) {
    // La petición pudo llegar a Conekta antes del corte: tampoco se sabe si se cobró.
    const timeout = error.name === 'AbortError';
    return { ok: false, modo: 'CONEKTA', unavailable: true, uncertain: true, motivo: timeout ? 'La pasarela de pago no respondió a tiempo.' : 'La pasarela de pago no está disponible.' };
  }
}

module.exports = { chargeCard, fetchWithTimeout };
