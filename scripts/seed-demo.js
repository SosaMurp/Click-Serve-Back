const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');
const { isDevelopment } = require('../src/lib/env');

// Cuentas de prueba (datos ficticios) para una base de desarrollo: `npm run db:seed`.
// Aplica primero las migraciones (por si la base está vacía) y luego scripts/seed-demo.sql.
// Solo corre con NODE_ENV=development o test: en producción crearía cuentas con contraseñas conocidas.
const CUENTAS = [
  { correo: 'cliente.prueba@clickserve.test', password: 'ClienteTest#2026', rol: 'cliente' },
  { correo: 'tecnico.prueba@clickserve.test', password: 'TecnicoTest#2026', rol: 'técnico' },
];

async function seedDemo(pool = getPool()) {
  if (!isDevelopment()) {
    throw new Error('El seed de cuentas de prueba corre solo en desarrollo (NODE_ENV=development o test).');
  }
  await migrate(pool, { silent: true });
  await pool.query(fs.readFileSync(path.join(__dirname, 'seed-demo.sql'), 'utf8'));
  return CUENTAS;
}

if (require.main === module) {
  seedDemo()
    .then((cuentas) => {
      console.log(`Cuentas de prueba listas en la base ${process.env.DB_NAME}:`);
      for (const c of cuentas) console.log(`  ${c.rol.padEnd(8)} ${c.correo} / ${c.password}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = { seedDemo, CUENTAS };
