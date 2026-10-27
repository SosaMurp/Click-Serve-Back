const pool = require('../config/db');

async function migrate() {
  try {
    await pool.query(`
      ALTER TABLE solicitudes_servicio 
      ADD COLUMN IF NOT EXISTS latitud NUMERIC(10, 7),
      ADD COLUMN IF NOT EXISTS longitud NUMERIC(10, 7);
    `);
    console.log('Columnas latitud y longitud agregadas exitosamente a solicitudes_servicio.');
    process.exit(0);
  } catch (err) {
    console.error('Error al agregar columnas geo:', err);
    process.exit(1);
  }
}

migrate();
