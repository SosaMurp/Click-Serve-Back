const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startServer, createUser, api, login, getPool, closePool } = require('./helpers');
const { totp, generateSecret } = require('../src/lib/totp');
const { outbox } = require('../src/lib/mailer');
const { signTicket, registroKey, sha256 } = require('../src/lib/ine/ticket');

let server;
test.before(async () => { await resetDb(); server = await startServer(); });
test.after(async () => { await server.close(); await closePool(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });
const lastCode = (to) => [...outbox].reverse().find((m) => m.to === to)?.code;

function registroForm(overrides = {}) {
  const data = {
    nombre: 'Ana', apellidos: 'López', telefono: '7531234567', email: `ana${Date.now()}${Math.random()}@prueba.test`,
    fechaNacimiento: '1995-05-10', password: 'Segura#2026', perfil: '1', acepta_privacidad: 'true', ...overrides,
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) form.append(k, v);
  // La verificación por OCR se prueba en ine-endpoint.test.js; aquí la INE llega ya verificada.
  const persona = registroKey({ nombre: data.nombre, apellidos: data.apellidos, fecha_nacimiento: data.fechaNacimiento });
  const ticket = (lado) => signTicket({ lado, hash: sha256(PNG), persona, curp: 'LOXA950510MMNPXN05', fecha_nacimiento: data.fechaNacimiento, sexo: 'M', comprobaciones: [] });
  form.append('ticket_ine_frente', ticket('frente'));
  form.append('ticket_ine_reverso', ticket('reverso'));
  form.append('ine_frente', png(), 'frente.png');
  form.append('ine_reverso', png(), 'reverso.png');
  form.append('rostro', png(), 'rostro.png');
  return { form, data };
}

test('TOTP cumple el vector de prueba del RFC 6238 (T=59 s)', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});

test('registro rechaza contraseña débil', async () => {
  const { form } = registroForm({ password: 'abc12345' });
  const res = await api(server.url, 'POST', '/api/register', { form });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEAK_PASSWORD');
});

test('registro rechaza menores de 18 años', async () => {
  const { form } = registroForm({ fechaNacimiento: `${new Date().getFullYear() - 15}-01-01` });
  const res = await api(server.url, 'POST', '/api/register', { form });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNDERAGE');
});

test('registro exige aceptar el aviso de privacidad (LFPDPPP)', async () => {
  const { form } = registroForm({ acepta_privacidad: undefined });
  const res = await api(server.url, 'POST', '/api/register', { form });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CONSENT_REQUIRED');
});

test('registro, verificación con código y sesión iniciada', async () => {
  const { form, data } = registroForm();
  const reg = await api(server.url, 'POST', '/api/register', { form });
  assert.equal(reg.status, 201);
  const code = lastCode(data.email);
  assert.match(code, /^\d{6}$/);
  const wrong = await api(server.url, 'POST', '/api/verify-token', { body: { email: data.email, token: '000000' } });
  assert.equal(wrong.status, 400);
  const ok = await api(server.url, 'POST', '/api/verify-token', { body: { email: data.email, token: code } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.usuario.aprobado, true);
  const docs = await getPool().query('SELECT tipo FROM documentos_usuario WHERE id_usuario = $1 ORDER BY tipo', [reg.body.id_usuario]);
  assert.deepEqual(docs.rows.map((r) => r.tipo), ['INE_FRENTE', 'INE_REVERSO', 'ROSTRO']);
});

test('un técnico recién verificado queda pendiente de aprobación', async () => {
  const { form, data } = registroForm({ perfil: '2' });
  await api(server.url, 'POST', '/api/register', { form });
  const ok = await api(server.url, 'POST', '/api/verify-token', { body: { email: data.email, token: lastCode(data.email) } });
  assert.equal(ok.body.usuario.rol, 'tecnico');
  assert.equal(ok.body.usuario.aprobado, false);
});

test('correo ya registrado responde 409 USER_EXISTS', async () => {
  const user = await createUser();
  const { form } = registroForm({ email: user.email });
  const res = await api(server.url, 'POST', '/api/register', { form });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'USER_EXISTS');
});

test('recuperación por SMS envía el código por ese canal y responde igual si el correo no existe', async () => {
  const user = await createUser();
  const res = await api(server.url, 'POST', '/api/request-recovery', { body: { email: user.email, canal: 'SMS' } });
  assert.equal(res.status, 200);
  const sms = [...outbox].reverse().find((m) => m.canal === 'SMS');
  assert.equal(sms.to, '2220000000');
  const ghost = await api(server.url, 'POST', '/api/request-recovery', { body: { email: 'nadie@prueba.test', canal: 'EMAIL' } });
  assert.equal(ghost.status, 200);
  assert.equal(ghost.body.mensaje, res.body.mensaje);
});

