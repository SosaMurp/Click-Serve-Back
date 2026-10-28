const path = require('path');
const sharp = require('sharp');
const { createWorker, OEM, PSM } = require('tesseract.js');
const { parseCurp, findCurp, curpMatchesName } = require('../lib/ine/curp');
const { parseMrzTd1, findMrz } = require('../lib/ine/mrz');
const { namesMatch, normalizeName, levenshtein } = require('../lib/ine/nombres');

// Verificación propia de la credencial INE (sin servicios de pago): calidad de la foto, OCR con
// tesseract.js y comprobaciones de CURP, MRZ y nombre contra los datos del registro.
// Prueba que la foto es de una INE con datos coherentes; no que el INE la emitió ni que está en la
// lista nominal (eso lo haría un proveedor con convenio: services/ineProvider.js).

const MOTIVOS = {
  noIne: 'No reconocimos una credencial del INE. Pon el frente de tu credencial dentro del marco, con buena luz y sin reflejos.',
  noCurp: 'No pudimos leer tu CURP en la credencial. Acércala un poco, con buena luz y sin reflejos.',
  datos: 'Los datos de la credencial no coinciden con los que escribiste. Revisa tu nombre y fecha de nacimiento, o usa tu propia credencial.',
  noMrz: 'No pudimos leer las tres líneas de letras y números de la parte de abajo del reverso. Acércala, con buena luz y sin reflejos.',
  otroReverso: 'Este reverso no corresponde al frente que tomaste. Toma el reverso de la misma credencial.',
  vencida: 'Tu credencial está vencida. Usa una credencial vigente.',
};

// ───────── Calidad de la foto ─────────
// Umbrales calibrados con imágenes de prueba a 640 px de ancho; son tolerantes a propósito:
// lo que pase de aquí lo filtra el OCR.
const UMBRAL = { oscuro: 50, claro: 240, reflejo: 0.15, nitidez: 25, minLado: 500 };
// La ruta es pública: una imagen de pocos KB con dimensiones enormes haría que sharp reservara cientos
// de MB al decodificarla. El encabezado se lee sin decodificar y se rechaza antes (50 MP sobra para
// una foto de celular; la app manda fotos de ≤1600 px).
const MAX_PIXELES = 50_000_000;

async function analyzeQuality(buffer) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    return { ok: false, motivo: 'No pudimos abrir la foto. Tómala otra vez.' };
  }
  if ((meta.width || 0) * (meta.height || 0) > MAX_PIXELES) {
    return { ok: false, motivo: 'La foto es demasiado grande. Tómala otra vez con la cámara de la app.' };
  }
  if (Math.max(meta.width || 0, meta.height || 0) < UMBRAL.minLado) {
    return { ok: false, motivo: 'La foto es muy pequeña. Acerca la credencial a la cámara.' };
  }
  const { data, info } = await sharp(buffer).rotate().resize({ width: 640 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let sum = 0;
  let sat = 0;
  for (const v of data) {
    sum += v;
    if (v >= 250) sat += 1;
  }
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      lapSum += lap;
      lapSq += lap * lap;
      n += 1;
    }
  }
  const brillo = sum / data.length;
  const reflejo = sat / data.length;
  const nitidez = lapSq / n - (lapSum / n) ** 2;
  const medidas = { brillo: Math.round(brillo), reflejo: Number(reflejo.toFixed(3)), nitidez: Math.round(nitidez) };
  if (brillo < UMBRAL.oscuro) return { ok: false, motivo: 'La foto salió muy oscura. Busca más luz.', ...medidas };
  if (brillo > UMBRAL.claro) return { ok: false, motivo: 'La foto salió muy clara. Evita la luz directa.', ...medidas };
  if (reflejo > UMBRAL.reflejo) return { ok: false, motivo: 'Hay mucho reflejo. Inclina un poco la credencial y vuelve a tomarla.', ...medidas };
  if (nitidez < UMBRAL.nitidez) return { ok: false, motivo: 'La foto salió borrosa. Mantén la credencial quieta y toma otra.', ...medidas };
  return { ok: true, ...medidas };
}

// ───────── OCR ─────────
const langPath = (code) => path.join(path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)), '4.0.0_best_int');
let workers = null;

function getWorkers() {
  if (!workers) {
    workers = (async () => {
      const opts = (code) => ({ langPath: langPath(code), gzip: true, cacheMethod: 'none' });
      const spa = await createWorker('spa', OEM.LSTM_ONLY, opts('spa'));
      const mrz = await createWorker('eng', OEM.LSTM_ONLY, opts('eng'));
      await mrz.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      return { spa, mrz };
    })().catch((e) => {
      workers = null;
      throw e;
    });
  }
  return workers;
}

async function closeOcr() {
  if (!workers) return;
  const w = await workers;
  workers = null;
  await Promise.all([w.spa.terminate(), w.mrz.terminate()]);
}

// Imagen para el OCR: orientada según EXIF, a 1400 px, girada si se pide, recortada a la parte de
// abajo (crop = fracción que se quita arriba) y en escala de grises con el contraste estirado.
async function prepare(buffer, { rotate = 0, crop = 0 } = {}) {
  const upright = await sharp(buffer).rotate().resize({ width: 1400 }).toBuffer();
  const turned = rotate ? await sharp(upright).rotate(rotate).toBuffer() : upright;
  let img = sharp(turned);
  if (crop) {
    const { width, height } = await img.metadata();
    const top = Math.round(height * crop);
    img = sharp(turned).extract({ left: 0, top, width, height: height - top });
  }
  return img.greyscale().normalize().png().toBuffer();
}

async function ocrText(buffer, { rotate = 0 } = {}) {
  const { spa } = await getWorkers();
  const { data } = await spa.recognize(await prepare(buffer, { rotate }));
  return data.text || '';
}

