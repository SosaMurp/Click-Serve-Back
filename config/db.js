const { Pool } = require('pg');
require('dotenv').config();

// Configuración de la Base de Datos PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

pool.connect(async (err, client, release) => {
  if (err) {
    return console.error('Error conectando a PostgreSQL:', err.stack);
  }
  console.log('¡Conectado exitosamente a PostgreSQL local (config/db.js)!');
  
  // Inicializar tabla de sesiones y asegurar columna id_rol
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sesiones_activas (
          id_sesion UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          id_usuario INT REFERENCES Usuarios(id_usuario) ON DELETE CASCADE,
          id_rol INT,
          dispositivo VARCHAR(255),
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          estado VARCHAR(20) DEFAULT 'activa'
      );
    `);
    
    // Asegurarse de agregar la columna id_rol por si la tabla ya existía
    await client.query(`
      ALTER TABLE sesiones_activas ADD COLUMN IF NOT EXISTS id_rol INT;
    `);
    
    console.log('Tabla sesiones_activas y columna id_rol listas.');
  } catch (tableErr) {
    console.error('Error creando/actualizando tabla sesiones_activas:', tableErr.stack);
  } finally {
    release();
  }
});

module.exports = pool;
