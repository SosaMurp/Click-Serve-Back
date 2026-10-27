-- Click & Serve: estado de pago para un cobro ya enviado a la pasarela que aún no se registra.
-- Mientras una orden esté en PROCESANDO no se intenta otro cargo (evita cobros dobles si la pasarela
-- no respondió o si el registro falló después de cobrar); se concilia con la referencia de auditoría.
INSERT INTO estados_pago (codigo, descripcion) VALUES ('PROCESANDO', 'Cobro enviado a la pasarela, pendiente de registrar')
ON CONFLICT (codigo) DO NOTHING;
