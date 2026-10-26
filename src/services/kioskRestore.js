/**
 * Regresar la cabina a su estado "en espera" cuando una sesión termina en
 * error DESPUÉS de haberle pasado el control a LumaBooth.
 *
 * En una sesión normal esto lo hace el Trigger session_end (ver
 * routes/dslrbooth.js): pantalla de bloqueo de LumaBooth y foco de vuelta al
 * navegador del kiosco. Pero en dos fallas no llega ningún session_end:
 *  - Grupo 2 (falla_inicio): startSession() truena justo después de quitarle
 *    el lockscreen a LumaBooth y pasarle el foco.
 *  - Grupo 3 (colgada): LumaBooth deja de mandar Triggers y el watchdog corta
 *    la sesión por booth_timeout.
 * Sin esto, tras la cancelación automática LumaBooth quedaba en primer plano
 * y sin lockscreen: el cliente podía tocarlo y tomarse fotos gratis
 * (encontrado en las pruebas en Debian, 23-oct-2026).
 *
 * Solo aplica con BOOTH_MODE=dslrbooth. Nunca tira error (best-effort, igual
 * que en session_end).
 */
const config = require('../config');

function restoreKioskAfterFailure(reason) {
  if (config.booth.mode !== 'dslrbooth') return Promise.resolve();
  // Lazy require: estos servicios no deben cargarse en otros modos.
  const dslrboothService = require('./dslrboothService');
  const windowFocusService = require('./windowFocusService');
  console.log(`[kioskRestore] regresando lockscreen y foco al kiosco tras falla (${reason})`);
  return dslrboothService
    .tryShowLockscreen()
    .then(() => windowFocusService.tryFocusBrowserPersistent())
    .catch((err) => console.warn(`[kioskRestore] no se pudo restaurar el kiosco: ${err.message}`));
}

module.exports = { restoreKioskAfterFailure };
