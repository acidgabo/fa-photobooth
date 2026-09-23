/**
 * Catálogo de paquetes — ÚNICA fuente de verdad para nombres y precios.
 * El frontend los muestra vía GET /api/packages, pero el precio que
 * realmente se cobra SIEMPRE se busca aquí en el backend a partir del
 * packageId — nunca se confía en un monto que mande el navegador.
 *
 * Para personalizar: edita este archivo (nombre, precio). No hay que
 * tocar nada más — el frontend pinta lo que haya aquí.
 *
 * Actualizado 22-sep-2026: Karen pidió volver a un solo paquete ($120,
 * "2 tiras", sin fijar 3 o 4 tomas) después de ver el mockup con 2
 * paquetes — le gustó el resultado visual y pidió dejar las dos tiras de
 * muestra (3 y 4 fotos) en la misma tarjeta en vez de separarlas en dos
 * paquetes con precios distintos. Por eso ya no hay un campo "photos"
 * aquí: las imágenes de las tiras (blanco3.jpg / negro4.jpg) quedaron
 * fijas en public/index.html, no derivadas del catálogo.
 */
const PACKAGES = [
  { id: 'premium', name: 'PREMIUM', price: 120 },
];

function getAll() {
  return PACKAGES;
}

function getById(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

module.exports = { getAll, getById };
