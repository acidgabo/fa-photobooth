/**
 * Orquestación DIRECTA de cámara + impresora en Windows — SOLO para demo
 * con hardware real cuando aún no hay dslrBooth instalado
 * (BOOTH_MODE=windirect). Emite la misma secuencia de eventos que
 * dslrBooth mandaría por Triggers, para que el frontend no note ninguna
 * diferencia entre este modo y el modo real.
 *
 * Es el equivalente Windows de directBoothService.js (que usa gphoto2 +
 * CUPS y es SOLO para Linux). Cuando llegue dslrBooth: cambiar BOOTH_MODE
 * a "dslrbooth" en .env y NI ESTE ARCHIVO NI directBoothService.js SE
 * USAN — no hay que tocar rutas ni frontend.
 */
const config = require('../config');
const sessionState = require('../sessionState');
const cameraService = require('./windowsCameraService');
const printerService = require('./windowsPrinterService');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runDirectSession() {
  try {
    console.log('[windirectBoothService] Iniciando sesión directa Windows (BOOTH_MODE=windirect)');
    sessionState.recordBoothEvent('session_start', 'PrintDirect');

    console.log(`[windirectBoothService] Iniciando countdown: ${config.camera.countdownSeconds}s`);
    sessionState.recordBoothEvent('countdown_start', String(config.camera.countdownSeconds));
    for (let elapsed = 1; elapsed <= config.camera.countdownSeconds; elapsed++) {
      await sleep(1000);
      const percent = Math.round((elapsed / config.camera.countdownSeconds) * 100);
      sessionState.recordBoothEvent('countdown', String(percent));
      console.log(`[windirectBoothService] Countdown: ${percent}%`);
    }

    console.log('[windirectBoothService] Disparando captura...');
    sessionState.recordBoothEvent('capture_start');
    const photoPath = await cameraService.capturePhoto();
    console.log(`[windirectBoothService] Foto capturada: ${photoPath}`);
    sessionState.recordBoothEvent('file_download', photoPath);

    console.log('[windirectBoothService] Procesando foto...');
    sessionState.recordBoothEvent('processing_start', photoPath, photoPath);

    console.log(`[windirectBoothService] Enviando a impresora: ${config.printer.name}`);
    sessionState.recordBoothEvent('printing', photoPath, String(config.printer.copies), config.printer.name);
    await printerService.printPhoto(photoPath);
    console.log('[windirectBoothService] Impresión completada');

    sessionState.recordBoothEvent('session_end');
    console.log('[windirectBoothService] Sesión finalizada exitosamente');
  } catch (err) {
    console.error('[windirectBoothService] Error durante sesión:', err.message, err.stack);
    sessionState.recordBoothEvent('session_error', err.message);
    throw err;
  }
}

module.exports = { runDirectSession };
