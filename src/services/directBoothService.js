/**
 * Orquestación DIRECTA de cámara + impresora — SOLO para demo temporal
 * (BOOTH_MODE=direct). Emite la misma secuencia de eventos que dslrBooth
 * mandaría por Triggers, para que el frontend no note ninguna diferencia
 * entre este modo y el modo real.
 *
 * Cuando haya NUC + dslrBooth: cambiar BOOTH_MODE a "dslrbooth" en .env y
 * ESTE ARCHIVO YA NO SE USA — no hay que tocar rutas ni frontend.
 */
const config = require('../config');
const sessionState = require('../sessionState');
const cameraService = require('./cameraService');
const printerService = require('./printerService');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runDirectSession() {
  try {
    console.log('[directBoothService] Iniciando sesión directa (BOOTH_MODE=direct)');
    sessionState.recordBoothEvent('session_start', 'PrintDirect');

    console.log(`[directBoothService] Iniciando countdown: ${config.camera.countdownSeconds}s`);
    sessionState.recordBoothEvent('countdown_start', String(config.camera.countdownSeconds));
    for (let elapsed = 1; elapsed <= config.camera.countdownSeconds; elapsed++) {
      await sleep(1000);
      const percent = Math.round((elapsed / config.camera.countdownSeconds) * 100);
      sessionState.recordBoothEvent('countdown', String(percent));
      console.log(`[directBoothService] Countdown: ${percent}%`);
    }

    console.log('[directBoothService] Disparando captura...');
    sessionState.recordBoothEvent('capture_start');
    const photoPath = await cameraService.capturePhoto();
    console.log(`[directBoothService] Foto capturada: ${photoPath}`);
    sessionState.recordBoothEvent('file_download', photoPath);

    console.log('[directBoothService] Procesando foto...');
    sessionState.recordBoothEvent('processing_start', photoPath, photoPath);

    console.log(`[directBoothService] Enviando a impresora: ${config.printer.name}`);
    sessionState.recordBoothEvent('printing', photoPath, String(config.printer.copies), config.printer.name);
    await printerService.printPhoto(photoPath);
    console.log('[directBoothService] Impresión completada');

    sessionState.recordBoothEvent('session_end');
    console.log('[directBoothService] Sesión finalizada exitosamente');
  } catch (err) {
    console.error('[directBoothService] Error durante sesión:', err.message, err.stack);
    sessionState.recordBoothEvent('session_error', err.message);
    throw err;
  }
}

module.exports = { runDirectSession };
