const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startServer, api, getPool, closePool } = require('./helpers');
const { seedDemo, CUENTAS } = require('../scripts/seed-demo');

let server;
test.before(async () => { await resetDb(); server = await startServer(); });
test.after(async () => { await server.close(); await closePool(); });

test('el seed crea las cuentas de prueba aprobadas y se puede correr dos veces', async () => {
  await seedDemo(getPool());
  await seedDemo(getPool());
  const { rows } = await getPool().query(
    'SELECT correo, id_rol, estado, estado_cuenta, identidad_verificada FROM usuarios WHERE correo = ANY($1) ORDER BY id_rol',
    [CUENTAS.map((c) => c.correo)]
  );
  assert.deepEqual(rows.map((r) => [r.correo, r.id_rol, r.estado, r.estado_cuenta, r.identidad_verificada]), [
    ['cliente.prueba@clickserve.test', 1, 'APROBADO', 'Activo', true],
    ['tecnico.prueba@clickserve.test', 2, 'APROBADO', 'Activo', true],
  ]);
});

test('las dos cuentas de prueba inician sesión con sus contraseñas de prueba', async () => {
  for (const c of CUENTAS) {
    const res = await api(server.url, 'POST', '/api/login', { body: { email: c.correo, password: c.password } });
    assert.equal(res.status, 200, `${c.correo}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.token);
    assert.equal(res.body.usuario.aprobado, true);
  }
});

test('el seed se niega a correr fuera de desarrollo', async () => {
  const antes = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(seedDemo(getPool()), /solo en desarrollo/);
  } finally {
    process.env.NODE_ENV = antes;
  }
});
