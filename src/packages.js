/**
 * Catálogo de paquetes — ÚNICA fuente de verdad para nombres y precios.
 * El frontend los muestra vía GET /api/packages, pero el precio que
 * realmente se cobra SIEMPRE se busca aquí en el backend a partir del
 * packageId — nunca se confía en un monto que mande el navegador.
 *
 * Para personalizar: edita este archivo (nombre, precio, fotos). No hay
 * que tocar nada más — el frontend pinta lo que haya aquí.
 *
 * Actualizado 21-sep-2026 al aplicar el diseño de Karen (mockup "ELIGE TU
 * PAQUETE" compartido por WhatsApp/Drive): pasa de 1 paquete único
 * (PREMIUM $120, 6 fotos) a los 2 paquetes de su mockup — "2 tiras" es
 * fijo en las dos opciones (lo pinta el frontend), por eso no es un campo
 * aquí. CONFIRMAR CON GABO/KAREN antes de comitear: este cambio afecta lo
 * que se cobra de verdad.
 */
const PACKAGES = [
  { id: 'paquete-3-tomas', name: '3 TOMAS', price: 100, photos: 3 },
  { id: 'paquete-4-tomas', name: '4 TOMAS', price: 130, photos: 4 },
];

function getAll() {
  return PACKAGES;
}

function getById(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

module.exports = { getAll, getById };
