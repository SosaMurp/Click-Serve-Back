const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startServer, createUser, api, login, closePool } = require('./helpers');

let server;
test.before(async () => { await resetDb(); server = await startServer(); });
test.after(async () => { await server.close(); await closePool(); });

test('sin token responde 401 AUTH_REQUIRED', async () => {
  const res = await api(server.url, 'GET', '/api/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
});

test('token mal formado responde 401 AUTH_INVALID', async () => {
  const res = await api(server.url, 'GET', '/api/me', { token: 'basura' });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'AUTH_INVALID');
});

test('token de una sesión cerrada responde 401 AUTH_REVOKED', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const out = await api(server.url, 'POST', '/api/logout', { token });
  assert.equal(out.status, 200);
  const res = await api(server.url, 'GET', '/api/me', { token });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'AUTH_REVOKED');
});

test('/api/me devuelve el perfil sin la contraseña', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const res = await api(server.url, 'GET', '/api/me', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.usuario.correo, user.email);
  assert.equal(res.body.usuario.contrasena, undefined);
  assert.equal(res.body.usuario.aprobado, true);
});

test('modo mantenimiento responde 503 MAINTENANCE', async () => {
  process.env.MAINTENANCE = '1';
  try {
    const res = await api(server.url, 'GET', '/api/me');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'MAINTENANCE');
  } finally {
    delete process.env.MAINTENANCE;
  }
});

test('el login se limita tras demasiados intentos fallidos', async () => {
  const user = await createUser();
  let last;
  for (let i = 0; i < 12; i += 1) {
    last = await api(server.url, 'POST', '/api/login', {
      body: { email: user.email, password: 'incorrecta' },
      headers: { 'X-Forwarded-For': '10.9.9.9' },
    });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'RATE_LIMITED');
});
