const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidClabe, bankFromClabe, luhn, isEmail, isStrongPassword, maskClabe } = require('../src/lib/validators');

test('CLABE con dígito verificador correcto es válida', () => {
  assert.equal(isValidClabe('002010077777777771'), true);
});

test('CLABE con dígito verificador incorrecto es inválida', () => {
  assert.equal(isValidClabe('002010077777777770'), false);
});

test('CLABE con longitud distinta de 18 o con letras es inválida', () => {
  assert.equal(isValidClabe('00201007777777777'), false);
  assert.equal(isValidClabe('00201007777777777A'), false);
});

test('el banco se obtiene de los tres primeros dígitos de la CLABE', () => {
  assert.equal(bankFromClabe('002010077777777771'), 'BANAMEX');
  assert.equal(bankFromClabe('012180012345678912'), 'BBVA MÉXICO');
});

test('la CLABE se enmascara dejando solo los últimos 4 dígitos', () => {
  assert.equal(maskClabe('002010077777777771'), '•••• •••• •••• 7771');
});

test('Luhn acepta la tarjeta de prueba 4242 4242 4242 4242', () => {
  assert.equal(luhn('4242 4242 4242 4242'), true);
});

test('Luhn rechaza un número con dígito alterado', () => {
  assert.equal(luhn('4242424242424241'), false);
});

test('isEmail valida formato básico', () => {
  assert.equal(isEmail('ana@correo.mx'), true);
  assert.equal(isEmail('ana@'), false);
});

test('contraseña fuerte exige 8+ caracteres, mayúscula, minúscula y número', () => {
  assert.equal(isStrongPassword('Prueba#2026'), true);
  assert.equal(isStrongPassword('prueba2026'), false);
  assert.equal(isStrongPassword('Pr1'), false);
});
