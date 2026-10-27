// Utilidades compartidas por las pruebas de integración (node:test).
// Usan la base clickyserve_test del Postgres local; cada archivo de prueba la reinicia.
process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost';
process.env.DB_PORT = process.env.TEST_DB_PORT || '5432';
process.env.DB_USER = process.env.TEST_DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || '';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'clickyserve_test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.FILES_SECRET = 'test-files-secret';

const http = require('http');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt');
const { getPool, closePool } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const realtime = require('../src/lib/realtime');

async function resetDb() {
  const pool = getPool();
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(pool, { silent: true });
}

async function startServer() {
  const server = http.createServer(createApp());
  realtime.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: async () => {
      realtime.closeAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let userCounter = 0;
async function createUser({ rol = 1, aprobado = true, password = 'Prueba#2026', nombre, latitud, longitud, disponible } = {}) {
  userCounter += 1;
  const email = `u${userCounter}.${randomUUID().slice(0, 6)}@prueba.test`;
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await getPool().query(
    `INSERT INTO usuarios (nombre, apellido, correo, contrasena, telefono, fecha_nacimiento, id_rol,
                           estado, estado_cuenta, identidad_verificada, latitud, longitud, disponible, ultimo_latido)
     VALUES ($1, 'Prueba', $2, $3, '2220000000', '1990-01-01', $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 THEN NOW() ELSE NULL END)
     RETURNING id_usuario`,
    [
      nombre || (rol === 2 ? 'Tecnico' : 'Cliente'),
      email,
      hash,
      rol,
      aprobado ? 'APROBADO' : 'pendiente',
      aprobado ? 'Activo' : 'pendiente',
      aprobado,
      latitud ?? null,
      longitud ?? null,
      disponible ?? false,
    ]
  );
  return { id: rows[0].id_usuario, email, password, rol };
}

async function api(base, method, path, { token, body, headers = {}, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* respuesta no JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function login(base, user) {
  const res = await api(base, 'POST', '/api/login', { body: { email: user.email, password: user.password } });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`login falló (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

function idem() {
  return { 'Idempotency-Key': randomUUID() };
}

module.exports = { resetDb, startServer, createUser, api, login, idem, getPool, closePool };
