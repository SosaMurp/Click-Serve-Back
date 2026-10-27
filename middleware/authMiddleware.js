const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const MASTER_EMAILS = ['jesusabar123@gmail.com', 'luisgallo123123@gmail.com', 'jesusabar123123@gmail.com'];

const authMiddleware = async (req, res, next) => {
  // 1. Extraer el token de los headers
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ error: 'Acceso denegado. No se proporcionó un token.' });
  }

  // 2. Formato esperado: "Bearer <token>"
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado. Token mal formado.' });
  }

  try {
    // 3. Decodificar y verificar el token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key');

    // 4. Lógica de invalidación por version_sesion (Global - Cambio de contraseña)
    const userQuery = await pool.query('SELECT version_sesion, correo, estado_cuenta, id_rol, identidad_verificada FROM Usuarios WHERE id_usuario = $1', [decoded.id_usuario]);
    if (userQuery.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado.' });
    }

    const dbUser = userQuery.rows[0];
    const versionDB = dbUser.version_sesion;
    if (versionDB !== decoded.version_sesion) {
      return res.status(401).json({ error: 'Sesión expirada globalmente por cambio de contraseña.' });
    }

    // 5. Lógica de invalidación selectiva (Desvinculación remota validando ID y Rol)
    if (decoded.sessionId) {
      const sessionQuery = await pool.query(
        'SELECT estado FROM sesiones_activas WHERE id_sesion = $1 AND id_usuario = $2 AND id_rol = $3', 
        [decoded.sessionId, decoded.id_usuario, decoded.id_rol]
      );
      
      if (sessionQuery.rows.length === 0) {
        return res.status(401).json({ error: 'Sesión no encontrada, ya no existe o rol inválido.' });
      }

      if (sessionQuery.rows[0].estado === 'revocada') {
        return res.status(401).json({ error: 'Tu sesión en este dispositivo fue desvinculada remotamente.' });
      }
    }

    // 6. Todo está bien, inyectamos los datos en la petición
    req.user = { 
      ...decoded, 
      correo: dbUser.correo, 
      estado_cuenta: dbUser.estado_cuenta,
      identidad_verificada: dbUser.identidad_verificada,
      verificado: dbUser.identidad_verificada === true
    };
    next();
  } catch (error) {
    console.error('Error en authMiddleware:', error);
    res.status(401).json({ error: 'Token inválido o expirado.' });
  }
};

module.exports = authMiddleware;
module.exports.MASTER_EMAILS = MASTER_EMAILS;
