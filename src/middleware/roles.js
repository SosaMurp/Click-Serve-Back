const { fail } = require('../lib/http');

const ROL = { CLIENTE: 1, TECNICO: 2, ADMIN: 3 };

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(Number(req.user?.id_rol))) {
      return fail(res, 403, 'ROLE_FORBIDDEN', 'Esta acción no está disponible para tu tipo de cuenta.');
    }
    return next();
  };
}

function requireApproved(req, res, next) {
  if (req.user?.aprobado) return next();
  const message = Number(req.user?.id_rol) === ROL.TECNICO
    ? 'Tu cuenta de técnico está en revisión de documentos. Podrás aceptar y gestionar servicios cuando sea aprobada.'
    : 'Tu cuenta está en revisión. Podrás solicitar servicios cuando sea aprobada.';
  return fail(res, 403, 'ACCOUNT_PENDING', message);
}

module.exports = { ROL, requireRole, requireApproved };
