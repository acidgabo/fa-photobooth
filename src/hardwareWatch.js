/**
 * Estado + loop de monitoreo de hardware (cámara + impresora) — ver
 * src/services/hardwareMonitorService.js para los chequeos en sí y
 * claude/Propuesta_Monitoreo_Camara_Impresora.md (doc del proyecto) para el
 * diseño completo.
 *
 * Reglas del diseño:
 *  - Solo corre en modos "Windows" (dslrbooth, windirect) — los chequeos son
 *    vía WMI/PowerShell, no existen en BOOTH_MODE=direct (Linux).
 *  - El loop de fondo SOLO revisa mientras sessionState.status === 'idle'
 *    (no tiene caso interrumpir una sesión ya pagada/en curso). Antes de
 *    aceptar un pago (POST /api/pay) SIEMPRE se hace ADEMÁS un chequeo
 *    síncrono fresco vía checkNow() — ese es la garantía real, el loop de
 *    fondo es solo para poder avisar (Discord) ANTES de que llegue un
 *    cliente a una cabina ya rota.
 *  - Mientras está marcada "fuera de servicio" el loop acelera su cadencia
 *    (retryPollIntervalMs) para detectar la recuperación solo, sin
 *    necesitar reiniciar el backend.
 */
const config = require('./config');
const sessionState = require('./sessionState');
const hardwareMonitorService = require('./services/hardwareMonitorService');
const notifyService = require('./services/notifyService');

let current = { ok: true, reasons: [], checkedAt: null };
let loopTimer = null;

function getStatus() {
  return current;
}

function applyResult(result) {
  const wasOk = current.ok;
  current = { ok: result.ok, reasons: result.reasons, checkedAt: new Date().toISOString() };

  if (wasOk && !result.ok) {
    console.warn(`[hardwareWatch] cabina fuera de servicio: ${result.reasons.join(' | ')}`);
    notifyService.notifyHardwareDown(result.reasons.join(' | '));
  } else if (!wasOk && result.ok) {
    console.log('[hardwareWatch] hardware recuperado — cabina de vuelta en servicio');
    notifyService.notifyHardwareRecovered();
  }

  return current;
}

const WINDOWS_CAPABLE_MODES = new Set(['dslrbooth', 'windirect']);

/**
 * Chequeo síncrono forzado, sin importar el estado de la sesión ni la
 * cadencia del loop de fondo. Usado por POST /api/pay como última
 * confirmación antes de aceptar un cobro.
 *
 * En BOOTH_MODE=direct (demo Linux) no hay WMI/PowerShell disponible, así
 * que esto siempre devuelve ok:true ahí — el monitoreo de hardware está
 * fuera de alcance para ese modo (ver claude/Propuesta_Monitoreo_Camara_
 * Impresora.md, solo cubre dslrbooth/windirect).
 */
async function checkNow() {
  if (!config.hardwareMonitor.enabled || !WINDOWS_CAPABLE_MODES.has(config.booth.mode)) {
    return current; // sin cambios: se queda en { ok: true, ... } por default
  }
  const result = await hardwareMonitorService.checkAll();
  return applyResult(result);
}

async function tick() {
  const sessionStatus = sessionState.get().status;

  // Fuera de "idle" no interrumpimos una sesión en curso — solo
  // reprogramamos para revisar más tarde.
  if (sessionStatus === 'idle') {
    try {
      await checkNow();
    } catch (err) {
      console.error('[hardwareWatch] chequeo de hardware falló inesperadamente:', err.message);
    }
  }

  const nextDelay = current.ok
    ? config.hardwareMonitor.idlePollIntervalMs
    : config.hardwareMonitor.retryPollIntervalMs;

  loopTimer = setTimeout(tick, nextDelay);
}

function start() {
  if (!config.hardwareMonitor.enabled) {
    console.log('[hardwareWatch] HARDWARE_MONITOR_ENABLED=false — monitoreo desactivado por configuración');
    return;
  }
  if (!WINDOWS_CAPABLE_MODES.has(config.booth.mode)) {
    console.log(`[hardwareWatch] BOOTH_MODE=${config.booth.mode} no soporta monitoreo WMI — desactivado`);
    return;
  }
  if (loopTimer) return; // ya iniciado

  console.log(
    `[hardwareWatch] monitoreo activo (cámara VID_${config.camera.vid}&PID_${config.camera.pid}, ` +
      `impresora "${config.printer.name || '(sin configurar)'}"), revisando cada ` +
      `${config.hardwareMonitor.idlePollIntervalMs / 1000}s mientras la cabina esté libre`
  );
  tick();
}

function stop() {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

module.exports = { start, stop, checkNow, getStatus };
