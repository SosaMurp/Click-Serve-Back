const bcrypt = require('bcrypt');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const pool = require('./config/db');
const nodemailer = require('nodemailer');
require('dotenv').config();
const authMiddleware = require('./middleware/authMiddleware');

const app = express();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'projectcys1@gmail.com', 
    pass: 'bzpacpnbucuobeat'       
  }
});

// Configuración básica
app.use(cors());
app.use(express.json());

// La conexión a PostgreSQL ahora se importa desde config/db.js

app.get('/', (req, res) => {
  res.send('Servidor Backend de Click & Serve funcionando 🚀');
});

// ==========================================
// RUTA 1: REGISTRAR USUARIO (/api/register)
// ==========================================
app.post('/api/register', async (req, res) => {
  const { nombre, apellidos, telefono, email, fechaNacimiento, password, perfil } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Nota: version_sesion tomará el valor por defecto '1' definido en la BD
    const newUser = await pool.query(
      `INSERT INTO Usuarios 
        (nombre, apellido, telefono, correo, fecha_nacimiento, contrasena, id_rol, estado_cuenta) 
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING id_usuario`,
      [nombre, apellidos, telefono, emailFormateado, fechaNacimiento, hashedPassword, perfil, 'No verificado']
    );
    
    const idUsuario = newUser.rows[0].id_usuario;
    const tokenGenerado = Math.floor(1000 + Math.random() * 9000).toString();

    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [idUsuario, tokenGenerado, 'registro', 'sin usar']
    );

    const mailOptions = {
      from: '"Click & Serve" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Tu código de verificación - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>¡Bienvenido a Click & Serve!</h2>
          <p>Hola ${nombre}, ingresa el siguiente código en la app para activar tu cuenta:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
          <p style="color: #7A8C9E; font-size: 12px; margin-top: 20px;">Este código es de un solo uso y de 4 dígitos.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ mensaje: 'Usuario registrado con éxito. Código enviado al correo.' });

  } catch (error) {
    console.error('Error en /api/register:', error);
    if (error.code === '23505' || error.constraint === 'usuarios_correo_key') {
      return res.status(409).json({ error: 'Usuario Existente' });
    }
    res.status(500).json({ error: 'Error en el servidor al registrar el usuario' });
  }
});

// ==========================================
// RUTA 2: INICIAR SESIÓN (/api/login)
// ==========================================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();

    // Traemos de forma explícita todos los campos, incluyendo version_sesion
    const userQuery = await pool.query(
      'SELECT id_usuario, nombre, apellido, telefono, correo, fecha_nacimiento, id_rol, estado_cuenta, contrasena, version_sesion FROM Usuarios WHERE correo = $1', 
      [emailFormateado]
    );

    if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

    const usuario = userQuery.rows[0];

    const contraseñaValida = await bcrypt.compare(password, usuario.contrasena);

    if (!contraseñaValida) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

    if (usuario.estado_cuenta === 'No verificado') {
      return res.status(403).json({ error: 'Por favor, verifica tu cuenta con el código de 4 dígitos enviado a tu correo antes de iniciar sesión.' });
    }

    delete usuario.contrasena;

    // Registrar la sesión en la base de datos (con ID y Rol)
    const dispositivo = req.headers['user-agent'] || 'Dispositivo desconocido';
    const sesionResult = await pool.query(
      `INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, $2, $3) RETURNING id_sesion`,
      [usuario.id_usuario, usuario.id_rol, dispositivo]
    );
    const sessionId = sesionResult.rows[0].id_sesion;

    // Generar el JWT con el ID de usuario, su Rol, versión de sesión y el ID de sesión específico
    const token = jwt.sign(
      { 
        id_usuario: usuario.id_usuario, 
        id_rol: usuario.id_rol,
        version_sesion: usuario.version_sesion || 1,
        sessionId: sessionId
      }, 
      process.env.JWT_SECRET || 'fallback_secret_key',
      { expiresIn: '7d' } // El token expira en 7 días
    );

    res.status(200).json({ 
      mensaje: 'Inicio de sesión exitoso',
      usuario: usuario,
      token: token
    });

  } catch (error) {
    console.error('Error en /api/login:', error);
    res.status(500).json({ error: 'Error en el servidor al intentar iniciar sesión' });
  }
});

