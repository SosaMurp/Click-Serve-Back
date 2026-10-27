// Aprueba una cuenta (identidad verificada) mientras no exista el panel de administrador.
// Uso: node scripts/aprobar-usuario.js correo@ejemplo.com
require('dotenv').config({ quiet: true });
const { getPool, closePool } = require('../src/db/pool');

(async () => {
  const correo = String(process.argv[2] || '').trim().toLowerCase();
  if (!correo) {
    console.error('Uso: node scripts/aprobar-usuario.js correo@ejemplo.com');
    process.exit(1);
  }
  const { rows } = await getPool().query(
    `UPDATE usuarios SET identidad_verificada = true, estado_cuenta = 'APROBADO', estado = 'APROBADO'
     WHERE correo = $1 AND anonimizado = false RETURNING id_usuario, nombre, id_rol`,
    [correo]
  );
  if (!rows[0]) {
    console.error(`No existe una cuenta activa con el correo ${correo}.`);
    process.exitCode = 1;
  } else {
    console.log(`Cuenta aprobada: ${rows[0].nombre} (id ${rows[0].id_usuario}, rol ${rows[0].id_rol}).`);
  }
  await closePool();
})();
