// Lázaro Cárdenas, Michoacán (RD-009): centro por defecto cuando no hay ubicación.
const DEFAULT_CENTER = { latitud: 17.9583, longitud: -102.2 };

// Distancia de gran círculo en SQL (km). Sin PostGIS en local (RNF-38 queda como dependencia de despliegue).
function haversineSql(lat1, lng1, lat2, lng2) {
  return `(6371 * 2 * ASIN(SQRT(
    POWER(SIN(RADIANS((${lat2}) - (${lat1})) / 2), 2) +
    COS(RADIANS(${lat1})) * COS(RADIANS(${lat2})) * POWER(SIN(RADIANS((${lng2}) - (${lng1})) / 2), 2)
  )))`;
}

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitud - a.latitud);
  const dLng = toRad(b.longitud - a.longitud);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitud)) * Math.cos(toRad(b.latitud)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// ETA aproximada a 25 km/h en ciudad; sin API de tráfico en tiempo real (RNF-43 parcial).
function etaMinutes(km) {
  if (km == null || Number.isNaN(km)) return null;
  return Math.max(1, Math.round((km / 25) * 60));
}

function parseCoord(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

module.exports = { DEFAULT_CENTER, haversineSql, haversineKm, etaMinutes, parseCoord };