// ==========================================
// RUTA 3: VERIFICAR TOKEN DE REGISTRO (/api/verify-token)
// ==========================================
app.post('/api/verify-token', async (req, res) => {
  const { email, token } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    
    const userQuery = await pool.query('SELECT id_usuario FROM Usuarios WHERE correo = $1', [emailFormateado]);
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const idUsuario = userQuery.rows[0].id_usuario;

    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND token = $2 AND tipo_accion = 'registro' AND estado_uso = 'sin usar'`,
      [idUsuario, token]
    );

    if (tokenQuery.rows.length === 0) return res.status(400).json({ error: 'Código incorrecto, expirado o ya utilizado.' });

    const idToken = tokenQuery.rows[0].id_token;

    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1`, [idToken]);
    await pool.query(`UPDATE Usuarios SET estado_cuenta = 'Activo' WHERE id_usuario = $1`, [idUsuario]);

    res.status(200).json({ mensaje: 'Cuenta verificada exitosamente y activada.' });
  } catch (error) {
    console.error('Error en /api/verify-token:', error);
    res.status(500).json({ error: 'Error al verificar el código' });
  }
});

// ==========================================
// RUTA 3.5: REENVIAR CÓDIGO DE REGISTRO (/api/resend-code)
// ==========================================
app.post('/api/resend-code', async (req, res) => {
  const { email } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();

    const userQuery = await pool.query('SELECT id_usuario, nombre FROM Usuarios WHERE correo = $1', [emailFormateado]);
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { id_usuario, nombre } = userQuery.rows[0];

    await pool.query(
      `UPDATE tokens_temporales SET estado_uso = 'expirado' WHERE id_usuario = $1 AND tipo_accion = 'registro' AND estado_uso = 'sin usar'`,
      [id_usuario]
    );

    const tokenGenerado = Math.floor(1000 + Math.random() * 9000).toString();

    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [id_usuario, tokenGenerado, 'registro', 'sin usar']
    );

    const mailOptions = {
      from: '"Click & Serve" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Nuevo código de verificación - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>¡Aquí tienes tu nuevo código!</h2>
          <p>Hola ${nombre}, los códigos anteriores han sido invalidados. Ingresa este nuevo código para activar tu cuenta:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ mensaje: 'Nuevo código enviado exitosamente.' });
  } catch (error) {
    console.error('Error en /api/resend-code:', error);
    res.status(500).json({ error: 'Error al intentar reenviar el código' });
  }
});

// ==========================================
// RUTA 4: SOLICITAR RECUPERACIÓN DE CONTRASEÑA (/api/request-recovery)
// ==========================================
app.post('/api/request-recovery', async (req, res) => {
  const { email } = req.body; 

  try {
    const emailFormateado = email.trim().toLowerCase();
    const userQuery = await pool.query('SELECT id_usuario, nombre FROM Usuarios WHERE correo = $1', [emailFormateado]);
    
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'No hay ninguna cuenta asociada a este correo.' });

    const { id_usuario, nombre } = userQuery.rows[0];

    // Invalidar códigos de recuperación anteriores que no se usaron
    await pool.query(
      `UPDATE tokens_temporales SET estado_uso = 'expirado' WHERE id_usuario = $1 AND tipo_accion = 'recuperacion' AND estado_uso = 'sin usar'`,
      [id_usuario]
    );

    const tokenGenerado = Math.floor(1000 + Math.random() * 9000).toString();

    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [id_usuario, tokenGenerado, 'recuperacion', 'sin usar']
    );

    const mailOptions = {
      from: '"Click & Serve" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Recuperación de contraseña - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>Recuperación de cuenta</h2>
          <p>Hola ${nombre}, recibimos una solicitud para restablecer tu contraseña. Ingresa este código en la app:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
          <p style="color: #7A8C9E; font-size: 12px; margin-top: 20px;">Si no solicitaste esto, ignora este correo.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ mensaje: 'Código de recuperación enviado al correo.' });
  } catch (error) {
    console.error('Error en /api/request-recovery:', error);
    res.status(500).json({ error: 'Error al procesar la solicitud de recuperación' });
  }
});

