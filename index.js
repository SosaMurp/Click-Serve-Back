const http = require('http');
require('dotenv').config({ quiet: true });
const { migrate } = require('./src/db/migrate');
const { createApp } = require('./src/app');
const realtime = require('./src/lib/realtime');
const { getPool } = require('./src/db/pool');

// RNF-34: un técnico sin latido en 5 minutos deja de figurar como disponible.
function startAvailabilitySweep() {
  const timer = setInterval(() => {
    getPool()
      .query("UPDATE usuarios SET disponible = false WHERE disponible AND id_rol = 2 AND (ultimo_latido IS NULL OR ultimo_latido < NOW() - INTERVAL '5 minutes')")
      .catch((error) => console.error('No se pudo actualizar la disponibilidad:', error.message));
  }, 60 * 1000);
  timer.unref();
}

async function start(port = process.env.PORT || 3000) {
  await migrate();
  const server = http.createServer(createApp());
  realtime.attach(server);
  startAvailabilitySweep();
  server.listen(port, () => {
    console.log(`Servidor corriendo en el puerto ${port}`);
  });
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('No se pudo iniciar el servidor:', error);
    process.exit(1);
  });
}

module.exports = { start };
