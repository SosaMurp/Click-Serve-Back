const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { resetDb, startServer, createUser, api, login, getPool, closePool } = require('./helpers');
const { saveFile } = require('../src/lib/files');

let server;
let fake;
let modelo = { match: true, distance: 0.31, confidence: 0.92 };
let recibidos = [];

test.before(async () => {
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      recibidos.push(Buffer.concat(chunks).toString('latin1'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(modelo));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  process.env.BIOMETRIC_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  await resetDb();
  server = await startServer();
});
test.after(async () => { await server.close(); await new Promise((r) => fake.close(r)); await closePool(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function tecnicoConRostro() {
  const u = await createUser({ rol: 2, aprobado: false });
  await getPool().query("UPDATE usuarios SET estado_cuenta = 'Activo' WHERE id_usuario = $1", [u.id]);
  const idArchivo = await saveFile(getPool(), { owner: u.id, buffer: Buffer.from('rostro-registro'), mime: 'image/png', name: 'rostro.png', categoria: 'ROSTRO' });
  await getPool().query("INSERT INTO documentos_usuario (id_usuario, tipo, id_archivo) VALUES ($1, 'ROSTRO', $2)", [u.id, idArchivo]);
  return { ...u, token: await login(server.url, u) };
}

function liveForm() {
  const form = new FormData();
  form.append('live_image', new Blob([PNG], { type: 'image/png' }), 'live.png');
  return form;
}

test('la comparación usa la foto del registro y NO aprueba la identidad (eso lo decide el administrador)', async () => {
  const t = await tecnicoConRostro();
  const v = await api(server.url, 'POST', '/api/biometria/solicitar', { token: t.token });
  assert.equal(v.status, 201);
  recibidos = [];
  const res = await api(server.url, 'POST', `/api/biometria/${v.body.verificacion.id_verificacion}/compare`, { token: t.token, form: liveForm() });
  assert.equal(res.status, 200);
  assert.equal(res.body.estado, 'APROBADO');
  assert.ok(recibidos[0].includes('rostro-registro'), 'se envió la referencia guardada, no una del cliente');
  const me = await api(server.url, 'GET', '/api/me', { token: t.token });
  assert.equal(me.body.usuario.biometria_estado, 'verificada');
  // Una selfie contra una foto que subió la misma persona no prueba identidad (hallazgo de seguridad H1).
  assert.equal(me.body.usuario.identidad_verificada, false);
  assert.equal(me.body.usuario.aprobado, false);
});

test('rostro que no coincide queda RECHAZADO y no aprueba', async () => {
  const t = await tecnicoConRostro();
  modelo = { match: false, distance: 0.8, confidence: 0.2 };
  const v = await api(server.url, 'POST', '/api/biometria/solicitar', { token: t.token });
  const res = await api(server.url, 'POST', `/api/biometria/${v.body.verificacion.id_verificacion}/compare`, { token: t.token, form: liveForm() });
  assert.equal(res.body.estado, 'RECHAZADO');
  const me = await api(server.url, 'GET', '/api/me', { token: t.token });
  assert.equal(me.body.usuario.aprobado, false);
  modelo = { match: true, distance: 0.31, confidence: 0.92 };
});

test('servicio biométrico caído responde 503 sin aprobar', async () => {
  const t = await tecnicoConRostro();
  const prev = process.env.BIOMETRIC_SERVICE_URL;
  process.env.BIOMETRIC_SERVICE_URL = 'http://127.0.0.1:1';
  try {
    const v = await api(server.url, 'POST', '/api/biometria/solicitar', { token: t.token });
    const res = await api(server.url, 'POST', `/api/biometria/${v.body.verificacion.id_verificacion}/compare`, { token: t.token, form: liveForm() });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'BIOMETRIC_UNAVAILABLE');
  } finally {
    process.env.BIOMETRIC_SERVICE_URL = prev;
  }
});
