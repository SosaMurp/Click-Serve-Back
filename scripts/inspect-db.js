const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function inspect() {
  await client.connect();
  const columns = await client.query(`
    SELECT c.table_name, c.ordinal_position, c.column_name, c.data_type,
           c.udt_name, c.character_maximum_length, c.is_nullable, c.column_default
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
    ORDER BY c.table_name, c.ordinal_position
  `);
  const constraints = await client.query(`
    SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
           kcu.column_name, ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name, kcu.ordinal_position
  `);
  const version = await client.query('SELECT version()');
  console.log(JSON.stringify({ version: version.rows[0].version, columns: columns.rows, constraints: constraints.rows }, null, 2));
  await client.end();
}

inspect().catch(async error => {
  console.error(error.message);
  await client.end().catch(() => {});
  process.exit(1);
});
