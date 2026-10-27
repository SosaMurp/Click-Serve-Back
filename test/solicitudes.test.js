const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startServer, createUser, api, login, idem, getPool, closePool } = require('./helpers');

let server;
test.before(async () => { await resetDb(); server = await startServer(); });
test.after(async () => { await server.close(); await closePool(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function cliente(opts = {}) {
  const u = await createUser({ rol: 1, ...opts });
  return { ...u, token: await login(server.url, u) };
}

async function tecnico(opts = {}) {
  const u = await createUser({ rol: 2, latitud: 17.96, longitud: -102.2, disponible: true, ...opts });
  return { ...u, token: await login(server.url, u) };
}

async function crearSolicitud(token, body = {}, headers = idem()) {
  return api(server.url, 'POST', '/api/solicitudes', {
    token,
    headers,
    body: {
      categoria: 'ELECTRICIDAD',
      descripcion: 'El contacto de la cocina hace chispa al conectar aparatos.',
      direccion: 'Av. Lázaro Cárdenas 120, Centro, Lázaro Cárdenas',
      fecha_preferida: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      hora_preferida: '10:30',
      latitud: 17.958,
      longitud: -102.199,
      ...body,
    },
  });
}

async function tarjeta(clienteId, token = 'tok_test_visa_4242', ultimos = '4242') {
  const { rows } = await getPool().query(
    `INSERT INTO metodos_pago (id_usuario, titular, ultimos_4, expiracion, token, marca, predeterminada)
     VALUES ($1, 'Cliente Prueba', $2, '12/30', $3, 'VISA', true) RETURNING id_metodo`,
    [clienteId, ultimos, token]
  );
  return rows[0].id_metodo;
}

// Lleva una solicitud hasta EN_PROCESO con una cotización de $800 + $360 = $1,160.
async function hastaEnProceso() {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  const id = s.id_solicitud;
  assert.equal((await api(server.url, 'POST', `/api/solicitudes/${id}/aceptar`, { token: t.token })).status, 200);
  assert.equal((await api(server.url, 'PATCH', `/api/solicitudes/${id}/estado`, { token: t.token, body: { estado: 'EN_CAMINO' } })).status, 200);
  assert.equal((await api(server.url, 'PATCH', `/api/solicitudes/${id}/estado`, { token: t.token, body: { estado: 'EN_SITIO' } })).status, 200);
  const cot = await api(server.url, 'POST', `/api/solicitudes/${id}/cotizar`, {
    token: t.token,
    body: {
      conceptos: [
        { tipo: 'MANO_OBRA', descripcion: 'Cambio de contacto y revisión de línea', monto: '800.00' },
        { tipo: 'MATERIAL', descripcion: 'Contacto dúplex con tierra', monto: '360.00' },
      ],
      detalles: 'Incluye prueba de continuidad',
      minutos: 60,
    },
  });
  assert.equal(cot.status, 200);
  assert.equal(cot.body.solicitud.estado, 'ESPERANDO_APROBACION');
  assert.equal(cot.body.cotizacion.monto_total, '1160.0000');
  const ok = await api(server.url, 'PATCH', `/api/solicitudes/${id}/responder-cotizacion`, { token: c.token, body: { respuesta: 'ACEPTAR' } });
  assert.equal(ok.body.solicitud.estado, 'EN_PROCESO');
  return { c, t, id };
}

async function subirEvidencia(token, id) {
  const form = new FormData();
  form.append('fotos', new Blob([PNG], { type: 'image/png' }), 'despues.png');
  form.append('tipo', 'DESPUES');
  return api(server.url, 'POST', `/api/solicitudes/${id}/evidencias`, { token, form });
}

test('una cotización de la versión anterior (sin desglose) regresa a EN_SITIO para reenviarse', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  // Así dejaba la orden la ruta anterior: solo el estado y el monto, sin fila en cotizaciones_servicio.
  await getPool().query("UPDATE solicitudes_servicio SET estado = 'ESPERANDO_APROBACION', monto_cotizacion = 500 WHERE id_solicitud = $1", [s.id_solicitud]);
  const res = await api(server.url, 'PATCH', `/api/solicitudes/${s.id_solicitud}/responder-cotizacion`, { token: c.token, body: { respuesta: 'ACEPTAR' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'QUOTE_OUTDATED');
  const row = await getPool().query('SELECT estado FROM solicitudes_servicio WHERE id_solicitud = $1', [s.id_solicitud]);
  assert.equal(row.rows[0].estado, 'EN_SITIO');
});

test('si el folio generado ya existe, se genera otro en vez de fallar', async () => {
  const S = require('../src/services/solicitudes');
  const c = await cliente();
  const original = S.folio;
  const primera = (await crearSolicitud(c.token)).body.solicitud;
  let llamadas = 0;
  S.folio = (prefix) => (prefix === 'SRV' && (llamadas += 1) === 1 ? primera.folio : original(prefix));
  try {
    const res = await crearSolicitud(c.token);
    assert.equal(res.status, 201);
    assert.notEqual(res.body.solicitud.folio, primera.folio);
  } finally {
    S.folio = original;
  }
});

test('un técnico suspendido no se puede proponer y su latido lo deja fuera de línea', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await getPool().query("UPDATE usuarios SET estado_cuenta = 'SUSPENDIDO' WHERE id_usuario = $1", [t.id]);
  const prop = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/proponer-tecnico`, { token: c.token, body: { id_tecnico: t.id } });
  assert.equal(prop.status, 409);
  assert.equal(prop.body.code, 'TECH_UNAVAILABLE');
  const cerca = await api(server.url, 'GET', '/api/tecnicos/cercanos?latitud=17.96&longitud=-102.2', { token: c.token });
  assert.equal(cerca.body.tecnicos.some((x) => x.id_usuario === t.id), false);
  const latido = await api(server.url, 'POST', '/api/tecnico/latido', { token: t.token, body: {} });
  assert.equal(latido.body.disponible, false);
});

test('programar para hoy a una hora que ya pasó se rechaza; hoy en México sí se acepta', async () => {
  const { nowMx } = require('../src/lib/dates');
  const c = await cliente();
  const ahora = nowMx();
  if (ahora.hora !== '00:00') {
    const pasada = await crearSolicitud(c.token, { fecha_preferida: ahora.fecha, hora_preferida: '00:00' });
    assert.equal(pasada.status, 400);
    assert.equal(pasada.body.field, 'hora_preferida');
  }
  if (ahora.hora < '23:58') {
    const luego = await crearSolicitud(c.token, { fecha_preferida: ahora.fecha, hora_preferida: '23:59' });
    assert.equal(luego.status, 201);
  }
});

test('un cliente pendiente de aprobación no puede crear solicitudes', async () => {
  const c = await cliente({ aprobado: false });
  const res = await crearSolicitud(c.token);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ACCOUNT_PENDING');
});

test('un técnico pendiente de aprobación no puede aceptar', async () => {
  const c = await cliente();
  const t = await tecnico({ aprobado: false });
  const s = (await crearSolicitud(c.token)).body.solicitud;
  const res = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ACCOUNT_PENDING');
});

test('crear solicitud dos veces con la misma clave genera una sola', async () => {
  const c = await cliente();
  const headers = idem();
  const a = await crearSolicitud(c.token, {}, headers);
  const b = await crearSolicitud(c.token, {}, headers);
  assert.equal(a.status, 201);
  assert.equal(b.body.solicitud.id_solicitud, a.body.solicitud.id_solicitud);
  const n = await getPool().query('SELECT COUNT(*)::int AS n FROM solicitudes_servicio WHERE id_usuario = $1', [c.id]);
  assert.equal(n.rows[0].n, 1);
});

test('descripción vacía o categoría inexistente se rechazan', async () => {
  const c = await cliente();
  assert.equal((await crearSolicitud(c.token, { descripcion: ' ' })).status, 400);
  assert.equal((await crearSolicitud(c.token, { categoria: 'NADA' })).status, 400);
});

test('dos técnicos aceptan a la vez: solo uno obtiene la solicitud', async () => {
  const c = await cliente();
  const [t1, t2] = await Promise.all([tecnico(), tecnico()]);
  const s = (await crearSolicitud(c.token)).body.solicitud;
  const [r1, r2] = await Promise.all([
    api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t1.token }),
    api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t2.token }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
});

test('descartar oculta la solicitud solo para ese técnico', async () => {
  const c = await cliente();
  const [t1, t2] = await Promise.all([tecnico(), tecnico()]);
  const s = (await crearSolicitud(c.token)).body.solicitud;
  assert.equal((await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/descartar`, { token: t1.token })).status, 200);
  const n1 = await api(server.url, 'GET', '/api/solicitudes/tecnico?vista=nuevas', { token: t1.token });
  const n2 = await api(server.url, 'GET', '/api/solicitudes/tecnico?vista=nuevas', { token: t2.token });
  assert.equal(n1.body.solicitudes.some((x) => x.id_solicitud === s.id_solicitud), false);
  assert.equal(n2.body.solicitudes.some((x) => x.id_solicitud === s.id_solicitud), true);
  const estado = await getPool().query('SELECT estado FROM solicitudes_servicio WHERE id_solicitud = $1', [s.id_solicitud]);
  assert.equal(estado.rows[0].estado, 'PENDIENTE');
});

