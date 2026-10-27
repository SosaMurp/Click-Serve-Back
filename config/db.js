// Compatibilidad: los scripts y las rutas heredadas importan el pool desde aquí.
// El pool real vive en src/db/pool.js y se crea al primer uso (sin conectar al importar).
const { getPool } = require('../src/db/pool');

module.exports = new Proxy({}, {
  get(_target, prop) {
    const pool = getPool();
    const value = pool[prop];
    return typeof value === 'function' ? value.bind(pool) : value;
  },
});
