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

function get() {
  return state;
}

function set(partial) {
  state = { ...state, ...partial, updatedAt: new Date().toISOString() };
  return state;
}

function reset() {
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