test('el técnico no asignado no ve el teléfono ni la dirección exacta; el asignado sí', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  const antes = await api(server.url, 'GET', `/api/solicitudes/${s.id_solicitud}`, { token: t.token });
  assert.equal(antes.status, 200);
  assert.equal(antes.body.solicitud.cliente_telefono, undefined);
  assert.equal(antes.body.solicitud.direccion, undefined);
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const despues = await api(server.url, 'GET', `/api/solicitudes/${s.id_solicitud}`, { token: t.token });
  assert.equal(despues.body.solicitud.cliente_telefono, '2220000000');
  assert.match(despues.body.solicitud.direccion, /Lázaro Cárdenas 120/);
  assert.ok(despues.body.solicitud.tareas.length > 0, 'se cargan tareas de plantilla');
});

test('otro cliente no puede ver una solicitud ajena', async () => {
  const c = await cliente();
  const otro = await cliente();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  const res = await api(server.url, 'GET', `/api/solicitudes/${s.id_solicitud}`, { token: otro.token });
  assert.equal(res.status, 404);
});

test('finalizar sin evidencia se rechaza y con evidencia pasa a POR_CONFIRMAR', async () => {
  const { t, id } = await hastaEnProceso();
  const sin = await api(server.url, 'POST', `/api/solicitudes/${id}/finalizar`, { token: t.token, headers: idem() });
  assert.equal(sin.status, 400);
  assert.equal(sin.body.code, 'EVIDENCE_REQUIRED');
  assert.equal((await subirEvidencia(t.token, id)).status, 201);
  const fin = await api(server.url, 'POST', `/api/solicitudes/${id}/finalizar`, { token: t.token, headers: idem() });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.solicitud.estado, 'POR_CONFIRMAR');
});

