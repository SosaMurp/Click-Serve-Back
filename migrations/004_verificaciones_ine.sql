-- Click & Serve: resultado de la verificación de la credencial INE con que se creó cada cuenta.
-- Una fila por lado (frente y reverso) con cada comprobación (calidad, textos, CURP, fecha, nombre, MRZ...),
-- la CURP leída y el SHA-256 de la imagen guardada en documentos_usuario.
CREATE TABLE IF NOT EXISTS verificaciones_ine (
    id_verificacion_ine SERIAL PRIMARY KEY,
    id_usuario INT NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    lado VARCHAR(10) NOT NULL CHECK (lado IN ('frente', 'reverso')),
    curp VARCHAR(18),
    comprobaciones JSONB NOT NULL,
    hash_imagen CHAR(64) NOT NULL,
    proveedor VARCHAR(30) NOT NULL DEFAULT 'propio',
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS verificaciones_ine_usuario_idx ON verificaciones_ine (id_usuario);
