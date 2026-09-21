require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: '127.0.0.1',
  port: 5435,
  database: process.env.DB_NAME,
});
console.log('Usando config:', {
  user: process.env.DB_USER,
  host: '127.0.0.1',
  port: 5435,
  database: process.env.DB_NAME,
});

(async () => {
  try {
    const client = await pool.connect();
    const res = await client.query('SELECT NOW() AS now');
    console.log('Conexion OK — server time:', res.rows[0].now);
    client.release();
    process.exit(0);
  } catch (err) {
    console.error('Fallo al conectar desde Node:', err.code || err.message || err);
    console.error(err.stack || err);
    process.exit(1);
  }
})();
