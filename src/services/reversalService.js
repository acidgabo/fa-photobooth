/**
 * Manejo de reversos (requisito obligatorio de NetPay — ver "Flujo Manejo
 * de Reversos.pdf" y el correo de Integraciones).
 *
 * Qué es un reverso: el banco SÍ autorizó el cobro, pero la comunicación se
 * cortó antes de que la terminal entregara la respuesta (tarjeta retirada
 * antes de tiempo, red, terminal apagada). La terminal/NetPay deshacen esa
 * autorización solos. Nosotros NO disparamos el reverso — lo que nos toca es
 * CONSULTAR cómo quedó la venta (reimpresión por folio) y actuar según eso.
 *
 * El estado real de una venta en una reimpresión lo da SOLO `reprintModule`
 * (confirmado con payloads reales, 24-sep-2026 — el responseCode de una
 * reimpresión es el de la venta original y no sirve para esto):
 *   C   aprobada y vigente (el cobro sigue en pie)
 *   V   cancelada
 *   RV  reversada (el cobro ya se deshizo)
 *   PRV pendiente por reversar (se resuelve sola con la siguiente venta
 *       exitosa en la terminal — documentado, aún sin probar en vivo)
 *   D   declinada (documentado, aún sin ver en vivo)
 *
 * Cuándo se consulta (checkFolio):
 *  - 'declined': la venta llegó con responseCode distinto de "00". Es el
 *    caso del reverso automático (p.ej. "05 Error al leer tarjeta" → RV).
 *  - 'payment_timeout': el watchdog de sessionState venció en
 *    awaiting_payment — nunca llegó respuesta de la venta (terminal
 *    apagada a medio flujo = reverso manual, o webhook perdido). Si la
 *    consulta dice C, hubo cobro sin sesión → se cancela automáticamente.
 *  - 'recheck': reconsulta de folios que quedaron pendientes (PRV o sin
 *    respuesta) después de cada venta exitosa (scheduleRecheck).
 *
 * Los folios pendientes se guardan en data/reversos-pendientes.json para
 * sobrevivir reinicios del backend (sessionState vive solo en memoria).
 */
const fs = require('fs');
const path = require('path');
const netpayService = require('./netpayService');
const notifyService = require('./notifyService');
const { autoCancelSale } = require('./autoCancelService');

const PENDING_PATH = path.join(__dirname, '..', '..', 'data', 'reversos-pendientes.json');

// Tiempos — leídos en cada uso (no al cargar el módulo) para poder
// ajustarlos por .env sin tocar código.
function ms(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}
// Cuánto esperar la respuesta de la terminal a una reimpresión.
const inquiryTimeoutMs = () => ms('REVERSAL_INQUIRY_TIMEOUT_MS', 60000);
// Margen tras una venta exitosa antes de reconsultar pendientes — la
// terminal todavía puede estar imprimiendo/mostrando el ticket de esa venta.
const recheckDelayMs = () => ms('REVERSAL_RECHECK_DELAY_MS', 30000);
// Separación entre reconsultas, para no encimar pushes a la terminal.
const recheckSpacingMs = () => ms('REVERSAL_RECHECK_SPACING_MS', 5000);

// folio -> { reason, detail, timer } — consultas enviadas esperando webhook.
const inquiries = new Map();

