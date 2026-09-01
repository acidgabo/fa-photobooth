/**
 * Catálogo de paquetes — ÚNICA fuente de verdad para nombres y precios.
 * El frontend los muestra vía GET /api/packages, pero el precio que
 * realmente se cobra SIEMPRE se busca aquí en el backend a partir del
 * packageId — nunca se confía en un monto que mande el navegador.
 *
 * Para personalizar: edita este archivo (nombre, precio, fotos). No hay
 * que tocar nada más — el frontend pinta lo que haya aquí.
 */
const PACKAGES = [
  { id: 'premium', name: 'PREMIUM', price: 120, photos: 6 },
];

function getAll() {
  return PACKAGES;
}

function getById(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

module.exports = { getAll, getById };