// ==========================================
// RUTA 5: VERIFICAR TOKEN DE RECUPERACIÓN (/api/verify-recovery)
// ==========================================
app.post('/api/verify-recovery', async (req, res) => {
  const { email, token } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    const userQuery = await pool.query('SELECT id_usuario FROM Usuarios WHERE correo = $1', [emailFormateado]);

    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const idUsuario = userQuery.rows[0].id_usuario;

    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND token = $2 AND tipo_accion = 'recuperacion' AND estado_uso = 'sin usar'`,
      [idUsuario, token]
    );

    if (tokenQuery.rows.length === 0) return res.status(400).json({ error: 'Código incorrecto o expirado.' });

    const idToken = tokenQuery.rows[0].id_token;
    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'verificado' WHERE id_token = $1`, [idToken]);

    res.status(200).json({ mensaje: 'Código verificado correctamente. Puedes cambiar tu contraseña.' });
  } catch (error) {
    console.error('Error en /api/verify-recovery:', error);
    res.status(500).json({ error: 'Error al verificar el código de recuperación' });
  }
});

// ==========================================
// RUTA 6: RESTABLECER CONTRASEÑA (/api/reset-password)
// ==========================================
app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    const userQuery = await pool.query('SELECT id_usuario FROM Usuarios WHERE correo = $1', [emailFormateado]);

    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const idUsuario = userQuery.rows[0].id_usuario;

    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND tipo_accion = 'recuperacion' AND estado_uso = 'verificado'`,
      [idUsuario]
    );

    if (tokenQuery.rows.length === 0) return res.status(403).json({ error: 'Acceso denegado. No has verificado tu código de seguridad.' });

    const idToken = tokenQuery.rows[0].id_token;
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // 👈 Sumamos +1 a version_sesion (o la ponemos en 2 si era nula)
    await pool.query(
      `UPDATE Usuarios SET contrasena = $1, version_sesion = COALESCE(version_sesion, 1) + 1 WHERE id_usuario = $2`, 
      [hashedPassword, idUsuario]
    );

    // Revocar todas las sesiones activas del usuario
    await pool.query(
      "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND estado = 'activa'",
      [idUsuario]
    );

    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1`, [idToken]);

    res.status(200).json({ mensaje: 'Contraseña actualizada exitosamente. Ya puedes iniciar sesión.' });
  } catch (error) {
    console.error('Error en /api/reset-password:', error);
    res.status(500).json({ error: 'Error al intentar restablecer la contraseña' });
  }
});

// ==========================================
// RUTA 7: CAMBIAR CONTRASEÑA DESDE PERFIL (/api/update-password)
// ==========================================
app.post('/api/update-password', authMiddleware, async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  try {
    // Obtenemos los datos del usuario logueado usando el token
    const userQuery = await pool.query('SELECT id_usuario, contrasena, version_sesion, id_rol FROM Usuarios WHERE id_usuario = $1', [req.user.id_usuario]);
    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const usuario = userQuery.rows[0];
    const contraseñaValida = await bcrypt.compare(currentPassword, usuario.contrasena);

    if (!contraseñaValida) return res.status(401).json({ error: 'contraseña actual incorrecta' });

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    const newVersionSesion = (usuario.version_sesion || 1) + 1;

    // 👈 Actualizar contraseña y version_sesion en Usuarios
    await pool.query(
      'UPDATE Usuarios SET contrasena = $1, version_sesion = $2 WHERE id_usuario = $3', 
      [hashedPassword, newVersionSesion, usuario.id_usuario]
    );

    // Revocar todas las demás sesiones activas en la base de datos
    if (req.user.sessionId) {
      await pool.query(
        "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND id_sesion != $2 AND estado = 'activa'",
        [usuario.id_usuario, req.user.sessionId]
      );
    }

    // Generar un nuevo JWT firmado con la versión de sesión actualizada y el mismo ID de sesión
    const token = jwt.sign(
      { 
        id_usuario: usuario.id_usuario, 
        id_rol: usuario.id_rol,
        version_sesion: newVersionSesion,
        sessionId: req.user.sessionId
      }, 
      process.env.JWT_SECRET || 'fallback_secret_key',
      { expiresIn: '7d' }
    );

    res.status(200).json({ 
      mensaje: 'Contraseña actualizada exitosamente.',
      token: token
    });
  } catch (error) {
    console.error('Error en /api/update-password:', error);
    res.status(500).json({ error: 'Error en el servidor al intentar cambiar la contraseña.' });
  }
});

