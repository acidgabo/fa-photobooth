const axios = require('axios');
const config = require('../config');
const netpayLog = require('./netpayLog');

// Guardamos el token en memoria (proceso único en la NUC). Si el backend
// se reinicia, se vuelve a pedir. El access_token dura ~12h según la doc.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

// El token se renueva ANTES de que venza: NetPay espera que se regenere de
// forma periódica ("por ejemplo, cada 6 u 11 horas"; el refresh token no
// existe y no se usa). Con expires_in de ~12h esto lo renueva a las ~11h,
// así ninguna venta sale con un token a punto de caducar.
const TOKEN_RENEW_MARGIN_MS = 60 * 60 * 1000;

function tokenLifetimeMs(expiresInSeconds) {
  const lifetimeMs = (expiresInSeconds || 3600) * 1000;
  // Si algún día NetPay diera tokens cortos (< 2h), se usa el 90% de su vida.
  return lifetimeMs > 2 * TOKEN_RENEW_MARGIN_MS ? lifetimeMs - TOKEN_RENEW_MARGIN_MS : Math.floor(lifetimeMs * 0.9);
}

/**
 * Objeto "traceability" que va en TODAS las peticiones a NetPay (venta,
 * cancelación, reimpresión) — checklist obligatorio de certificación
 * ("Implementación del objeto traceability"). Según la Referencia API es
 * un objeto libre "para enviar información relevante para el comercio"
 * que sirve para hacer match dentro de nuestro sistema; la terminal lo
 * regresa tal cual en el webhook.
 *
 * Se mantiene plano y corto (solo strings, máx. 60 caracteres por valor)
 * para no arriesgar un rechazo por tamaño o tipo. Siempre incluye la
 * cabina (BOOTH_ID); los campos vacíos se omiten.
 */
const TRACEABILITY_MAX_LEN = 60;

// La terminal vuelve a serializar el traceability al armar el webhook y se
// atraganta con ciertos caracteres: el 15-oct-2026 un motivo con comillas,
// "=" y acentos ("...cámara ausente (orderId=\"cabina-1_...") regresó como
// JSON inválido (orderIdu003d"cabina-1_") y se perdió la confirmación de la
// cancelación. Por eso los valores van solo en ASCII simple: sin acentos,
// comillas, "=", barras ni paréntesis, y se recortan DESPUÉS de limpiar.
function sanitizeTraceabilityValue(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _.,:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TRACEABILITY_MAX_LEN);
}

function buildTraceability(fields = {}) {
  const traceability = { cabina: config.netpay.boothId };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    traceability[key] = sanitizeTraceabilityValue(value);
  }
  return traceability;
}

