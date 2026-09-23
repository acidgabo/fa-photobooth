/**
 * Punto único para las cancelaciones automáticas de venta — todos los
 * casos de la taxonomía de fallas donde el cobro ya se hizo y se confirmó
 * que NO se entregó nada (ver claude/Taxonomia_Fallas_Cancelacion_
 * Automatica.md en el proyecto):
 *  - Grupo 2: startSession() (o el equivalente direct/windirect) truena
 *    justo después de confirmar el pago (routes/webhook.js).
 *  - Grupo 3: la sesión se cuelga a medio camino (watchdog, booth_timeout).
 *  - Grupo 4a: session_end sin "printing" + cámara confirmada ausente.
 *  - Grupo 4b: impresora con problema + trabajo pendiente en cola.
 *
 * Fire-and-forget, best-effort: nunca debe tirar el flujo de quien la
 * llama. Si algo falla se loguea y se avisa por Discord para reverso manual;
 * nunca se reintenta solo.
 *
 * Confirmación en dos tiempos (agregado en feature/reimpresion-reversos):
 * que cancelSale() regrese OK solo significa que la terminal RECIBIÓ la
 * orden ("Mensaje enviado exitosamente"). El resultado real llega después
 * por el webhook con transType "V" — routes/webhook.js lo pasa a
 * resolveCancelResult(). Mientras tanto la cancelación queda en
 * `pendingCancels`; si no llega respuesta en CANCEL_CONFIRM_TIMEOUT_MS se
 * avisa por Discord igual que una falla.
 */
const netpayService = require('./netpayService');
const notifyService = require('./notifyService');

// Tiempo máximo esperando la respuesta de la terminal a una cancelación.
// Mismo orden de magnitud que el watchdog de pago (3 min): si la terminal
// no contestó en ese tiempo, hay que revisarlo a mano.
const CANCEL_CONFIRM_TIMEOUT_MS = 180000;

// terminalOrderId -> { folioNumber, reason, requestedAt, timer }
const pendingCancels = new Map();

async function autoCancelSale(terminalOrderId, reason, { folioNumber = null } = {}) {
  if (!terminalOrderId) {
    // No debería pasar en la práctica (todos los grupos aplican después de
    // que NetPay ya confirmó el pago y nos dio su orderId), pero sin él no
    // hay nada que cancelar — mejor avisar que fallar en silencio.
    console.warn(
      `[autoCancelService] no se puede cancelar automáticamente — no hay terminalOrderId (motivo: ${reason})`
    );
    notifyService.notifyAutoCancelFailed(`terminalOrderId="(ninguno)" folio="${folioNumber || '?'}" motivo="${reason}"`);
    return;
  }

  try {
    await netpayService.cancelSale({ orderId: terminalOrderId });
  } catch (err) {
    console.error(
      `[autoCancelService] la cancelación automática FALLÓ al enviarse — terminalOrderId=${terminalOrderId} ` +
        `(motivo: ${reason}) — ${err.message}`
    );
    notifyService.notifyAutoCancelFailed(
      `terminalOrderId="${terminalOrderId}" folio="${folioNumber || '?'}" motivo="${reason}" error="${err.message}"`
    );
    return;
  }

  console.log(
    `[autoCancelService] cancelación enviada a la terminal, esperando confirmación por webhook — ` +
      `terminalOrderId=${terminalOrderId} (motivo: ${reason})`
  );

  const previous = pendingCancels.get(terminalOrderId);
  if (previous) clearTimeout(previous.timer);

  const timer = setTimeout(() => {
    if (!pendingCancels.has(terminalOrderId)) return;
    pendingCancels.delete(terminalOrderId);
    console.error(
      `[autoCancelService] la terminal NUNCA confirmó la cancelación tras ${CANCEL_CONFIRM_TIMEOUT_MS}ms — ` +
        `terminalOrderId=${terminalOrderId} (motivo: ${reason})`
    );
    notifyService.notifyAutoCancelFailed(
      `terminalOrderId="${terminalOrderId}" folio="${folioNumber || '?'}" motivo="${reason}" ` +
        `error="sin respuesta de la terminal a la cancelación tras ${Math.round(CANCEL_CONFIRM_TIMEOUT_MS / 1000)}s"`
    );
  }, CANCEL_CONFIRM_TIMEOUT_MS);
  // No mantener vivo el proceso solo por este timer (tests / apagado limpio).
  if (typeof timer.unref === 'function') timer.unref();

  pendingCancels.set(terminalOrderId, { folioNumber, reason, requestedAt: Date.now(), timer });
}

// Busca la cancelación pendiente que corresponde a una respuesta de la
// terminal. Primero por el orderId de la terminal; si no, por nuestro
// folio. Todavía NO está confirmado con un payload real cuál de los dos
// trae la respuesta de una cancelación (la venta original o uno nuevo) —
// por eso se intentan ambos.
function findPending(body) {
  if (body.orderId && pendingCancels.has(body.orderId)) return body.orderId;
  if (body.folioNumber) {
    for (const [terminalOrderId, info] of pendingCancels) {
      if (info.folioNumber && info.folioNumber === body.folioNumber) return terminalOrderId;
    }
  }
  return null;
}

/**
 * Llamado desde routes/webhook.js con el body de una respuesta de
 * cancelación (transType "V", isRePrint false). Regresa lo que pasó para
 * que el webhook lo loguee: 'confirmed' | 'rejected' | 'unmatched'.
 */
function resolveCancelResult(body) {
  const key = findPending(body);
  const approved = body.responseCode === '00';

  if (!key) {
    // Respuesta de cancelación que no corresponde a ninguna pendiente:
    // puede ser una cancelación hecha a mano desde la terminal, o que el
    // payload real no traiga ni el orderId ni el folio que esperamos (ver
    // findPending). Se loguea y ya — si era nuestra, el timeout de arriba
    // avisará igual.
    console.warn(
      `[autoCancelService] respuesta de cancelación sin cancelación pendiente conocida — ` +
        `orderId=${body.orderId} folio=${body.folioNumber} responseCode=${body.responseCode} message="${body.message}"`
    );
    return 'unmatched';
  }

  const info = pendingCancels.get(key);
  clearTimeout(info.timer);
  pendingCancels.delete(key);

  if (approved) {
    console.log(
      `[autoCancelService] cancelación CONFIRMADA por la terminal — terminalOrderId=${key} (motivo original: ${info.reason})`
    );
    return 'confirmed';
  }

  console.error(
    `[autoCancelService] la terminal RECHAZÓ la cancelación — terminalOrderId=${key} ` +
      `responseCode=${body.responseCode} message="${body.message}" (motivo original: ${info.reason})`
  );
  notifyService.notifyAutoCancelFailed(
    `terminalOrderId="${key}" folio="${info.folioNumber || '?'}" motivo="${info.reason}" ` +
      `error="terminal rechazó la cancelación: ${body.responseCode} ${body.message || ''}"`
  );
  return 'rejected';
}

// Solo para diagnóstico/tests.
function getPendingCancels() {
  return [...pendingCancels.entries()].map(([terminalOrderId, { folioNumber, reason, requestedAt }]) => ({
    terminalOrderId,
    folioNumber,
    reason,
    requestedAt,
  }));
}

module.exports = { autoCancelSale, resolveCancelResult, getPendingCancels, CANCEL_CONFIRM_TIMEOUT_MS };