test('confirmar y pagar: un solo cobro, total del servidor y liquidación con retenciones', async () => {
  const { c, t, id } = await hastaEnProceso();
  await subirEvidencia(t.token, id);
  await api(server.url, 'POST', `/api/solicitudes/${id}/finalizar`, { token: t.token, headers: idem() });
  const metodo = await tarjeta(c.id);
  const headers = idem();
  const body = { id_metodo: metodo, monto: '1.00', calificacion: 5, comentario: 'Muy profesional' };
  const a = await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers, body });
  const b = await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers, body });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.solicitud.estado, 'FINALIZADA');
  assert.equal(a.body.pago.monto, '1160.0000');
  assert.deepEqual(a.body.desglose, { total: '1160.00', comision: '116.00', base: '1000.00', retencion_isr: '21.00', retencion_iva: '80.00', neto_tecnico: '943.00' });
  const pagos = await getPool().query('SELECT COUNT(*)::int AS n FROM pagos WHERE id_solicitud = $1', [id]);
  assert.equal(pagos.rows[0].n, 1);
  const saldo = await getPool().query('SELECT saldo_actual FROM billetera_tecnico WHERE id_usuario = $1', [t.id]);
  assert.equal(saldo.rows[0].saldo_actual, '943.0000');
  const garantia = await getPool().query('SELECT garantia_hasta - CURRENT_DATE AS dias FROM solicitudes_servicio WHERE id_solicitud = $1', [id]);
  assert.equal(garantia.rows[0].dias, 90);
});

test('tarjeta declinada responde 402 y la orden sigue por confirmar', async () => {
  const { c, t, id } = await hastaEnProceso();
  await subirEvidencia(t.token, id);
  await api(server.url, 'POST', `/api/solicitudes/${id}/finalizar`, { token: t.token, headers: idem() });
  const metodo = await tarjeta(c.id, 'tok_test_card_declined', '0002');
  const res = await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers: idem(), body: { id_metodo: metodo } });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'PAYMENT_DECLINED');
  const row = await getPool().query('SELECT estado FROM solicitudes_servicio WHERE id_solicitud = $1', [id]);
  assert.equal(row.rows[0].estado, 'POR_CONFIRMAR');
});