test('recuperación completa con reset_token y contraseña nueva', async () => {
  const user = await createUser();
  await api(server.url, 'POST', '/api/request-recovery', { body: { email: user.email, canal: 'EMAIL' } });
  const code = lastCode(user.email);
  const ver = await api(server.url, 'POST', '/api/verify-recovery', { body: { email: user.email, token: code } });
  assert.equal(ver.status, 200);
  assert.ok(ver.body.reset_token);
  // Sin el reset_token (o con uno ajeno) nadie puede cambiarla, aunque la persona ya haya verificado su código.
  const sinToken = await api(server.url, 'POST', '/api/reset-password', { body: { email: user.email, newPassword: 'Atacante#2026' } });
  assert.equal(sinToken.status, 403);
  const otroToken = await api(server.url, 'POST', '/api/reset-password', { body: { email: user.email, reset_token: '00000000-0000-4000-8000-000000000000', newPassword: 'Atacante#2026' } });
  assert.equal(otroToken.status, 403);
  const weak = await api(server.url, 'POST', '/api/reset-password', { body: { email: user.email, reset_token: ver.body.reset_token, newPassword: 'corta' } });
  assert.equal(weak.status, 400);
  const ok = await api(server.url, 'POST', '/api/reset-password', { body: { email: user.email, reset_token: ver.body.reset_token, newPassword: 'NuevaClave#1' } });
  assert.equal(ok.status, 200);
  await login(server.url, { email: user.email, password: 'NuevaClave#1' });
});

test('cambio de contraseña con la actual incorrecta responde 400, no 401', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const res = await api(server.url, 'POST', '/api/update-password', { token, body: { currentPassword: 'mala', newPassword: 'OtraClave#9' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'PASSWORD_INCORRECT');
});

test('cambio de contraseña cierra las demás sesiones y conserva la actual', async () => {
  const user = await createUser();
  const otra = await login(server.url, user);
  const actual = await login(server.url, user);
  const res = await api(server.url, 'POST', '/api/update-password', { token: actual, body: { currentPassword: user.password, newPassword: 'OtraClave#9' } });
  assert.equal(res.status, 200);
  assert.equal((await api(server.url, 'GET', '/api/me', { token: otra })).body.code, 'AUTH_REVOKED');
  assert.equal((await api(server.url, 'GET', '/api/me', { token: res.body.token })).status, 200);
});

test('desvincular una sesión invalida su token', async () => {
  const user = await createUser();
  const remota = await login(server.url, user);
  const actual = await login(server.url, user);
  const list = await api(server.url, 'GET', '/api/auth/sessions', { token: actual });
  const other = list.body.sesiones.find((s) => !s.es_sesion_actual);
  const del = await api(server.url, 'DELETE', `/api/auth/sessions/${other.id_sesion}`, { token: actual });
  assert.equal(del.status, 200);
  assert.equal((await api(server.url, 'GET', '/api/me', { token: remota })).body.code, 'AUTH_REVOKED');
});

test('2FA: activar con app autenticadora y entrar con el código', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const ini = await api(server.url, 'POST', '/api/usuarios/2fa/iniciar', { token });
  assert.equal(ini.status, 200);
  assert.match(ini.body.otpauth, /^otpauth:\/\/totp\//);
  const conf = await api(server.url, 'POST', '/api/usuarios/2fa/confirmar', { token, body: { codigo: totp(ini.body.secreto) } });
  assert.equal(conf.status, 200);
  const step1 = await api(server.url, 'POST', '/api/login', { body: { email: user.email, password: user.password } });
  assert.equal(step1.body.requires2FA, true);
  const step2 = await api(server.url, 'POST', '/api/login/verify-2fa', { body: { reto: step1.body.reto, codigo: totp(ini.body.secreto) } });
  assert.equal(step2.status, 200);
  assert.ok(step2.body.token);
});

test('2FA: con la verificación ya activa no se puede cambiar el secreto sin desactivarla antes', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const secreto = generateSecret();
  await getPool().query('UPDATE usuarios SET totp_secreto = $1, "2FA_Activo" = true WHERE id_usuario = $2', [secreto, user.id]);
  const ini = await api(server.url, 'POST', '/api/usuarios/2fa/iniciar', { token });
  assert.equal(ini.status, 409);
  assert.equal(ini.body.code, 'TWO_FA_ACTIVE');
  assert.equal(ini.body.secreto, undefined);
  const { rows } = await getPool().query('SELECT totp_secreto, totp_pendiente FROM usuarios WHERE id_usuario = $1', [user.id]);
  assert.equal(rows[0].totp_secreto, secreto);
  assert.equal(rows[0].totp_pendiente, null);
});