/**
 * Confirmado contra el correo de Integraciones de Netpay (Terminales Smart
 * API) y la Referencia API oficial:
 * - Endpoint: POST {baseUrl}/oauth-service/oauth/token (NO "/oauth/token").
 * - Header: Authorization: Basic {NETPAY_AUTH_STRING} — credenciales FIJAS
 *   de la app ("trusted-app:secret" en base64), distintas de username/password.
 * - Body: application/x-www-form-urlencoded con grant_type, username,
 *   password (las credenciales de comercio: NETPAY_USERNAME/PASSWORD) — NO
 *   JSON, que es lo que axios manda por default con un objeto plano.
 *
 * Mientras tanto, config.netpay.baseUrl puede apuntar a mocks/mock-netpay.js
 * para probar todo el flujo de código sin depender del sandbox real (el
 * mock no valida content-type, así que esto también sigue funcionando ahí).
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: config.netpay.grantType,
    username: config.netpay.username,
    password: config.netpay.password,
  });

  // Cada token NUEVO queda en la bitácora (los que salen del cache no):
  // así se puede demostrar en la certificación con qué frecuencia se
  // genera ("Validación de generación de access token"). Nunca se escribe
  // el token ni las credenciales.
  const startedAt = Date.now();
  let response;
  try {
    response = await axios.post(`${config.netpay.baseUrl}${config.netpay.tokenPath}`, body, {
      headers: {
        Authorization: `Basic ${config.netpay.authString}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // 15s: con 5s se vio fallar la PRIMERA petición de token en pruebas reales
      // (24-sep-2026, "timeout of 5000ms exceeded" con el servidor OAuth de
      // NetPay lento) — posible causa de parte de los timeouts intermitentes
      // del 16-sep. Sigue acotado para que una URL mal configurada no se
      // cuelgue en silencio.
      timeout: 15000,
    });
  } catch (err) {
    netpayLog.append({
      kind: 'request',
      op: 'token',
      endpoint: config.netpay.tokenPath,
      ok: false,
      httpStatus: err.response ? err.response.status : undefined,
      error: err.code || 'error',
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }

  cachedToken = response.data.access_token;
  cachedTokenExpiresAt = now + tokenLifetimeMs(response.data.expires_in);
  netpayLog.append({
    kind: 'request',
    op: 'token',
    endpoint: config.netpay.tokenPath,
    ok: true,
    httpStatus: response.status,
    expiresIn: response.data.expires_in,
    renewAt: new Date(cachedTokenExpiresAt).toISOString(),
    durationMs: Date.now() - startedAt,
  });
  return cachedToken;
}

// NetPay exige que la solicitud de cancelación llegue antes de las 8:00
// p.m. hora Ciudad de México (Referencia API, sección "6. Cancelación" +
// confirmado en claude/Guias_SDKs_Netpay.md) — restricción dura del lado de
// ellos, no algo que podamos evitar desde acá. % 24 es por si el runtime de
// Node en esta máquina llega a formatear la medianoche como "24" en vez de
// "00" (varía según versión de ICU) — sin eso, medianoche se leería como
// ">= 20" y bloquearía cancelaciones válidas de madrugada.
function isPastCancelCutoff(now = new Date()) {
  const hourCdmx =
    parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Mexico_City',
        hour: '2-digit',
        hour12: false,
      }).format(now),
      10
    ) % 24;
  return hourCdmx >= 20;
}

// Qué se registra de cada petición en la bitácora (netpayLog). Solo datos
// para conciliar: nunca el token ni credenciales.
function describeRequest(op, pathSuffix, body) {
  return {
    kind: 'request',
    op,
    endpoint: pathSuffix,
    folioNumber: body.folioNumber || body.folioId || undefined,
    orderId: body.orderId || undefined,
    amount: body.amount,
    print: body.disablePrintAnimation === undefined ? undefined : !body.disablePrintAnimation,
    traceability: body.traceability,
  };
}

/**
 * Helper común para TODOS los "push" a la terminal: venta, cancelación y
 * reimpresiones.
 *
 * - Valida el "code" del body: NetPay responde {code:"00", message:"Mensaje
 *   enviado exitosamente"} cuando el push llegó a la terminal, y
 *   {code:"19", message:"No se encontró la terminal"} cuando no. Cualquier
 *   code distinto de "00" se trata como error (err.code = "netpay_<code>").
 *   OJO: "00" aquí solo significa "la terminal recibió la orden" — el
 *   resultado REAL de la operación llega después por el webhook
 *   (routes/webhook.js).
 * - Si NetPay rechaza el token (invalid_token / 401) se descarta el token
 *   cacheado y se reintenta UNA vez con uno nuevo — sin esto, un token
 *   invalidado del lado de NetPay antes de sus 12h dejaría fallando todas
 *   las operaciones hasta reiniciar el backend. Es seguro también para la
 *   venta: con 401 NetPay no empujó nada a la terminal.
 * - Registra cada petición y su resultado inmediato en la bitácora
 *   (logs/netpay-transacciones.log, kind "request"). ANTES de enviar se
 *   escribe una línea con stage "enviando" (pre-registro): si el backend se
 *   cae o la petición se cuelga, el folio ya quedó registrado y la venta se
 *   puede recuperar por reimpresión por folio.
 */
