const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { randomUUID } = require('crypto');
const { resetDb, startServer, createUser, api, getPool, closePool } = require('./helpers');
const { idempotent } = require('../src/lib/idempotency');
const { saveFile, signFileUrl } = require('../src/lib/files');
const { sanitizeText } = require('../src/lib/sanitize');

let server;
test.before(async () => { await resetDb(); server = await startServer(); });
test.after(async () => { await server.close(); await closePool(); });

async function miniApp(handler) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id_usuario: Number(req.header('X-User')) }; next(); });
  app.post('/accion', idempotent('prueba'), handler);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('idempotencia: sin Idempotency-Key responde 400', async () => {
  const app = await miniApp((_req, res) => res.json({ ok: true }));
  try {
    const res = await api(app.url, 'POST', '/accion', { body: {}, headers: { 'X-User': '1' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  } finally { await app.close(); }
});

test('idempotencia: la misma clave repite la respuesta sin ejecutar dos veces', async () => {
  const user = await createUser();
  let efectos = 0;
  const app = await miniApp((_req, res) => { efectos += 1; res.status(201).json({ n: efectos }); });
  try {
    const key = randomUUID();
    const headers = { 'X-User': String(user.id), 'Idempotency-Key': key };
    const a = await api(app.url, 'POST', '/accion', { body: {}, headers });
    const b = await api(app.url, 'POST', '/accion', { body: {}, headers });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(b.body, a.body);
    assert.equal(efectos, 1);
  } finally { await app.close(); }
});

test('idempotencia: un rechazo 4xx no se guarda; el reintento con la misma clave vuelve a ejecutarse', async () => {
  const user = await createUser();
  let intentos = 0;
  // Simula un pago: el primer intento lo rechaza el banco (402), el segundo con otra tarjeta pasa.
  const app = await miniApp((_req, res) => {
    intentos += 1;
    if (intentos === 1) return res.status(402).json({ code: 'PAYMENT_DECLINED' });
    return res.status(200).json({ pagado: true });
  });
  try {
    const headers = { 'X-User': String(user.id), 'Idempotency-Key': randomUUID() };
    const rechazo = await api(app.url, 'POST', '/accion', { body: {}, headers });
    const reintento = await api(app.url, 'POST', '/accion', { body: {}, headers });
    assert.equal(rechazo.status, 402);
    assert.equal(reintento.status, 200);
    assert.equal(reintento.body.pagado, true);
    assert.equal(intentos, 2);
  } finally { await app.close(); }
});

test('archivos: URL firmada vigente entrega el contenido', async () => {
  const user = await createUser();
  const id = await saveFile(getPool(), { owner: user.id, buffer: Buffer.from('hola'), mime: 'text/plain', name: 'a.txt', categoria: 'CHAT' });
  const url = signFileUrl(id);
  const res = await fetch(server.url + url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hola');
});

test('archivos: firma alterada o vencida responde 403', async () => {
  const user = await createUser();
  const id = await saveFile(getPool(), { owner: user.id, buffer: Buffer.from('x'), mime: 'text/plain', name: 'b.txt', categoria: 'CHAT' });
  const vencida = signFileUrl(id, -10);
  assert.equal((await fetch(server.url + vencida)).status, 403);
  const alterada = signFileUrl(id).replace(/sig=[^&]+/, 'sig=abc');
  assert.equal((await fetch(server.url + alterada)).status, 403);
});

test('TRUST_PROXY: detrás de un proxy configurado se usa la IP real del cliente', async () => {
  const { createApp } = require('../src/app');
  const prev = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    const app = createApp();
    assert.equal(app.get('trust proxy fn')('10.0.0.8', 0), true);
    assert.equal(app.get('trust proxy fn')('10.0.0.8', 1), false);
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
  }
  const local = createApp();
  assert.equal(local.get('trust proxy fn')('127.0.0.1', 0), true);
  assert.equal(local.get('trust proxy fn')('10.0.0.8', 0), false);
});

test('sanitizeText elimina etiquetas HTML y recorta', () => {
  assert.equal(sanitizeText('  <script>alert(1)</script>Hola <b>mundo</b> '), 'alert(1)Hola mundo');
});

test('pagos: sin CONEKTA_PRIVATE_KEY en producción no se aprueba ningún cargo (falla cerrado)', async () => {
  const { chargeCard } = require('../src/services/payments');
  const prev = { key: process.env.CONEKTA_PRIVATE_KEY, env: process.env.NODE_ENV, jwt: process.env.JWT_SECRET };
  delete process.env.CONEKTA_PRIVATE_KEY;
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = prev.jwt || 'secreto-de-prueba';
  try {
    const r = await chargeCard({ token: 'tok_test_visa_4242', amount: '100.00', description: 'Servicio', customer: { nombre: 'A', correo: 'a@b.c' } });
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, true);
  } finally {
    if (prev.key !== undefined) process.env.CONEKTA_PRIVATE_KEY = prev.key;
    if (prev.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev.env;
    if (prev.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev.jwt;
  }
  const dev = await chargeCard({ token: 'tok_test_visa_4242', amount: '100.00', description: 'Servicio', customer: { nombre: 'A', correo: 'a@b.c' } });
  assert.equal(dev.ok, true);
  assert.equal(dev.modo, 'SANDBOX');
});

test('sin NODE_ENV el servidor se comporta como producción: sin cobros sandbox, secretos de respaldo ni códigos en consola', async () => {
  const { chargeCard } = require('../src/services/payments');
  const { sendMail, outbox } = require('../src/lib/mailer');
  const prev = { env: process.env.NODE_ENV, files: process.env.FILES_SECRET, jwt: process.env.JWT_SECRET };
  delete process.env.NODE_ENV;
  delete process.env.FILES_SECRET;
  delete process.env.JWT_SECRET;
  const enviados = outbox.length;
  try {
    const r = await chargeCard({ token: 'tok_test_visa_4242', amount: '100.00', description: 'Servicio', customer: { nombre: 'A', correo: 'a@b.c' } });
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, true);
    assert.throws(() => signFileUrl(1), /obligatorio/);
    await assert.rejects(sendMail({ to: 'a@b.c', subject: 'Código', html: '', code: '123456' }), (e) => e.code === 'MAIL_UNAVAILABLE');
    assert.equal(outbox.length, enviados);
  } finally {
    process.env.NODE_ENV = prev.env;
    process.env.FILES_SECRET = prev.files;
    process.env.JWT_SECRET = prev.jwt;
  }
});
