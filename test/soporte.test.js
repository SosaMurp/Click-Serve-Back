const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { resetDb, startServer, createUser, api, login, idem, closePool } = require('./helpers');
const realtime = require('../src/lib/realtime');

let server;
test.before(async () => { await resetDb(); server = await startServer(); });
test.after(async () => { await server.close(); await closePool(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function as(rol) {
  const u = await createUser({ rol, ...(rol === 2 ? { latitud: 17.96, longitud: -102.2, disponible: true } : {}) });
  return { ...u, token: await login(server.url, u) };
}

function wsUrl(token) {
  return `${server.url.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`;
}

function nextEvent(ws, name, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sin evento ${name}`)), timeoutMs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === name) { clearTimeout(timer); resolve(msg); }
    });
  });
}

test('ticket de soporte con folio y respuesta automática del asesor', async () => {
  const c = await as(1);
  const res = await api(server.url, 'POST', '/api/soporte/tickets', {
    token: c.token, body: { asunto: 'Cobro duplicado', categoria: 'PAGOS', mensaje: 'Me cobraron dos veces el servicio de ayer.' },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.ticket.folio, /^TCK-/);
  const msgs = await api(server.url, 'GET', `/api/soporte/tickets/${res.body.ticket.id_ticket}/mensajes`, { token: c.token });
  assert.equal(msgs.body.mensajes.length, 2);
  assert.equal(msgs.body.mensajes[1].es_asesor, true);
  const list = await api(server.url, 'GET', '/api/soporte/tickets', { token: c.token });
  assert.equal(list.body.tickets.length, 1);
});

test('nadie más puede leer el ticket de otra persona', async () => {
  const c = await as(1);
  const otro = await as(1);
  const t = await api(server.url, 'POST', '/api/soporte/tickets', { token: c.token, body: { asunto: 'Duda', categoria: 'OTRO', mensaje: 'Tengo una duda con mi cuenta.' } });
  assert.equal((await api(server.url, 'GET', `/api/soporte/tickets/${t.body.ticket.id_ticket}/mensajes`, { token: otro.token })).status, 404);
});

test('mensaje de soporte con adjunto y escalación del ticket', async () => {
  const c = await as(1);
  const t = await api(server.url, 'POST', '/api/soporte/tickets', { token: c.token, body: { asunto: 'Problema', categoria: 'SERVICIO', mensaje: 'El técnico dejó un desperfecto.' } });
  const id = t.body.ticket.id_ticket;
  const form = new FormData();
  form.append('mensaje', 'Adjunto la foto');
  form.append('adjunto', new Blob([PNG], { type: 'image/png' }), 'foto.png');
  const m = await api(server.url, 'POST', `/api/soporte/tickets/${id}/mensajes`, { token: c.token, form });
  assert.equal(m.status, 201);
  assert.match(m.body.mensaje.adjunto_url, /^\/api\/archivos\//);
  const esc = await api(server.url, 'POST', `/api/soporte/tickets/${id}/escalar`, { token: c.token });
  assert.equal(esc.body.ticket.estado, 'ESCALADO');
  assert.equal(esc.body.ticket.prioridad, 'ALTA');
});

test('escalar desde el chat del servicio crea ticket urgente e incidencia de seguridad', async () => {
  const c = await as(1);
  const t = await as(2);
  const s = (await api(server.url, 'POST', '/api/solicitudes', {
    token: c.token, headers: idem(),
    body: { categoria: 'CERRAJERIA', descripcion: 'Me quedé fuera de casa y necesito abrir.', direccion: 'Calle 1 #2, Centro' },
  })).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const res = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/escalar`, { token: c.token, body: { motivo: 'El técnico se comporta de forma agresiva.' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.ticket.prioridad, 'ALTA');
  assert.equal(res.body.incidencia.tipo, 'SEGURIDAD');
});

test('direcciones: crear, editar con PUT, predeterminada y borrar; ajenas devuelven 404', async () => {
  const c = await as(1);
  const otro = await as(1);
  const a = await api(server.url, 'POST', '/api/direcciones', { token: c.token, body: { etiqueta: 'Casa', calle: 'Av. Melchor Ocampo', numero: '45', colonia: 'Centro', cp: '60950', latitud: 17.95, longitud: -102.19 } });
  assert.equal(a.status, 201);
  assert.equal(a.body.direccion.predeterminada, true);
  const b = await api(server.url, 'POST', '/api/direcciones', { token: c.token, body: { etiqueta: 'Trabajo', calle: 'Blvd. Costero', numero: '10', colonia: 'Puerto', cp: '60954' } });
  const edit = await api(server.url, 'PUT', `/api/direcciones/${b.body.direccion.id_direccion}`, { token: c.token, body: { etiqueta: 'Oficina', calle: 'Blvd. Costero', numero: '12', colonia: 'Puerto', cp: '60954' } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.direccion.etiqueta, 'Oficina');
  assert.equal((await api(server.url, 'PUT', `/api/direcciones/${b.body.direccion.id_direccion}`, { token: otro.token, body: { calle: 'X', numero: '1' } })).status, 404);
  await api(server.url, 'PATCH', `/api/direcciones/${b.body.direccion.id_direccion}/predeterminada`, { token: c.token });
  const list = await api(server.url, 'GET', '/api/direcciones', { token: c.token });
  assert.deepEqual(list.body.direcciones.map((d) => [d.etiqueta, d.predeterminada]), [['Oficina', true], ['Casa', false]]);
  assert.equal((await api(server.url, 'DELETE', `/api/direcciones/${a.body.direccion.id_direccion}`, { token: c.token })).status, 200);
  assert.equal((await api(server.url, 'DELETE', `/api/direcciones/${a.body.direccion.id_direccion}`, { token: otro.token })).status, 404);
});

test('dirección sin calle se rechaza', async () => {
  const c = await as(1);
  const res = await api(server.url, 'POST', '/api/direcciones', { token: c.token, body: { etiqueta: 'Casa', calle: '' } });
  assert.equal(res.status, 400);
});

test('WebSocket: token inválido se rechaza', async () => {
  const ws = new WebSocket(wsUrl('basura'));
  const err = await new Promise((resolve) => { ws.on('error', resolve); ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)); });
  assert.ok(err === 401 || err instanceof Error);
});

test('WebSocket: el técnico recibe en tiempo real el mensaje del cliente', async () => {
  const c = await as(1);
  const t = await as(2);
  const s = (await api(server.url, 'POST', '/api/solicitudes', {
    token: c.token, headers: idem(),
    body: { categoria: 'PINTURA', descripcion: 'Pintar recámara de 3 por 4 metros.', direccion: 'Calle 3 #4, Centro' },
  })).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const ws = new WebSocket(wsUrl(t.token));
  await nextEvent(ws, 'conectado');
  const waiting = nextEvent(ws, 'chat.mensaje');
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/chat`, { token: c.token, body: { mensaje: '¿Trae su escalera?' } });
  const msg = await waiting;
  assert.equal(msg.data.mensaje, '¿Trae su escalera?');
  ws.close();
});

test('WebSocket: al cerrar la sesión se corta la conexión abierta', async () => {
  const c = await as(1);
  const ws = new WebSocket(wsUrl(c.token));
  await nextEvent(ws, 'conectado');
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  assert.equal((await api(server.url, 'POST', '/api/logout', { token: c.token })).status, 200);
  await realtime.revalidateSessions();
  const code = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('abierta'), 2000))]);
  assert.equal(code, 4401);
});
