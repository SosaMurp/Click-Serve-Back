const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { resetDb, startServer, createUser, api, login, idem, getPool, closePool } = require('./helpers');

let server;
let fakeSep;
let sepResponse = { items: [] };

test.before(async () => {
  fakeSep = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(sepResponse)); });
  });
  await new Promise((r) => fakeSep.listen(0, r));
  process.env.SEP_URL = `http://127.0.0.1:${fakeSep.address().port}/cedula`;
  await resetDb();
  server = await startServer();
});
test.after(async () => { await server.close(); await new Promise((r) => fakeSep.close(r)); await closePool(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });
const futureExp = () => `12/${String((new Date().getFullYear() + 3) % 100).padStart(2, '0')}`;

async function as(rol, opts = {}) {
  const u = await createUser({ rol, ...(rol === 2 ? { latitud: 17.96, longitud: -102.2, disponible: true } : {}), ...opts });
  return { ...u, token: await login(server.url, u) };
}

async function saldo(idUsuario, monto) {
  await getPool().query(
    `INSERT INTO billetera_tecnico (id_usuario, saldo_actual) VALUES ($1, $2)
     ON CONFLICT (id_usuario) DO UPDATE SET saldo_actual = EXCLUDED.saldo_actual`,
    [idUsuario, monto]
  );
}

test('tarjeta: enviar número completo o CVV se rechaza (RNF-02)', async () => {
  const c = await as(1);
  const res = await api(server.url, 'POST', '/api/metodos-pago', { token: c.token, body: { numero_tarjeta: '4242424242424242', cvv: '123', titular: 'Ana', expiracion: futureExp() } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'PAN_NOT_ALLOWED');
});

test('tarjeta: se guarda solo el token; la primera queda como predeterminada', async () => {
  const c = await as(1);
  const a = await api(server.url, 'POST', '/api/metodos-pago', { token: c.token, body: { token: 'tok_test_visa_4242', marca: 'VISA', ultimos_4: '4242', expiracion: futureExp(), titular: 'Ana López' } });
  assert.equal(a.status, 201);
  assert.equal(a.body.metodo.predeterminada, true);
  assert.equal(a.body.metodo.token, undefined);
  const b = await api(server.url, 'POST', '/api/metodos-pago', { token: c.token, body: { token: 'tok_test_mastercard_4444', marca: 'MASTERCARD', ultimos_4: '4444', expiracion: futureExp(), titular: 'Ana López' } });
  assert.equal(b.body.metodo.predeterminada, false);
  await api(server.url, 'PATCH', `/api/metodos-pago/${b.body.metodo.id_metodo}/predeterminada`, { token: c.token });
  const list = await api(server.url, 'GET', '/api/metodos-pago', { token: c.token });
  assert.deepEqual(list.body.metodos.map((m) => [m.ultimos_4, m.predeterminada]), [['4444', true], ['4242', false]]);
  await api(server.url, 'DELETE', `/api/metodos-pago/${b.body.metodo.id_metodo}`, { token: c.token });
  const after = await api(server.url, 'GET', '/api/metodos-pago', { token: c.token });
  assert.equal(after.body.metodos[0].predeterminada, true);
});

test('tarjeta vencida se rechaza', async () => {
  const c = await as(1);
  const res = await api(server.url, 'POST', '/api/metodos-pago', { token: c.token, body: { token: 'tok_test_visa_4242', marca: 'VISA', ultimos_4: '4242', expiracion: '01/20', titular: 'Ana' } });
  assert.equal(res.status, 400);
});

test('CLABE con dígito verificador incorrecto se rechaza', async () => {
  const t = await as(2);
  const res = await api(server.url, 'PUT', '/api/billetera/clabe', { token: t.token, body: { clabe_interbancaria: '002010077777777770' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_CLABE');
});

test('CLABE válida se guarda y se devuelve enmascarada con el banco', async () => {
  const t = await as(2);
  const res = await api(server.url, 'PUT', '/api/billetera/clabe', { token: t.token, body: { clabe_interbancaria: '002010077777777771' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.billetera.clabe, '•••• •••• •••• 7771');
  assert.equal(res.body.billetera.banco, 'BANAMEX');
  assert.equal(JSON.stringify(res.body).includes('002010077777777771'), false);
});

test('retiro: requiere CLABE, mínimo $100 y saldo suficiente', async () => {
  const t = await as(2);
  await saldo(t.id, 500);
  const sinClabe = await api(server.url, 'POST', '/api/billetera/retiro', { token: t.token, headers: idem(), body: { monto: '200.00' } });
  assert.equal(sinClabe.body.code, 'CLABE_REQUIRED');
  await api(server.url, 'PUT', '/api/billetera/clabe', { token: t.token, body: { clabe_interbancaria: '002010077777777771' } });
  const minimo = await api(server.url, 'POST', '/api/billetera/retiro', { token: t.token, headers: idem(), body: { monto: '50.00' } });
  assert.equal(minimo.body.code, 'MIN_WITHDRAWAL');
  const excede = await api(server.url, 'POST', '/api/billetera/retiro', { token: t.token, headers: idem(), body: { monto: '900.00' } });
  assert.equal(excede.body.code, 'INSUFFICIENT_FUNDS');
});

test('retiro idempotente con comprobante y movimientos', async () => {
  const t = await as(2);
  const otro = await as(2);
  await saldo(t.id, 1420);
  await api(server.url, 'PUT', '/api/billetera/clabe', { token: t.token, body: { clabe_interbancaria: '002010077777777771' } });
  const headers = idem();
  const a = await api(server.url, 'POST', '/api/billetera/retiro', { token: t.token, headers, body: { monto: '420.00' } });
  const b = await api(server.url, 'POST', '/api/billetera/retiro', { token: t.token, headers, body: { monto: '420.00' } });
  assert.equal(a.status, 201);
  assert.deepEqual(b.body, a.body);
  assert.match(a.body.transaccion.folio, /^TRX-/);
  const wallet = await api(server.url, 'GET', '/api/billetera', { token: t.token });
  assert.equal(wallet.body.saldo_actual, '1000.0000');
  const movs = await api(server.url, 'GET', '/api/billetera/movimientos', { token: t.token });
  assert.equal(movs.body.movimientos.filter((m) => m.tipo === 'RETIRO').length, 1);
  const comp = await api(server.url, 'GET', `/api/billetera/movimientos/${a.body.transaccion.id_transaccion}`, { token: t.token });
  assert.equal(comp.status, 200);
  assert.equal(comp.body.comprobante.cuenta_destino, '•••• •••• •••• 7771');
  assert.equal(comp.body.comprobante.banco_destino, 'BANAMEX');
  assert.equal((await api(server.url, 'GET', `/api/billetera/movimientos/${a.body.transaccion.id_transaccion}`, { token: otro.token })).status, 404);
});

test('disponibilidad: el técnico aprobado se conecta; sin latido reciente deja de recomendarse', async () => {
  const t = await as(2, { disponible: false });
  const on = await api(server.url, 'PUT', '/api/tecnico/disponibilidad', { token: t.token, body: { disponible: true, latitud: 17.957, longitud: -102.199 } });
  assert.equal(on.status, 200);
  assert.equal(on.body.disponible, true);
  const c = await as(1);
  const s = await api(server.url, 'POST', '/api/solicitudes', {
    token: c.token, headers: idem(),
    body: { categoria: 'COMPUTO', descripcion: 'La computadora no enciende desde ayer.', direccion: 'Calle 5 #20, Centro', latitud: 17.958, longitud: -102.2 },
  });
  const rec = await api(server.url, 'GET', `/api/tecnicos/recomendados?id_solicitud=${s.body.solicitud.id_solicitud}`, { token: c.token });
  assert.equal(rec.body.tecnicos.some((x) => x.id_usuario === t.id), true);
  // Para el mapa del cliente solo viaja la posición redondeada (~1 km), nunca la exacta.
  const ficha = rec.body.tecnicos.find((x) => x.id_usuario === t.id);
  assert.equal(ficha.latitud_aprox, 17.96);
  assert.equal(ficha.longitud_aprox, -102.2);
  assert.equal(ficha.latitud, undefined);
  assert.equal(ficha.longitud, undefined);
  await getPool().query("UPDATE usuarios SET ultimo_latido = NOW() - INTERVAL '5 minutes' WHERE id_usuario = $1", [t.id]);
  const rec2 = await api(server.url, 'GET', `/api/tecnicos/recomendados?id_solicitud=${s.body.solicitud.id_solicitud}`, { token: c.token });
  assert.equal(rec2.body.tecnicos.some((x) => x.id_usuario === t.id), false);
  const latido = await api(server.url, 'POST', '/api/tecnico/latido', { token: t.token, body: { latitud: 17.957, longitud: -102.199 } });
  assert.equal(latido.status, 200);
});

test('un técnico pendiente no puede ponerse en línea', async () => {
  const t = await as(2, { aprobado: false });
  const res = await api(server.url, 'PUT', '/api/tecnico/disponibilidad', { token: t.token, body: { disponible: true } });
  assert.equal(res.status, 403);
});

test('resumen del panel con ganancias reales de la semana', async () => {
  const t = await as(2);
  await saldo(t.id, 0);
  const w = (await getPool().query('SELECT id_billetera FROM billetera_tecnico WHERE id_usuario = $1', [t.id])).rows[0];
  await getPool().query("INSERT INTO transacciones (id_billetera, monto, tipo, estado, folio, concepto) VALUES ($1, 943.00, 'INGRESO', 'COMPLETADO', 'TRX-T1', 'SERVICIO'), ($1, 100.00, 'INGRESO', 'COMPLETADO', 'TRX-T2', 'SERVICIO')", [w.id_billetera]);
  const res = await api(server.url, 'GET', '/api/tecnico/resumen', { token: t.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.ganancias_semana, '1043.00');
  assert.equal(typeof res.body.contadores.nuevas, 'number');
});

test('perfil público del técnico; un cliente no tiene perfil de técnico', async () => {
  const t = await as(2);
  const c = await as(1);
  const res = await api(server.url, 'GET', `/api/tecnicos/${t.id}/perfil`, { token: c.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.tecnico.nombre, 'Tecnico');
  assert.ok(Array.isArray(res.body.tecnico.resenas));
  assert.equal((await api(server.url, 'GET', `/api/tecnicos/${c.id}/perfil`, { token: c.token })).status, 404);
});

test('especialidades por categoría: agregar y desactivar alertas', async () => {
  const t = await as(2);
  const add = await api(server.url, 'POST', '/api/tecnico/especialidades', { token: t.token, body: { categoria: 'ELECTRICIDAD' } });
  assert.equal(add.status, 201);
  const off = await api(server.url, 'PATCH', `/api/tecnico/especialidades/${add.body.especialidad.id_especialidad}/toggle`, { token: t.token, body: { activa: false } });
  assert.equal(off.body.especialidad.activa, false);
  const list = await api(server.url, 'GET', '/api/tecnico/especialidades', { token: t.token });
  assert.deepEqual(list.body.especialidades.map((e) => [e.categoria, e.activa]), [['ELECTRICIDAD', false]]);
});

test('portafolio: subir y borrar evidencias propias', async () => {
  const t = await as(2);
  const form = new FormData();
  form.append('foto', png(), 'obra.png');
  form.append('titulo', 'Instalación de centro de carga');
  const add = await api(server.url, 'POST', '/api/tecnico/portafolio', { token: t.token, form });
  assert.equal(add.status, 201);
  const list = await api(server.url, 'GET', '/api/tecnico/portafolio', { token: t.token });
  assert.match(list.body.portafolio[0].url, /^\/api\/archivos\//);
  assert.equal((await api(server.url, 'DELETE', `/api/tecnico/portafolio/${add.body.item.id_item}`, { token: t.token })).status, 200);
});

test('documentos: carga de certificación queda en revisión', async () => {
  const t = await as(2);
  const form = new FormData();
  form.append('archivo', png(), 'cert.png');
  form.append('tipo', 'CERTIFICACION');
  form.append('descripcion', 'CompTIA A+');
  const res = await api(server.url, 'POST', '/api/tecnico/documentos', { token: t.token, form });
  assert.equal(res.status, 201);
  assert.equal(res.body.documento.estado, 'EN_REVISION');
});

test('cédula SEP: coincide el nombre → insignia; no coincide → 400', async () => {
  const t = await as(2, { nombre: 'Roberto' });
  sepResponse = { items: [{ nombre: 'ROBERTO', paterno: 'PRUEBA', materno: 'X', titulo: 'INGENIERO ELECTRICISTA' }] };
  const ok = await api(server.url, 'POST', '/api/tecnicos/validar-cedula', { token: t.token, body: { cedula: '1234567' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verificado_sep, true);
  sepResponse = { items: [] };
  const no = await api(server.url, 'POST', '/api/tecnicos/validar-cedula', { token: t.token, body: { cedula: '7654321' } });
  assert.equal(no.status, 400);
  assert.equal(no.body.code, 'SEP_NO_MATCH');
});

test('cédula SEP: un técnico sin identidad verificada no puede validarla', async () => {
  const t = await as(2, { aprobado: false });
  sepResponse = { items: [{ nombre: 'TECNICO', paterno: 'PRUEBA', materno: 'X', titulo: 'INGENIERO' }] };
  const res = await api(server.url, 'POST', '/api/tecnicos/validar-cedula', { token: t.token, body: { cedula: '1234567' } });
  assert.equal(res.status, 403);
  const row = await getPool().query('SELECT verificado_sep FROM usuarios WHERE id_usuario = $1', [t.id]);
  assert.equal(row.rows[0].verificado_sep, false);
});

test('cédula SEP: servicio caído responde 503 sin aprobar por formato', async () => {
  const t = await as(2);
  const prev = process.env.SEP_URL;
  process.env.SEP_URL = 'http://127.0.0.1:1/cedula';
  try {
    const res = await api(server.url, 'POST', '/api/tecnicos/validar-cedula', { token: t.token, body: { cedula: '1234567' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'SEP_UNAVAILABLE');
    const row = await getPool().query('SELECT verificado_sep FROM usuarios WHERE id_usuario = $1', [t.id]);
    assert.equal(row.rows[0].verificado_sep, false);
  } finally {
    process.env.SEP_URL = prev;
  }
});

test('ubicación del técnico en camino llega al detalle del cliente', async () => {
  const c = await as(1);
  const t = await as(2);
  const s = (await api(server.url, 'POST', '/api/solicitudes', {
    token: c.token, headers: idem(),
    body: { categoria: 'PLOMERIA', descripcion: 'Fuga en el lavabo del baño principal.', direccion: 'Calle 8 #3, Centro', latitud: 17.958, longitud: -102.2 },
  })).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  await api(server.url, 'PATCH', `/api/solicitudes/${s.id_solicitud}/estado`, { token: t.token, body: { estado: 'EN_CAMINO' } });
  await api(server.url, 'PUT', '/api/usuarios/ubicacion', { token: t.token, body: { latitud: 17.97, longitud: -102.21 } });
  const det = await api(server.url, 'GET', `/api/solicitudes/${s.id_solicitud}`, { token: c.token });
  assert.equal(det.body.solicitud.tecnico_ubicacion.latitud, 17.97);
  assert.ok(det.body.solicitud.tecnico_ubicacion.eta_min >= 1);
});

test('aprobación de técnicos solo para administradores', async () => {
  const t = await as(2, { aprobado: false });
  const c = await as(1);
  assert.equal((await api(server.url, 'PATCH', `/api/admin/usuarios/${t.id}/aprobar`, { token: c.token })).status, 403);
  const admin = await createUser({ rol: 3 });
  const adminToken = (await getPool().query("INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, 3, 'test') RETURNING id_sesion", [admin.id])).rows[0].id_sesion;
  const { signSession } = require('../src/lib/tokens');
  const token = signSession({ id_usuario: admin.id, id_rol: 3, version_sesion: 1, sessionId: adminToken });
  const ok = await api(server.url, 'PATCH', `/api/admin/usuarios/${t.id}/aprobar`, { token });
  assert.equal(ok.status, 200);
  const me = await api(server.url, 'GET', '/api/me', { token: t.token });
  assert.equal(me.body.usuario.aprobado, true);
});

test('técnicos cercanos: solo disponibles y con ubicación aproximada', async () => {
  const c = await as(1);
  const t = await as(2);
  await api(server.url, 'PUT', '/api/tecnico/disponibilidad', { token: t.token, body: { disponible: true, latitud: 17.95678, longitud: -102.19876 } });
  const res = await api(server.url, 'GET', '/api/tecnicos/cercanos?latitud=17.958&longitud=-102.2', { token: c.token });
  assert.equal(res.status, 200);
  const found = res.body.tecnicos.find((x) => x.id_usuario === t.id);
  assert.ok(found);
  assert.equal(found.latitud, 17.96);
  assert.equal(found.telefono, undefined);
});
