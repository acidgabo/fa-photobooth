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
  res.json({ paymentMock: config.netpay.isMock, certCustomAmount: config.netpay.certCustomAmount });
});

// Estados en los que ya hay una venta o una sesión de fotos en curso — un
// segundo POST /api/pay en cualquiera de ellos pisaría la sesión activa y
// dejaría el primer cobro huérfano. 'idle' y 'error' sí aceptan un pago
// nuevo (el frontend resetea la sesión antes de reintentar).
const BUSY_STATUSES = new Set(['awaiting_payment', 'payment_confirmed', 'booth_running']);

// Monto manual de certificación (CERT_CUSTOM_AMOUNT=true, ver config.js).
// Regresa el número válido o null.
const CERT_MAX_AMOUNT = 50000;
function parseCertAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > CERT_MAX_AMOUNT) return null;
  return Math.round(amount * 100) / 100;
}

// El frontend llama esto cuando el usuario elige un paquete y toca "Pagar".
// IMPORTANTE: el monto NUNCA se toma de lo que mande el navegador — se
// busca en el catálogo del backend a partir de packageId. Si se confiara
// en un "amount" mandado por el cliente, cualquiera con las herramientas
// de desarrollador podría pagar $1 por un paquete de $120. Única excepción:
// CERT_CUSTOM_AMOUNT=true, solo para la sesión de certificación (ver
// config.js); en producción va en false y "amount" se ignora.
router.post('/pay', async (req, res) => {
  const { packageId } = req.body;

  const pkg = packageId && packages.getById(packageId);
  if (!pkg) {
    return res.status(400).json({ error: `packageId inválido o faltante: ${packageId}` });
  }

  // Monto: SIEMPRE el del catálogo, salvo en modo certificación.
  let amount = pkg.price;
  let packageForTrace = pkg.id;
  if (config.netpay.certCustomAmount && req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== '') {
    const certAmount = parseCertAmount(req.body.amount);
    if (certAmount === null) {
      return res.status(400).json({ error: `Monto de prueba inválido: ${req.body.amount}` });
    }
    amount = certAmount;
    packageForTrace = 'prueba-certificacion';
    console.warn(`[payment] MODO CERTIFICACIÓN: se cobra un monto manual de $${amount} (CERT_CUSTOM_AMOUNT=true)`);
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

  // Bloqueo de multi-instancias del lado del backend (además del guard
  // paymentInFlight del frontend): nunca se manda una segunda venta
  // mientras hay otra en curso, aunque llegue de otra pestaña o de un
  // doble envío que se salte el frontend. Pregunta y escenario de
  // certificación "Venta normal con NIP (crédito) con multi-instancias".
  // Va justo antes de sessionState.set(), sin ningún await de por medio,
  // para que dos peticiones casi simultáneas no pasen las dos el chequeo.
  const current = sessionState.get();
  if (BUSY_STATUSES.has(current.status)) {
    console.warn(
      `[payment] POST /api/pay rechazado — ya hay una sesión en curso (estado: ${current.status}, folio: ${current.orderId})`
    );
    return res.status(409).json({ error: 'Ya hay un pago en curso', code: 'session_in_progress', orderId: current.orderId });
  }

  // Folio = <BOOTH_ID>_<timestamp en ms>, p. ej. "cabina-1_1790533514915"
  // (10-oct-2026; antes "order_<timestamp>"). Incluir la cabina hace el folio
  // único entre sucursales (pregunta #15 de la certificación NetPay). Hoy
  // hay UNA sola cabina (BOOTH_ID default "cabina-1"); al instalar otra,
  // cada una debe tener su propio BOOTH_ID en el .env. Se limpia a
  // [A-Za-z0-9-] para que el folio no lleve espacios ni caracteres raros.
  const boothPrefix = String(config.netpay.boothId || 'cabina-1').replace(/[^A-Za-z0-9-]/g, '') || 'cabina-1';
  const orderId = `${boothPrefix}_${Date.now()}`;
  sessionState.set({
    status: 'awaiting_payment',
    package: pkg.name,
    orderId,
    error: null,
  });

  try {
    // Solo EMPUJA la venta a la terminal (y valida que NetPay la haya
    // recibido, code "00"). La confirmación real del cobro llega después
    // por /webhooks/netpay; mientras tanto la sesión queda en
    // "awaiting_payment".
    await netpayService.createSale({ amount, orderId, packageId: packageForTrace });
    res.status(202).json({ orderId, status: 'awaiting_payment' });
  } catch (err) {
    // A4 (10-oct-2026): error AMBIGUO = la venta pudo haber llegado a la
    // terminal (timeout / conexión cortada sin respuesta HTTP, o 504). No se
    // marca error: la sesión sigue en "awaiting_payment" y el frontend se
    // queda en "Procesando pago". Si el cliente paga, el webhook llega y la
    // sesión arranca normal. Si no llega nada, el watchdog (6 min) consulta
    // el folio por reimpresión: aprobada (C) → cancelación automática; sin
    // datos / declinada → se cierra sin cobro. Antes, con la sesión ya en
    // "error", un cobro aprobado que llegaba después se ignoraba y quedaba
    // vigente.
    if (netpayService.isAmbiguousPushError(err)) {
      console.warn(
        `[payment] respuesta AMBIGUA al enviar la venta (folio ${orderId}): ${err.message} — ` +
          'la venta pudo llegar a la terminal; se sigue esperando el webhook (el watchdog consulta el folio si no llega)'
      );
      return res.status(202).json({ orderId, status: 'awaiting_payment', ambiguous: true });
    }

    // Rechazo CLARO (code distinto de "00" como "19" terminal no
    // encontrada, 4xx, otros 5xx, o falla al pedir el token): la venta no
    // llegó a la terminal.
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
