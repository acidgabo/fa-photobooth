const express = require('express');
const router = express.Router();
const config = require('../config');
const sessionState = require('../sessionState');
const dslrboothService = require('../services/dslrboothService');
const directBoothService = require('../services/directBoothService');
const windirectBoothService = require('../services/windirectBoothService');
const windowFocusService = require('../services/windowFocusService');

// NetPay pega aquí cuando confirma (o rechaza) el cobro.
// TODO: cuando tengamos la doc de autorización de webhooks de NetPay,
// validar la firma/origen de la petición antes de confiar en el body.
//
// Confirmado contra la Referencia API (sección "9. Recibiendo la respuesta"):
// - La terminal real NO manda {orderId, success, errorCode} — eso es solo lo
//   que simula mocks/mock-netpay.js. Manda "responseCode" ("00" = éxito,
//   cualquier otro valor = declinada/error) junto con authCode, cardNumber,
//   amount, message, etc.
// - El campo que corresponde a NUESTRO orderId (el que generamos en
//   payment.js y mandamos como "folioNumber" al crear la venta, ver
//   netpayService.createSale) es "folioNumber" en la respuesta — el
//   "orderId" que manda la terminal es un identificador DISTINTO, generado
//   por ella misma, que solo sirve para operaciones futuras de
//   cancelación/reimpresión sobre esta transacción (lo guardamos como
//   terminalOrderId por si se necesita más adelante).
// - El ack de vuelta hacia la terminal debe ser EXACTAMENTE
//   {"code":"00","message":"Recibido"} con HTTP 200 en TODOS los casos
//   (match, duplicado, rechazo, etc.) — la doc advierte que si la terminal
//   nunca ve ese "Recibido" puede dejar de mandar transacciones
//   subsecuentes. {received:true} (lo que había antes) no cumple esto.
const NETPAY_ACK = { code: '00', message: 'Recibido' };

router.post('/netpay', async (req, res) => {
  // Log de diagnóstico del body completo recibido de Netpay — gateado por
  // NETPAY_DEBUG_LOG (ver .env / .env.example) para poder seguir usándolo
  // en pruebas contra la terminal real sin que corra en producción. Imprime
  // el body tal cual lo manda la terminal (los 41 campos documentados:
  // responseCode, authCode, cardNumber, transDate, hexSign, etc.) para ver
  // el detalle exacto de casos como "Falló en conexión" sin adivinar.
  if (config.netpay.debugLog) {
    console.log('[webhook] body completo recibido de Netpay:', JSON.stringify(req.body, null, 2));
  }

  const { folioNumber, orderId: terminalOrderId, responseCode, message: netpayMessage } = req.body;

  const current = sessionState.get();
  if (current.orderId !== folioNumber) {
    // Llegó una confirmación que no corresponde a la sesión activa.
    console.log(`[webhook] webhook ignorado — folioNumber "${folioNumber}" no coincide con la sesión activa (orderId: ${current.orderId})`);
    return res.status(200).json(NETPAY_ACK);
  }

  // Solo procesar si aún estamos esperando el pago.
  // Si ya hay un resultado (error, confirmado, o booth corriendo), ignorar
  // cualquier webhook duplicado — esto evita la condición de carrera donde
  // la terminal reintenta la entrega de la respuesta y el segundo webhook
  // sobrescribe al primero.
  if (current.status !== 'awaiting_payment') {
    console.log(`[webhook] webhook ignorado — estado ya es "${current.status}" (folioNumber: ${folioNumber})`);
    return res.status(200).json(NETPAY_ACK);
  }

  if (responseCode !== '00') {
    console.log(`[webhook] pago rechazado (folioNumber: ${folioNumber}, responseCode: ${responseCode}, message: ${netpayMessage})`);
    sessionState.set({ status: 'error', error: netpayMessage || `responseCode ${responseCode}` });
    return res.status(200).json(NETPAY_ACK);
  }

  sessionState.set({ status: 'payment_confirmed', terminalOrderId });

  if (config.booth.mode === 'direct') {
    // Modo demo (Linux): cámara/impresora reales, controladas por este
    // backend vía gphoto2 + CUPS. No se espera aquí (tarda varios segundos:
    // countdown + captura + impresión) — el estado avanza vía los eventos
    // que va emitiendo directBoothService, igual que pasaría con los
    // triggers de dslrBooth.
    sessionState.set({ status: 'booth_running' });
    directBoothService.runDirectSession().catch((err) => {
      sessionState.set({ status: 'error', error: `booth directo: ${err.message}` });
    });
  } else if (config.booth.mode === 'windirect') {
    // Modo demo (Windows): cámara/impresora reales, controladas por este
    // backend vía digiCamControl + impresión nativa de Windows. Mismo
    // patrón que 'direct' pero para cuando la demo con hardware corre en
    // la laptop Windows antes de tener dslrBooth instalado.
    sessionState.set({ status: 'booth_running' });
    windirectBoothService.runDirectSession().catch((err) => {
      sessionState.set({ status: 'error', error: `booth directo (Windows): ${err.message}` });
    });
  } else {
    try {
      // Convivencia de pantallas (ver "Convivencia visual/de foco..." en
      // claude/Integración dslrbooth.md): antes de disparar la sesión,
      // LumaBooth debe recuperar el primer plano. Primero se le quita su
      // propia pantalla de bloqueo (API confiable) y luego se intenta el
      // cambio de foco a nivel de SO (best-effort). Ninguna de las dos
      // llamadas tira error — son hardening, no deben romper el flujo si
      // fallan (ver dslrboothService.js / windowFocusService.js).
      await dslrboothService.tryExitLockscreen();
      await windowFocusService.tryFocusDslrbooth();

      await dslrboothService.startSession({ mode: 'print' });
      sessionState.set({ status: 'booth_running' });
    } catch (err) {
      sessionState.set({ status: 'error', error: `dslrBooth: ${err.message}` });
    }
  }

  res.status(200).json(NETPAY_ACK);
});

module.exports = router;
