const test = require('node:test');
const assert = require('node:assert/strict');
const { todayMx, nowMx } = require('../src/lib/dates');

test('la fecha de hoy es la de México, no la de UTC (después de las 18:00 en Lázaro Cárdenas)', () => {
  // 27 de octubre, 19:30 en Lázaro Cárdenas = 28 de octubre 01:30 UTC.
  const tarde = new Date('2026-10-28T01:30:00Z');
  assert.equal(todayMx(tarde), '2026-10-27');
  assert.deepEqual(nowMx(tarde), { fecha: '2026-10-27', hora: '19:30' });
});
