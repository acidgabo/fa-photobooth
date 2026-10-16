/**
 * Lectura tolerante del body del webhook de NetPay.
 *
 * Problema (15-oct-2026): al cancelar una venta, la terminal mandó la
 * respuesta con un JSON inválido ("Expected ',' or '}' after property value
 * in JSON at position 1073"), tres veces seguidas. express.json() la
 * rechazaba con 400 antes de llegar a la ruta, así que la confirmación de la
 * cancelación se perdió y ni siquiera quedó el body en la bitácora para ver
 * qué tenía de malo.
 *
 * Qué hace este middleware (solo para el webhook de NetPay):
 *  1. Lee el body como texto y lo parsea. Si es válido, todo sigue igual.
 *  2. Si no lo es, GUARDA el texto crudo completo en la bitácora
 *     (logs/netpay-transacciones.log, kind "invalid_json") y lo muestra en
 *     consola con el contexto del punto donde falla el parseo.
 *  3. Intenta repararlo (el caso típico: saltos de línea/tabuladores sin
 *     escapar dentro de un valor de texto). Si se repara, la petición
 *     continúa normal y queda anotado en la bitácora (kind
 *     "invalid_json_repaired").
 *  4. Si no se puede reparar, responde el ack de siempre (200 "Recibido")
 *     para que la terminal no se quede reintentando; el texto crudo quedó en
 *     la bitácora para procesarlo a mano, y el aviso de "cancelación sin
 *     confirmar" del autoCancelService sigue siendo la red de seguridad.
 */
const netpayLog = require('../services/netpayLog');

const NETPAY_ACK = { code: '00', message: 'Recibido' };

// Escapa caracteres de control (< 0x20) que aparezcan DENTRO de un string
// JSON; fuera de strings no toca nada.
function escapeControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch < ' ') {
        out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function errorPosition(err) {
  const m = /position (\d+)/.exec(err && err.message ? err.message : '');
  return m ? Number(m[1]) : null;
}

function lenientNetpayBody(req, res, next) {
  const text = typeof req.body === 'string' ? req.body : '';

  if (!text.trim()) {
    req.body = {};
    return next();
  }

  let parseError;
  try {
    req.body = JSON.parse(text);
    return next();
  } catch (err) {
    parseError = err;
  }

  const position = errorPosition(parseError);
  const context =
    position === null ? null : text.slice(Math.max(0, position - 80), position + 80);
  console.error(
    `[webhook] body de NetPay con JSON inválido (${parseError.message}) — largo=${text.length}` +
      (context !== null ? ` — contexto alrededor del error: ${JSON.stringify(context)}` : '')
  );
  netpayLog.append({
    kind: 'invalid_json',
    error: parseError.message,
    position,
    length: text.length,
    bodyText: text,
  });

  try {
    req.body = JSON.parse(escapeControlCharsInStrings(text));
    console.warn('[webhook] body reparado (caracteres de control dentro de un texto) — se procesa normal');
    netpayLog.append({ kind: 'invalid_json_repaired', length: text.length });
    return next();
  } catch (_) {
    // sin reparación posible
  }

  // Segunda reparación: quitar el objeto "traceability". Es el único campo
  // que armamos nosotros con texto libre y la terminal lo regresa mal
  // serializado cuando trae comillas, "=" o acentos (cancelación del
  // 15-oct-2026: "motivo":"...(orderIdu003d"cabina-1_"}). Sin él se
  // recuperan todos los campos de la terminal (responseCode, orderId,
  // folioNumber, transType...) y la cancelación se puede confirmar.
  const withoutTraceability = text.replace(/"traceability"\s*:\s*\{[^{}]*\}/, '"traceability":null');
  if (withoutTraceability !== text) {
    try {
      req.body = JSON.parse(escapeControlCharsInStrings(withoutTraceability));
      console.warn('[webhook] body reparado quitando el traceability mal formado — se procesa normal');
      netpayLog.append({ kind: 'invalid_json_repaired', length: text.length, removed: 'traceability' });
      return next();
    } catch (_) {
      // sigue sin poderse leer
    }
  }

  console.error(
    '[webhook] no se pudo reparar el body — se responde Recibido para que la terminal no reintente; ' +
      'el texto crudo quedó en logs/netpay-transacciones.log (kind "invalid_json")'
  );
  return res.status(200).json(NETPAY_ACK);
}

module.exports = { lenientNetpayBody, escapeControlCharsInStrings };
