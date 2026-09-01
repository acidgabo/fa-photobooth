const express = require('express');
const router = express.Router();
const config = require('../config');
const sessionState = require('../sessionState');
const dslrboothService = require('../services/dslrboothService');
const directBoothService = require('../services/directBoothService');
const windirectBoothService = require('../services/windirectBoothService');

// NetPay pega aquí cuando confirma (o rechaza) el cobro.
// TODO: cuando tengamos la doc de autorización de webhooks de NetPay,
// validar la firma/origen de la petición antes de confiar en el body.
router.post('/netpay', async (req, res) => {
  const { orderId, success, errorCode } = req.body;

  const current = sessionState.get();
  if (current.orderId !== orderId) {
    // Llegó una confirmación que no corresponde a la sesión activa.
    return res.status(200).json({ received: true, ignored: true });
  }

  // Solo procesar si aún estamos esperando el pago.
  // Si ya hay un resultado (error, confirmado, o booth corriendo), ignorar
  // cualquier webhook duplicado — esto evita la condición de carrera donde
  // el mock de NetPay confirma después de que el usuario simuló un error
  // (o viceversa), y el segundo webhook sobrescribe al primero.
  if (current.status !== 'awaiting_payment') {
    console.log(`[webhook] webhook ignorado — estado ya es "${current.status}" (orderId: ${orderId})`);
    return res.status(200).json({ received: true, ignored: true, reason: 'already_processed' });
  }

  if (!success) {
    console.log(`[webhook] pago rechazado (orderId: ${orderId}, errorCode: ${errorCode})`);
    sessionState.set({ status: 'error', error: errorCode || 'pago_rechazado' });
    return res.status(200).json({ received: true });
  }

  sessionState.set({ status: 'payment_confirmed' });

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
    // el NUC/PC Windows antes de tener dslrBooth instalado.
    sessionState.set({ status: 'booth_running' });
    windirectBoothService.runDirectSession().catch((err) => {
      sessionState.set({ status: 'error', error: `booth directo (Windows): ${err.message}` });
    });
  } else {
    try {
      await dslrboothService.startSession({ mode: 'print' });
      sessionState.set({ status: 'booth_running' });
    } catch (err) {
      sessionState.set({ status: 'error', error: `dslrBooth: ${err.message}` });
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;