test('tras un rechazo, el reintento con otra tarjeta y la misma clave sí cobra', async () => {
  const { c, t, id } = await hastaEnProceso();
  await subirEvidencia(t.token, id);
  await api(server.url, 'POST', `/api/solicitudes/${id}/finalizar`, { token: t.token, headers: idem() });
  const mala = await tarjeta(c.id, 'tok_test_card_declined', '0002');
  const buena = await tarjeta(c.id);
  const headers = idem();
  const rechazo = await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers, body: { id_metodo: mala } });
  assert.equal(rechazo.status, 402);
  const pago = await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers, body: { id_metodo: buena } });
  assert.equal(pago.status, 200);
  assert.equal(pago.body.solicitud.estado, 'FINALIZADA');
});

test('si la pasarela no confirma el cobro, la orden queda en PROCESANDO y un reintento no vuelve a cobrar', async () => {
  const { c, t, id } = await hastaEnProceso();
  await subirEvidencia(t.token, id);
  await api(server.url, 'POST', `/api/solicitudes/${id}/finalizar`, { token: t.token, headers: idem() });
  const metodo = await tarjeta(c.id);
  const realFetch = global.fetch;
  let cobros = 0;
  // Conekta recibe la orden pero la respuesta no llega a tiempo: no se sabe si se cobró.
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.conekta.io')) {
      cobros += 1;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    return realFetch(url, opts);
  };
  process.env.CONEKTA_PRIVATE_KEY = 'key_prueba';
  try {
    const a = await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers: idem(), body: { id_metodo: metodo } });
    assert.equal(a.status, 503);
    assert.equal(a.body.code, 'PAYMENT_UNCERTAIN');
    const b = await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers: idem(), body: { id_metodo: metodo } });
    assert.equal(b.status, 409);
    assert.equal(b.body.code, 'PAYMENT_IN_PROGRESS');
    assert.equal(cobros, 1);
    const row = await getPool().query('SELECT estado, estado_pago FROM solicitudes_servicio WHERE id_solicitud = $1', [id]);
    assert.deepEqual(row.rows[0], { estado: 'POR_CONFIRMAR', estado_pago: 'PROCESANDO' });
  } finally {
    global.fetch = realFetch;
    delete process.env.CONEKTA_PRIVATE_KEY;
  }
});

