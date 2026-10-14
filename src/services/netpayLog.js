/**
 * Bitácora de NetPay en el punto de venta — requisito obligatorio de la
 * certificación ("Implementación de logging en el punto de venta" /
 * "Logs del servicio en punto de venta").
 *
 * Un solo archivo JSONL (una línea JSON por evento) con las dos
 * direcciones de la comunicación:
 *  - kind "request": lo que ESTE sistema le pide a NetPay (token, venta,
 *    cancelación, reimpresión) y la respuesta inmediata del push
 *    (netpayService.js).
 *    Antes de cada push se escribe además una línea con stage "enviando"
 *    (pre-registro): si el proceso se cae a media petición, el folio ya
 *    quedó registrado y se puede consultar por reimpresión por folio.
 *  - kind "sale" | "cancel" | "reprint" | "reprint_not_found": lo que la
 *    terminal manda de vuelta por el webhook (routes/webhook.js). Incluye
 *    "raw": el body COMPLETO tal como llegó, sin filtrar ni truncar
 *    (requisito de certificación: la respuesta se registra íntegra antes de
 *    procesarla).
 *
 * Así una venta se puede seguir de punta a punta por su folio. Nunca se
 * escriben el access token, las credenciales ni datos sensibles de la
 * tarjeta (cardNumber ya viene solo con los últimos 4).
 *
 * "*.log" está en .gitignore: el archivo nunca se sube al repo. Lo usa
 * también test-netpay-cancelacion.js (--list), que solo lee las líneas de
 * kind "sale" / "cancel" / "reprint".
 */
const fs = require('fs');
const path = require('path');

const TRANSACTIONS_LOG_PATH = path.join(__dirname, '..', '..', 'logs', 'netpay-transacciones.log');

function append(entry) {
  try {
    fs.mkdirSync(path.dirname(TRANSACTIONS_LOG_PATH), { recursive: true });
    fs.appendFileSync(TRANSACTIONS_LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    // Nunca debe tumbar un cobro ni el manejo del webhook por no poder
    // escribir a disco (permisos, disco lleno, etc.).
    console.error(`[netpayLog] no se pudo escribir en ${TRANSACTIONS_LOG_PATH}: ${err.message}`);
  }
}

// Todas las líneas del log como objetos (las que no se puedan parsear se
// saltan). El archivo es chico — se lee completo cada vez.
function readEntries() {
  try {
    if (!fs.existsSync(TRANSACTIONS_LOG_PATH)) return [];
    return fs
      .readFileSync(TRANSACTIONS_LOG_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`[netpayLog] no se pudo leer ${TRANSACTIONS_LOG_PATH}: ${err.message}`);
    return [];
  }
}

/**
 * Estado de cancelación de una venta según el log, por el orderId de la
 * TERMINAL. Lo usa netpayService.cancelSale() para no mandar una segunda
 * cancelación (escenarios de certificación "Cancelación de una venta con
 * multi-instancias" y "Evitar la cancelación de una venta cancelada desde
 * el POS"). Funciona entre procesos distintos (backend y
 * test-netpay-cancelacion.js) porque los dos escriben el mismo archivo.
 *  - 'cancelled': la terminal ya confirmó la cancelación (webhook "V" con
 *    "00") o una reimpresión la reporta como cancelada (reprintModule "V").
 *  - 'pending': se envió una cancelación hace menos de pendingWindowMs y
 *    todavía no llega su respuesta.
 *  - null: no hay nada que lo impida.
 */
function findCancelState(orderId, { pendingWindowMs = 180000, now = Date.now() } = {}) {
  if (!orderId) return null;
  let lastSentAt = null;
  let answeredAfterSend = false;
  for (const e of readEntries()) {
    if (e.orderId !== orderId) continue;
    if ((e.kind === 'cancel' && e.responseCode === '00') || (e.kind === 'reprint' && e.reprintModule === 'V')) {
      return 'cancelled';
    }
    if (e.kind === 'request' && e.op === 'cancel' && e.ok === true && e.stage !== 'enviando') {
      lastSentAt = Date.parse(e.at);
      answeredAfterSend = false;
    } else if (e.kind === 'cancel' && lastSentAt !== null) {
      answeredAfterSend = true;
    }
  }
  if (lastSentAt !== null && !answeredAfterSend && now - lastSentAt < pendingWindowMs) return 'pending';
  return null;
}

/**
 * ¿Hay una reimpresión de esta venta enviada hace poco y todavía sin
 * respuesta? Lo usa test-netpay-reimpresion.js (herramienta del operador)
 * para no mandar reimpresiones duplicadas si se lanza varias veces seguidas
 * (escenarios de certificación "Reimpresión … con MULTI-INSTANCIAS").
 * Cuenta tanto las reimpresiones manuales como las automáticas del manejo
 * de reversos, porque todas pasan por el mismo log. Regresa los ms desde el
 * envío, o null si no hay ninguna en curso.
 *  - Por folio: petición con ese folioNumber y sin orderId; la contesta una
 *    respuesta "reprint" de ese folio o un "reprint_not_found" (que llega
 *    sin folio).
 *  - Por orderId: petición con ese orderId; la contesta una respuesta
 *    "reprint" con ese orderId.
 */
function findReprintInFlight({ folio, orderId }, { windowMs = 60000, now = Date.now() } = {}) {
  if (!folio && !orderId) return null;
  let lastSentAt = null;
  let answered = false;
  for (const e of readEntries()) {
    const isRequest =
      e.kind === 'request' &&
      e.op === 'reprint' &&
      e.sent !== false &&
      (orderId ? e.orderId === orderId : e.folioNumber === folio && !e.orderId);
    if (isRequest) {
      if (e.ok === false) {
        // El envío falló (la terminal no recibió nada): no hay nada en curso.
        lastSentAt = null;
      } else {
        lastSentAt = Date.parse(e.at);
        answered = false;
      }
      continue;
    }
    if (lastSentAt === null) continue;
    if (e.kind === 'reprint' && (orderId ? e.orderId === orderId : e.folioNumber === folio)) answered = true;
    else if (!orderId && e.kind === 'reprint_not_found') answered = true;
  }
  if (lastSentAt === null || answered) return null;
  const elapsed = now - lastSentAt;
  return elapsed < windowMs ? elapsed : null;
}

module.exports = { append, readEntries, findCancelState, findReprintInFlight, TRANSACTIONS_LOG_PATH };
