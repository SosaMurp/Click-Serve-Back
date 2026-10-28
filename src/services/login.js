const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { audit } = require('../lib/audit');
const { sendCode } = require('../lib/mailer');
const { publicUser, createSession } = require('./users');

const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// Cierre común de un inicio de sesión ya autenticado (contraseña, Google o Apple):
// si la cuenta tiene 2FA se crea el reto; si no, se abre la sesión.
async function finishLogin(req, res, user) {
  if (user['2FA_Activo'] === true || user.totp_secreto) {
    // Cuentas con la bandera anterior sin app autenticadora reciben el código por correo.
    let codigoHash = null;
    if (!user.totp_secreto) {
      const code = newCode();
      codigoHash = await bcrypt.hash(code, 8);
      await sendCode({ canal: 'EMAIL', usuario: user, code, titulo: 'Código de acceso', texto: 'Usa este código para terminar de iniciar sesión.' });
    }
    const { rows } = await getPool().query(
      'INSERT INTO retos_2fa (id_usuario, codigo_hash) VALUES ($1, $2) RETURNING id_reto, expira',
      [user.id_usuario, codigoHash]
    );
    return res.status(200).json({
      requires2FA: true,
      reto: rows[0].id_reto,
      expira: rows[0].expira,
      metodo: user.totp_secreto ? 'TOTP' : 'EMAIL',
      correo: user.correo,
      mensaje: user.totp_secreto
        ? 'Ingresa el código de 6 dígitos de tu app autenticadora.'
        : 'Te enviamos un código de 6 dígitos a tu correo.',
    });
  }

  const { token } = await createSession(user, req);
  audit({ ...req, user: { id_usuario: user.id_usuario } }, 'LOGIN', 'usuario', user.id_usuario);
  return res.status(200).json({ mensaje: 'Inicio de sesión exitoso', usuario: publicUser(user), token });
}

module.exports = { finishLogin, newCode };
