/**
 * Panel de reimpresiones / reversos para el operador (public/admin.html).
 *
 * Pendiente 1 de la certificación NetPay (15-oct-2026): "implementar la
 * pantalla/dashboard para las reimpresiones o, en su caso, tener una opción
 * en el kiosco para reimprimir transacciones sin respuesta o PRV".
 *
 * Todo sale de lo que ya existe:
 *  - logs/netpay-transacciones.log (netpayLog) — ventas, cancelaciones y
 *    reimpresiones del día, con el JSON íntegro de cada respuesta.
 *  - data/reversos-pendientes.json (reversalService) — folios PRV o sin
 *    respuesta.
 * Las consultas pasan por reversalService.manualCheck() (por folio) o
 * netpayService.reprintByOrderId() (por orderId), con candados para no
 * mandar reimpresiones duplicadas (multi-instancias) ni empujar nada a la
 * terminal mientras un cliente está pagando.
 *
 * Acceso: si ADMIN_PIN está definido en .env, cada petición debe traer el
 * header "x-admin-pin" con ese valor. Si no está definido, el panel solo
 * responde a peticiones desde la misma PC (localhost) — el kiosco corre ahí.
 */
const express = require('express');
const netpayLog = require('../services/netpayLog');
const netpayService = require('../services/netpayService');
const reversalService = require('../services/reversalService');
const sessionState = require('../sessionState');

const router = express.Router();

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function requireAdmin(req, res, next) {
  const pin = process.env.ADMIN_PIN;
  if (pin) {
    if (req.get('x-admin-pin') === pin) return next();
    return res.status(401).json({ error: 'pin_required', message: 'PIN incorrecto' });
  }
  const remote = req.socket.remoteAddress || '';
  if (LOCAL_ADDRESSES.has(remote) && !req.get('cf-connecting-ip') && !req.get('x-forwarded-for')) return next();
  return res.status(403).json({
    error: 'local_only',
    message: 'El panel solo se puede abrir desde la PC de la cabina (o define ADMIN_PIN en .env)',
  });
}

router.use(requireAdmin);

function cdmxDay(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}

const MODULE_LABEL = {
  C: 'Aprobada',
  V: 'Cancelada',
  RV: 'Transacción reversada',
  PRV: 'Pendiente por reversar',
  D: 'Declinada',
};

/**
 * Arma la lista de ventas del día (hora CDMX) agrupando la bitácora por
 * folio. Un "No se encontraron datos" llega sin folio: se atribuye a la
 * última reimpresión por folio enviada que seguía sin respuesta (mismo
 * criterio que reversalService.handleNotFound).
 */
