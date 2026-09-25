const config = require('./config');
const notifyService = require('./services/notifyService');
const { autoCancelSale } = require('./services/autoCancelService');
// Ninguno de estos dos depende de sessionState.js (a diferencia de
// hardwareWatch.js, que sí lo requiere) — por eso se puede llamar directo
// desde aquí sin crear una dependencia circular.
const hardwareMonitorService = require('./services/hardwareMonitorService');
const windowsPrinterService = require('./services/windowsPrinterService');

// Mismo set que WINDOWS_CAPABLE_MODES en hardwareWatch.js — los chequeos de
// cámara/impresora son vía WMI/PowerShell, no existen en BOOTH_MODE=direct
// (Linux).
const WINDOWS_CAPABLE_MODES = new Set(['dslrbooth', 'windirect']);

function hardwareChecksAvailable() {
  return config.hardwareMonitor.enabled && WINDOWS_CAPABLE_MODES.has(config.booth.mode);
}

// Margen antes de revisar si la impresión de una sesión "exitosa" (sí vimos
// el Trigger "printing") realmente salió — sin esto podríamos cachar un
// trabajo todavía en curso normal y confundirlo con una falla.
const POST_PRINT_CHECK_DELAY_MS = 5000;

// Estado en memoria de la sesión actual de la cabina.
// Suficiente para un solo NUC/una sola cabina operando a la vez.
// Si en el futuro hay más de una cabina, esto se vuelve un Map por boothId.

let state = {
  status: 'idle', // idle | awaiting_payment | payment_confirmed | booth_running | error
  package: null,
  orderId: null,
  // orderId que la PROPIA terminal NetPay genera y regresa al confirmar el
  // pago (routes/webhook.js) — distinto de "orderId" arriba, que es
  // nuestro folio interno. Es lo que se necesita para cancelar/reimprimir
  // (ver src/services/netpayService.js). Solo existe desde que el pago se
  // confirma en adelante.
  terminalOrderId: null,
  lastEvent: null,
  updatedAt: new Date().toISOString(),
  error: null,
  // Grupo 4 de la taxonomía de fallas: ¿vimos el Trigger "printing" en
  // ALGÚN momento de la sesión actual? Se usa solo como señal en
  // recordBoothEvent() al llegar "session_end" — ver el comentario ahí.
  sawPrintingEvent: false,
  // dslrBooth a veces manda el Trigger "session_end" DOS VECES seguidas
  // para la misma sesión (confirmado en pruebas reales, 22-sep-2026). Este
  // guard evita procesar el bloque de Grupo 4 (cancelación automática,
  // limpieza de cola) más de una vez por sesión — ver recordBoothEvent().
  sessionEndHandled: false,
};

// --- Watchdog de sesión colgada -------------------------------------
// Ver config.watchdog para el porqué de los tiempos. Un solo timer vive
// aquí (no un Map) porque solo hay una cabina/sesión a la vez.
//
// Mecánica: cada vez que `set()` deja la sesión en un estado vigilado
// (awaiting_payment o booth_running), se (re)arma un timer con el tiempo
// completo. Esto significa que en booth_running el reloj se reinicia con
// CADA evento que manda dslrBooth (countdown, capture_start, printing...),
// así que lo que se detecta es "sin ningún avance por X tiempo", no solo
// "nunca llegó session_end". Si el timer llega a disparar, se hace un
// doble chequeo (mismo status + mismo orderId que cuando se armó) antes de
// forzar el error, para no pisar una transición legítima que haya ocurrido
// justo antes de que corriera el callback.
const WATCHDOG_TIMEOUT_MS = {
  awaiting_payment: () => config.watchdog.paymentTimeoutMs,
  booth_running: () => config.watchdog.boothTimeoutMs,
};
const WATCHDOG_ERROR = {
  awaiting_payment: 'payment_timeout',
  booth_running: 'booth_timeout',
};