test('concepto extra durante el trabajo recalcula el total en el servidor', async () => {
  const { t, id } = await hastaEnProceso();
  const res = await api(server.url, 'POST', `/api/solicitudes/${id}/conceptos`, {
    token: t.token, body: { tipo: 'EXTRA', descripcion: 'Pastilla termomagnética 20A', monto: '185.50' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.solicitud.monto_total, '1345.5000');
});

test('monto con más de dos decimales o negativo se rechaza', async () => {
  const { t, id } = await hastaEnProceso();
  for (const monto of ['10.123', '-5', 'abc']) {
    const res = await api(server.url, 'POST', `/api/solicitudes/${id}/conceptos`, { token: t.token, body: { tipo: 'EXTRA', descripcion: 'X', monto } });
    assert.equal(res.status, 400, `monto ${monto}`);
  }
});

test('el cliente cancela sin cargo antes de iniciar el trabajo; después ya no', async () => {
  const c = await cliente();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  const res = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/cancelar`, { token: c.token, body: { motivo: 'Ya no lo necesito' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.solicitud.estado, 'CANCELADA');
  assert.equal(res.body.solicitud.estado_pago, 'NO_APLICA');
  const { c: c2, id } = await hastaEnProceso();
  const tarde = await api(server.url, 'POST', `/api/solicitudes/${id}/cancelar`, { token: c2.token, body: { motivo: 'x' } });
  assert.equal(tarde.status, 409);
});

test('el técnico cancela en ruta: la solicitud vuelve a buscar técnico sin él', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  await api(server.url, 'PATCH', `/api/solicitudes/${s.id_solicitud}/estado`, { token: t.token, body: { estado: 'EN_CAMINO' } });
  const sinMotivo = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/cancelar`, { token: t.token, body: {} });
  assert.equal(sinMotivo.status, 400);
  const res = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/cancelar`, { token: t.token, body: { motivo: 'Se descompuso mi vehículo' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.solicitud.estado, 'PENDIENTE');
  assert.equal(res.body.solicitud.id_tecnico, null);
  const nuevas = await api(server.url, 'GET', '/api/solicitudes/tecnico?vista=nuevas', { token: t.token });
  assert.equal(nuevas.body.solicitudes.some((x) => x.id_solicitud === s.id_solicitud), false);
});

test('incidencia "no se presentó" suspende la orden; reasignar y cancelar sin cargo', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const inc = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/incidencias`, {
    token: c.token, body: { tipo: 'NO_SE_PRESENTO', descripcion: 'Esperé dos horas y nunca llegó.' },
  });
  assert.equal(inc.status, 201);
  assert.match(inc.body.incidencia.folio, /^INC-/);
  assert.equal(inc.body.solicitud.estado, 'SUSPENDIDA');
  const reasignar = await api(server.url, 'POST', `/api/incidencias/${inc.body.incidencia.id_incidencia}/resolver`, { token: c.token, body: { accion: 'REASIGNAR' } });
  assert.equal(reasignar.body.solicitud.estado, 'PENDIENTE');
  assert.equal(reasignar.body.solicitud.id_tecnico, null);

  const t2 = await tecnico();
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t2.token });
  const inc2 = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/incidencias`, {
    token: c.token, body: { tipo: 'NO_SE_PRESENTO', descripcion: 'Tampoco llegó el segundo técnico.' },
  });
  const cancelar = await api(server.url, 'POST', `/api/incidencias/${inc2.body.incidencia.id_incidencia}/resolver`, { token: c.token, body: { accion: 'CANCELAR' } });
  assert.equal(cancelar.body.solicitud.estado, 'CANCELADA');
  assert.equal(cancelar.body.solicitud.estado_pago, 'NO_APLICA');
});

test('el cliente no puede cerrar el SOS ni retirar el reporte que hizo el técnico', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const sos = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/sos`, { token: t.token, headers: idem(), body: { latitud: 17.95, longitud: -102.2 } });
  assert.equal(sos.status, 200);
  const cerrarSos = await api(server.url, 'POST', `/api/incidencias/${sos.body.incidencia.id_incidencia}/resolver`, { token: c.token, body: { accion: 'CONTINUAR' } });
  assert.equal(cerrarSos.status, 403);
  const abierta = await getPool().query('SELECT estado FROM incidencias WHERE id_incidencia = $1', [sos.body.incidencia.id_incidencia]);
  assert.equal(abierta.rows[0].estado, 'ABIERTA');

  const rep = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/incidencias`, {
    token: t.token, body: { tipo: 'OTRO', descripcion: 'El domicilio no coincide con la dirección indicada.' },
  });
  const retirar = await api(server.url, 'POST', `/api/incidencias/${rep.body.incidencia.id_incidencia}/resolver`, { token: c.token, body: { accion: 'CONTINUAR' } });
  assert.equal(retirar.status, 403);
  const propio = await api(server.url, 'POST', `/api/incidencias/${rep.body.incidencia.id_incidencia}/resolver`, { token: t.token, body: { accion: 'CONTINUAR' } });
  assert.equal(propio.status, 200);
  assert.equal(propio.body.solicitud.estado, 'ASIGNADA');
});

test('reprogramación: el técnico propone, el cliente contrapropone y el técnico acepta', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const manana = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const pasado = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const prop = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/reprogramaciones`, {
    token: t.token, body: { fecha: manana, hora: '16:00', motivo: 'Me surgió una urgencia' },
  });
  assert.equal(prop.status, 201);
  const contra = await api(server.url, 'PATCH', `/api/reprogramaciones/${prop.body.reprogramacion.id_reprogramacion}`, {
    token: c.token, body: { respuesta: 'RECHAZAR', contrapropuesta: { fecha: pasado, hora: '09:00' } },
  });
  assert.equal(contra.status, 200);
  const nueva = contra.body.contrapropuesta;
  const ok = await api(server.url, 'PATCH', `/api/reprogramaciones/${nueva.id_reprogramacion}`, { token: t.token, body: { respuesta: 'ACEPTAR' } });
  assert.equal(ok.status, 200);
  const row = await getPool().query("SELECT to_char(fecha_preferida, 'YYYY-MM-DD') AS f, to_char(hora_preferida, 'HH24:MI') AS h FROM solicitudes_servicio WHERE id_solicitud = $1", [s.id_solicitud]);
  assert.deepEqual(row.rows[0], { f: pasado, h: '09:00' });
});

