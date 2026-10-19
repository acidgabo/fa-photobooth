/**
 * Hardware simulado (HARDWARE_MODE=mock) — misma interfaz que los servicios
 * reales de Windows (hardwareMonitorService + windowsPrinterService), pero
 * el estado de la cámara y la impresora lo da el mock de LumaBooth
 * (mocks/mock-dslrbooth.js, GET /mock/hardware) según el escenario elegido.
 *
 * Así el escenario controla en un solo lugar las dos cosas que necesita
 * cada caso de cancelación automática: los Triggers que manda "LumaBooth"
 * y lo que "ve" el backend al revisar el hardware.
 *
 * Si el mock no responde se reporta como falla de cámara — igual que en la
 * cabina cuando la consulta WMI falla — para que el comportamiento sea el
 * mismo que en producción.
 */
const axios = require('axios');
const config = require('../config');

async function readState() {
  const { data } = await axios.get(config.hardwareMonitor.mockUrl, { timeout: 3000 });
  return data;
}

async function checkCameraPresence() {
  try {
    const { camera } = await readState();
    return camera.present
      ? { ok: true, detail: null }
      : { ok: false, detail: camera.detail || 'Cámara no detectada por USB (simulado)' };
  } catch (err) {
    return { ok: false, detail: `No se pudo consultar el hardware simulado (${config.hardwareMonitor.mockUrl}): ${err.message}` };
  }
}

async function getPrinterStatus() {
  try {
    const { printer } = await readState();
    return printer.ok ? { ok: true, detail: null } : { ok: false, detail: printer.detail || 'Impresora con problema (simulado)' };
  } catch (err) {
    return { ok: false, detail: `No se pudo consultar el hardware simulado (${config.hardwareMonitor.mockUrl}): ${err.message}` };
  }
}

async function checkAll() {
  const [camera, printer] = await Promise.all([checkCameraPresence(), getPrinterStatus()]);
  const reasons = [camera, printer].filter((r) => !r.ok).map((r) => r.detail);
  return { ok: reasons.length === 0, reasons, camera, printer };
}

// Misma regla que la real: impresora con problema Y un trabajo pendiente en cola.
async function checkPrintFailure() {
  try {
    const { printer } = await readState();
    if (!printer.ok && printer.pendingJobs > 0) {
      return { failed: true, detail: printer.detail || 'Impresora con problema (simulado)', pendingJobs: printer.pendingJobs };
    }
    return { failed: false };
  } catch (_) {
    return { failed: false };
  }
}

async function clearPrintQueue() {
  try {
    const { data } = await axios.post(`${config.hardwareMonitor.mockUrl}/clear-queue`, {}, { timeout: 3000 });
    return { ok: true, cleared: data.cleared || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { checkCameraPresence, checkAll, checkPrintFailure, clearPrintQueue };
