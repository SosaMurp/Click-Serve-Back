-- Columnas y tablas que el index.js original creaba en tiempo de ejecución (ALTER/CREATE al vuelo)
-- y que los scripts/*.js agregaban a mano. Idempotente: es seguro en bases que ya las tienen.
-- Va antes de clickyserve_3nf_schema.sql porque ese archivo crea una FK sobre solicitudes_servicio.estado_pago.

ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS estado VARCHAR(30) DEFAULT 'pendiente',
    ADD COLUMN IF NOT EXISTS identidad_verificada BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS verificado_sep BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS ine_frente TEXT,
    ADD COLUMN IF NOT EXISTS ine_reverso TEXT,
    ADD COLUMN IF NOT EXISTS foto_rostro TEXT,
    ADD COLUMN IF NOT EXISTS latitud NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS longitud NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS ultima_conexion TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS foto_perfil TEXT,
    ADD COLUMN IF NOT EXISTS push_token TEXT;

ALTER TABLE solicitudes_servicio
    ADD COLUMN IF NOT EXISTS estado_pago VARCHAR(20) DEFAULT 'PENDIENTE',
    ADD COLUMN IF NOT EXISTS calificacion_cliente INTEGER,
    ADD COLUMN IF NOT EXISTS comentario_cliente TEXT,
    ADD COLUMN IF NOT EXISTS evidencia_foto TEXT,
    ADD COLUMN IF NOT EXISTS monto_cotizacion NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS detalles_cotizacion TEXT,
    ADD COLUMN IF NOT EXISTS latitud NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS longitud NUMERIC(10, 7);

CREATE TABLE IF NOT EXISTS billetera_tecnico (
    id_billetera SERIAL PRIMARY KEY,
    id_usuario INT NOT NULL UNIQUE REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    saldo_actual NUMERIC(12, 2) DEFAULT 0.00,
    clabe_interbancaria VARCHAR(18) DEFAULT NULL,
    fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transacciones (
    id_transaccion SERIAL PRIMARY KEY,
    id_billetera INT NOT NULL REFERENCES billetera_tecnico(id_billetera) ON DELETE CASCADE,
    monto NUMERIC(12, 2) NOT NULL,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('INGRESO', 'RETIRO')),
    estado VARCHAR(20) DEFAULT 'COMPLETADO',
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS especialidades_tecnico (
    id_especialidad SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    nombre VARCHAR(100) NOT NULL,
    estado VARCHAR(30) NOT NULL DEFAULT 'VERIFICADO',
    activa BOOLEAN DEFAULT TRUE,
    fecha_creacion TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_usuario_especialidad UNIQUE (id_usuario, nombre)
);

CREATE TABLE IF NOT EXISTS direcciones (
    id_direccion SERIAL PRIMARY KEY,
    id_usuario INTEGER,
    etiqueta VARCHAR(50),
    calle VARCHAR(255),
    numero VARCHAR(50),
    interior VARCHAR(50),
    colonia VARCHAR(100),
    cp VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS metodos_pago (
    id_metodo SERIAL PRIMARY KEY,
    id_usuario INTEGER,
    titular VARCHAR(100),
    ultimos_4 VARCHAR(4),
    expiracion VARCHAR(10)
);
