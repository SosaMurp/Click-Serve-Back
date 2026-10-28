// Adaptador para un proveedor que valide la credencial contra la lista nominal del INE y compare la
// selfie con la foto de la credencial (p. ej. Verificamex, Nubarium, Truora o MetaMap).
// Queda APAGADO: sin INE_PROVIDER no se llama a nadie y la verificación sigue siendo la propia
// (services/ineVerifier.js). Para activarlo hay que contratar el servicio, poner INE_PROVIDER e
// INE_PROVIDER_KEY y escribir aquí la llamada de ese proveedor según su documentación.

function isEnabled() {
  return Boolean(process.env.INE_PROVIDER && process.env.INE_PROVIDER_KEY);
}

// { frente, reverso, selfie }: buffers de imagen; datos: { curp, nombre, apellidos, fecha_nacimiento }.
// Debe devolver { valida: boolean, en_lista_nominal: boolean, rostro_coincide: boolean, referencia: string }.
async function validarEnListaNominal(/* { frente, reverso, selfie, datos } */) {
  const error = new Error(isEnabled()
    ? `El proveedor ${process.env.INE_PROVIDER} no tiene integración todavía.`
    : 'No hay proveedor de validación de INE configurado.');
  error.code = 'PROVIDER_DISABLED';
  throw error;
}

module.exports = { isEnabled, validarEnListaNominal };
