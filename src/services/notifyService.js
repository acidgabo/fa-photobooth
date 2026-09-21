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

module.exports = { notifyDiscord, notifyHardwareDown, notifyHardwareRecovered };
