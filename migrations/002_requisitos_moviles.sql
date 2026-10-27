-- Click & Serve: soporte de los requisitos de la app móvil (RF/RNF/RD de la matriz).
-- Idempotente: puede aplicarse sobre bases nuevas o sobre la base existente del equipo.

-- ───────────────────────── Catálogos ─────────────────────────
-- usuarios.id_rol tiene FK hacia rol; el DDL base no lo llenaba.
INSERT INTO rol (id_rol, nombre_rol) VALUES (1, 'CLIENTE'), (2, 'TECNICO'), (3, 'ADMIN')
ON CONFLICT (id_rol) DO UPDATE SET nombre_rol = EXCLUDED.nombre_rol;
SELECT setval('rol_id_rol_seq', GREATEST((SELECT MAX(id_rol) FROM rol), 3));

INSERT INTO estados_solicitud (id_estado, nombre, descripcion, orden_flujo) VALUES
('PENDIENTE', 'Buscando técnico', 'La solicitud espera a que un técnico la acepte', 1),
('ASIGNADA', 'Técnico asignado', 'Un técnico aceptó la solicitud', 2),
('EN_CAMINO', 'Técnico en camino', 'El técnico se dirige al domicilio', 3),
('EN_SITIO', 'Técnico en sitio', 'El técnico llegó al domicilio', 4),
('ESPERANDO_APROBACION', 'Cotización enviada', 'El cliente debe aprobar la cotización', 5),
('EN_PROCESO', 'Trabajo en proceso', 'El técnico realiza el trabajo', 6),
('POR_CONFIRMAR', 'Por confirmar', 'El técnico terminó; el cliente confirma y paga', 7),
('FINALIZADA', 'Servicio finalizado', 'Servicio confirmado y pagado', 8),
('SUSPENDIDA', 'Orden suspendida', 'Orden detenida por una incidencia', 90),
('CANCELADA', 'Cancelada', 'Servicio cancelado', 99)
ON CONFLICT (id_estado) DO UPDATE
SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion, orden_flujo = EXCLUDED.orden_flujo;

ALTER TABLE solicitudes_servicio DROP CONSTRAINT IF EXISTS solicitudes_estado_ck;
ALTER TABLE solicitudes_servicio ADD CONSTRAINT solicitudes_estado_ck CHECK (estado IN (
    'PENDIENTE', 'ASIGNADA', 'EN_CAMINO', 'EN_SITIO', 'ESPERANDO_APROBACION', 'EN_PROCESO',
    'POR_CONFIRMAR', 'FINALIZADA', 'SUSPENDIDA', 'CANCELADA'));

INSERT INTO estados_pago (codigo, descripcion) VALUES ('NO_APLICA', 'Servicio cancelado sin cargo')
ON CONFLICT (codigo) DO NOTHING;

-- Categorías: se conservan las seis del 3NF y se agregan cómputo (RD-003) y mecánica (RD-007).
INSERT INTO categorias_servicio (codigo, nombre, descripcion, icono) VALUES
('COMPUTO', 'Cómputo y redes', 'Soporte, hardware, redes domésticas y equipo de oficina', 'monitor'),
('ELECTRICIDAD', 'Electricidad', 'Instalaciones, contactos, luminarias y fallas eléctricas (NOM-001-SEDE)', 'zap'),
('PLOMERIA', 'Plomería', 'Fugas, tuberías, sanitarios, calentadores e instalaciones de gas', 'droplet'),
('CERRAJERIA', 'Cerrajería', 'Apertura, cambio de chapas y duplicados', 'key'),
('LINEA_BLANCA', 'Línea blanca', 'Refrigeradores, lavadoras, secadoras y estufas', 'box'),
('CLIMATIZACION', 'Climatización', 'Instalación y mantenimiento de aire acondicionado', 'wind'),
('PINTURA', 'Pintura e impermeabilización', 'Pintura interior, exterior e impermeabilizado', 'edit-3'),
('MECANICA', 'Mecánica automotriz', 'Diagnóstico, afinación y reparaciones a domicilio', 'truck')
ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion, icono = EXCLUDED.icono;

ALTER TABLE categorias_servicio ADD COLUMN IF NOT EXISTS orden SMALLINT DEFAULT 50;
UPDATE categorias_servicio SET orden = CASE codigo
    WHEN 'COMPUTO' THEN 1 WHEN 'ELECTRICIDAD' THEN 2 WHEN 'PLOMERIA' THEN 3 WHEN 'CLIMATIZACION' THEN 4
    WHEN 'LINEA_BLANCA' THEN 5 WHEN 'CERRAJERIA' THEN 6 WHEN 'PINTURA' THEN 7 WHEN 'MECANICA' THEN 8 ELSE 50 END;

