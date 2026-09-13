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

/**
 * Pantalla de bloqueo de LumaBooth — endpoints confirmados por prueba
 * directa contra el booth real (ver claude/Integración dslrbooth.md, doc
 * del proyecto, sección "Endpoints de dslrBooth API"). La doc oficial en
 * Postman sugiere paths distintos (`/api/showlockscreen`, `/api/lock`,
 * `/api/show/lockscreen`, etc.) que en la práctica NO funcionan — los
 * únicos que responden `IsSuccessful: true` son estos dos, con `/exit`
 * (no `/hide`) para ocultarla:
 *   GET /api/lockscreen/show?password=XXX
 *   GET /api/lockscreen/exit?password=XXX
 *
 * Uso: (1) red de seguridad del swap de foco kiosco↔LumaBooth (ver
 * windowFocusService.js) y (2) pantalla de "Cabina fuera de servicio"
 * cuando el monitoreo de hardware detecte una falla (pendiente de
 * implementar, ver Propuesta_Monitoreo_Camara_Impresora.md).
 */
async function showLockscreen() {
  const url = `${config.dslrbooth.baseUrl}/api/lockscreen/show`;

  const response = await axios.get(url, {
    params: { password: config.dslrbooth.apiPassword },
    timeout: 5000,
  });

  if (!response.data || !response.data.IsSuccessful) {
    throw new Error(
      `dslrBooth respondió sin éxito (lockscreen/show): ${response.data && response.data.ErrorMessage}`
    );
  }

  return response.data;
}

async function exitLockscreen() {
  const url = `${config.dslrbooth.baseUrl}/api/lockscreen/exit`;

  const response = await axios.get(url, {
    params: { password: config.dslrbooth.apiPassword },
    timeout: 5000,
  });

  if (!response.data || !response.data.IsSuccessful) {
    throw new Error(
      `dslrBooth respondió sin éxito (lockscreen/exit): ${response.data && response.data.ErrorMessage}`
    );
  }

  return response.data;
}

// Wrappers "silenciosos": nunca tiran error hacia quien los llama, solo
// loguean. Son hardening (convivencia de pantallas / cabina fuera de
// servicio) — no deben poder romper el flujo real de pago/sesión si
// dslrBooth no responde (por ejemplo, corriendo contra el mock, que no
// implementa estos endpoints — el warning ahí es esperado y no es un error).
async function tryShowLockscreen() {
  try {
    await showLockscreen();
    console.log('[dslrboothService] lockscreen/show OK');
  } catch (err) {
    console.warn(`[dslrboothService] lockscreen/show falló (no bloqueante): ${err.message}`);
  }
}

async function tryExitLockscreen() {
  try {
    await exitLockscreen();
    console.log('[dslrboothService] lockscreen/exit OK');
  } catch (err) {
    console.warn(`[dslrboothService] lockscreen/exit falló (no bloqueante): ${err.message}`);
  }
}

module.exports = {
  startSession,
  showLockscreen,
  exitLockscreen,
  tryShowLockscreen,
  tryExitLockscreen,
};