// ==========================================
// NUEVA RUTA 8: VERIFICAR ESTADO DE SESIÓN (/api/check-session)
// ==========================================
app.post('/api/check-session', async (req, res) => {
  const { id_usuario, version_local } = req.body;

  try {
    const query = await pool.query('SELECT version_sesion FROM Usuarios WHERE id_usuario = $1', [id_usuario]);
    
    if (query.rows.length === 0) {
      return res.status(404).json({ valid: false });
    }

    const versionDB = query.rows[0].version_sesion;

    if (versionDB !== version_local) {
      return res.status(401).json({ valid: false, error: 'Sesión expirada o cambiada en otro dispositivo' });
    }

    res.status(200).json({ valid: true });

  } catch (error) {
    console.error('Error al verificar sesión:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ==========================================
// RUTA 9: RUTA PROTEGIDA DE EJEMPLO (/api/perfil-protegido)
// ==========================================
app.get('/api/perfil-protegido', authMiddleware, async (req, res) => {
  // Gracias al middleware, sabemos que el token es válido y la sesión no ha expirado
  res.status(200).json({ 
    mensaje: 'Acceso concedido a ruta protegida',
    usuarioId: req.user.id_usuario,
    versionSesion: req.user.version_sesion
  });
});

// ==========================================
// RUTA 10: OBTENER SESIONES ACTIVAS DEL USUARIO (/api/auth/sessions)
// ==========================================
app.get('/api/auth/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id_usuario;
    const userRol = req.user.id_rol;
    // Solo devolvemos sesiones activas que coincidan con id_usuario y con id_rol
    const query = await pool.query(
      "SELECT id_sesion, dispositivo, fecha_creacion FROM sesiones_activas WHERE id_usuario = $1 AND id_rol = $2 AND estado = 'activa' ORDER BY fecha_creacion DESC",
      [userId, userRol]
    );
    
    // Identificar cuál de estas sesiones es la "actual"
    const sesiones = query.rows.map(sesion => ({
      ...sesion,
      es_sesion_actual: sesion.id_sesion === req.user.sessionId
    }));

    res.status(200).json({ sesiones });
  } catch (error) {
    console.error('Error al obtener sesiones:', error);
    res.status(500).json({ error: 'Error al obtener tus sesiones activas.' });
  }
});

// ==========================================
// RUTA 11: REVOCAR/DESVINCULAR UNA SESIÓN ESPECÍFICA (/api/auth/sessions/:sessionId)
// ==========================================
app.delete('/api/auth/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id_usuario;
    const userRol = req.user.id_rol;
    const sessionToRevoke = req.params.sessionId;

    // Verificar que la sesión exista y pertenezca al usuario y al rol correspondiente (Prevención IDOR)
    const checkQuery = await pool.query(
      "SELECT id_usuario, id_rol FROM sesiones_activas WHERE id_sesion = $1",
      [sessionToRevoke]
    );

    if (checkQuery.rows.length === 0) {
      return res.status(404).json({ error: 'La sesión no existe o ya fue eliminada.' });
    }

    const { id_usuario, id_rol } = checkQuery.rows[0];

    if (id_usuario !== userId || id_rol !== userRol) {
      // Intento de borrar la sesión de alguien más (IDOR)
      return res.status(403).json({ error: 'Acceso denegado. No tienes permiso para desvincular esta sesión.' });
    }

    // Actualizar el estado a 'revocada'
    await pool.query(
      "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_sesion = $1",
      [sessionToRevoke]
    );

    res.status(200).json({ mensaje: 'Dispositivo desvinculado exitosamente.' });
  } catch (error) {
    console.error('Error al revocar sesión:', error);
    res.status(500).json({ error: 'Error al intentar desvincular el dispositivo.' });
  }
});
// ==========================================
// RUTA: LOGIN EXCLUSIVO ADMINISTRADOR (Paso 1: Credenciales y Envío de Código)
// ==========================================
app.post('/api/login-admin', async (req, res) => {
  const { email, password } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();

    // Buscar al usuario
    const userQuery = await pool.query(
      'SELECT id_usuario, nombre, id_rol, estado_cuenta, contrasena FROM Usuarios WHERE correo = $1', 
      [emailFormateado]
    );

    if (userQuery.rows.length === 0) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

    const usuario = userQuery.rows[0];

    // Validar contraseña primero
    const contraseñaValida = await bcrypt.compare(password, usuario.contrasena);
    if (!contraseñaValida) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

    // Verificar que el rol sea de administrador (id_rol = 3)
    if (usuario.id_rol !== 3) {
      return res.status(403).json({ error: 'Acceso denegado. Credenciales no válidas para el panel web administrativo.' });
    }

    if (usuario.estado_cuenta === 'No verificado') {
      return res.status(403).json({ error: 'Tu cuenta administrativa aún no está verificada.' });
    }

    // Generar código de 6 dígitos para mayor seguridad en 2FA
    const tokenGenerado = Math.floor(100000 + Math.random() * 900000).toString();

    // Invalidar códigos de login anteriores que no se usaron
    await pool.query(
      `UPDATE tokens_temporales SET estado_uso = 'expirado' WHERE id_usuario = $1 AND tipo_accion = 'login_admin' AND estado_uso = 'sin usar'`,
      [usuario.id_usuario]
    );

    // Guardar el nuevo código
    await pool.query(
      `INSERT INTO tokens_temporales (id_usuario, token, tipo_accion, estado_uso) VALUES ($1, $2, $3, $4)`,
      [usuario.id_usuario, tokenGenerado, 'login_admin', 'sin usar']
    );

    // Enviar el correo
    const mailOptions = {
      from: '"Click & Serve - Seguridad" <projectcys1@gmail.com>', 
      to: emailFormateado,
      subject: 'Código de acceso al panel - Click & Serve',
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <h2>Autenticación de Dos Factores</h2>
          <p>Hola ${usuario.nombre}, se ha detectado un intento de inicio de sesión en tu cuenta administrativa.</p>
          <p>Ingresa el siguiente código de seguridad para acceder al dashboard:</p>
          <h1 style="letter-spacing: 5px; color: #0A192F; background-color: #F8FAFC; padding: 15px; border-radius: 8px; display: inline-block;">
            ${tokenGenerado}
          </h1>
          <p style="color: #7A8C9E; font-size: 12px; margin-top: 20px;">Si no intentaste iniciar sesión, cambia tu contraseña de inmediato.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    
    // Respondemos que se requiere el 2FA, NO devolvemos el JWT todavía
    res.status(200).json({ 
      mensaje: 'Credenciales correctas. Código enviado al correo.',
      requiere2FA: true 
    });

  } catch (error) {
    console.error('Error en /api/login-admin:', error);
    res.status(500).json({ error: 'Error en el servidor al intentar iniciar sesión' });
  }
});