let watchdogTimer = null;

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function armWatchdog() {
  clearWatchdog();

  const getTimeoutMs = WATCHDOG_TIMEOUT_MS[state.status];
  if (!getTimeoutMs) return; // estado no vigilado (idle, payment_confirmed, error)

  const timeoutMs = getTimeoutMs();
  const armedForStatus = state.status;
  const armedForOrderId = state.orderId;

  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;

    // Solo actuar si nada cambió desde que se armó este timer.
    if (state.status !== armedForStatus || state.orderId !== armedForOrderId) return;

    console.warn(
      `[sessionState] watchdog: sin avance tras ${timeoutMs}ms en estado ` +
        `"${armedForStatus}" (orderId: ${armedForOrderId}) — forzando a error`
    );
    const armedForTerminalOrderId = state.terminalOrderId;
    set({ status: 'error', error: WATCHDOG_ERROR[armedForStatus] });

    // Grupo 3 de la taxonomía de fallas: si el watchdog disparó estando en
    // booth_running, el cobro ya se hizo (terminalOrderId existe desde que
    // NetPay confirmó el pago) y la sesión se colgó a medio camino sin
    // terminar — candidato limpio para cancelar automáticamente. No aplica
    // a "awaiting_payment": ahí nunca llegó el webhook de NetPay, así que
    // no hay terminalOrderId con qué cancelar (ver el manejo de "cobro
    // huérfano" en routes/webhook.js para ese otro caso, que sí puede
    // implicar dinero cobrado pero requiere revisión manual).
    if (armedForStatus === 'booth_running') {
      autoCancelSale(armedForTerminalOrderId, WATCHDOG_ERROR[armedForStatus], { folioNumber: armedForOrderId });
    }
  }, timeoutMs);
}

function get() {
  return state;
}

function set(partial) {
  state = { ...state, ...partial, updatedAt: new Date().toISOString() };
  armWatchdog();
  return state;
}

function reset() {
  clearWatchdog();
  state = {
    status: 'idle',
    package: null,
    orderId: null,
    terminalOrderId: null,
    lastEvent: null,
    updatedAt: new Date().toISOString(),
    error: null,
    sawPrintingEvent: false,
    sessionEndHandled: false,
  };
  return state;
}

// Usado tanto por el listener de Triggers de dslrBooth (routes/dslrbooth.js)
// como por el modo directo (services/directBoothService.js), para que el
// frontend reciba exactamente la misma forma de evento sin importar cuál
// de los dos está disparando la sesión.
function recordBoothEvent(eventType, param1, param2) {
  const updates = { lastEvent: { eventType, param1, param2, at: new Date().toISOString() } };

  if (eventType === 'session_start') {
    // reset() (1.5s después del session_end anterior) ya debería dejar esto
    // en false — defensivo por si algún día dos sesiones llegaran a
    // solaparse más de cerca de lo que hoy permite el flujo.
    updates.sawPrintingEvent = false;
    updates.sessionEndHandled = false;
  } else if (eventType === 'printing') {
    updates.sawPrintingEvent = true;
  }

  set(updates);

  if (eventType === 'session_end') {
    // dslrBooth también manda "session_end" cuando NO hay ninguna sesión
    // nuestra en curso — confirmado en pruebas reales (24-sep-2026): llega
    // uno al arrancar el backend, con la cabina en idle, y disparaba el
    // aviso "Sesión cerrada sin confirmar impresión" con orderId="?". Sin
    // orderId no hubo cobro, así que no hay nada que revisar ni cancelar
    // (y si la cámara estuviera desconectada en ese momento, habría
    // intentado una cancelación sin terminalOrderId). El lockscreen/foco de
    // routes/dslrbooth.js sí se sigue aplicando — eso es inofensivo.
    if (!state.orderId) {
      console.log('[sessionState] session_end sin sesión activa (sin orderId) — se ignora');
      return;
    }

    // dslrBooth a veces manda "session_end" DOS VECES seguidas para la
    // misma sesión — confirmado en pruebas reales (22-sep-2026): se veían
    // dos intentos de cancelación automática (y, en el caso de impresora,
    // dos limpiezas de cola) para el mismo terminalOrderId. El resto de
    // los efectos del duplicado (lockscreen, swap de foco en
    // routes/dslrbooth.js) son inofensivos porque dslrBooth/Windows los
    // manejan de forma idempotente, pero el bloque de abajo SÍ dispara
    // acciones reales (cancelSale, limpiar cola) que no deben correr dos
    // veces por la misma sesión — de ahí este guard.
    if (state.sessionEndHandled) {
      return;
    }
    set({ sessionEndHandled: true });

    // Capturamos estos datos AHORA — reset() (1.5s más abajo) los borra, y
    // el chequeo de impresión corre 5s después, así que para entonces ya
    // no quedaría nada de esto en `state`.
    const endedInfo = {
      orderId: state.orderId,
      package: state.package,
      terminalOrderId: state.terminalOrderId,
      sawPrintingEvent: state.sawPrintingEvent,
    };

    if (!endedInfo.sawPrintingEvent) {
      handleSessionEndWithoutPrinting(endedInfo);
    } else {
      setTimeout(() => handlePostPrintCheck(endedInfo), POST_PRINT_CHECK_DELAY_MS);
    }

    setTimeout(() => reset(), 1500);
  }
}

