-- Click & Serve - DDL canonico de la base productiva
-- Fuente de verdad para inicializar clickyserve_db desde cero.
-- Este archivo no modifica la instancia existente por si mismo.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Catalogos historicos de roles y permisos
CREATE TABLE rol (
    id_rol SERIAL PRIMARY KEY,
    nombre_rol VARCHAR(50) NOT NULL
);

CREATE TABLE permiso (
    id_permiso SERIAL PRIMARY KEY,
    clave_permiso VARCHAR(50) NOT NULL,
    descripcion TEXT,
    CONSTRAINT permiso_clave_permiso_key UNIQUE (clave_permiso)
);

CREATE TABLE rol_permiso (
    id_rol_permiso SERIAL PRIMARY KEY,
    id_rol INTEGER REFERENCES rol(id_rol),
    id_permiso INTEGER REFERENCES permiso(id_permiso)
);

-- Identidad y cuentas
CREATE TABLE usuarios (
    id_usuario SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    apellido VARCHAR(100) NOT NULL,
    correo VARCHAR(150) NOT NULL,
    contrasena VARCHAR(255) NOT NULL,
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    estado_cuenta VARCHAR(20) DEFAULT 'Activo',
    fecha_nacimiento DATE,
    telefono VARCHAR(15),
    url_ine_front TEXT,
    url_ine_rev TEXT,
    fecha_actualizacion_contrasena TIMESTAMP,
    "2FA_Activo" BOOLEAN DEFAULT FALSE,
    "2FA_Sem" VARCHAR(255),
    id_rol INTEGER REFERENCES rol(id_rol),
    version_sesion INTEGER DEFAULT 1,
    biometria_estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    referencia_facial BYTEA,
    CONSTRAINT usuarios_correo_key UNIQUE (correo)
);

CREATE TABLE tokens_temporales (
    id_token SERIAL PRIMARY KEY,
    token VARCHAR(10) NOT NULL,
    tipo_accion VARCHAR(50) NOT NULL,
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_expiracion TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '15 minutes'),
    estado_uso VARCHAR(20) DEFAULT 'sin usar',
    id_usuario INTEGER NOT NULL,
    CONSTRAINT fk_usuario FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
);

CREATE TABLE sesiones_activas (
    id_sesion UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario INTEGER REFERENCES usuarios(id_usuario),
    dispositivo VARCHAR(255),
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    estado VARCHAR(20) DEFAULT 'activa',
    id_rol INTEGER
);

-- Verificacion biometrica local
CREATE TABLE verificaciones_biometricas (
    id_verificacion UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    desafio VARCHAR(128) NOT NULL UNIQUE,
    proveedor VARCHAR(40) NOT NULL DEFAULT 'opencv',
    estado VARCHAR(30) NOT NULL DEFAULT 'solicitada',
    resultado JSONB,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_expiracion TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
    fecha_resolucion TIMESTAMPTZ,
    CONSTRAINT verificaciones_estado_ck CHECK (estado IN ('solicitada', 'procesando', 'APROBADO', 'RECHAZADO', 'expirada'))
);

-- Solicitudes de servicio y archivos adjuntos
CREATE TABLE solicitudes_servicio (
    id_solicitud BIGSERIAL PRIMARY KEY,
    folio VARCHAR(24) NOT NULL UNIQUE,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    id_tecnico INTEGER REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    categoria VARCHAR(30),
    descripcion TEXT NOT NULL,
    direccion TEXT NOT NULL,
    fecha_preferida DATE,
    hora_preferida TIME,
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT solicitudes_estado_ck CHECK (estado IN ('PENDIENTE', 'ASIGNADA', 'EN_PROCESO', 'FINALIZADA', 'CANCELADA'))
);

CREATE TABLE solicitud_imagenes (
    id_imagen BIGSERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    nombre VARCHAR(255) NOT NULL,
    tipo_mime VARCHAR(100) NOT NULL,
    contenido BYTEA NOT NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sesiones_usuario_estado_idx ON sesiones_activas (id_usuario, estado);
CREATE INDEX tokens_usuario_tipo_idx ON tokens_temporales (id_usuario, tipo_accion, estado_uso);
CREATE INDEX verificaciones_usuario_estado_idx ON verificaciones_biometricas (id_usuario, estado);
CREATE INDEX solicitudes_usuario_fecha_idx ON solicitudes_servicio (id_usuario, fecha_creacion DESC);

ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS calificacion SMALLINT;
ALTER TABLE solicitudes_servicio ADD COLUMN IF NOT EXISTS comentario_calificacion TEXT;

CREATE TABLE mensajes_chat (
    id BIGSERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_emisor INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    mensaje TEXT NOT NULL,
    fecha_envio TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mensajes_chat_solicitud_fecha_idx ON mensajes_chat (id_solicitud, fecha_envio);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'solicitudes_estado_ck') THEN
        ALTER TABLE solicitudes_servicio DROP CONSTRAINT solicitudes_estado_ck;
    END IF;
    ALTER TABLE solicitudes_servicio
        ADD CONSTRAINT solicitudes_estado_ck
        CHECK (estado IN ('PENDIENTE', 'ASIGNADA', 'EN_CAMINO', 'EN_PROCESO', 'FINALIZADA', 'CANCELADA'));
END $$;
