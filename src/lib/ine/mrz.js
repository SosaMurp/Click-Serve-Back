// Zona de lectura mecánica (MRZ) del reverso de la INE: formato TD1 de ICAO 9303, 3 líneas de 30.
//   1: IDMEX + CIC (9) + dígito + datos opcionales (15)
//   2: nacimiento AAMMDD + dígito, sexo (H/M), vigencia AAMMDD + dígito, MEX, opcional, dígito compuesto
//   3: APELLIDOS<<NOMBRES
const WEIGHTS = [7, 3, 1];
const charValue = (c) => (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55);

function mrzCheckDigit(value) {
  return [...String(value)].reduce((sum, c, i) => sum + charValue(c) * WEIGHTS[i % 3], 0) % 10;
}

function mrzDate(yymmdd, kind) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const nowYY = new Date().getUTCFullYear() % 100;
  const year = kind === 'birth' && yy > nowYY ? 1900 + yy : 2000 + yy;
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

const digitOk = (value, digit) => mrzCheckDigit(value) === Number(digit);

function parseMrzTd1(lines) {
  if (!Array.isArray(lines) || lines.length !== 3 || lines.some((l) => typeof l !== 'string' || l.length !== 30)) {
    return { valido: false, errores: ['formato'] };
  }
  const [l1, l2, l3] = lines;
  const errores = [];
  if (!l1.startsWith('IDMEX') || l2.slice(15, 18) !== 'MEX') errores.push('formato');
  const documento = l1.slice(5, 14);
  if (!digitOk(documento, l1[14])) errores.push('documento');
  const fechaNacimiento = mrzDate(l2.slice(0, 6), 'birth');
  if (!fechaNacimiento || !digitOk(l2.slice(0, 6), l2[6])) errores.push('fecha_nacimiento');
  const vigencia = mrzDate(l2.slice(8, 14), 'expiry');
  if (!vigencia || !digitOk(l2.slice(8, 14), l2[14])) errores.push('vigencia');
  if (!digitOk(l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29), l2[29])) errores.push('compuesto');
  // La INE usa H (hombre) y M (mujer); F se acepta como mujer por si el lector usa la letra de ICAO.
  const sexo = l2[7] === 'H' ? 'H' : l2[7] === 'M' || l2[7] === 'F' ? 'M' : null;
  const [ap = '', nom = ''] = l3.split('<<');
  const apellidos = ap.split('<').filter(Boolean).join(' ');
  const nombres = nom.split('<').filter(Boolean).join(' ');
  return { documento, fechaNacimiento, sexo, vigencia, apellidos, nombres, valido: errores.length === 0, errores };
}

// Corrige confusiones del OCR en las posiciones que solo pueden ser dígitos.
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const fixDigits = (line, positions) => [...line].map((c, i) => (positions.has(i) ? TO_DIGIT[c] || c : c)).join('');
const L1_DIGITS = new Set([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
const L2_DIGITS = new Set([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 29]);
const to30 = (line) => line.slice(0, 30).padEnd(30, '<');

function findMrz(text) {
  const lines = String(text || '')
    .toUpperCase()
    .split(/\r?\n/)
    .map((l) => l.replace(/[«‹]/g, '<<').replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, ''))
    .filter(Boolean);
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const start = lines[i].search(/[I1]DMEX/);
    if (start < 0) continue;
    const l1 = to30(`ID${lines[i].slice(start + 2)}`);
    // El relleno final de los nombres (<<<<) a veces se lee como LLLL o KKKK.
    const l3 = to30(lines[i + 2]).replace(/<[LK<]{2,}$/, (m) => '<'.repeat(m.length));
    return [fixDigits(l1, L1_DIGITS), fixDigits(to30(lines[i + 1]), L2_DIGITS), l3];
  }
  return null;
}

module.exports = { mrzCheckDigit, parseMrzTd1, findMrz };
