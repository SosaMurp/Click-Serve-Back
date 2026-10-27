const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

const ROOT = path.join(__dirname, '..', '..');

// Orden de arranque de una base vacía. Cada paso se registra en schema_migraciones y se aplica una vez.
// clickyserve_db.sql solo corre si la base no tiene la tabla usuarios (bases existentes ya lo tienen).
const STEPS = [
  { id: '000_base', file: 'clickyserve_db.sql', onlyIfMissing: 'usuarios' },
  { id: '001_columnas_runtime', file: 'migrations/001_columnas_runtime.sql' },
  { id: '001b_normalizacion_3nf', file: 'clickyserve_3nf_schema.sql' },
  { id: '002_requisitos_moviles', file: 'migrations/002_requisitos_moviles.sql' },
];

async function migrate(pool = getPool(), { silent = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migraciones (id VARCHAR(80) PRIMARY KEY, aplicada TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );
    const applied = new Set((await client.query('SELECT id FROM schema_migraciones')).rows.map((r) => r.id));

    for (const step of STEPS) {
      if (applied.has(step.id)) continue;

      if (step.onlyIfMissing) {
        const exists = await client.query('SELECT to_regclass($1) AS t', [`public.${step.onlyIfMissing}`]);
        if (exists.rows[0].t) {
          await client.query('INSERT INTO schema_migraciones (id) VALUES ($1)', [step.id]);
          continue;
        }
      }

      const sql = fs.readFileSync(path.join(ROOT, step.file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migraciones (id) VALUES ($1)', [step.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        error.message = `Migración ${step.id} falló: ${error.message}`;
        throw error;
      }
      if (!silent) console.log(`Migración aplicada: ${step.id}`);
    }
  } finally {
    client.release();
  }
}

module.exports = { migrate };