// ==========================================
// RUTA: VALIDAR CÓDIGO ADMIN Y GENERAR SESIÓN (Paso 2: Entrega de JWT)
// ==========================================
app.post('/api/verify-login-admin', async (req, res) => {
  const { email, token } = req.body;

  try {
    const emailFormateado = email.trim().toLowerCase();
    
    // Obtener datos del usuario
    const userQuery = await pool.query(
      'SELECT id_usuario, id_rol, version_sesion FROM Usuarios WHERE correo = $1 AND id_rol = 3', 
      [emailFormateado]
    );

    if (userQuery.rows.length === 0) return res.status(404).json({ error: 'Usuario administrador no encontrado.' });
    const usuario = userQuery.rows[0];

    // Verificar el código 2FA
    const tokenQuery = await pool.query(
      `SELECT id_token FROM tokens_temporales WHERE id_usuario = $1 AND token = $2 AND tipo_accion = 'login_admin' AND estado_uso = 'sin usar'`,
      [usuario.id_usuario, token]
    );

    if (tokenQuery.rows.length === 0) return res.status(400).json({ error: 'Código de seguridad incorrecto o expirado.' });
    const idToken = tokenQuery.rows[0].id_token;

    // Marcar código como usado
    await pool.query(`UPDATE tokens_temporales SET estado_uso = 'usado' WHERE id_token = $1`, [idToken]);

    // Crear la sesión en la base de datos
    const dispositivo = req.headers['user-agent'] || 'Panel Web Administrativo';
    const sesionResult = await pool.query(
      `INSERT INTO sesiones_activas (id_usuario, id_rol, dispositivo) VALUES ($1, $2, $3) RETURNING id_sesion`,
      [usuario.id_usuario, usuario.id_rol, dispositivo]
    );
    const sessionId = sesionResult.rows[0].id_sesion;

    // Generar el JWT final
    const jwtToken = jwt.sign(
      { 
        id_usuario: usuario.id_usuario, 
        id_rol: usuario.id_rol,
        version_sesion: usuario.version_sesion || 1,
        sessionId: sessionId
      }, 
      process.env.JWT_SECRET || 'fallback_secret_key',
      { expiresIn: '8h' } // Las sesiones de admin suelen expirar más rápido por seguridad
    );

    res.status(200).json({ 
      mensaje: 'Acceso autorizado',
      usuario: usuario,
      token: jwtToken
    });

  } catch (error) {
    console.error('Error en /api/verify-login-admin:', error);
    res.status(500).json({ error: 'Error al verificar el código de seguridad' });
  }
});
// ==========================================
// RUTA 12: DESVINCULAR TODAS LAS DEMÁS SESIONES (/api/auth/sessions)
// ==========================================
app.delete('/api/auth/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id_usuario;
    const userRol = req.user.id_rol;
    const currentSessionId = req.user.sessionId; // El ID de la sesión actual

    // Actualizamos a revocada cualquier sesión activa del usuario que NO sea la actual
    await pool.query(
      "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_usuario = $1 AND id_rol = $2 AND id_sesion != $3 AND estado = 'activa'",
      [userId, userRol, currentSessionId]
    );

    res.status(200).json({ mensaje: 'Todas las demás sesiones han sido cerradas exitosamente.' });
  } catch (error) {
    console.error('Error al revocar todas las sesiones:', error);
    res.status(500).json({ error: 'Error al intentar cerrar las sesiones.' });
  }
});
// ==========================================
// RUTA 13: CERRAR SESIÓN (LOGOUT) (/api/logout)
// ==========================================
app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    if (req.user && req.user.sessionId) {
      await pool.query(
        "UPDATE sesiones_activas SET estado = 'revocada' WHERE id_sesion = $1",
        [req.user.sessionId]
      );
    }
    res.status(200).json({ mensaje: 'Sesión cerrada exitosamente en el servidor.' });
  } catch (error) {
    console.error('Error en /api/logout:', error);
    res.status(500).json({ error: 'Error al intentar cerrar la sesión en el servidor.' });
  }
});

// Encender el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});