// Grupo 4 de la taxonomía de fallas: dslrBooth a veces manda "session_end"
// aunque la sesión haya fallado internamente (confirmado en pruebas reales,
// 19-sep-2026: desconexión de cámara a medio tomar fotos — LumaBooth igual
// cerró la sesión con normalidad). La señal de partida es no haber visto el
// Trigger "printing" antes de este "session_end".
//
// Esa señal sola es ambigua (podría ser por otro motivo que no sea
// hardware), así que antes de escalar a cancelación automática se hace un
// chequeo FRESCO y específico de la cámara en este mismo instante — si
// confirma que de verdad no está, ya no es una sospecha sino un hecho
// verificado, y se trata igual que los Grupos 2/3 (cancelación
// automática). Si la cámara sí responde, la causa es desconocida y nos
// quedamos en modo aviso nada más, como antes.
async function handleSessionEndWithoutPrinting({ orderId, package: pkg, terminalOrderId }) {
  const detail = `orderId="${orderId || '?'}" package="${pkg || '?'}"`;

  if (hardwareChecksAvailable()) {
    try {
      const cameraCheck = await hardwareMonitorService.checkCameraPresence();
      if (!cameraCheck.ok) {
        console.warn(
          `[sessionState] session_end sin "printing" Y cámara confirmada ausente — cancelando automáticamente (${detail})`
        );
        autoCancelSale(terminalOrderId, `session_end sin printing, cámara ausente (${detail})`, { folioNumber: orderId });
        return;
      }
    } catch (err) {
      console.error('[sessionState] chequeo de cámara tras session_end falló inesperadamente:', err.message);
      // seguimos al aviso genérico de abajo — no bloquear por un error de consulta
    }
  }

  console.warn(
    `[sessionState] session_end sin Trigger "printing" previo — sesión probablemente incompleta (${detail})`
  );
  notifyService.notifySessionLikelyIncomplete(detail);
}

// Sesión "exitosa" a ojos de dslrBooth (sí vimos "printing" antes de
// session_end) — de todas formas se confirma, tras un margen de
// POST_PRINT_CHECK_DELAY_MS, que la impresión de verdad haya salido (ver
// hardwareMonitorService.checkPrintFailure: exige impresora con problema Y
// un trabajo todavía pendiente en cola, no una sola señal aislada). Si se
// confirma la falla: cancelación automática + se limpia la cola para que
// ese trabajo no salga impreso solo más tarde, para una venta ya
// cancelada.
async function handlePostPrintCheck({ orderId, package: pkg, terminalOrderId }) {
  if (!hardwareChecksAvailable()) return;

  const detail = `orderId="${orderId || '?'}" package="${pkg || '?'}"`;

  try {
    const result = await hardwareMonitorService.checkPrintFailure();
    if (!result.failed) return; // todo bien — no hacer ni avisar nada

    console.warn(
      `[sessionState] impresión probablemente fallida tras session_end — impresora con problema Y ` +
        `${result.pendingJobs} trabajo(s) pendiente(s) en cola (${detail}: ${result.detail})`
    );

    autoCancelSale(
      terminalOrderId,
      `impresión fallida (${result.detail}, ${result.pendingJobs} trabajo(s) en cola) — ${detail}`,
      { folioNumber: orderId }
    );

    const cleared = await windowsPrinterService.clearPrintQueue();
    console.log(`[sessionState] cola de impresión limpiada tras falla confirmada — ${cleared.cleared} trabajo(s) removido(s)`);
  } catch (err) {
    console.error('[sessionState] handlePostPrintCheck falló inesperadamente:', err.message);
  }
}

module.exports = { get, set, reset, recordBoothEvent };
