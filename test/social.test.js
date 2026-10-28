const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');
const { resetDb, startServer, createUser, api, closePool } = require('./helpers');

const GOOGLE_AUD = 'cliente-prueba.apps.googleusercontent.com';
const APPLE_AUD = 'com.gallo122.clickservemovil';
let server;
let jwks;
let key;

async function token({ iss = 'https://accounts.google.com', aud = GOOGLE_AUD, email, verified = true, given = 'Ana', family = 'López Ruiz' }) {
  return new SignJWT({ email, email_verified: verified, given_name: given, family_name: family })
    .setProtectedHeader({ alg: 'RS256', kid: 'prueba' })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject('sub-123')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key.privateKey);
}

test.before(async () => {
  await resetDb();
  server = await startServer();
  key = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'prueba', alg: 'RS256', use: 'sig' };
  jwks = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => jwks.listen(0, resolve));
  const url = `http://127.0.0.1:${jwks.address().port}/jwks`;
  process.env.GOOGLE_JWKS_URL = url;
  process.env.APPLE_JWKS_URL = url;
});

test.after(async () => {
  await server.close();
  await new Promise((resolve) => jwks.close(resolve));
  await closePool();
});

test('sin GOOGLE_CLIENT_IDS el inicio con Google está apagado', async () => {
  delete process.env.GOOGLE_CLIENT_IDS;
  const res = await api(server.url, 'POST', '/api/auth/google', { body: { id_token: await token({ email: 'x@prueba.test' }) } });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'PROVIDER_DISABLED');
});

test('Google con un correo registrado inicia sesión', async () => {
  process.env.GOOGLE_CLIENT_IDS = `otro.apps.googleusercontent.com,${GOOGLE_AUD}`;
  const user = await createUser();
  const res = await api(server.url, 'POST', '/api/auth/google', { body: { id_token: await token({ email: user.email }) } });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.usuario.correo, user.email);
});

test('Google con un correo nuevo pide completar el registro', async () => {
  process.env.GOOGLE_CLIENT_IDS = GOOGLE_AUD;
  const res = await api(server.url, 'POST', '/api/auth/google', { body: { id_token: await token({ email: 'nueva@prueba.test' }) } });
  assert.equal(res.status, 200);
  assert.equal(res.body.requiere_registro, true);
  assert.equal(res.body.email, 'nueva@prueba.test');
  assert.equal(res.body.nombre, 'Ana');
  assert.equal(res.body.apellidos, 'López Ruiz');
  assert.equal(res.body.token, undefined);
});

test('Google rechaza un token para otra aplicación', async () => {
  process.env.GOOGLE_CLIENT_IDS = GOOGLE_AUD;
  const res = await api(server.url, 'POST', '/api/auth/google', { body: { id_token: await token({ email: 'a@prueba.test', aud: 'ajena.apps.googleusercontent.com' }) } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_TOKEN');
});

test('Google rechaza un correo que Google no ha verificado', async () => {
  process.env.GOOGLE_CLIENT_IDS = GOOGLE_AUD;
  const user = await createUser();
  const res = await api(server.url, 'POST', '/api/auth/google', { body: { id_token: await token({ email: user.email, verified: false }) } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_TOKEN');
});

test('sin APPLE_BUNDLE_ID el inicio con Apple está apagado', async () => {
  delete process.env.APPLE_BUNDLE_ID;
  const res = await api(server.url, 'POST', '/api/auth/apple', { body: { identity_token: 'x' } });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'PROVIDER_DISABLED');
});

test('Apple con un correo registrado inicia sesión', async () => {
  process.env.APPLE_BUNDLE_ID = APPLE_AUD;
  const user = await createUser();
  const identity = await token({ iss: 'https://appleid.apple.com', aud: APPLE_AUD, email: user.email });
  const res = await api(server.url, 'POST', '/api/auth/apple', { body: { identity_token: identity } });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});
