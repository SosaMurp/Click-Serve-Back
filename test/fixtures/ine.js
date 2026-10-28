// Credenciales INE sintéticas para las pruebas (no son documentos reales): se dibujan como SVG y
// sharp las convierte en JPEG, con el texto y la MRZ que el OCR debe leer.
const sharp = require('sharp');
const { mrzCheckDigit } = require('../../src/lib/ine/mrz');

const PERSONA = {
  nombre: 'José Luis',
  apellidos: 'Pérez García',
  fecha_nacimiento: '1985-03-12',
  curp: 'PEGL850312HMNRRS08',
  sexo: 'H',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function frenteSvg({ curp = PERSONA.curp, nombres = ['PEREZ', 'GARCIA', 'JOSE LUIS'], sexo = 'H', nacimiento = '12/03/1985' } = {}) {
  const line = (x, y, text, size = 30, weight = 'bold') => `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" font-weight="${weight}" fill="#111">${esc(text)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760">
    <rect width="1200" height="760" rx="36" fill="#f3efe6"/>
    ${line(40, 70, 'MÉXICO', 34)}
    ${line(260, 70, 'INSTITUTO NACIONAL ELECTORAL', 34)}
    ${line(260, 115, 'CREDENCIAL PARA VOTAR', 30)}
    <rect x="40" y="160" width="260" height="330" fill="#c9c3b8"/>
    ${line(340, 190, 'NOMBRE', 24)}
    ${nombres.map((n, i) => line(340, 230 + i * 40, n, 32)).join('')}
    ${line(340, 380, 'DOMICILIO', 24)}
    ${line(340, 415, 'C AV LAZARO CARDENAS 100 COL CENTRO', 26, 'normal')}
    ${line(340, 470, 'CLAVE DE ELECTOR PRGRJS85031216H400', 26)}
    ${line(340, 525, `CURP ${curp}`, 30)}
    ${line(340, 580, `FECHA DE NACIMIENTO ${nacimiento}`, 26)}
    ${line(340, 635, `SEXO ${sexo}`, 26)}
    ${line(340, 690, 'VIGENCIA 2023 - 2033', 26)}
  </svg>`;
}

function mrzLines({ cic = '123456789', nacimiento = '850312', sexo = 'H', vigencia = '331231', nombres = 'PEREZ<GARCIA<<JOSE<LUIS', alterar = false } = {}) {
  const l1 = `IDMEX${cic}${mrzCheckDigit(cic)}<<4364051134577`.slice(0, 30);
  const base = `${nacimiento}${mrzCheckDigit(nacimiento)}${sexo}${vigencia}${mrzCheckDigit(vigencia)}MEX<03<<12345<`;
  const composite = mrzCheckDigit(l1.slice(5, 30) + base.slice(0, 7) + base.slice(8, 15) + base.slice(18, 29));
  let l2 = `${base.padEnd(29, '<').slice(0, 29)}${composite}`;
  if (alterar) l2 = `${l2.slice(0, 5)}${(Number(l2[5]) + 1) % 10}${l2.slice(6)}`;
  return [l1, l2, nombres.padEnd(30, '<').slice(0, 30)];
}

function reversoSvg(opts = {}) {
  const lines = mrzLines(opts);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760">
    <rect width="1200" height="760" rx="36" fill="#f3efe6"/>
    <rect x="60" y="60" width="300" height="300" fill="#222"/>
    <text x="420" y="120" font-family="Arial" font-size="26" fill="#111">FIRMA</text>
    ${lines.map((l, i) => `<text x="60" y="${560 + i * 64}" font-family="Courier New" font-size="44" font-weight="bold" fill="#111" xml:space="preserve">${esc(l)}</text>`).join('')}
  </svg>`;
}

const toJpeg = (svg, { blur } = {}) => {
  let img = sharp(Buffer.from(svg)).flatten({ background: '#ffffff' });
  if (blur) img = img.blur(blur);
  return img.jpeg({ quality: 90 }).toBuffer();
};

module.exports = {
  PERSONA,
  mrzLines,
  frente: (opts) => toJpeg(frenteSvg(opts)),
  frenteBorroso: () => toJpeg(frenteSvg(), { blur: 9 }),
  reverso: (opts) => toJpeg(reversoSvg(opts)),
  // Una foto que no es credencial: un paisaje liso con un poco de texto.
  otraFoto: () => toJpeg(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="#7fb3d5"/><rect y="460" width="1200" height="300" fill="#6c8e3a"/><text x="80" y="200" font-family="Arial" font-size="60" fill="#fff">VACACIONES 2024</text></svg>`),
};
