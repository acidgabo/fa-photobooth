/**
 * Punto único para los chequeos de hardware que usa el resto del backend
 * (sessionState.js y hardwareWatch.js). Según HARDWARE_MODE:
 *  - 'windows' (default, la cabina): los servicios reales vía WMI/PowerShell
 *    — hardwareMonitorService.js + windowsPrinterService.js, sin cambios.
 *  - 'mock' (laptop de desarrollo): mockHardwareService.js, que le pregunta
 *    al mock de LumaBooth cómo están la cámara y la impresora en el
 *    escenario actual.
 * El resto del código no sabe cuál de los dos está corriendo: pasar de la
 * laptop a la cabina es solo cambiar HARDWARE_MODE en el .env.
 */
const config = require('../config');

function provider() {
  if (config.hardwareMonitor.mode === 'mock') return require('./mockHardwareService');
  const hardwareMonitorService = require('./hardwareMonitorService');
  const windowsPrinterService = require('./windowsPrinterService');
  return {
    checkCameraPresence: hardwareMonitorService.checkCameraPresence,
    checkAll: hardwareMonitorService.checkAll,
    checkPrintFailure: hardwareMonitorService.checkPrintFailure,
    clearPrintQueue: windowsPrinterService.clearPrintQueue,
  };
}

module.exports = {
  checkCameraPresence: (...args) => provider().checkCameraPresence(...args),
  checkAll: (...args) => provider().checkAll(...args),
  checkPrintFailure: (...args) => provider().checkPrintFailure(...args),
  clearPrintQueue: (...args) => provider().clearPrintQueue(...args),
  mode: () => config.hardwareMonitor.mode,
};