test('quien propuso no puede aceptar su propia reprogramación', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const fecha = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const prop = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/reprogramaciones`, { token: t.token, body: { fecha, hora: '12:00' } });
  const res = await api(server.url, 'PATCH', `/api/reprogramaciones/${prop.body.reprogramacion.id_reprogramacion}`, { token: t.token, body: { respuesta: 'ACEPTAR' } });
  assert.equal(res.status, 403);
});

test('calificación bidireccional queda en una sola fila', async () => {
  const { c, t, id } = await hastaEnProceso();
  await subirEvidencia(t.token, id);
  await api(server.url, 'POST', `/api/solicitudes/${id}/finalizar`, { token: t.token, headers: idem() });
  await api(server.url, 'POST', `/api/solicitudes/${id}/confirmar`, { token: c.token, headers: idem(), body: { id_metodo: await tarjeta(c.id) } });
  assert.equal((await api(server.url, 'POST', `/api/solicitudes/${id}/calificar`, { token: c.token, body: { calificacion: 4, comentario: 'Bien' } })).status, 200);
  assert.equal((await api(server.url, 'POST', `/api/solicitudes/${id}/calificar-cliente`, { token: t.token, body: { calificacion: 5, comentario: 'Cliente amable' } })).status, 200);
  const row = await getPool().query('SELECT puntuacion_tecnico, puntuacion_cliente FROM calificaciones_servicio WHERE id_solicitud = $1', [id]);
  assert.deepEqual(row.rows[0], { puntuacion_tecnico: 4, puntuacion_cliente: 5 });
});

test('chat: solo participantes; los adjuntos llegan con URL firmada', async () => {
  const c = await cliente();
  const t = await tecnico();
  const intruso = await cliente();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  assert.equal((await api(server.url, 'GET', `/api/solicitudes/${s.id_solicitud}/chat`, { token: intruso.token })).status, 403);
  const form = new FormData();
  form.append('mensaje', 'Así se ve el contacto');
  form.append('adjunto', new Blob([PNG], { type: 'image/png' }), 'foto.png');
  const sent = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/chat`, { token: c.token, form });
  assert.equal(sent.status, 201);
  const list = await api(server.url, 'GET', `/api/solicitudes/${s.id_solicitud}/chat`, { token: t.token });
  assert.match(list.body.mensajes[0].adjunto_url, /^\/api\/archivos\/\d+\?exp=/);
  assert.equal(list.body.mensajes[0].mensaje, 'Así se ve el contacto');
});

test('SOS con la misma clave registra una sola alerta e incidencia de seguridad', async () => {
  const c = await cliente();
  const t = await tecnico();
  const s = (await crearSolicitud(c.token)).body.solicitud;
  await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/aceptar`, { token: t.token });
  const headers = idem();
  const body = { latitud: 17.95, longitud: -102.19 };
  const a = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/sos`, { token: c.token, headers, body });
  const b = await api(server.url, 'POST', `/api/solicitudes/${s.id_solicitud}/sos`, { token: c.token, headers, body });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const n = await getPool().query("SELECT COUNT(*)::int AS n FROM incidencias WHERE id_solicitud = $1 AND tipo = 'SEGURIDAD'", [s.id_solicitud]);
  assert.equal(n.rows[0].n, 1);
});

test('NUEVAS incluye la distancia y los contadores del panel', async () => {
  const c = await cliente();
  const t = await tecnico();
  await crearSolicitud(c.token);
  const res = await api(server.url, 'GET', '/api/solicitudes/tecnico?vista=nuevas', { token: t.token });
  assert.equal(res.status, 200);
  assert.ok(res.body.solicitudes[0].distancia_km !== undefined);
  assert.equal(typeof res.body.contadores.nuevas, 'number');
});

test('las fotos de la solicitud se sirven con URL firmada (sin cabecera de sesión)', async () => {
  const c = await cliente();
  const form = new FormData();
  form.append('categoria', 'PLOMERIA');
  form.append('descripcion', 'Gotea la llave del fregadero de la cocina.');
  form.append('direccion', 'Calle 9 #12, Centro');
  form.append('imagenes', new Blob([PNG], { type: 'image/png' }), 'fuga.png');
  const s = await api(server.url, 'POST', '/api/solicitudes', { token: c.token, headers: idem(), form });
  assert.equal(s.status, 201);
  const det = await api(server.url, 'GET', `/api/solicitudes/${s.body.solicitud.id_solicitud}`, { token: c.token });
  assert.match(det.body.solicitud.imagenes[0].url, /\?exp=\d+&sig=/);
  const res = await fetch(server.url + det.body.solicitud.imagenes[0].url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});
