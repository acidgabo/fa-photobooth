const express = require('express');
const router = express.Router();
const config = require('../config');
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

// El frontend consulta esto una sola vez al cargar, para decidir si corre
// su propio timeout local de 30s (ver public/index.html, PAYMENT_TIMEOUT_MS)
// — solo tiene sentido en modo mock. Contra terminal real, el watchdog del
// backend (config.watchdog, ver sessionState.js) ya es la autoridad real e
// independiente del frontend; el timer local de 30s del navegador era lo
// que causaba los cobros huérfanos documentados en
// Bitacora_Pruebas_Netpay_dslrBooth.md.
router.get('/config', (req, res) => {
  res.json({ paymentMock: config.netpay.isMock });
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
    // Solo EMPUJA la venta a la terminal (y valida que NetPay la haya
    // recibido, code "00"). La confirmación real del cobro llega después
    // por /webhooks/netpay; mientras tanto la sesión queda en
    // "awaiting_payment".
    await netpayService.createSale({ amount, orderId, packageId: pkg.id });
    res.status(202).json({ orderId, status: 'awaiting_payment' });
  } catch (err) {
    // TODO (A4, pendiente): distinguir un error ambiguo (timeout / sin
    // respuesta HTTP: la terminal pudo haber recibido la venta) de un
    // rechazo claro (code distinto de "00", p. ej. "19" terminal no
    // encontrada). Hoy ambos marcan la sesión como error.
    console.error(`[payment] no se pudo iniciar el cobro (folio ${orderId}): ${err.message}`);
    sessionState.set({ status: 'error', error: err.message });
    // El frontend muestra "error" tal cual al cliente (+ "verifica tu
    // tarjeta e intenta de nuevo"), así que va un texto para el cliente;
    // el detalle técnico queda en "detail", la consola y la bitácora.
    res.status(502).json({
      error: 'No se pudo conectar con la terminal de pago',
      code: err.code,
      detail: err.message,
      orderId,
    });
  }
});

module.exports = router;
