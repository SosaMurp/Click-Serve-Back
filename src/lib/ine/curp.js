const { nameWords } = require('./nombres');

// CURP (RENAPO): 4 letras del nombre, fecha AAMMDD, sexo, estado, 3 consonantes internas,
// homoclave (dígito si nació antes de 2000, letra desde 2000) y dígito verificador.
const STATES = 'AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE';
const CURP_RE = new RegExp(`^[A-Z][AEIOUX][A-Z]{2}\\d{6}[HMX](${STATES})[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\\d$`);
const DICT = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

function curpCheckDigit(base17) {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += DICT.indexOf(base17[i]) * (18 - i);
  return (10 - (sum % 10)) % 10;
}

function realDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Devuelve los datos de la CURP si la estructura, la fecha y el dígito verificador son válidos; si no, null.
function parseCurp(value) {
  const curp = String(value || '').trim().toUpperCase();
  if (!CURP_RE.test(curp)) return null;
  if (curpCheckDigit(curp.slice(0, 17)) !== Number(curp[17])) return null;
  const year = (/\d/.test(curp[16]) ? 1900 : 2000) + Number(curp.slice(4, 6));
  const month = Number(curp.slice(6, 8));
  const day = Number(curp.slice(8, 10));
  if (!realDate(year, month, day)) return null;
  const fechaNacimiento = `${year}-${curp.slice(6, 8)}-${curp.slice(8, 10)}`;
  return { curp, fechaNacimiento, sexo: curp[10], estado: curp.slice(11, 13) };
}

// El OCR confunde letras y números: se corrigen según la posición (dígitos en la fecha y el verificador).
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6', T: '7' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G', 7: 'T' };
const DIGIT_POS = new Set([4, 5, 6, 7, 8, 9, 17]);

function fixCurpCandidate(word) {
  return [...word].map((ch, i) => (DIGIT_POS.has(i) ? TO_DIGIT[ch] || ch : i === 16 ? ch : TO_LETTER[ch] || ch)).join('');
}

function findCurp(text) {
  const tokens = String(text || '').toUpperCase().replace(/[^A-Z0-9Ñ]+/g, ' ').split(' ');
  for (const token of tokens) {
    for (let i = 0; i + 18 <= token.length; i += 1) {
      const found = parseCurp(fixCurpCandidate(token.slice(i, i + 18)));
      if (found) return found.curp;
    }
  }
  return null;
}

// Las 4 primeras letras de la CURP salen del nombre: inicial y primera vocal interna del paterno,
// inicial del materno (X si no hay) e inicial del nombre (saltando MARÍA o JOSÉ en nombres compuestos).
// RENAPO cambia letras por X en palabras altisonantes y en la Ñ: una X siempre se acepta.
function curpMatchesName(curp, { nombre, apellidos }) {
  const c = String(curp || '').toUpperCase();
  const ap = nameWords(apellidos);
  const nom = nameWords(nombre);
  if (c.length !== 18 || !ap.length || !nom.length) return false;
  const paterno = ap[0];
  const materno = ap[1];
  const nombreBase = nom.length > 1 && ['MARIA', 'MA', 'JOSE', 'J'].includes(nom[0]) ? nom[1] : nom[0];
  const vowel = (paterno.slice(1).match(/[AEIOU]/) || ['X'])[0];
  const expected = [paterno[0], vowel, materno ? materno[0] : 'X', nombreBase[0]];
  return expected.every((ch, i) => c[i] === ch || c[i] === 'X');
}

module.exports = { parseCurp, findCurp, curpMatchesName, curpCheckDigit };
