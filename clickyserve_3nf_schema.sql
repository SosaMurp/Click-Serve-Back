-- ====================================================================
-- CLICK & SERVE - NORMALIZACIÓN A TERCERA FORMA NORMAL (3NF)
-- ====================================================================
--
-- Principios aplicados:
-- 1NF (Primera Forma Normal):
--   - Todos los atributos son atómicos (sin listas, arrays ni valores compuestos en una sola columna).
--   - Cada tabla cuenta con una clave primaria (PK) única.
--
-- 2NF (Segunda Forma Normal):
--   - Cumple 1NF.
--   - Todos los atributos que no son clave dependen funcionalmente por completo de la clave primaria.
--
-- 3NF (Tercera Forma Normal):
--   - Cumple 2NF.
--   - No existen dependencias transitivas: ningún atributo no-clave depende de otro atributo no-clave.
--   - Se aíslan catálogos de estado, categorías de servicio, métodos de pago y cotizaciones/calificaciones.
-- ====================================================================

-- 1. Catálogo de Roles de Usuario (Lookup)
CREATE TABLE IF NOT EXISTS roles (
    id_rol SMALLINT PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL UNIQUE,
    descripcion VARCHAR(255)
);

INSERT INTO roles (id_rol, nombre, descripcion) VALUES
(1, 'CLIENTE', 'Usuario solicitante de servicios para hogar o negocio'),
(2, 'TECNICO', 'Profesional prestador de servicios técnicos especializados'),
(3, 'ADMIN', 'Administrador de plataforma y soporte central')
ON CONFLICT (id_rol) DO UPDATE 
SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion;

-- 2. Catálogo de Estados de Solicitud de Servicio (Lookup)
CREATE TABLE IF NOT EXISTS estados_solicitud (
    id_estado VARCHAR(20) PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL,
    descripcion VARCHAR(255),
    orden_flujo SMALLINT DEFAULT 0
);

INSERT INTO estados_solicitud (id_estado, nombre, descripcion, orden_flujo) VALUES
('PENDIENTE', 'Pendiente de Asignación', 'La solicitud fue creada y espera a ser tomada por un técnico', 1),
('ASIGNADA', 'Técnico Asignado', 'Un técnico ha aceptado o se le ha asignado la solicitud', 2),
('EN_CAMINO', 'Técnico en Camino', 'El técnico se desplaza a la dirección del cliente', 3),
('EN_PROCESO', 'Servicio en Proceso', 'El técnico se encuentra realizando el trabajo', 4),
('ESPERANDO_APROBACION', 'Esperando Aprobación de Cotización', 'El técnico ha enviado la cotización y espera la confirmación del cliente', 5),
('FINALIZADA', 'Servicio Finalizado', 'Trabajo completado y verificado', 6),
('CANCELADA', 'Solicitud Cancelada', 'Servicio cancelado por el cliente o técnico', 99)
ON CONFLICT (id_estado) DO UPDATE 
SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion, orden_flujo = EXCLUDED.orden_flujo;

-- 3. Catálogo de Categorías de Servicio (Lookup)
CREATE TABLE IF NOT EXISTS categorias_servicio (
    id_categoria SERIAL PRIMARY KEY,
    codigo VARCHAR(40) NOT NULL UNIQUE,
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    icono VARCHAR(50),
    tarifa_base NUMERIC(10, 2) DEFAULT 0.00
);

INSERT INTO categorias_servicio (codigo, nombre, descripcion, icono) VALUES
('PLOMERIA', 'Plomería', 'Reparación de fugas, grifería, tuberías y sanitarios', 'plumbing'),
('ELECTRICIDAD', 'Electricidad', 'Instalación eléctrica, cableado, contactos y luminarias', 'flash-outline'),
('CERRAJERIA', 'Cerrajería', 'Apertura de cerraduras, duplicados e instalación', 'key-outline'),
('LINEA_BLANCA', 'Línea Blanca', 'Mantenimiento y reparación de refrigeradores, lavadoras y estufas', 'construct-outline'),
('CLIMATIZACION', 'Climatización', 'Instalación y mantenimiento de aires acondicionados', 'snow-outline'),
('PINTURA', 'Pintura e Impermeabilización', 'Pintura interior, exterior e impermeabilizado', 'color-palette-outline')
ON CONFLICT (codigo) DO UPDATE 
SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion, icono = EXCLUDED.icono;

-- 4. Catálogo de Estados de Cuenta de Usuario
CREATE TABLE IF NOT EXISTS estados_cuenta (
    codigo VARCHAR(20) PRIMARY KEY,
    descripcion VARCHAR(100) NOT NULL
);

INSERT INTO estados_cuenta (codigo, descripcion) VALUES
('Activo', 'Cuenta verificada y activa'),
('Pendiente', 'Pendiente de confirmación o verificación'),
('Suspendido', 'Cuenta temporal o definitivamente inactiva')
ON CONFLICT (codigo) DO NOTHING;

-- 5. Catálogo de Estados de Pago
CREATE TABLE IF NOT EXISTS estados_pago (
    codigo VARCHAR(20) PRIMARY KEY,
    descripcion VARCHAR(100) NOT NULL
);

