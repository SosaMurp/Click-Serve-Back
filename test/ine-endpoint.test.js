const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startServer, api, getPool, closePool } = require('./helpers');
const fx = require('./fixtures/ine');
const { closeOcr } = require('../src/services/ineVerifier');

let server;
test.before(async () => { await resetDb(); server = await startServer(); });
test.after(async () => { await server.close(); await closeOcr(); await closePool(); });

const jpeg = (buf) => new Blob([buf], { type: 'image/jpeg' });

function verificar(lado, foto, { registro = fx.PERSONA, ticket } = {}) {
  const form = new FormData();
  form.append('lado', lado);
  form.append('nombre', registro.nombre);
  form.append('apellidos', registro.apellidos);
  form.append('fecha_nacimiento', registro.fecha_nacimiento);
  if (ticket) form.append('ticket_frente', ticket);
  form.append('foto', jpeg(foto), `${lado}.jpg`);
  return api(server.url, 'POST', '/api/ine/verificar', { form });
}

const check = (body, id) => body.comprobaciones.find((c) => c.id === id);

test('el frente de una INE con datos coherentes se acepta y devuelve un ticket', async () => {
  const res = await verificar('frente', await fx.frente());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, JSON.stringify(res.body.comprobaciones));
  assert.ok(res.body.ticket);
  assert.equal(res.body.datos.curp, fx.PERSONA.curp);
  assert.equal(res.body.datos.sexo, 'H');
});

test('una foto que no es una credencial se rechaza con un motivo claro', async () => {
  const res = await verificar('frente', await fx.otraFoto());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.motivo, /No reconocimos una credencial del INE/);
  assert.equal(res.body.ticket, undefined);
});

test('una foto borrosa se rechaza pidiendo que se tome quieta', async () => {
  const res = await verificar('frente', await fx.frenteBorroso());
  assert.equal(res.body.ok, false);
  assert.match(res.body.motivo, /borrosa/i);
});

test('un frente con la CURP alterada no pasa la comprobación de la CURP', async () => {
  const res = await verificar('frente', await fx.frente({ curp: 'PEGL850312HMNRRS09' }));
  assert.equal(res.body.ok, false);
  assert.equal(check(res.body, 'curp').ok, false);
});

test('si la fecha registrada no coincide se rechaza sin revelar los datos de la credencial', async () => {
  const res = await verificar('frente', await fx.frente(), { registro: { ...fx.PERSONA, fecha_nacimiento: '1990-01-01' } });
  assert.equal(res.body.ok, false);
  assert.equal(check(res.body, 'fecha_nacimiento').ok, false);
  assert.match(res.body.motivo, /no coinciden/);
  assert.equal(res.body.datos, undefined);
  assert.ok(!JSON.stringify(res.body).includes(fx.PERSONA.curp));
});

test('si el nombre registrado es de otra persona se rechaza', async () => {
  const res = await verificar('frente', await fx.frente(), { registro: { ...fx.PERSONA, nombre: 'Juan', apellidos: 'López Ruiz' } });
  assert.equal(res.body.ok, false);
  assert.equal(check(res.body, 'nombre').ok, false);
});

test('el reverso con su MRZ válida y el ticket del frente se acepta', async () => {
  const frente = await verificar('frente', await fx.frente());
  const res = await verificar('reverso', await fx.reverso(), { ticket: frente.body.ticket });
  assert.equal(res.body.ok, true, JSON.stringify(res.body.comprobaciones));
  assert.ok(res.body.ticket);
  assert.equal(res.body.datos.vigencia, '2033-12-31');
});

test('el reverso con un dígito de la MRZ alterado se rechaza', async () => {
  const frente = await verificar('frente', await fx.frente());
  const res = await verificar('reverso', await fx.reverso({ alterar: true }), { ticket: frente.body.ticket });
  assert.equal(res.body.ok, false);
  assert.equal(check(res.body, 'mrz').ok, false);
});

test('el reverso de otra persona no corresponde al frente', async () => {
  const frente = await verificar('frente', await fx.frente());
  const res = await verificar('reverso', await fx.reverso({ nacimiento: '900101', nombres: 'LOPEZ<RUIZ<<JUAN' }), { ticket: frente.body.ticket });
  assert.equal(res.body.ok, false);
  assert.match(res.body.motivo, /no corresponde/);
});

test('el reverso sin el ticket del frente se rechaza', async () => {
  const res = await verificar('reverso', await fx.reverso());
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'FRONT_REQUIRED');
});

async function registro(tickets, fotos) {
  const form = new FormData();
  const data = {
    nombre: fx.PERSONA.nombre, apellidos: fx.PERSONA.apellidos, telefono: '7531234567', email: `jose${Date.now()}${Math.random()}@prueba.test`,
    fechaNacimiento: fx.PERSONA.fecha_nacimiento, password: 'Segura#2026', perfil: '1', acepta_privacidad: 'true',
  };
  for (const [k, v] of Object.entries(data)) form.append(k, v);
  if (tickets) {
    form.append('ticket_ine_frente', tickets.frente);
    form.append('ticket_ine_reverso', tickets.reverso);
  }
  form.append('ine_frente', jpeg(fotos.frente), 'frente.jpg');
  form.append('ine_reverso', jpeg(fotos.reverso), 'reverso.jpg');
  form.append('rostro', jpeg(fotos.frente), 'rostro.jpg');
  return { res: await api(server.url, 'POST', '/api/register', { form }), email: data.email };
}

test('el registro sin la INE verificada se rechaza', async () => {
  const { res } = await registro(null, { frente: await fx.frente(), reverso: await fx.reverso() });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INE_NOT_VERIFIED');
});

test('el registro con tickets de otras imágenes se rechaza', async () => {
  const frente = await verificar('frente', await fx.frente());
  const reverso = await verificar('reverso', await fx.reverso(), { ticket: frente.body.ticket });
  const { res } = await registro({ frente: frente.body.ticket, reverso: reverso.body.ticket }, { frente: await fx.otraFoto(), reverso: await fx.reverso() });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INE_NOT_VERIFIED');
});

test('el registro con la INE verificada crea la cuenta y guarda las comprobaciones', async () => {
  const fotos = { frente: await fx.frente(), reverso: await fx.reverso() };
  const frente = await verificar('frente', fotos.frente);
  const reverso = await verificar('reverso', fotos.reverso, { ticket: frente.body.ticket });
  const { res } = await registro({ frente: frente.body.ticket, reverso: reverso.body.ticket }, fotos);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { rows } = await getPool().query('SELECT lado, curp, comprobaciones FROM verificaciones_ine WHERE id_usuario = $1 ORDER BY lado', [res.body.id_usuario]);
  assert.deepEqual(rows.map((r) => r.lado), ['frente', 'reverso']);
  assert.equal(rows[0].curp, fx.PERSONA.curp);
  assert.ok(rows[0].comprobaciones.every((c) => c.ok !== false));
});
