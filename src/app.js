const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { maintenance } = require('./middleware/maintenance');
const { errorHandler, notFound } = require('./lib/http');

function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  next();
}

// Construye la app sin escuchar en ningún puerto (las pruebas la levantan en un puerto libre).
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(compression());
  app.use(cors({ exposedHeaders: ['Idempotent-Replay', 'Retry-After'] }));
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  app.use(securityHeaders);

  app.get('/', (_req, res) => res.send('Servidor Backend de Click & Serve funcionando 🚀'));
  app.get('/api/salud', (_req, res) => res.json({ ok: true, hora: new Date().toISOString() }));
  app.use(maintenance);

  app.use(require('./routes/archivos'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/cuenta'));
  app.use(require('./routes/solicitudes'));
  app.use(require('./routes/incidencias'));
  app.use(require('./routes/pagos'));
  app.use(require('./routes/tecnico'));
  app.use(require('./routes/soporte'));
  app.use(require('./routes/direcciones'));
  app.use(require('./routes/biometria'));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
