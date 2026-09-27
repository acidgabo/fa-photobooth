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
 *  - kind "sale" | "cancel" | "reprint" | "reprint_not_found": lo que la
 *    terminal manda de vuelta por el webhook (routes/webhook.js).
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

module.exports = { append, TRANSACTIONS_LOG_PATH };
