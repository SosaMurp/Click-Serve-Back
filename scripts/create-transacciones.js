const pool = require('../config/db');

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transacciones (
        id_transaccion SERIAL PRIMARY KEY,
        id_billetera INT NOT NULL REFERENCES billetera_tecnico(id_billetera) ON DELETE CASCADE,
        monto NUMERIC(12, 2) NOT NULL,
        tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('INGRESO', 'RETIRO')),
        estado VARCHAR(20) DEFAULT 'COMPLETADO',
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Tabla transacciones creada o verificada exitosamente.');
    process.exit(0);
  } catch (err) {
    console.error('Error al crear tabla transacciones:', err);
    process.exit(1);
  }
}

migrate();
