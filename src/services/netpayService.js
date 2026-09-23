const axios = require('axios');
const config = require('../config');

// Guardamos el token en memoria (proceso único en la NUC). Si el backend
// se reinicia, se vuelve a pedir. El access_token dura ~12h según la doc.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

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

  const response = await axios.post(`${config.netpay.baseUrl}/oauth-service/oauth/token`, body, {
    headers: {
      Authorization: `Basic ${config.netpay.authString}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 5000, // sin esto, una URL mal configurada o caída se cuelga en silencio
  });

  cachedToken = response.data.access_token;
  cachedTokenExpiresAt = now + (response.data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Inicia un cobro en la terminal A910.
 * Confirmado contra la Referencia API (sección "5. Venta"):
 * - Endpoint: sin el prefijo "/gateway" que tenía antes.
 * - "folioNumber" es obligatorio — es NUESTRO identificador de referencia
 *   (reutilizamos el mismo orderId que ya trackeamos en sessionState).
 *   "orderId" en sí NO es un campo del request: lo genera y regresa la
 *   propia terminal en su respuesta (distinto a nuestro orderId interno).
 * - "traceability" también es obligatorio según la tabla de parámetros
 *   (puede ir como objeto vacío si no necesitamos mandar nada extra).
 *
 * Timeout de 20s (no 5s como en getAccessToken): esta llamada empuja un
 * cobro a un dispositivo físico (la terminal), no solo pega contra un
 * servicio en la nube — confirmado en pruebas reales que un timeout de 5s
 * es demasiado ajustado y produce "timeout of 5000ms exceeded" en
 * situaciones donde la terminal tarda en confirmar que recibió el push
 * (p. ej. si venía de mostrar el ticket de una transacción anterior).
 */
async function createSale({ amount, orderId }) {
  const token = await getAccessToken();

  const response = await axios.post(
    `${config.netpay.baseUrl}/integration-service/transactions/sale`,
    {
      serialNumber: config.netpay.serialNumber,
      storeId: config.netpay.storeId,
      amount,
      folioNumber: orderId,
      traceability: {},
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  return response.data;
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

/**
 * Helper común para los "push" a la terminal que NO son la venta
 * (cancelación y reimpresiones). createSale() se queda como está a
 * propósito — su validación de respuesta es un paso aparte.
 *
 * Dos cosas que createSale() todavía no hace y aquí sí:
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
 *   las operaciones hasta reiniciar el backend.
 */
async function pushToTerminal(pathSuffix, body, { retryOnInvalidToken = true } = {}) {
  const token = await getAccessToken();

  let response;
  try {
    response = await axios.post(`${config.netpay.baseUrl}${pathSuffix}`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000, // push a un dispositivo físico — mismo criterio que createSale()
    });
  } catch (err) {
    const data = err.response && err.response.data;
    const isInvalidToken =
      (err.response && err.response.status === 401) || (data && data.error === 'invalid_token');
    if (isInvalidToken && retryOnInvalidToken) {
      cachedToken = null;
      cachedTokenExpiresAt = 0;
      return pushToTerminal(pathSuffix, body, { retryOnInvalidToken: false });
    }
    if (data && data.code) {
      const wrapped = new Error(`NetPay ${pathSuffix}: code ${data.code} — ${data.message || 'sin mensaje'}`);
      wrapped.code = `netpay_${data.code}`;
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
 * Cancela (reversa) una venta ya cobrada — SIEMPRE por el monto completo,
 * NetPay no soporta cancelaciones parciales.
 * Confirmado contra la Referencia API oficial ("6. Cancelación") y el
 * correo de Integraciones:
 * - Endpoint: POST {baseUrl}/integration-service/transactions/cancel
 * - Body: { serialNumber, storeId, orderId } — este "orderId" es el que la
 *   PROPIA terminal generó y regresó en la respuesta de la venta original
 *   (terminalOrderId en sessionState.js / routes/webhook.js), NO nuestro
 *   folioNumber/orderId interno que sí usa createSale().
 * - Restricción: mismo día + antes de las 8pm CDMX (ver isPastCancelCutoff
 *   arriba) — se revisa ANTES de llamar al endpoint para no gastar el
 *   intento en un request que sabemos que NetPay va a rechazar, y para
 *   poder distinguir en el log/aviso "fuera de ventana" de una falla real
 *   de red o de la terminal.
 * - Que esta función regrese sin error solo significa que la terminal
 *   RECIBIÓ la orden de cancelar. El resultado real (aprobada/declinada)
 *   llega por el webhook con transType "V" — ver autoCancelService.
 *   resolveCancelResult().
 */
async function cancelSale({ orderId }) {
  if (isPastCancelCutoff()) {
    const err = new Error(
      'fuera de la ventana de cancelación de NetPay (después de las 8:00 p.m. hora CDMX) — requiere reverso manual'
    );
    err.code = 'cancel_window_closed';
    throw err;
  }

  return pushToTerminal('/integration-service/transactions/cancel', {
    serialNumber: config.netpay.serialNumber,
    storeId: config.netpay.storeId,
    orderId,
    traceability: {},
  });
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
async function reprintByOrderId({ orderId, print = false }) {
  if (!orderId) throw new Error('reprintByOrderId: falta orderId (terminalOrderId)');
  return pushToTerminal('/integration-service/transactions/reprint', {
    serialNumber: config.netpay.serialNumber,
    storeId: config.netpay.storeId,
    orderId,
    traceability: {},
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
async function reprintByFolio({ folioId, print = false }) {
  if (!folioId) throw new Error('reprintByFolio: falta folioId');
  return pushToTerminal('/integration-service/transactions/reprint', {
    serialNumber: config.netpay.serialNumber,
    storeId: config.netpay.storeId,
    orderId: '',
    folioId,
    traceability: {},
    disablePrintAnimation: !print,
  });
}

module.exports = {
  getAccessToken,
  createSale,
  cancelSale,
  reprintByOrderId,
  reprintByFolio,
  isPastCancelCutoff,
};