-- ───────────────────────── Usuarios ─────────────────────────
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS disponible BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS ultimo_latido TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS preferencias JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS totp_secreto TEXT,
    ADD COLUMN IF NOT EXISTS totp_pendiente TEXT,
    ADD COLUMN IF NOT EXISTS foto_archivo BIGINT,
    ADD COLUMN IF NOT EXISTS anonimizado BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS consentimiento_privacidad TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS bio TEXT;

-- ───────────────────────── Archivos (RNF-26) ─────────────────────────
CREATE TABLE IF NOT EXISTS archivos (
    id_archivo BIGSERIAL PRIMARY KEY,
    id_propietario INTEGER REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    categoria VARCHAR(30) NOT NULL,
    nombre VARCHAR(255) NOT NULL,
    tipo_mime VARCHAR(100) NOT NULL,
    tamano INTEGER NOT NULL,
    contenido BYTEA NOT NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────── Idempotencia y auditoría ─────────────────────────
CREATE TABLE IF NOT EXISTS idempotencia (
    clave UUID NOT NULL,
    id_usuario INTEGER NOT NULL,
    alcance VARCHAR(60) NOT NULL,
    status INTEGER,
    cuerpo JSONB,
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (clave, id_usuario)
);
CREATE INDEX IF NOT EXISTS idempotencia_creado_idx ON idempotencia (creado);

CREATE TABLE IF NOT EXISTS auditoria (
    id_auditoria BIGSERIAL PRIMARY KEY,
    id_usuario INTEGER,
    accion VARCHAR(60) NOT NULL,
    entidad VARCHAR(40),
    id_entidad VARCHAR(60),
    ip VARCHAR(64),
    user_agent TEXT,
    detalle JSONB,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auditoria_usuario_fecha_idx ON auditoria (id_usuario, fecha DESC);

CREATE TABLE IF NOT EXISTS retos_2fa (
    id_reto UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    intentos SMALLINT NOT NULL DEFAULT 0,
    usado BOOLEAN NOT NULL DEFAULT false,
    expira TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 minutes'),
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE retos_2fa ADD COLUMN IF NOT EXISTS codigo_hash TEXT;

ALTER TABLE tokens_temporales ADD COLUMN IF NOT EXISTS canal VARCHAR(10) DEFAULT 'EMAIL';
ALTER TABLE tokens_temporales ADD COLUMN IF NOT EXISTS reset_token UUID;
ALTER TABLE tokens_temporales ADD COLUMN IF NOT EXISTS fecha_verificacion TIMESTAMPTZ;
ALTER TABLE tokens_temporales ADD COLUMN IF NOT EXISTS intentos SMALLINT NOT NULL DEFAULT 0;

-- ───────────────────────── Solicitudes ─────────────────────────
ALTER TABLE solicitudes_servicio
    ADD COLUMN IF NOT EXISTS id_tecnico_propuesto INTEGER REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS propuesto_hasta TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fecha_asignacion TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fecha_llegada TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fecha_finalizacion TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS garantia_hasta DATE,
    ADD COLUMN IF NOT EXISTS motivo_cancelacion TEXT,
    ADD COLUMN IF NOT EXISTS cancelado_por VARCHAR(10),
    ADD COLUMN IF NOT EXISTS monto_total NUMERIC(19, 4),
    ADD COLUMN IF NOT EXISTS estado_previo VARCHAR(20),
    ADD COLUMN IF NOT EXISTS alerta_sos BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS latitud_sos NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS longitud_sos NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS fecha_sos TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS referencias TEXT;

ALTER TABLE solicitudes_servicio ALTER COLUMN monto_cotizacion TYPE NUMERIC(19, 4);
CREATE INDEX IF NOT EXISTS solicitudes_estado_idx ON solicitudes_servicio (estado);
CREATE INDEX IF NOT EXISTS solicitudes_tecnico_idx ON solicitudes_servicio (id_tecnico, estado);

CREATE TABLE IF NOT EXISTS solicitudes_descartadas (
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_tecnico INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id_solicitud, id_tecnico)
);

ALTER TABLE cotizaciones_servicio ALTER COLUMN monto_mano_obra TYPE NUMERIC(19, 4);
ALTER TABLE cotizaciones_servicio ALTER COLUMN monto_materiales TYPE NUMERIC(19, 4);
ALTER TABLE cotizaciones_servicio ALTER COLUMN monto_total TYPE NUMERIC(19, 4);

CREATE TABLE IF NOT EXISTS conceptos_cotizacion (
    id_concepto BIGSERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_cotizacion INTEGER REFERENCES cotizaciones_servicio(id_cotizacion) ON DELETE CASCADE,
    tipo VARCHAR(12) NOT NULL CHECK (tipo IN ('MANO_OBRA', 'MATERIAL', 'EXTRA')),
    descripcion VARCHAR(200) NOT NULL,
    monto NUMERIC(19, 4) NOT NULL CHECK (monto > 0),
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conceptos_solicitud_idx ON conceptos_cotizacion (id_solicitud);

CREATE TABLE IF NOT EXISTS tareas_servicio (
    id_tarea BIGSERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    descripcion VARCHAR(200) NOT NULL,
    origen VARCHAR(12) NOT NULL DEFAULT 'TECNICO' CHECK (origen IN ('PLANTILLA', 'TECNICO')),
    norma VARCHAR(40),
    completada BOOLEAN NOT NULL DEFAULT false,
    fecha_completada TIMESTAMPTZ,
    orden SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tareas_solicitud_idx ON tareas_servicio (id_solicitud);

ALTER TABLE evidencias_servicio ADD COLUMN IF NOT EXISTS id_archivo BIGINT REFERENCES archivos(id_archivo) ON DELETE SET NULL;
ALTER TABLE evidencias_servicio ALTER COLUMN url_foto DROP NOT NULL;

ALTER TABLE mensajes_chat ADD COLUMN IF NOT EXISTS id_archivo BIGINT REFERENCES archivos(id_archivo) ON DELETE SET NULL;
ALTER TABLE mensajes_chat ALTER COLUMN mensaje DROP NOT NULL;

-- Calificación bidireccional (RF-43): una fila por solicitud en calificaciones_servicio (3NF).
ALTER TABLE calificaciones_servicio ALTER COLUMN id_tecnico DROP NOT NULL;

CREATE TABLE IF NOT EXISTS incidencias (
    id_incidencia BIGSERIAL PRIMARY KEY,
    folio VARCHAR(20) NOT NULL UNIQUE,
    id_solicitud BIGINT REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('NO_SE_PRESENTO', 'COBRO_INDEBIDO', 'MALA_CALIDAD', 'DANOS', 'SEGURIDAD', 'GARANTIA', 'OTRO')),
    descripcion TEXT NOT NULL,
    prioridad VARCHAR(5) NOT NULL DEFAULT 'MEDIA' CHECK (prioridad IN ('BAJA', 'MEDIA', 'ALTA')),
    estado VARCHAR(10) NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA', 'RESUELTA')),
    resolucion VARCHAR(12) CHECK (resolucion IN ('REASIGNAR', 'CANCELAR', 'CONTINUAR')),
    estado_previo VARCHAR(20),
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_resolucion TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reprogramaciones (
    id_reprogramacion BIGSERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    propuesta_por INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    hora TIME NOT NULL,
    motivo TEXT,
    estado VARCHAR(10) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'ACEPTADA', 'RECHAZADA', 'CANCELADA')),
    id_anterior BIGINT REFERENCES reprogramaciones(id_reprogramacion) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_respuesta TIMESTAMPTZ
);

-- ───────────────────────── Pagos y billetera ─────────────────────────
ALTER TABLE metodos_pago
    ADD COLUMN IF NOT EXISTS token TEXT,
    ADD COLUMN IF NOT EXISTS marca VARCHAR(20),
    ADD COLUMN IF NOT EXISTS predeterminada BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS pagos (
    id_pago BIGSERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL UNIQUE REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_cliente INTEGER NOT NULL REFERENCES usuarios(id_usuario),
    id_metodo INTEGER,
    monto NUMERIC(19, 4) NOT NULL,
    moneda VARCHAR(3) NOT NULL DEFAULT 'MXN',
    estado VARCHAR(12) NOT NULL CHECK (estado IN ('PAGADO', 'FALLIDO', 'REEMBOLSADO')),
    modo VARCHAR(10) NOT NULL CHECK (modo IN ('CONEKTA', 'SANDBOX')),
    referencia VARCHAR(80),
    desglose JSONB NOT NULL DEFAULT '{}'::jsonb,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE billetera_tecnico ALTER COLUMN saldo_actual TYPE NUMERIC(19, 4);
ALTER TABLE billetera_tecnico ADD COLUMN IF NOT EXISTS banco VARCHAR(60);

ALTER TABLE transacciones ALTER COLUMN monto TYPE NUMERIC(19, 4);
ALTER TABLE transacciones
    ADD COLUMN IF NOT EXISTS folio VARCHAR(24),
    ADD COLUMN IF NOT EXISTS concepto VARCHAR(20) DEFAULT 'SERVICIO',
    ADD COLUMN IF NOT EXISTS id_solicitud BIGINT REFERENCES solicitudes_servicio(id_solicitud) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS desglose JSONB,
    ADD COLUMN IF NOT EXISTS clabe_destino VARCHAR(30),
    ADD COLUMN IF NOT EXISTS banco_destino VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_folio_uq ON transacciones (folio) WHERE folio IS NOT NULL;
UPDATE transacciones SET folio = 'TRX-' || LPAD(id_transaccion::text, 6, '0') WHERE folio IS NULL;

-- ───────────────────────── Técnico ─────────────────────────
ALTER TABLE especialidades_tecnico ADD COLUMN IF NOT EXISTS categoria VARCHAR(40);

CREATE TABLE IF NOT EXISTS portafolio_tecnico (
    id_item BIGSERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    id_archivo BIGINT NOT NULL REFERENCES archivos(id_archivo) ON DELETE CASCADE,
    titulo VARCHAR(120) NOT NULL,
    descripcion TEXT,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documentos_usuario (
    id_documento BIGSERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    tipo VARCHAR(25) NOT NULL CHECK (tipo IN ('INE_FRENTE', 'INE_REVERSO', 'ROSTRO', 'CEDULA', 'CERTIFICACION', 'COMPROBANTE_DOMICILIO', 'ANTECEDENTES')),
    id_archivo BIGINT REFERENCES archivos(id_archivo) ON DELETE SET NULL,
    numero VARCHAR(40),
    descripcion VARCHAR(150),
    estado VARCHAR(12) NOT NULL DEFAULT 'EN_REVISION' CHECK (estado IN ('EN_REVISION', 'APROBADO', 'RECHAZADO')),
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────── Direcciones ─────────────────────────
ALTER TABLE direcciones
    ADD COLUMN IF NOT EXISTS latitud NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS longitud NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS referencias TEXT,
    ADD COLUMN IF NOT EXISTS ciudad VARCHAR(100) DEFAULT 'Lázaro Cárdenas',
    ADD COLUMN IF NOT EXISTS predeterminada BOOLEAN NOT NULL DEFAULT false;

-- ───────────────────────── Soporte (RF-107/108/113, RF-94) ─────────────────────────
CREATE TABLE IF NOT EXISTS soporte_tickets (
    id_ticket BIGSERIAL PRIMARY KEY,
    folio VARCHAR(20) NOT NULL UNIQUE,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    id_solicitud BIGINT REFERENCES solicitudes_servicio(id_solicitud) ON DELETE SET NULL,
    asunto VARCHAR(150) NOT NULL,
    categoria VARCHAR(15) NOT NULL DEFAULT 'OTRO' CHECK (categoria IN ('PAGOS', 'SERVICIO', 'CUENTA', 'SEGURIDAD', 'OTRO')),
    prioridad VARCHAR(5) NOT NULL DEFAULT 'MEDIA' CHECK (prioridad IN ('BAJA', 'MEDIA', 'ALTA')),
    estado VARCHAR(12) NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'EN_ATENCION', 'ESCALADO', 'CERRADO')),
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS soporte_mensajes (
    id_mensaje BIGSERIAL PRIMARY KEY,
    id_ticket BIGINT NOT NULL REFERENCES soporte_tickets(id_ticket) ON DELETE CASCADE,
    id_emisor INTEGER REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    es_asesor BOOLEAN NOT NULL DEFAULT false,
    mensaje TEXT,
    id_archivo BIGINT REFERENCES archivos(id_archivo) ON DELETE SET NULL,
    fecha_envio TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS soporte_mensajes_ticket_idx ON soporte_mensajes (id_ticket, fecha_envio);

-- ───────────────────────── Liquidación al técnico (RD-013, RNF-37/39) ─────────────────────────
-- total cobrado (IVA incluido) − comisión Click & Serve 10 % − retención ISR 2.1 % y IVA 8 % sobre la base sin IVA.
CREATE OR REPLACE FUNCTION cs_liquidacion(p_total NUMERIC)
RETURNS TABLE (total NUMERIC, comision NUMERIC, base NUMERIC, retencion_isr NUMERIC, retencion_iva NUMERIC, neto_tecnico NUMERIC)
LANGUAGE sql IMMUTABLE AS $$
    WITH v AS (SELECT ROUND(p_total, 2) AS t, ROUND(ROUND(p_total, 2) / 1.16, 2) AS b)
    SELECT t, ROUND(t * 0.10, 2), b, ROUND(b * 0.021, 2), ROUND(b * 0.08, 2),
           t - ROUND(t * 0.10, 2) - ROUND(b * 0.021, 2) - ROUND(b * 0.08, 2)
    FROM v
$$;
