const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCurp, findCurp, curpMatchesName, curpCheckDigit } = require('../src/lib/ine/curp');
const { mrzCheckDigit, parseMrzTd1, findMrz } = require('../src/lib/ine/mrz');
const { normalizeName, namesMatch } = require('../src/lib/ine/nombres');

// José Luis Pérez García, 12/03/1985, hombre, Michoacán (dígito verificador calculado con el algoritmo de RENAPO).
const CURP_JOSE = 'PEGL850312HMNRRS08';

test('una CURP válida da su fecha de nacimiento, sexo y estado', () => {
  assert.deepEqual(parseCurp(CURP_JOSE), { curp: CURP_JOSE, fechaNacimiento: '1985-03-12', sexo: 'H', estado: 'MN' });
});

test('la homoclave con letra indica nacimiento desde el año 2000', () => {
  assert.equal(parseCurp('GALA010101MDFRPNA3').fechaNacimiento, '2001-01-01');
  assert.equal(parseCurp('GALA010101MDFRPNA3').sexo, 'M');
});

test('una CURP con el dígito verificador cambiado no es válida', () => {
  assert.equal(parseCurp('PEGL850312HMNRRS09'), null);
});

test('una CURP con una fecha que no existe no es válida', () => {
  const base = 'PEGL850231HMNRRS0';
  assert.equal(parseCurp(base + curpCheckDigit(base)), null);
});

test('una CURP con un estado que no existe no es válida', () => {
  assert.equal(parseCurp('PEGL850312HZZRRS08'), null);
});

test('la CURP se encuentra en el texto del OCR aunque confunda letras y números', () => {
  const ocr = 'NOMBRE\nPEREZ\nGARCIA\nJOSE LUIS\nCURP PEGL85O312HMNRRS08 AÑO DE REGISTRO 2003 01';
  assert.equal(findCurp(ocr), CURP_JOSE);
  assert.equal(findCurp('INSTITUTO NACIONAL ELECTORAL sin curp'), null);
});

test('las iniciales de la CURP coinciden con el nombre registrado', () => {
  assert.equal(curpMatchesName(CURP_JOSE, { nombre: 'José Luis', apellidos: 'Pérez García' }), true);
  assert.equal(curpMatchesName('LOMA920704MMNPRN01', { nombre: 'Ana', apellidos: 'López Martínez' }), true);
  assert.equal(curpMatchesName(CURP_JOSE, { nombre: 'Juan', apellidos: 'López Ruiz' }), false);
});

test('el dígito verificador de la MRZ coincide con el ejemplar oficial de ICAO 9303', () => {
  assert.equal(mrzCheckDigit('D23145890'), 7);
  assert.equal(mrzCheckDigit('740812'), 2);
  assert.equal(mrzCheckDigit('120415'), 9);
});

// MRZ de prueba con el formato de la INE (TD1: 3 líneas de 30), con sus dígitos calculados.
function ineMrz({ cic = '123456789', nacimiento = '850312', sexo = 'H', vigencia = '331231', nombres = 'PEREZ<GARCIA<<JOSE<LUIS' } = {}) {
  const l1 = `IDMEX${cic}${mrzCheckDigit(cic)}<<4364051134577`.padEnd(30, '<').slice(0, 30);
  const l2base = `${nacimiento}${mrzCheckDigit(nacimiento)}${sexo}${vigencia}${mrzCheckDigit(vigencia)}MEX<03<<12345<`;
  const composite = mrzCheckDigit(l1.slice(5, 30) + l2base.slice(0, 7) + l2base.slice(8, 15) + l2base.slice(18, 29));
  const l2 = `${l2base.padEnd(29, '<').slice(0, 29)}${composite}`;
  const l3 = nombres.padEnd(30, '<').slice(0, 30);
  return [l1, l2, l3];
}

test('una MRZ de INE válida da nacimiento, sexo, vigencia y nombre', () => {
  const r = parseMrzTd1(ineMrz());
  assert.equal(r.valido, true, JSON.stringify(r.errores));
  assert.equal(r.fechaNacimiento, '1985-03-12');
  assert.equal(r.sexo, 'H');
  assert.equal(r.vigencia, '2033-12-31');
  assert.equal(r.apellidos, 'PEREZ GARCIA');
  assert.equal(r.nombres, 'JOSE LUIS');
});

test('una MRZ con un dígito de la fecha alterado no es válida', () => {
  const lines = ineMrz();
  lines[1] = `850313${lines[1].slice(6)}`;
  const r = parseMrzTd1(lines);
  assert.equal(r.valido, false);
  assert.ok(r.errores.includes('fecha_nacimiento'));
});

test('una MRZ que no es de INE (no empieza con IDMEX) no se acepta', () => {
  const lines = ineMrz();
  lines[0] = `IDUTO${lines[0].slice(5)}`;
  assert.equal(parseMrzTd1(lines).valido, false);
});

test('la MRZ se encuentra en el texto del OCR aunque lleve espacios y «', () => {
  const [l1, l2, l3] = ineMrz();
  const ocr = `FIRMA\n${l1.replace(/<</g, '« ')}\n${l2}\n ${l3} \n`;
  assert.deepEqual(findMrz(ocr), [l1, l2, l3]);
  assert.equal(findMrz('sin zona de lectura'), null);
});

test('los nombres se comparan sin acentos y tolerando errores de lectura', () => {
  assert.equal(normalizeName('José Luis PÉREZ  García'), 'JOSE LUIS PEREZ GARCIA');
  assert.equal(namesMatch('PEREZ GARCIA JOSE LUIS', 'José Luis Pérez García'), true);
  assert.equal(namesMatch('PERFZ GARC1A JOSE LUlS', 'José Luis Pérez García'), true);
  assert.equal(namesMatch('JUAN LOPEZ RUIZ', 'José Luis Pérez García'), false);
});

test('el relleno final de la MRZ que el OCR lee como L vuelve a ser <', () => {
  const [l1, l2] = ineMrz();
  const lines = findMrz(`${l1}\n${l2}\nPEREZ<GARCIA<<JOSE<LUIS<<LLLLLL`);
  assert.equal(lines[2], 'PEREZ<GARCIA<<JOSE<LUIS<<<<<<<');
});

test('sin INE_PROVIDER el proveedor externo está apagado', async () => {
  const provider = require('../src/services/ineProvider');
  delete process.env.INE_PROVIDER;
  assert.equal(provider.isEnabled(), false);
  await assert.rejects(provider.validarEnListaNominal({}), { code: 'PROVIDER_DISABLED' });
});

test('una imagen de dimensiones enormes se rechaza sin decodificarla', async () => {
  const sharp = require('sharp');
  const { analyzeQuality, closeOcr } = require('../src/services/ineVerifier');
  const huge = await sharp({ create: { width: 9000, height: 7000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
  const r = await analyzeQuality(huge);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /demasiado grande/);
  await closeOcr();
});