async function ocrMrz(buffer, { rotate = 0 } = {}) {
  const { mrz } = await getWorkers();
  for (const crop of [0.5, 0]) {
    const { data } = await mrz.recognize(await prepare(buffer, { rotate, crop }));
    const lines = findMrz(data.text);
    if (lines) return lines;
  }
  return null;
}

// ───────── Comprobaciones ─────────
const KEYWORDS = ['INSTITUTO NACIONAL ELECTORAL', 'CREDENCIAL PARA VOTAR', 'MEXICO', 'NOMBRE', 'DOMICILIO', 'CLAVE DE ELECTOR', 'CURP', 'FECHA DE NACIMIENTO', 'SEXO', 'VIGENCIA'];

// Palabra clave presente aunque el OCR cambie una o dos letras (en las frases largas).
function hasKeyword(text, keyword) {
  if (text.includes(keyword)) return true;
  const allowed = keyword.length >= 15 ? 2 : keyword.length >= 8 ? 1 : 0;
  if (!allowed) return false;
  for (let i = 0; i + keyword.length <= text.length; i += 1) {
    if (levenshtein(text.slice(i, i + keyword.length), keyword) <= allowed) return true;
  }
  return false;
}

const result = (id, ok, detalle) => ({ id, ok, detalle });

async function verifyFront(buffer, registro) {
  let text = normalizeName(await ocrText(buffer));
  let found = KEYWORDS.filter((k) => hasKeyword(text, k));
  if (found.length < 2) {
    // Credencial al revés: se intenta una vez girada.
    const turned = normalizeName(await ocrText(buffer, { rotate: 180 }));
    const foundTurned = KEYWORDS.filter((k) => hasKeyword(turned, k));
    if (foundTurned.length > found.length) {
      text = turned;
      found = foundTurned;
    }
  }
  const checks = [result('textos', found.length >= 2, found.length >= 2 ? `Se leyeron ${found.length} textos de la credencial.` : 'No se leyeron los textos de una credencial del INE.')];
  if (found.length < 2) return { ok: false, comprobaciones: checks, motivo: MOTIVOS.noIne };

  const curp = findCurp(text);
  const datos = curp ? parseCurp(curp) : null;
  checks.push(result('curp', !!datos, datos ? 'CURP con estructura y dígito verificador válidos.' : 'No se encontró una CURP válida.'));
  if (!datos) return { ok: false, comprobaciones: checks, motivo: MOTIVOS.noCurp };

  checks.push(result('fecha_nacimiento', datos.fechaNacimiento === registro.fecha_nacimiento, 'La fecha de nacimiento de la CURP se compara con la del registro.'));
  checks.push(result('iniciales', curpMatchesName(datos.curp, registro), 'Las iniciales de la CURP se comparan con el nombre registrado.'));
  checks.push(result('nombre', namesMatch(text, `${registro.nombre} ${registro.apellidos}`), 'El nombre de la credencial se compara con el registrado.'));
  const sexoLeido = (/SEXO\s*([HM])\b/.exec(text) || [])[1];
  if (sexoLeido) checks.push(result('sexo', sexoLeido === datos.sexo, 'El sexo impreso se compara con el de la CURP.'));

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    comprobaciones: checks,
    motivo: ok ? undefined : MOTIVOS.datos,
    datos: ok ? { curp: datos.curp, sexo: datos.sexo, fecha_nacimiento: datos.fechaNacimiento } : undefined,
  };
}

async function verifyBack(buffer, registro, frente) {
  let lines = await ocrMrz(buffer);
  if (!lines) lines = await ocrMrz(buffer, { rotate: 180 });
  const mrz = lines ? parseMrzTd1(lines) : null;
  const checks = [result('mrz', !!mrz?.valido, mrz?.valido ? 'Zona de lectura (IDMEX) con dígitos verificadores válidos.' : 'No se leyó una zona de lectura válida.')];
  if (!mrz?.valido) return { ok: false, comprobaciones: checks, motivo: MOTIVOS.noMrz };

  checks.push(result('fecha_nacimiento', mrz.fechaNacimiento === frente.fecha_nacimiento, 'La fecha del reverso se compara con la del frente.'));
  checks.push(result('sexo', mrz.sexo === frente.sexo, 'El sexo del reverso se compara con el del frente.'));
  checks.push(result('nombre', namesMatch(`${mrz.apellidos} ${mrz.nombres}`, `${registro.nombre} ${registro.apellidos}`), 'El nombre del reverso se compara con el registrado.'));
  const mismatch = checks.some((c) => !c.ok);
  const hoy = new Date().toISOString().slice(0, 10);
  checks.push(result('vigencia', mrz.vigencia >= hoy, `Vigente hasta ${mrz.vigencia}.`));

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    comprobaciones: checks,
    motivo: ok ? undefined : mismatch ? MOTIVOS.otroReverso : MOTIVOS.vencida,
    datos: ok ? { vigencia: mrz.vigencia } : undefined,
  };
}

// registro: { nombre, apellidos, fecha_nacimiento }; frente: datos del ticket del frente (para el reverso).
async function verifyIne({ buffer, lado, registro, frente }) {
  const calidad = await analyzeQuality(buffer);
  if (!calidad.ok) {
    return { ok: false, comprobaciones: [result('calidad', false, calidad.motivo)], motivo: calidad.motivo };
  }
  const r = lado === 'reverso' ? await verifyBack(buffer, registro, frente) : await verifyFront(buffer, registro);
  return { ...r, comprobaciones: [result('calidad', true, 'Foto nítida y con buena luz.'), ...r.comprobaciones] };
}

module.exports = { verifyIne, analyzeQuality, closeOcr, MOTIVOS };