INSERT INTO estados_pago (codigo, descripcion) VALUES
('PENDIENTE', 'Pago no procesado o en espera'),
('PAGADO', 'Pago acreditado satisfactoriamente'),
('REEMBOLSADO', 'Monto reintegrado al cliente'),
('FALLIDO', 'Intento de cobro denegado')
ON CONFLICT (codigo) DO NOTHING;

-- 6. Normalización de Direcciones de Usuario (1NF, 2NF, 3NF)
-- Separadas de la tabla de usuarios para permitir cardinalidad 1 a N sin redundancia
CREATE TABLE IF NOT EXISTS usuario_direcciones (
    id_direccion SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    etiqueta VARCHAR(50) DEFAULT 'Casa', -- Casa, Trabajo, etc.
    calle VARCHAR(255) NOT NULL,
    numero_exterior VARCHAR(50),
    numero_interior VARCHAR(50),
    colonia VARCHAR(100),
    codigo_postal VARCHAR(10),
    ciudad VARCHAR(100) DEFAULT 'Puebla',
    estado VARCHAR(100) DEFAULT 'Puebla',
    pais VARCHAR(50) DEFAULT 'México',
    latitud NUMERIC(10, 7),
    longitud NUMERIC(10, 7),
    es_predeterminada BOOLEAN DEFAULT FALSE,
    creado_en TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuario_direcciones_usuario ON usuario_direcciones(id_usuario);

-- 7. Normalización de Métodos de Pago
CREATE TABLE IF NOT EXISTS usuario_metodos_pago (
    id_metodo SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    titular VARCHAR(150) NOT NULL,
    ultimos_4 VARCHAR(4) NOT NULL,
    marca_tarjeta VARCHAR(30) DEFAULT 'VISA',
    expiracion VARCHAR(10) NOT NULL,
    token_pasarela TEXT,
    es_predeterminado BOOLEAN DEFAULT FALSE,
    creado_en TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuario_metodos_pago_usuario ON usuario_metodos_pago(id_usuario);

-- 8. Normalización de Cotizaciones (Desacopladas de solicitudes para historial y versiones en 3NF)
CREATE TABLE IF NOT EXISTS cotizaciones_servicio (
    id_cotizacion SERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_tecnico INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    monto_mano_obra NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    monto_materiales NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    monto_total NUMERIC(10, 2) NOT NULL,
    detalles TEXT,
    tiempo_estimado_minutos INTEGER,
    estado VARCHAR(20) DEFAULT 'ENVIADA', -- ENVIADA, ACEPTADA, RECHAZADA, EXPIRADA
    fecha_creacion TIMESTAMPTZ DEFAULT NOW(),
    fecha_respuesta TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cotizaciones_solicitud ON cotizaciones_servicio(id_solicitud);

-- 9. Normalización de Calificaciones y Reseñas (Desacopladas en 3NF)
CREATE TABLE IF NOT EXISTS calificaciones_servicio (
    id_calificacion SERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL UNIQUE REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_cliente INTEGER NOT NULL REFERENCES usuarios(id_usuario),
    id_tecnico INTEGER NOT NULL REFERENCES usuarios(id_usuario),
    puntuacion_tecnico SMALLINT CHECK (puntuacion_tecnico BETWEEN 1 AND 5),
    comentario_cliente TEXT,
    puntuacion_cliente SMALLINT CHECK (puntuacion_cliente BETWEEN 1 AND 5),
    comentario_tecnico TEXT,
    fecha_calificacion TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calificaciones_tecnico ON calificaciones_servicio(id_tecnico);

-- 10. Normalización de Evidencias de Trabajo
CREATE TABLE IF NOT EXISTS evidencias_servicio (
    id_evidencia SERIAL PRIMARY KEY,
    id_solicitud BIGINT NOT NULL REFERENCES solicitudes_servicio(id_solicitud) ON DELETE CASCADE,
    id_tecnico INTEGER NOT NULL REFERENCES usuarios(id_usuario),
    tipo_evidencia VARCHAR(20) DEFAULT 'POST_TRABAJO', -- PRE_TRABAJO, EN_PROCESO, POST_TRABAJO
    url_foto TEXT NOT NULL,
    descripcion TEXT,
    fecha_subida TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidencias_solicitud ON evidencias_servicio(id_solicitud);

-- 11. Restricciones de Claves Foráneas de Catálogos (Garantizar Integridad Referencial 3NF)
DO $$
BEGIN
    -- Validar FK de estado_solicitud
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_solicitudes_estado'
    ) THEN
        ALTER TABLE solicitudes_servicio 
        ADD CONSTRAINT fk_solicitudes_estado 
        FOREIGN KEY (estado) REFERENCES estados_solicitud(id_estado) ON UPDATE CASCADE;
    END IF;

    -- Validar FK de estado_pago
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_solicitudes_estado_pago'
    ) THEN
        ALTER TABLE solicitudes_servicio 
        ADD CONSTRAINT fk_solicitudes_estado_pago 
        FOREIGN KEY (estado_pago) REFERENCES estados_pago(codigo) ON UPDATE CASCADE;
    END IF;
END $$;
