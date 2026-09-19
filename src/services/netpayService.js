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

async function cancelSale({ orderId }) {
  const token = await getAccessToken();
  // --- STUB: POST /integration-service/transactions/cancel ---
  throw new Error('NetPay: cancelSale() no implementado todavía');
}

async function reprintTicket({ orderId }) {
  const token = await getAccessToken();
  // --- STUB: POST /integration-service/transactions/reprint ---
  throw new Error('NetPay: reprintTicket() no implementado todavía');
}

module.exports = { getAccessToken, createSale, cancelSale, reprintTicket };
