const pool = require('../config/db');

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS billetera_tecnico (
        id_billetera SERIAL PRIMARY KEY,
        id_usuario INT NOT NULL UNIQUE REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        saldo_actual NUMERIC(12, 2) DEFAULT 0.00,
        clabe_interbancaria VARCHAR(18) DEFAULT NULL,
        fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Tabla billetera_tecnico creada o verificada exitosamente.');
    process.exit(0);
  } catch (err) {
    console.error('Error al crear tabla billetera_tecnico:', err);
    process.exit(1);
  }
}

migrate();
