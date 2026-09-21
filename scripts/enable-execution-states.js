const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function migrate() {
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE solicitudes_servicio DROP CONSTRAINT IF EXISTS solicitudes_estado_ck');
    await client.query(`
      ALTER TABLE solicitudes_servicio
      ADD CONSTRAINT solicitudes_estado_ck
      CHECK (estado IN ('PENDIENTE', 'ASIGNADA', 'EN_CAMINO', 'EN_PROCESO', 'FINALIZADA', 'CANCELADA'))
    `);
    await client.query('COMMIT');
    console.log('Estados de ejecución habilitados.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('No se pudo habilitar estados de ejecución:', error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

migrate();
