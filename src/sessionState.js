const config = require('./config');

// Estado en memoria de la sesión actual de la cabina.
// Suficiente para un solo NUC/una sola cabina operando a la vez.
// Si en el futuro hay más de una cabina, esto se vuelve un Map por boothId.

let state = {
  status: 'idle', // idle | awaiting_payment | payment_confirmed | booth_running | error
  package: null,
  orderId: null,
  lastEvent: null,
  updatedAt: new Date().toISOString(),
  error: null,
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
    set({ status: 'error', error: WATCHDOG_ERROR[armedForStatus] });
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
    lastEvent: null,
    updatedAt: new Date().toISOString(),
    error: null,
  };
  return state;
}

// Usado tanto por el listener de Triggers de dslrBooth (routes/dslrbooth.js)
// como por el modo directo (services/directBoothService.js), para que el
// frontend reciba exactamente la misma forma de evento sin importar cuál
// de los dos está disparando la sesión.
function recordBoothEvent(eventType, param1, param2) {
  set({ lastEvent: { eventType, param1, param2, at: new Date().toISOString() } });
  if (eventType === 'session_end') {
    setTimeout(() => reset(), 1500);
  }
}

module.exports = { get, set, reset, recordBoothEvent };
