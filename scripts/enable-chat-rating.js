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
    await client.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS calificacion SMALLINT');
    await client.query('ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS comentario_calificacion TEXT');
    await client.query(`
      CREATE TABLE IF NOT EXISTS mensajes_chat (
        id BIGSERIAL PRIMARY KEY,
        id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
        id_emisor INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        mensaje TEXT NOT NULL,
        fecha_envio TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS mensajes_chat_solicitud_fecha_idx ON mensajes_chat (id_solicitud, fecha_envio)');
    await client.query('COMMIT');
    console.log('Chat y calificación habilitados.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

migrate();