test('2FA: tres códigos incorrectos destruyen el reto', async () => {
  const user = await createUser();
  const secreto = generateSecret();
  await getPool().query('UPDATE usuarios SET totp_secreto = $1, "2FA_Activo" = true WHERE id_usuario = $2', [secreto, user.id]);
  const step1 = await api(server.url, 'POST', '/api/login', { body: { email: user.email, password: user.password } });
  for (let i = 0; i < 3; i += 1) {
    await api(server.url, 'POST', '/api/login/verify-2fa', { body: { reto: step1.body.reto, codigo: '000000' } });
  }
  const late = await api(server.url, 'POST', '/api/login/verify-2fa', { body: { reto: step1.body.reto, codigo: totp(secreto) } });
  assert.equal(late.status, 401);
  assert.equal(late.body.code, 'TWO_FA_LOCKED');
});

test('perfil y preferencias se guardan en la base', async () => {
  const user = await createUser({ aprobado: false });
  const token = await login(server.url, user);
  const perfil = await api(server.url, 'PUT', '/api/usuarios/perfil', { token, body: { nombre: 'Rosa', apellido: 'Díaz', telefono: '7539876543' } });
  assert.equal(perfil.status, 200);
  const pref = await api(server.url, 'PUT', '/api/usuarios/preferencias', { token, body: { notificaciones_push: false, notificaciones_email: true, otra_cosa: 'x' } });
  assert.equal(pref.status, 200);
  const me = await api(server.url, 'GET', '/api/me', { token });
  assert.equal(me.body.usuario.nombre, 'Rosa');
  assert.deepEqual(me.body.usuario.preferencias, { notificaciones_push: false, notificaciones_email: true });
});

test('con la identidad verificada el nombre ya no se puede cambiar; teléfono y presentación sí', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const rename = await api(server.url, 'PUT', '/api/usuarios/perfil', { token, body: { nombre: 'Juan', apellido: 'López' } });
  assert.equal(rename.status, 409);
  assert.equal(rename.body.code, 'IDENTITY_LOCKED');
  const same = await api(server.url, 'PUT', '/api/usuarios/perfil', { token, body: { nombre: 'Cliente', apellido: 'Prueba', telefono: '7531112233', bio: 'Hola' } });
  assert.equal(same.status, 200);
  const me = await api(server.url, 'GET', '/api/me', { token });
  assert.equal(me.body.usuario.nombre, 'Cliente');
  assert.equal(me.body.usuario.telefono, '7531112233');
});

test('teléfono con formato inválido responde 400', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const res = await api(server.url, 'PUT', '/api/usuarios/perfil', { token, body: { telefono: '123' } });
  assert.equal(res.status, 400);
});

test('avatar multipart queda disponible con URL firmada', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const form = new FormData();
  form.append('foto', png(), 'yo.png');
  const res = await api(server.url, 'PUT', '/api/usuarios/avatar', { token, form });
  assert.equal(res.status, 200);
  assert.match(res.body.usuario.foto_url, /^\/api\/archivos\/\d+\?exp=/);
  assert.equal((await fetch(server.url + res.body.usuario.foto_url)).status, 200);
});

test('exportar mis datos (ARCO) no incluye la contraseña', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const res = await api(server.url, 'GET', '/api/cuenta/exportar', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.usuario.correo, user.email);
  assert.equal(JSON.stringify(res.body).includes('contrasena'), false);
});

test('eliminar cuenta exige contraseña y anonimiza los datos', async () => {
  const user = await createUser();
  const token = await login(server.url, user);
  const sin = await api(server.url, 'DELETE', '/api/cuenta', { token, body: {} });
  assert.equal(sin.status, 400);
  const mala = await api(server.url, 'DELETE', '/api/cuenta', { token, body: { password: 'mala' } });
  assert.equal(mala.status, 400);
  assert.equal(mala.body.code, 'PASSWORD_INCORRECT');
  const ok = await api(server.url, 'DELETE', '/api/cuenta', { token, body: { password: user.password } });
  assert.equal(ok.status, 200);
  const row = (await getPool().query('SELECT correo, anonimizado FROM usuarios WHERE id_usuario = $1', [user.id])).rows[0];
  assert.equal(row.anonimizado, true);
  assert.notEqual(row.correo, user.email);
  const relogin = await api(server.url, 'POST', '/api/login', { body: { email: user.email, password: user.password } });
  assert.equal(relogin.status, 401);
});
