/**
 * Monitoreo de hardware para producción (BOOTH_MODE=dslrbooth) y windirect —
 * ver src/hardwareWatch.js para el loop que usa esto y
 * claude/Propuesta_Monitoreo_Camara_Impresora.md (doc del proyecto) para el
 * diseño completo.
 *
 * IMPORTANTE: la detección de cámara aquí es DISTINTA de
 * windowsCameraService.js#detectCamera(). Esa otra función abre una sesión
 * real por digiCamControl (PTP) y solo tiene sentido en BOOTH_MODE=windirect
 * (sin dslrBooth corriendo). Aquí en cambio solo confirmamos que el sistema
 * operativo ve la cámara conectada por USB — vía WMI (Win32_PnPEntity),
 * SIN abrir ninguna sesión — precisamente para no competir por el mismo
 * canal PTP/USB que dslrBooth usa en producción.
 */
const { execFile } = require('child_process');
const config = require('../config');
const windowsPrinterService = require('./windowsPrinterService');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Confirma, vía WMI (Win32_PnPEntity), que Windows ve conectada la cámara
 * con el VID/PID configurado (config.camera.vid/pid — Nikon D7200 por
 * default). Solo presencia por USB, no abre sesión PTP.
 *
 * Limitación conocida (aceptada en el diseño): esto NO detecta fallas
 * "suaves" como batería baja o tarjeta SD llena — solo si el sistema
 * operativo sigue viendo el dispositivo conectado.
 */
async function checkCameraPresence() {
  const vid = config.camera.vid;
  const pid = config.camera.pid;
  const filter = `VID_${vid}&PID_${pid}`;

  const script = `
$ErrorActionPreference = 'Stop'
$match = Get-CimInstance -ClassName Win32_PnPEntity | Where-Object { $_.DeviceID -like '*${filter}*' }
if ($match) { Write-Output 'PRESENT' } else { Write-Output 'ABSENT' }
`.trim();

  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const present = stdout.trim().startsWith('PRESENT');
    return present
      ? { ok: true, detail: null }
      : { ok: false, detail: `Cámara (${filter}) no detectada por USB — revisa el cable y que esté encendida` };
  } catch (err) {
    console.error('[hardwareMonitorService] checkCameraPresence falló:', err.message, err.stderr);
    return {
      ok: false,
      detail: `No se pudo consultar la presencia de la cámara vía WMI: ${err.message}`,
    };
  }
}

/**
 * Corre los dos chequeos (cámara + impresora) en paralelo y devuelve un
 * resultado agregado. `reasons` trae un detalle por cada falla encontrada
 * (puede haber más de una a la vez).
 */
async function checkAll() {
  const [camera, printer] = await Promise.all([checkCameraPresence(), windowsPrinterService.getPrinterStatus()]);

  const reasons = [camera, printer].filter((r) => !r.ok).map((r) => r.detail);

  return {
    ok: reasons.length === 0,
    reasons,
    camera,
    printer,
  };
}

/**
 * Verificación específica POST-sesión (distinta de checkAll(), que es el
 * chequeo genérico de fondo) — usada por src/sessionState.js para confirmar
 * que una impresión que dslrBooth SÍ reportó (Trigger "printing" visto)
 * realmente haya salido.
 *
 * Exige AMBAS condiciones a la vez, no una sola:
 *  - getPrinterStatus() con problema (fuera de línea, atascada, sin papel,
 *    etc.) — por sí sola es ambigua: en pruebas reales (19-sep-2026) la
 *    impresora "parpadeó" fuera de línea y recuperada varias veces seguidas
 *    sin que eso implicara que ningún trabajo se haya perdido.
 *  - Un trabajo TODAVÍA pendiente en la cola de esa impresora — por sí sola
 *    también es ambigua: podría ser un trabajo a punto de completarse con
 *    normalidad, o uno que ya se limpió de la cola (los trabajos pueden
 *    desaparecer de Win32_PrintJob en 1-2s en impresoras conectadas
 *    directo, incluso cuando sí imprimieron bien).
 * Juntas sí son una confirmación razonable: un trabajo que sigue ahí Y la
 * impresora reportando problema, al mismo tiempo, es la combinación que
 * indica que ese trabajo específico no se pudo completar.
 */
async function checkPrintFailure() {
  const printerStatus = await windowsPrinterService.getPrinterStatus();
  if (printerStatus.ok) {
    return { failed: false };
  }

  const pendingJobs = await windowsPrinterService.getPendingJobCount();
  if (pendingJobs > 0) {
    return { failed: true, detail: printerStatus.detail, pendingJobs };
  }

  return { failed: false };
}

module.exports = { checkCameraPresence, checkAll, checkPrintFailure };