function buildTransactions(day) {
  const byFolio = new Map();
  const orderToFolio = new Map();
  let awaitingNotFound = null;

  const get = (folio) => {
    if (!byFolio.has(folio)) {
      byFolio.set(folio, { folio, at: null, amount: null, sale: null, orderId: null, cardNumber: null, cancel: null, lastReprint: null });
    }
    return byFolio.get(folio);
  };

  for (const e of netpayLog.readEntries()) {
    if (!e.at || cdmxDay(new Date(e.at)) !== day) continue;

    if (e.kind === 'request' && e.op === 'sale' && e.folioNumber) {
      const tx = get(e.folioNumber);
      if (!tx.at) tx.at = e.at;
      if (e.amount) tx.amount = e.amount;
      if (e.ok === false && !tx.sale) tx.sendError = e.message || e.error || 'no se pudo enviar';
      continue;
    }
    if (e.kind === 'sale' && e.folioNumber) {
      const tx = get(e.folioNumber);
      if (!tx.at) tx.at = e.at;
      tx.sale = { responseCode: e.responseCode, message: e.message, at: e.at };
      tx.amount = tx.amount || e.amount;
      if (e.orderId) {
        tx.orderId = e.orderId;
        orderToFolio.set(e.orderId, e.folioNumber);
      }
      if (e.cardNumber) tx.cardNumber = e.cardNumber;
      continue;
    }
    if (e.kind === 'cancel') {
      const folio = e.folioNumber || orderToFolio.get(e.orderId);
      if (folio && byFolio.has(folio)) byFolio.get(folio).cancel = { responseCode: e.responseCode, message: e.message, at: e.at };
      continue;
    }
    if (e.kind === 'request' && e.op === 'reprint' && e.stage !== 'enviando' && e.ok !== false && e.folioNumber && !e.orderId) {
      awaitingNotFound = e.folioNumber;
      continue;
    }
    if (e.kind === 'reprint') {
      const folio = e.folioNumber || orderToFolio.get(e.orderId);
      if (folio && byFolio.has(folio)) {
        byFolio.get(folio).lastReprint = {
          reprintModule: e.reprintModule,
          responseCode: e.responseCode,
          message: e.message,
          at: e.at,
        };
      }
      if (folio === awaitingNotFound) awaitingNotFound = null;
      continue;
    }
    if (e.kind === 'reprint_not_found') {
      if (awaitingNotFound && byFolio.has(awaitingNotFound)) {
        byFolio.get(awaitingNotFound).lastReprint = { reprintModule: 'NF', responseCode: e.responseCode, message: e.message, at: e.at };
      }
      awaitingNotFound = null;
    }
  }

  return [...byFolio.values()]
    .map((tx) => ({ ...tx, status: statusOf(tx) }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function statusOf(tx) {
  if (tx.lastReprint) {
    const m = tx.lastReprint.reprintModule;
    if (m === 'NF') return { code: 'NF', label: 'Sin registro en la terminal (sin cobro)' };
    if (m === 'C' && tx.cancel && tx.cancel.responseCode === '00') return { code: 'V', label: 'Cancelada' };
    return { code: m || '?', label: MODULE_LABEL[m] || tx.lastReprint.message || 'Desconocido' };
  }
  if (tx.cancel && tx.cancel.responseCode === '00') return { code: 'V', label: 'Cancelada' };
  if (!tx.sale) return { code: 'SR', label: tx.sendError ? 'No se pudo enviar' : 'Sin respuesta de la terminal' };
  if (tx.sale.responseCode === '00') return { code: 'C', label: 'Aprobada' };
  return { code: 'D', label: `Declinada (${tx.sale.responseCode})` };
}

function kioskBusy() {
  return sessionState.get().status === 'awaiting_payment';
}

router.get('/api/state', (req, res) => {
  const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : cdmxDay(new Date());
  const current = sessionState.get();
  res.json({
    day,
    kiosk: { status: current.status, orderId: current.orderId || null },
    autoRecheck: String(process.env.REVERSAL_AUTO_RECHECK || 'true').toLowerCase() !== 'false',
    inquiries: reversalService.openInquiries(),
    pending: reversalService.getPending(),
    transactions: buildTransactions(day),
  });
});

// Todo lo de un folio (y de su orderId de terminal), con el JSON íntegro de
// cada respuesta — para la evidencia de la matriz y el voucher personalizado.
router.get('/api/folio/:folio', (req, res) => {
  const folio = req.params.folio;
  const entries = netpayLog.readEntries();
  const orderIds = new Set(entries.filter((e) => e.folioNumber === folio && e.orderId).map((e) => e.orderId));
  let awaiting = false;
  const events = [];
  for (const e of entries) {
    const mine = e.folioNumber === folio || (e.orderId && orderIds.has(e.orderId));
    if (e.kind === 'request' && e.op === 'reprint' && e.stage !== 'enviando' && e.ok !== false && !e.orderId) {
      awaiting = e.folioNumber === folio;
    }
    if (mine || (e.kind === 'reprint_not_found' && awaiting)) {
      if (e.kind === 'reprint_not_found') awaiting = false;
      if (e.kind === 'request' && e.stage === 'enviando') continue;
      events.push(e);
    }
  }
  res.json({ folio, orderIds: [...orderIds], events });
});

// Consulta / reimpresión por folio. print=true imprime el ticket en la terminal.
router.post('/api/consultar', async (req, res) => {
  const folio = String((req.body && req.body.folio) || '').trim();
  const print = !!(req.body && req.body.print);
  if (!folio) return res.status(400).json({ ok: false, error: 'missing_folio', message: 'Falta el folio' });
  if (kioskBusy()) {
    return res.status(409).json({ ok: false, error: 'kiosk_busy', message: 'Hay un cliente pagando en este momento. Intenta cuando termine' });
  }
  const inFlight = netpayLog.findReprintInFlight({ folio });
  if (inFlight !== null) {
    return res.status(409).json({
      ok: false,
      error: 'reprint_in_progress',
      message: `Ya se envió una reimpresión de ${folio} hace ${Math.round(inFlight / 1000)} s y sigue sin respuesta`,
    });
  }
  const result = await reversalService.manualCheck(folio, { print });
  res.status(result.ok ? 200 : 409).json(result);
});

// Reimpresión por orderId de la terminal (solo ventas que sí regresaron orderId).
const orderReprintsInFlight = new Set();
router.post('/api/reimprimir-orden', async (req, res) => {
  const orderId = String((req.body && req.body.orderId) || '').trim();
  const folio = String((req.body && req.body.folio) || '').trim() || undefined;
  const print = !!(req.body && req.body.print);
  if (!orderId) return res.status(400).json({ ok: false, error: 'missing_order', message: 'Falta el orderId' });
  if (kioskBusy()) {
    return res.status(409).json({ ok: false, error: 'kiosk_busy', message: 'Hay un cliente pagando en este momento. Intenta cuando termine' });
  }
  const inFlight = netpayLog.findReprintInFlight({ orderId });
  if (orderReprintsInFlight.has(orderId) || inFlight !== null) {
    return res.status(409).json({
      ok: false,
      error: 'reprint_in_progress',
      message: `Ya hay una reimpresión de ${orderId} esperando respuesta de la terminal`,
    });
  }
  orderReprintsInFlight.add(orderId);
  try {
    await netpayService.reprintByOrderId({ orderId, print, folioNumber: folio, motivo: 'operador panel' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'send_failed', message: err.message });
  } finally {
    orderReprintsInFlight.delete(orderId);
  }
});

router.post('/api/pendientes/:folio/descartar', (req, res) => {
  const entry = reversalService.discardPending(req.params.folio);
  if (!entry) return res.status(404).json({ ok: false, message: 'Ese folio ya no está pendiente' });
  res.json({ ok: true, entry });
});

module.exports = router;
module.exports._buildTransactions = buildTransactions;
