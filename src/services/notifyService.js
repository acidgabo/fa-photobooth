/**
 * Notificaciones best-effort a un canal de Discord vía webhook — gratis, sin
 * OAuth ni cuenta de bot: solo una URL generada en Configuración del canal >
 * Integraciones > Webhooks > Nuevo webhook (ver DISCORD_WEBHOOK_URL en
 * .env). Si falla o no está configurado, se loguea y ya — nunca debe romper
 * el flujo de la cabina (mismo criterio que src/services/
 * windowFocusService.js con el swap de foco).
 */
const config = require('../config');

let warnedMissingWebhook = false;

async function notifyDiscord(content) {
  const url = config.discord.webhookUrl;

  if (!url) {
    if (!warnedMissingWebhook) {
      console.warn('[notifyService] DISCORD_WEBHOOK_URL no está configurado — no se manda notificación');
      warnedMissingWebhook = true;
    }
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error(`[notifyService] Discord respondió ${res.status} al mandar la notificación`);
    }
  } catch (err) {
    console.error('[notifyService] Falló el POST al webhook de Discord:', err.message);
  }
}

// Formato exacto pedido para la alerta de falla de hardware.
function notifyHardwareDown(reason) {
  return notifyDiscord(`Cabina fuera de servicio!\nDetalles: ${reason}`);
}

// Aviso de recuperación automática — mismo canal, para no tener que revisar
// manualmente si ya se resolvió solo.
function notifyHardwareRecovered() {
  return notifyDiscord('✅ Cabina restablecida — el monitoreo de hardware detectó que todo volvió a la normalidad.');
}

// Aviso de una sesión que dslrBooth cerró con "session_end" sin que
// hayamos visto antes el Trigger "printing" — señal (no prueba) de que la
// entrega de la foto pudo fallar aunque el cobro sí se haya hecho. Ver
// Grupo 4 de la taxonomía de fallas (claude/Propuesta_Monitoreo_Camara_
// Impresora.md u otro doc del proyecto donde quede la taxonomía completa).
// Por ahora es solo para que alguien pueda revisar/reimprimir a mano — no
// dispara ninguna cancelación automática ni cambia lo que ve el cliente.
function notifySessionLikelyIncomplete(detail) {
  return notifyDiscord(`⚠️ Sesión cerrada sin confirmar impresión — revisar\nDetalles: ${detail}`);
}

// Aviso cuando una cancelación automática de venta (Grupos 2/3 de la
// taxonomía de fallas — cobro hecho, cero fotos entregadas) FALLA: fuera de
// la ventana de las 8pm CDMX, problema de red con la terminal, etc. A
// diferencia del resto de las notificaciones, esto sí implica dinero
// cobrado sin resolver — requiere reverso MANUAL, por eso se marca distinto
// (🔴 en vez de ⚠️).
function notifyAutoCancelFailed(detail) {
  return notifyDiscord(`🔴 Cancelación automática de venta FALLÓ — revisar y reversar a mano\nDetalles: ${detail}`);
}

// Aviso de que una cancelación automática SÍ se aplicó: la terminal
// confirmó la cancelación (webhook transType "V" con responseCode "00") y el
// cargo se le devolvió al cliente. Informativo — no requiere acción, pero
// deja constancia en el canal de cada venta que se cobró y se regresó.
function notifyAutoCancelConfirmed(detail) {
  return notifyDiscord(`↩️ Venta cancelada automáticamente — cargo devuelto al cliente\nDetalles: ${detail}`);
}

// Aviso de una cancelación que llegó de la terminal pero no corresponde a
// ninguna cancelación automática pendiente (p. ej. alguien canceló a mano
// desde la terminal, o se reinició el backend entre el envío y la
// respuesta). Informativo, para que no pase desapercibida.
function notifyUnmatchedCancel(detail) {
  return notifyDiscord(`⚠️ Cancelación recibida de la terminal que no fue automática — revisar\nDetalles: ${detail}`);
}

module.exports = {
  notifyDiscord,
  notifyHardwareDown,
  notifyHardwareRecovered,
  notifySessionLikelyIncomplete,
  notifyAutoCancelFailed,
  notifyAutoCancelConfirmed,
  notifyUnmatchedCancel,
};
