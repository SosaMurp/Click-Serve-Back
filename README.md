# Click & Serve — Backend

API REST + WebSocket de Click & Serve (Express 5, PostgreSQL).

## Arranque

```bash
npm install
cp .env.example .env      # y llena los valores
npm start                 # aplica migraciones y escucha en PORT
```

`NODE_ENV=development` (en `.env`) habilita los atajos de desarrollo: cobros en modo sandbox, códigos de verificación
en consola y llaves de respaldo. Sin `NODE_ENV`, o con cualquier otro valor, el servidor se comporta como producción:
exige `JWT_SECRET`, `FILES_SECRET`, `CONEKTA_PRIVATE_KEY` y SMTP, y falla cerrado si faltan.

Las migraciones (`migrations/` y los `.sql` de la raíz) se aplican solas al arrancar y quedan registradas en `schema_migraciones`.

## Base de datos local desde cero

Los datos no viven en el repositorio; la estructura sí (los `.sql` de la raíz y `migrations/`). Para tener una base
de desarrollo igual a la del equipo, con las cuentas de prueba:

```bash
# 1. Base vacía en tu PostgreSQL (17 o similar)
psql -h localhost -U postgres -c "CREATE DATABASE clickyserve_db"

# 2. En .env: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME=clickyserve_db y NODE_ENV=development

# 3. Estructura: arrancar el backend aplica todas las migraciones (o, sin arrancarlo, npm run db:migrate)
npm start

# 4. Cuentas de prueba (en otra terminal; se puede repetir sin duplicar nada)
npm run db:seed
```

Cuentas que crea `npm run db:seed` (datos ficticios, ya aprobadas y sin 2FA):

| Rol | Correo | Contraseña |
|---|---|---|
| Cliente | `cliente.prueba@clickserve.test` | `ClienteTest#2026` |
| Técnico | `tecnico.prueba@clickserve.test` | `TecnicoTest#2026` |

El seed (`scripts/seed-demo.sql` y `scripts/seed-demo.js`) solo corre con `NODE_ENV=development` o `test`: en
producción crearía cuentas con contraseñas conocidas. Para empezar de cero: `DROP DATABASE clickyserve_db;` y repetir.
`npm run db:setup` es el script viejo que solo aplica `clickyserve_db.sql`; usa `npm start` o `npm run db:migrate`.

## Pruebas

```bash
# requiere una base vacía llamada clickyserve_test en el Postgres local
npm test
```

## Estructura

- `index.js` — arranque (migraciones, HTTP, WebSocket en `/ws`, barrido de disponibilidad).
- `src/app.js` — Express y routers.
- `src/routes/` — auth, cuenta, solicitudes, incidencias y reprogramación, pagos y billetera, técnico, soporte, direcciones, biometría, archivos.
- `src/lib/` — validadores (CLABE, Luhn), TOTP, idempotencia, auditoría, archivos con URL firmada, correo/SMS, tiempo real.
- `src/middleware/` — autenticación con códigos `AUTH_*`, roles y aprobación, límite de intentos, mantenimiento.

## Aprobar una cuenta sin panel de administrador

```bash
node scripts/aprobar-usuario.js correo@ejemplo.com
```
