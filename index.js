const http = require('http');
require('dotenv').config({ quiet: true });
const { migrate } = require('./src/db/migrate');
const { createApp } = require('./src/app');
const realtime = require('./src/lib/realtime');

async function start(port = process.env.PORT || 3000) {
  await migrate();
  const server = http.createServer(createApp());
  realtime.attach(server);
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
