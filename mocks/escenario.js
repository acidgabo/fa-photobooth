/**
 * Cambia el escenario del mock de LumaBooth mientras está corriendo.
 *
 *   node mocks/escenario.js                 lista los escenarios y cuál está activo
 *   node mocks/escenario.js sin_impresion   activa ese escenario (y resetea el hardware simulado)
 *
 * El escenario aplica a las siguientes sesiones hasta que se cambie otra vez.
 * Los que dejan la cabina "fuera de servicio" (cámara/impresora con falla)
 * se quitan volviendo a "normal".
 */
require('dotenv').config();
const axios = require('axios');

const BASE = process.env.DSLRBOOTH_BASE_URL || 'http://localhost:1500';

async function main() {
  const name = process.argv[2];
  try {
    if (!name) {
      const { data } = await axios.get(`${BASE}/mock/escenarios`);
      console.log(`Escenario activo: ${data.activo}\n`);
      for (const s of data.escenarios) {
        console.log(`${s.nombre === data.activo ? '▶' : ' '} ${s.nombre}`);
        console.log(`    ${s.descripcion}`);
        console.log(`    Se espera: ${s.esperado}\n`);
      }
      return;
    }
    const { data } = await axios.post(`${BASE}/mock/escenario`, { nombre: name });
    console.log(`Escenario activo: ${data.activo}`);
    console.log(`  ${data.descripcion}`);
    console.log(`  Se espera: ${data.esperado}`);
  } catch (err) {
    if (err.response && err.response.data && err.response.data.error) {
      console.error(err.response.data.error);
      console.error('Escenarios: ' + err.response.data.escenarios.map((s) => s.nombre).join(', '));
    } else {
      console.error(`No se pudo hablar con el mock en ${BASE} (${err.message}). ¿Está corriendo "npm run mock:dslrbooth"?`);
    }
    process.exitCode = 1;
  }
}

main();
