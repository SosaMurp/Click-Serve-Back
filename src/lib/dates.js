// Fechas del negocio en la hora de Lázaro Cárdenas (zona del centro de México). Con toISOString la
// fecha es la de UTC, que después de las 18:00 locales ya es "mañana" y rechazaba servicios para hoy.
const ZONA = 'America/Mexico_City';

function nowMx(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { fecha: `${parts.year}-${parts.month}-${parts.day}`, hora: `${parts.hour}:${parts.minute}` };
}

function todayMx(now = new Date()) {
  return nowMx(now).fecha;
}

module.exports = { nowMx, todayMx };