// ---------------------------------------------------------------------
// Persistencia de pendientes
// ---------------------------------------------------------------------
// folio -> { folio, status: 'PRV' | 'sin_respuesta', origin, detail,
//            firstSeenAt, lastCheckedAt, checks }
function loadPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[reversalService] no se pudo leer ${PENDING_PATH}: ${err.message}`);
    }
    return {};
  }
}

function savePending(pending) {
  try {
    fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
    fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
  } catch (err) {
    console.error(`[reversalService] no se pudo escribir ${PENDING_PATH}: ${err.message}`);
  }
}

function upsertPending(folio, fields) {
  const pending = loadPending();
  const now = new Date().toISOString();
  const previous = pending[folio];
  pending[folio] = {
    folio,
    firstSeenAt: previous ? previous.firstSeenAt : now,
    checks: previous ? previous.checks : 0,
    ...(previous || {}),
    ...fields,
    lastCheckedAt: now,
  };
  savePending(pending);
  return { isNew: !previous, entry: pending[folio] };
}

function removePending(folio) {
  const pending = loadPending();
  if (!pending[folio]) return null;
  const entry = pending[folio];
  delete pending[folio];
  savePending(pending);
  return entry;
}

function getPending() {
  return Object.values(loadPending());
}

// ---------------------------------------------------------------------
// Consulta (reimpresión por folio)
// ---------------------------------------------------------------------
/**
 * Pide a la terminal el estado de una venta por folio. Fire-and-forget:
 * nunca tira error hacia quien la llama. La respuesta llega por el webhook
 * y se procesa en handleReprintResponse().
 */
async function checkFolio(folio, reason, detail = '') {
  if (!folio) return;

  const previous = inquiries.get(folio);
  if (previous) clearTimeout(previous.timer);

  const timer = setTimeout(() => onInquiryTimeout(folio), inquiryTimeoutMs());
  if (typeof timer.unref === 'function') timer.unref();
  inquiries.set(folio, { reason, detail, timer });

  try {
    await netpayService.reprintByFolio({ folioId: folio });
    console.log(`[reversalService] consulta de estado enviada — folio=${folio} (motivo: ${reason})`);
  } catch (err) {
    console.error(`[reversalService] no se pudo enviar la consulta — folio=${folio} (motivo: ${reason}): ${err.message}`);
    clearTimeout(timer);
    inquiries.delete(folio);
    markUnknown(folio, reason, detail, `no se pudo enviar la consulta: ${err.message}`);
  }
}

function onInquiryTimeout(folio) {
  const inquiry = inquiries.get(folio);
  if (!inquiry) return;
  inquiries.delete(folio);
  console.warn(
    `[reversalService] la terminal no respondió a la consulta en ${inquiryTimeoutMs()}ms — folio=${folio} (motivo: ${inquiry.reason})`
  );
  markUnknown(folio, inquiry.reason, inquiry.detail, 'la terminal no respondió a la consulta');
}

// Sin respuesta de la terminal: el estado de la venta es desconocido. Solo
// importa cuando PUDO haber cobro (payment_timeout, o reconsulta de algo
// que ya estaba pendiente). Para una venta declinada que no se pudo
// consultar se avisa igual, porque el reverso es justo lo que no pudimos
// confirmar.
function markUnknown(folio, reason, detail, why) {
  const origin = reason === 'recheck' ? undefined : reason;
  const { isNew, entry } = upsertPending(folio, {
    status: statusKeepingPrv(folio, 'sin_respuesta'),
    ...(origin ? { origin } : {}),
    ...(detail ? { detail } : {}),
    lastError: why,
  });
  bumpChecks(folio);
  if (isNew) {
    notifyService.notifyReversalUnknown(
      `folio="${folio}" motivo="${entry.origin || reason}" ${detail ? `detalle="${detail}" ` : ''}` +
        `(${why}) — se volverá a consultar después de la siguiente venta exitosa`
    );
  }
}

// Si el folio ya estaba como PRV, una consulta sin respuesta no debe
// "degradarlo" a sin_respuesta — seguimos sabiendo que está pendiente.
function statusKeepingPrv(folio, fallback) {
  const current = loadPending()[folio];
  return current && current.status === 'PRV' ? 'PRV' : fallback;
}

function bumpChecks(folio) {
  const pending = loadPending();
  if (pending[folio]) {
    pending[folio].checks = (pending[folio].checks || 0) + 1;
    savePending(pending);
  }
}

// ---------------------------------------------------------------------
// Respuesta de la terminal
// ---------------------------------------------------------------------
/**
 * Llamado por routes/webhook.js con cada respuesta de reimpresión
 * (isRePrint: true). Las reimpresiones hechas a mano (script de prueba)
 * que no correspondan a ninguna consulta ni pendiente solo se registran.
 * Regresa el reprintModule procesado (útil para logs/tests).
 */
function handleReprintResponse(body) {
  const folio = body.folioNumber;
  const module = body.reprintModule || '(ninguno)';
  const inquiry = folio ? inquiries.get(folio) : null;
  const pendingEntry = folio ? loadPending()[folio] : null;

  console.log(
    `[webhook] respuesta de REIMPRESIÓN — folio=${folio} orderId=${body.orderId} ` +
      `responseCode=${body.responseCode} reprintModule=${module} message="${body.message}"`
  );

  if (inquiry) {
    clearTimeout(inquiry.timer);
    inquiries.delete(folio);
  }

  if (!inquiry && !pendingEntry) return module; // reimpresión manual, nada que hacer

  if (pendingEntry) {
    const pending = loadPending();
    if (pending[folio]) {
      pending[folio].checks = (pending[folio].checks || 0) + 1;
      savePending(pending);
    }
  }

  const origin = (pendingEntry && pendingEntry.origin) || (inquiry && inquiry.reason);
  const detail = (inquiry && inquiry.detail) || (pendingEntry && pendingEntry.detail) || '';
  const who = `folio="${folio}" monto=$${body.amount || '?'} tarjeta=****${body.cardNumber || '?'} motivo="${origin}"${detail ? ` detalle="${detail}"` : ''}`;

  switch (body.reprintModule) {
    case 'RV': {
      removePending(folio);
      console.log(`[reversalService] reverso CONFIRMADO — ${who}`);
      notifyService.notifyReversalConfirmed(
        `${who} — el cobro autorizado se deshizo (${body.message || 'Transacción reversada'})` +
          (pendingEntry && pendingEntry.status === 'PRV' ? ' — estaba pendiente por reversar' : '')
      );
      break;
    }
    case 'PRV': {
      const { isNew } = upsertPending(folio, {
        status: 'PRV',
        ...(origin ? { origin } : {}),
        ...(detail ? { detail } : {}),
        lastError: undefined,
      });
      console.warn(`[reversalService] venta PENDIENTE POR REVERSAR — ${who}`);
      if (isNew || (pendingEntry && pendingEntry.status !== 'PRV')) {
        notifyService.notifyReversalPending(
          `${who} — se reversa sola con la siguiente venta exitosa; se volverá a consultar entonces`
        );
      }
      break;
    }
    case 'C': {
      removePending(folio);
      if (origin === 'payment_timeout') {
        // Nunca nos llegó la respuesta de la venta, pero la venta SÍ quedó
        // cobrada y vigente — el cliente pagó y no se entregó nada (el
        // watchdog ya dio la sesión por perdida). Mismo criterio que los
        // Grupos 2-4: cancelar automáticamente.
        console.error(`[reversalService] venta APROBADA sin sesión (respuesta perdida) — cancelando — ${who}`);
        autoCancelSale(body.orderId, `venta aprobada sin respuesta a tiempo (${origin})`, { folioNumber: folio });
      } else {
        // Venta que nos llegó como declinada pero la terminal dice que
        // quedó aprobada — no debería pasar; no se cancela a ciegas.
        console.error(`[reversalService] la consulta dice APROBADA (C) pero la venta llegó como declinada — ${who}`);
        notifyService.notifyReversalMismatch(
          `${who} orderId="${body.orderId || '?'}" — la venta llegó como declinada pero la terminal la reporta aprobada. Revisar a mano`
        );
      }
      break;
    }
    case 'V':
    case 'D': {
      removePending(folio);
      console.log(
        `[reversalService] consulta resuelta: ${body.reprintModule === 'V' ? 'cancelada' : 'declinada'} (sin cobro vigente) — ${who}`
      );
      break;
    }
    default: {
      console.warn(`[reversalService] reprintModule desconocido "${module}" — ${who}`);
      notifyService.notifyReversalMismatch(`${who} — reprintModule desconocido "${module}", revisar a mano`);
    }
  }

  return module;
}

// ---------------------------------------------------------------------
// Reconsulta de pendientes
// ---------------------------------------------------------------------
let recheckTimer = null;

/**
 * Llamado por routes/webhook.js después de cada venta EXITOSA: esa venta
 * es la que dispara que la terminal complete los reversos pendientes
 * (PRV → RV), y además prueba que la terminal ya está en línea (para los
 * que quedaron "sin_respuesta"). Se espera un margen y se consultan uno
 * por uno.
 */
function scheduleRecheck() {
  if (getPending().length === 0) return;
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = setTimeout(runRecheck, recheckDelayMs());
  if (typeof recheckTimer.unref === 'function') recheckTimer.unref();
}

async function runRecheck() {
  recheckTimer = null;
  // Lazy require: sessionState.js también requiere este módulo.
  const sessionState = require('../sessionState');
  const folios = getPending().map((entry) => entry.folio);

  for (let i = 0; i < folios.length; i++) {
    // No mandar pushes a la terminal si otro cliente está pagando en ese
    // momento — se reintenta con la siguiente venta exitosa.
    if (sessionState.get().status === 'awaiting_payment') {
      console.log('[reversalService] reconsulta pospuesta — hay un pago en curso');
      return;
    }
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, recheckSpacingMs()));
    await checkFolio(folios[i], 'recheck');
  }
}

module.exports = {
  checkFolio,
  handleReprintResponse,
  scheduleRecheck,
  getPending,
  // solo tests
  _runRecheck: runRecheck,
  _inquiries: inquiries,
  PENDING_PATH,
};
