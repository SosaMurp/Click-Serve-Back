const crypto = require('crypto');
const multer = require('multer');
const { HttpError } = require('./http');
const { isDevelopment } = require('./env');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

function filesSecret() {
  const secret = process.env.FILES_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (!isDevelopment()) throw new Error('FILES_SECRET o JWT_SECRET es obligatorio fuera de desarrollo (NODE_ENV=development)');
  return 'dev-files-secret';
}

function hmac(payload) {
  return crypto.createHmac('sha256', filesSecret()).update(payload).digest('base64url');
}

// RNF-26: URL firmada con vigencia corta (5 min por defecto). La firma es la autorización.
function signFileUrl(idArchivo, ttlSeconds = 300) {
  if (!idArchivo) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/api/archivos/${idArchivo}?exp=${exp}&sig=${hmac(`${idArchivo}.${exp}`)}`;
}

function verifyFileSignature(idArchivo, exp, sig) {
  const expNum = Number(exp);
  if (!expNum || expNum < Math.floor(Date.now() / 1000) || typeof sig !== 'string') return false;
  const expected = Buffer.from(hmac(`${idArchivo}.${expNum}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Fotos de una solicitud (tabla solicitud_imagenes) con la misma firma de vigencia corta.
function signRequestImageUrl(idImagen, ttlSeconds = 600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/api/solicitudes/imagenes/${idImagen}?exp=${exp}&sig=${hmac(`img.${idImagen}.${exp}`)}`;
}

function verifyRequestImageSignature(idImagen, exp, sig) {
  return verifyFileSignature(`img.${idImagen}`, exp, sig);
}

async function saveFile(db, { owner, buffer, mime, name, categoria }) {
  const { rows } = await db.query(
    `INSERT INTO archivos (id_propietario, categoria, nombre, tipo_mime, tamano, contenido)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_archivo`,
    [owner ?? null, categoria, String(name || 'archivo').slice(0, 255), mime, buffer.length, buffer]
  );
  return rows[0].id_archivo;
}

// Multer en memoria con lista blanca de tipos; los archivos van a la tabla archivos (bytea).
function uploader({ types = IMAGE_TYPES, maxFiles = 5, maxSizeMb = 5 } = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMb * 1024 * 1024, files: maxFiles },
    fileFilter: (_req, file, cb) => {
      if (types.includes(file.mimetype)) return cb(null, true);
      return cb(new HttpError(400, 'UNSUPPORTED_FILE', 'Formato de archivo no permitido. Usa JPG, PNG, WEBP o PDF.'));
    },
  });
}

module.exports = { signFileUrl, verifyFileSignature, signRequestImageUrl, verifyRequestImageSignature, saveFile, uploader, IMAGE_TYPES, DOCUMENT_TYPES };
