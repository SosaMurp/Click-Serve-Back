// Saneamiento de texto libre (RNF-06/15): quita etiquetas HTML y caracteres de control.
// Las consultas usan parámetros, así que esto protege la presentación (XSS), no el SQL.
function sanitizeText(value, maxLength = 2000) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

module.exports = { sanitizeText };
