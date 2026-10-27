const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

let pool = null;

// Pool perezoso y sin efectos al importarse: las pruebas y los scripts deciden cuándo conectar.
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
      user: process.env.DB_USER,
      // Vacío = undefined: node-postgres recurre a PGPASSWORD o a pgpass.conf.
      password: process.env.DB_PASSWORD || undefined,
      database: process.env.DB_NAME,
      max: Number(process.env.DB_POOL_MAX || 10),
    });
    pool.on('error', (err) => console.error('Error inesperado en el pool de PostgreSQL:', err.message));
  }
  return pool;
}

async function closePool() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

// Ejecuta fn(client) dentro de BEGIN/COMMIT; cualquier error hace ROLLBACK (RNF-20/22).
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getPool, closePool, withTransaction };
