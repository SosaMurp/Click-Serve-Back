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

test('sanitizeText elimina etiquetas HTML y recorta', () => {
  assert.equal(sanitizeText('  <script>alert(1)</script>Hola <b>mundo</b> '), 'alert(1)Hola mundo');
});
