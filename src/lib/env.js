// Los atajos de desarrollo (secretos de respaldo, cobros sandbox, códigos impresos en consola) solo
// existen cuando NODE_ENV dice explícitamente development o test. Sin NODE_ENV, o con cualquier otro
// valor, el servidor se comporta como producción y falla cerrado.
function isDevelopment() {
  return ['development', 'test'].includes(process.env.NODE_ENV);
}

module.exports = { isDevelopment };
