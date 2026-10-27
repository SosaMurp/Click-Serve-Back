const nodemailer = require('nodemailer');
const { HttpError } = require('./http');
const { isDevelopment } = require('./env');

// Mensajes simulados en desarrollo y pruebas (para inspección); se conservan los últimos 200.
const outbox = [];
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = process.env.SMTP_HOST
    ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
    : nodemailer.createTransport({
      service: process.env.SMTP_SERVICE || 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  return transporter;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function codeEmailHtml({ titulo, saludo, texto, code }) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#14213D">
    <h2 style="margin:0 0 12px">${escapeHtml(titulo)}</h2>
    <p>${escapeHtml(saludo)}</p>
    <p>${escapeHtml(texto)}</p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:bold;background:#F4F1EA;padding:16px;text-align:center;border-radius:12px">${escapeHtml(code)}</p>
    <p style="color:#6B7280;font-size:12px">Si no solicitaste este código, ignora este mensaje.</p>
  </div>`;
}

// Solo en desarrollo o pruebas se simula el envío (consola y outbox acotado). Fuera de desarrollo, sin
// proveedor configurado se responde 503: los códigos de un solo uso nunca terminan en los logs.
function simulate(record, line, code) {
  if (!isDevelopment()) {
    console.error(`${record.canal} sin proveedor configurado: no se envió "${record.subject}".`);
    throw new HttpError(503, code, 'No pudimos enviarte el código en este momento. Intenta más tarde.');
  }
  outbox.push(record);
  if (outbox.length > 200) outbox.shift();
  if (process.env.NODE_ENV !== 'test') console.log(line);
  return { simulated: true };
}

async function sendMail({ to, subject, html, code }) {
  const record = { canal: 'EMAIL', to, subject, code, fecha: new Date() };
  const t = process.env.NODE_ENV === 'test' ? null : getTransporter();
  if (!t) return simulate(record, `[correo simulado] Para ${to}: ${subject}${code ? ` — código ${code}` : ''}`, 'MAIL_UNAVAILABLE');
  await t.sendMail({ from: process.env.SMTP_FROM || `"Click & Serve" <${process.env.SMTP_USER}>`, to, subject, html });
  return { simulated: false };
}

// RF-10: canal SMS con Twilio cuando hay credenciales; sin ellas se simula en consola.
async function sendSms({ to, body, code }) {
  const record = { canal: 'SMS', to, subject: body, code, fecha: new Date() };
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tokenTw, TWILIO_FROM: from } = process.env;
  if (process.env.NODE_ENV === 'test' || !sid || !tokenTw || !from) {
    return simulate(record, `[SMS simulado] Para ${to}: ${body}`, 'SMS_UNAVAILABLE');
  }
  const twilio = require('twilio')(sid, tokenTw);
  const phone = String(to).startsWith('+') ? to : `+52${String(to).replace(/\D/g, '')}`;
  await twilio.messages.create({ to: phone, from, body });
  return { simulated: false };
}

async function sendCode({ canal = 'EMAIL', usuario, code, titulo, texto }) {
  if (canal === 'SMS') {
    if (!usuario.telefono) throw Object.assign(new Error('Sin teléfono registrado'), { code: 'NO_PHONE' });
    return sendSms({ to: usuario.telefono, body: `Click & Serve: tu código es ${code}. Vence en 15 minutos.`, code });
  }
  return sendMail({
    to: usuario.correo,
    subject: `${titulo} - Click & Serve`,
    html: codeEmailHtml({ titulo, saludo: `Hola ${usuario.nombre || ''},`, texto, code }),
    code,
  });
}

module.exports = { sendMail, sendSms, sendCode, outbox, escapeHtml };
