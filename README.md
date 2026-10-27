# Click & Serve — Backend

API REST + WebSocket de Click & Serve (Express 5, PostgreSQL).

## Arranque

```bash
npm install
cp .env.example .env      # y llena los valores
npm start                 # aplica migraciones y escucha en PORT
```

Las migraciones (`migrations/` y los `.sql` de la raíz) se aplican solas al arrancar y quedan registradas en `schema_migraciones`.

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