async function pushToTerminal(op, pathSuffix, body) {
  const startedAt = Date.now();
  const attempt = { tokenRenewed: false };
  const logBase = describeRequest(op, pathSuffix, body);

  netpayLog.append({ ...logBase, stage: 'enviando' });

  try {
    const data = await sendToTerminal(pathSuffix, body, attempt);
    netpayLog.append({
      ...logBase,
      ok: true,
      code: data.code,
      message: data.message,
      tokenRenewed: attempt.tokenRenewed || undefined,
      durationMs: Date.now() - startedAt,
    });
    return data;
  } catch (err) {
    netpayLog.append({
      ...logBase,
      ok: false,
      httpStatus: err.response ? err.response.status : undefined,
      error: err.code || 'error',
      message: err.message,
      tokenRenewed: attempt.tokenRenewed || undefined,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function sendToTerminal(pathSuffix, body, attempt) {
  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    // Falla al pedir el token: la operación NUNCA se envió a la terminal.
    // payment.js usa esta marca para no confundirla con una venta ambigua.
    err.netpayStage = 'token';
    throw err;
  }

  let response;
  try {
    response = await axios.post(`${config.netpay.baseUrl}${pathSuffix}`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // 20s (no 5s): esta llamada empuja una orden a un dispositivo físico,
      // no solo pega contra un servicio en la nube — con 5s hubo timeouts
      // reales cuando la terminal venía de mostrar el ticket anterior.
      timeout: 20000,
    });
  } catch (err) {
    const data = err.response && err.response.data;
    const isInvalidToken =
      (err.response && err.response.status === 401) || (data && data.error === 'invalid_token');
    if (isInvalidToken && !attempt.tokenRenewed) {
      console.warn(`[netpayService] NetPay rechazó el token en ${pathSuffix} — se pide uno nuevo y se reintenta una vez`);
      cachedToken = null;
      cachedTokenExpiresAt = 0;
      attempt.tokenRenewed = true;
      return sendToTerminal(pathSuffix, body, attempt);
    }
    if (data && data.code) {
      const wrapped = new Error(`NetPay ${pathSuffix}: code ${data.code} — ${data.message || 'sin mensaje'}`);
      wrapped.code = `netpay_${data.code}`;
      wrapped.response = err.response;
      throw wrapped;
    }
    throw err;
  }

  const data = response.data || {};
  if (data.code !== undefined && String(data.code) !== '00') {
    const err = new Error(`NetPay ${pathSuffix}: code ${data.code} — ${data.message || 'sin mensaje'}`);
    err.code = `netpay_${data.code}`;
    throw err;
  }
  return data;
}

/**
 * Inicia un cobro en la terminal A910.
 * Confirmado contra la Referencia API (sección "5. Venta"):
 * - Endpoint: sin el prefijo "/gateway" que tenía antes.
 * - "folioNumber" es obligatorio — es NUESTRO identificador de referencia
 *   (reutilizamos el mismo orderId que ya trackeamos en sessionState).
 *   "orderId" en sí NO es un campo del request: lo genera y regresa la
 *   propia terminal en su respuesta (distinto a nuestro orderId interno).
 * - "traceability" es obligatorio: cabina, folio, paquete y operación
 *   (ver buildTraceability).
 * - Va por pushToTerminal() (27-sep-2026): valida el "code" de la
 *   respuesta — antes un code "19" (terminal no encontrada) pasaba como
 *   éxito y el cliente esperaba hasta el watchdog de pago — y reintenta
 *   una vez con token nuevo si NetPay lo invalidó.
 * - Que regrese sin error solo significa que la terminal RECIBIÓ la venta;
 *   el resultado llega por el webhook.
 */
async function createSale({ amount, orderId, packageId }) {
  return pushToTerminal('sale', '/integration-service/transactions/sale', {
    serialNumber: config.netpay.serialNumber,
    storeId: config.netpay.storeId,
    amount,
    folioNumber: orderId,
    traceability: buildTraceability({ operacion: 'venta', folio: orderId, paquete: packageId }),
  });
}

/**
 * Cancela (reversa) una venta ya cobrada — SIEMPRE por el monto completo,
 * NetPay no soporta cancelaciones parciales.
 * Confirmado contra la Referencia API oficial ("6. Cancelación") y el
 * correo de Integraciones:
 * - Endpoint: POST {baseUrl}/integration-service/transactions/cancel
 * - Body: { serialNumber, storeId, orderId, traceability } — este
 *   "orderId" es el que la PROPIA terminal generó y regresó en la
 *   respuesta de la venta original (terminalOrderId en sessionState.js /
 *   routes/webhook.js), NO nuestro folioNumber/orderId interno.
 *   folioNumber y reason son opcionales y solo van en traceability/log.
 * - Restricción: mismo día + antes de las 8pm CDMX (ver isPastCancelCutoff
 *   arriba) — se revisa ANTES de llamar al endpoint para no gastar el
 *   intento en un request que sabemos que NetPay va a rechazar, y para
 *   poder distinguir en el log/aviso "fuera de ventana" de una falla real
 *   de red o de la terminal. También queda en la bitácora.
 * - Que esta función regrese sin error solo significa que la terminal
 *   RECIBIÓ la orden de cancelar. El resultado real (aprobada/declinada)
 *   llega por el webhook con transType "V" — ver autoCancelService.
 *   resolveCancelResult().
 */
// orderIds (de la terminal) con una cancelación en vuelo en ESTE proceso —
// cubre dos llamadas casi simultáneas antes de que la primera alcance a
// quedar en el log.
const cancelsInFlight = new Set();

async function cancelSale({ orderId, folioNumber, reason }) {
  const body = {
    serialNumber: config.netpay.serialNumber,
    storeId: config.netpay.storeId,
    orderId,
    traceability: buildTraceability({ operacion: 'cancelacion', folio: folioNumber, motivo: reason }),
  };

  // Bloqueo de multi-instancias / doble cancelación (escenarios de
  // certificación "Cancelación de una venta con multi-instancias" y "Evitar
  // la cancelación de una venta cancelada desde el POS"): no se manda una
  // segunda cancelación si ya hay una en curso o si la venta ya está
  // cancelada según el log. Aplica igual a la cancelación automática y al
  // script manual. Queda en la bitácora con sent:false.
  const blocked = cancelsInFlight.has(orderId) ? 'pending' : netpayLog.findCancelState(orderId);
  if (blocked) {
    const err = new Error(
      blocked === 'cancelled'
        ? `la venta ${orderId} ya está cancelada — no se envía otra cancelación`
        : `ya hay una cancelación en curso para ${orderId} — se espera su respuesta antes de reintentar`
    );
    err.code = blocked === 'cancelled' ? 'already_cancelled' : 'cancel_in_progress';
    netpayLog.append({
      ...describeRequest('cancel', '/integration-service/transactions/cancel', body),
      ok: false,
      sent: false,
      error: err.code,
      message: err.message,
    });
    throw err;
  }

  if (isPastCancelCutoff()) {
    const err = new Error(
      'fuera de la ventana de cancelación de NetPay (después de las 8:00 p.m. hora CDMX) — requiere reverso manual'
    );
    err.code = 'cancel_window_closed';
    netpayLog.append({
      ...describeRequest('cancel', '/integration-service/transactions/cancel', body),
      ok: false,
      sent: false,
      error: err.code,
      message: err.message,
    });
    throw err;
  }

  cancelsInFlight.add(orderId);
  try {
    return await pushToTerminal('cancel', '/integration-service/transactions/cancel', body);
  } finally {
    cancelsInFlight.delete(orderId);
  }
}

/**
 * Reimpresión por orderId (Referencia API, "7. Reimpresión por orderId").
 * - "orderId" es el de la TERMINAL (terminalOrderId), igual que en
 *   cancelSale(). Solo sirve para transacciones que sí generaron orderId
 *   (aprobadas / canceladas) — para declinadas o ventas sin respuesta usar
 *   reprintByFolio().
 * - print=false manda disablePrintAnimation:true (la terminal NO imprime
 *   el ticket oficial, solo manda el JSON por webhook). En un kiosco
 *   desatendido casi siempre queremos solo el JSON; print=true es para
 *   cuando de verdad se necesita el papel (p.ej. pruebas de certificación).
 * - La respuesta llega por el webhook con isRePrint:true (routes/webhook.js).
 */
async function reprintByOrderId({ orderId, print = false, folioNumber, motivo }) {
  if (!orderId) throw new Error('reprintByOrderId: falta orderId (terminalOrderId)');
  return pushToTerminal('reprint', '/integration-service/transactions/reprint', {
    serialNumber: config.netpay.serialNumber,
    storeId: config.netpay.storeId,
    orderId,
    traceability: buildTraceability({ operacion: 'reimpresion', folio: folioNumber, motivo }),
    disablePrintAnimation: !print,
  });
}

/**
 * Reimpresión por folio (Referencia API, "8. Reimpresión por folio") —
 * OBLIGATORIA para certificar con NetPay, y la herramienta base del
 * manejo de reversos: es la única forma de consultar una venta cuando NO
 * tenemos el orderId de la terminal (declinada, o sin respuesta porque la
 * terminal se apagó a medio flujo).
 * - folioId = NUESTRO folio, el mismo que mandamos como folioNumber en
 *   createSale() (sessionState.orderId). Case-sensitive.
 * - orderId debe ir VACÍO — si trae algo, NetPay busca por orderId en vez
 *   de por folio.
 * - La respuesta llega por el webhook con isRePrint:true y el campo
 *   reprintModule indica el estado ("D" declinada, "RV" reversada, "PRV"
 *   pendiente por reversar — ver Flujo Manejo de Reversos.pdf).
 */
// `motivo` viaja en el traceability y la terminal lo regresa en la
// respuesta: así cada reimpresión dice de qué folio es y QUIÉN la pidió
// (consulta automática tras una declinada, tras un timeout, reconsulta de
// un PRV, o el operador desde el panel). Pendiente 4 de NetPay (15-oct):
// "validar si se está reimprimiendo el folio correcto".
async function reprintByFolio({ folioId, print = false, motivo }) {
  if (!folioId) throw new Error('reprintByFolio: falta folioId');
  return pushToTerminal('reprint', '/integration-service/transactions/reprint', {
    serialNumber: config.netpay.serialNumber,
    storeId: config.netpay.storeId,
    orderId: '',
    folioId,
    traceability: buildTraceability({ operacion: 'reimpresion', folio: folioId, motivo }),
    disablePrintAnimation: !print,
  });
}

/**
 * ¿La venta pudo haber llegado a la terminal aunque la petición falló?
 * (pendiente A4, 10-oct-2026). Ambigua = la petición de venta salió pero no
 * hubo respuesta HTTP (timeout, conexión cortada) o NetPay respondió 504
 * (gateway timeout). No es ambigua si falló al pedir el token (la venta no
 * se envió) ni si NetPay respondió con un rechazo claro (code distinto de
 * "00", 4xx, otros 5xx).
 */
function isAmbiguousPushError(err) {
  if (!err || err.netpayStage === 'token') return false;
  if (typeof err.code === 'string' && err.code.startsWith('netpay_')) return false;
  if (!err.response) return true;
  return err.response.status === 504;
}

module.exports = {
  isAmbiguousPushError,
  getAccessToken,
  createSale,
  cancelSale,
  reprintByOrderId,
  reprintByFolio,
  isPastCancelCutoff,
  buildTraceability,
};
