// Comparación de nombres de la credencial (leídos por OCR) contra los que la persona registró.
// Sin acentos ni signos, y tolerando los errores típicos de lectura (1 por I, 0 por O, una letra cambiada).

const PARTICLES = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'MC', 'MAC', 'VON', 'VAN', 'DA', 'DAS', 'DER', 'DI', 'DIE', 'DD', 'EL', 'LE', 'LES', 'MI']);
const OCR_DIGITS = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palabras significativas de un nombre (sin partículas como DE, LA, DEL).
function nameWords(value, { ocr = false } = {}) {
  let text = normalizeName(value);
  if (ocr) text = text.replace(/[0-9]/g, (d) => OCR_DIGITS[d] || d);
  return text.split(' ').filter((w) => w && !PARTICLES.has(w));
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const tolerance = (word) => (word.length <= 3 ? 0 : word.length <= 7 ? 1 : 2);

// Todas las palabras registradas deben aparecer (con tolerancia) en lo que leyó el OCR.
function namesMatch(ocrText, registered) {
  const read = nameWords(ocrText, { ocr: true });
  const wanted = nameWords(registered);
  if (!wanted.length || !read.length) return false;
  return wanted.every((w) => read.some((r) => levenshtein(r, w) <= tolerance(w)));
}

module.exports = { normalizeName, nameWords, namesMatch, levenshtein, PARTICLES };
