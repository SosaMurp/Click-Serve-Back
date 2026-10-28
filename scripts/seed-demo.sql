-- Click & Serve: cuentas de prueba para desarrollo (datos ficticios). Lo corre `npm run db:seed`
-- después de las migraciones; se puede correr las veces que haga falta.
--
--   CLIENTE (id_rol 1): cliente.prueba@clickserve.test / ClienteTest#2026
--   TECNICO (id_rol 2): tecnico.prueba@clickserve.test / TecnicoTest#2026
--
-- Ya aprobadas, con identidad y biometría verificadas y sin 2FA. Las contraseñas van con bcrypt de
-- 10 rondas, igual que el registro. NUNCA se corre contra producción (el script lo impide).
INSERT INTO usuarios
    (nombre, apellido, correo, contrasena, telefono, fecha_nacimiento, id_rol,
     estado, estado_cuenta, identidad_verificada, verificado_sep, biometria_estado, "2FA_Activo",
     fecha_actualizacion_contrasena)
VALUES
    ('Cliente', 'Prueba', 'cliente.prueba@clickserve.test',
     '$2b$10$KJp9zmdOISJ2UIyAiwZJ7eD3sl/E8W9gnFndUUgamMsJ1ARGB613C',
     '2220000001', '1995-01-01', 1,
     'APROBADO', 'Activo', true, false, 'verificada', false, NOW()),
    ('Tecnico', 'Prueba', 'tecnico.prueba@clickserve.test',
     '$2b$10$0MUOcIxXbp0XsEg//flfse6LTOApG7kc6dSC0Piy9nlowpMFPYHRq',
     '2220000002', '1990-01-01', 2,
     'APROBADO', 'Activo', true, true, 'verificada', false, NOW())
ON CONFLICT (correo) DO UPDATE SET
    contrasena = EXCLUDED.contrasena,
    id_rol = EXCLUDED.id_rol,
    estado = EXCLUDED.estado,
    estado_cuenta = EXCLUDED.estado_cuenta,
    identidad_verificada = EXCLUDED.identidad_verificada,
    verificado_sep = EXCLUDED.verificado_sep,
    biometria_estado = EXCLUDED.biometria_estado,
    "2FA_Activo" = EXCLUDED."2FA_Activo";
