const axios = require('axios');
const config = require('../config');

/**
 * Dispara una sesión en dslrBooth (LumaBooth for Windows).
 * Ya validado en la Fase 0 (Plan_Validacion_Camara_Impresora.md) que este
 * endpoint funciona vía GET con password en query string:
 *   GET http://localhost:1500/api/start?mode=print&password=XXX
 *
 * NOTA: dslrBooth debe estar en la pantalla de inicio para que responda bien.
 */
async function startSession({ mode = 'print' } = {}) {
  const url = `${config.dslrbooth.baseUrl}/api/start`;

  const response = await axios.get(url, {
    params: {
      mode,
      password: config.dslrbooth.apiPassword,
    },
    timeout: 5000,
  });

  // Respuesta esperada: { ApiVersion, Command, IsSuccessful, ErrorMessage }
  if (!response.data || !response.data.IsSuccessful) {
    throw new Error(
      `dslrBooth respondió sin éxito: ${response.data && response.data.ErrorMessage}`
    );
  }

  return response.data;
}

// TODO: revisar API doc para confirmar endpoints de show/exit lock screen
// y de compartir sesión por email/SMS, si el negocio los llega a necesitar.

module.exports = { startSession };
