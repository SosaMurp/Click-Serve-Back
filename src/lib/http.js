// Respuestas de error uniformes: { error: <mensaje para la persona>, code: <código estable para la app> }.
class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

// Lanza un 400 con el primer campo inválido; evita escribir el mismo if en cada ruta.
function requireFields(body, fields) {
  for (const [field, label] of Object.entries(fields)) {
    const value = body?.[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new HttpError(400, 'VALIDATION_ERROR', `${label} es obligatorio.`, { field });
    }
  }
}

function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return fail(res, err.status, err.code, err.message, err.extra);
  }
  if (err?.type === 'entity.too.large') {
    return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'El archivo o los datos enviados son demasiado grandes.');
  }
  if (err?.type === 'entity.parse.failed') {
    return fail(res, 400, 'INVALID_JSON', 'La petición no tiene un formato válido.');
  }
  if (err?.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Cada archivo puede pesar máximo 5 MB.' : 'No se pudo procesar el archivo enviado.';
    return fail(res, 400, 'UPLOAD_ERROR', message);
  }
  if (err?.code === '22P02') {
    return fail(res, 400, 'VALIDATION_ERROR', 'Alguno de los datos enviados no tiene un formato válido.');
  }
  console.error(`Error en ${req.method} ${req.originalUrl}:`, err);
  return fail(res, 500, 'SERVER_ERROR', 'Error en el servidor. Intenta más tarde.');
}

function notFound(req, res) {
  return fail(res, 404, 'NOT_FOUND', 'Recurso no encontrado.');
}

module.exports = { HttpError, fail, requireFields, errorHandler, notFound };
