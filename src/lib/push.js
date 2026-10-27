const { getPool } = require('../db/pool');

// Notificación push vía Expo (requiere build nativo con token ExponentPushToken). Nunca bloquea la operación.
async function sendPush(userId, title, body, data = {}) {
  if (process.env.NODE_ENV === 'test' || !userId) return;
  try {
    const { rows } = await getPool().query('SELECT push_token, preferencias FROM usuarios WHERE id_usuario = $1', [userId]);
    const row = rows[0];
    if (!row?.push_token?.startsWith('ExponentPushToken') || row.preferencias?.notificaciones_push === false) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: row.push_token, sound: 'default', title, body, data }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (error) {
    console.error('No se pudo enviar la notificación push:', error.message);
  }
}

module.exports = { sendPush };
