const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function applySchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'clickyserve_db.sql'), 'utf8'));
    await client.query('COMMIT');
    console.log('Esquema del Modulo 1 aplicado correctamente.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('No se pudo aplicar el esquema:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

applySchema();
