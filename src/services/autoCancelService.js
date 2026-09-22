/**
 * Punto único para las cancelaciones automáticas de venta — Grupos 2 y 3 de
 * la taxonomía de fallas (cobro exitoso pero SIN AMBIGÜEDAD de que no se
 * entregó ninguna foto, ver docs del proyecto):
 *  - Grupo 2: dslrboothService.startSession() (o el equivalente en modo
 *    direct/windirect) truena justo después de confirmar el pago — cero
 *    fotos, cero interacción del cliente (routes/webhook.js).
 *  - Grupo 3: la sesión se cuelga a medio camino sin más eventos, detectado
 *    por el watchdog de sessionState.js (booth_timeout).
 *
 * NO se usa para el Grupo 4 (session_end sin Trigger "printing" previo):
 * ahí la señal es una heurística, no una confirmación de que no se entregó
 * nada — por diseño, ese caso solo avisa (notifyService.
 * notifySessionLikelyIncomplete) para revisión manual, sin cancelar nada
 * automáticamente todavía.
 *
 * Fire-and-forget, best-effort: nunca debe tirar el flujo de quien la
 * llama (mismo criterio que notifyService/windowFocusService) — si la
 * cancelación falla (fuera de la ventana de las 8pm CDMX, problema de red
 * con la terminal, etc.) se loguea y se avisa por Discord para que alguien
 * haga el reverso a mano; nunca se reintenta solo.
 */
const netpayService = require('./netpayService');
const notifyService = require('./notifyService');

async function autoCancelSale(terminalOrderId, reason) {
  if (!terminalOrderId) {
    // No debería pasar en la práctica (Grupos 2/3 solo aplican después de
    // que NetPay ya confirmó el pago y nos dio su orderId), pero sin él no
    // hay nada que cancelar — mejor avisar que fallar en silencio.
    console.warn(
      `[autoCancelService] no se puede cancelar automáticamente — no hay terminalOrderId (motivo: ${reason})`
    );
    notifyService.notifyAutoCancelFailed(`terminalOrderId="(ninguno)" motivo="${reason}"`);
    return;
  }

  try {
    await netpayService.cancelSale({ orderId: terminalOrderId });
    console.log(
      `[autoCancelService] cancelación automática OK — terminalOrderId=${terminalOrderId} (motivo: ${reason})`
    );
  } catch (err) {
    console.error(
      `[autoCancelService] la cancelación automática FALLÓ — terminalOrderId=${terminalOrderId} ` +
        `(motivo: ${reason}) — ${err.message}`
    );
    notifyService.notifyAutoCancelFailed(
      `terminalOrderId="${terminalOrderId}" motivo="${reason}" error="${err.message}"`
    );
  }
}

module.exports = { autoCancelSale };
