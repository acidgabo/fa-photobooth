const express = require('express');
const router = express.Router();
const netpayService = require('../services/netpayService');
const sessionState = require('../sessionState');
const packages = require('../packages');
const hardwareWatch = require('../hardwareWatch');

// El frontend consulta esto para pintar las tarjetas de paquete —
// nombre, precio y fotos vienen SIEMPRE de aquí, nunca hardcodeados
// en el HTML, para que cambiar precios sea editar un solo archivo
// (src/packages.js).
router.get('/packages', (req, res) => {
  res.json(packages.getAll());
});

// El frontend llama esto cuando el usuario elige un paquete y toca "Pagar".
// IMPORTANTE: el monto NUNCA se toma de lo que mande el navegador — se
// busca en el catálogo del backend a partir de packageId. Si se confiara
// en un "amount" mandado por el cliente, cualquiera con las herramientas
// de desarrollador podría pagar $1 por un paquete de $120.
router.post('/pay', async (req, res) => {
  const { packageId } = req.body;

  const pkg = packageId && packages.getById(packageId);
  if (!pkg) {
    return res.status(400).json({ error: `packageId inválido o faltante: ${packageId}` });
  }

  // Chequeo síncrono y FRESCO de cámara+impresora — la garantía real del
  // monitoreo de hardware (ver src/hardwareWatch.js). No importa qué tan
  // reciente sea el último chequeo del loop de fondo (cada 30s en idle):
  // en el instante en que alguien va a pagar, se vuelve a confirmar antes
  // de aceptar el cobro. No toca sessionState — la sesión se queda en
  // 'idle' para que el frontend pueda reintentar sin necesitar un reset.
  const hw = await hardwareWatch.checkNow();
  if (!hw.ok) {
    return res.status(503).json({ error: 'hardware_unavailable', detail: hw.reasons.join(' | ') });
  }

  const orderId = `order_${Date.now()}`;
  sessionState.set({
    status: 'awaiting_payment',
    package: pkg.name,
    orderId,
    error: null,
  });

  const amount = pkg.price;

  try {
    // TODO: cuando exista credencial de sandbox, esto llama de verdad a NetPay.
    // Por ahora solo deja la sesión en "awaiting_payment" y responde 202,
    // porque la confirmación real llega después por /webhooks/netpay.
    await netpayService.createSale({ amount, orderId });
    res.status(202).json({ orderId, status: 'awaiting_payment' });
  } catch (err) {
    sessionState.set({ status: 'error', error: err.message });
    res.status(501).json({
      error: 'NetPay no implementado todavía (esqueleto)',
      detail: err.message,
      orderId,
    });
  }
});

module.exports = router;
