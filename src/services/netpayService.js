const axios = require('axios');
const config = require('../config');

// Guardamos el token en memoria (proceso único en la NUC). Si el backend
// se reinicia, se vuelve a pedir. El access_token dura ~12h según la doc.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * IMPORTANTE: la forma exacta del body/response de /oauth/token todavía no
 * está confirmada contra el sandbox real (no tenemos cuenta de desarrollador
 * todavía). Esta implementación sigue lo que dice la doc de API Reference,
 * pero hay que RE-VALIDAR en cuanto lleguen las credenciales — puede que
 * cambien nombres de campo o headers exactos.
 *
 * Mientras tanto, config.netpay.baseUrl puede apuntar a mocks/mock-netpay.js
 * (ver .env: NETPAY_BASE_URL=http://localhost:5001) para probar todo el
 * flujo de código sin depender del sandbox real.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const response = await axios.post(`${config.netpay.baseUrl}/oauth/token`, {
    grant_type: config.netpay.grantType,
    username: config.netpay.username,
    password: config.netpay.password,
  }, {
    headers: { Authorization: `Basic ${config.netpay.authString}` },
    timeout: 5000, // sin esto, una URL mal configurada o caída se cuelga en silencio
  });

  cachedToken = response.data.access_token;
  cachedTokenExpiresAt = now + (response.data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Inicia un cobro en la terminal A910.
 * TODO: confirmar el shape exacto del body/response contra la guía de
 * "Realizando una venta" una vez tengamos acceso al sandbox real.
 */
async function createSale({ amount, orderId }) {
  const token = await getAccessToken();

  const response = await axios.post(
    `${config.netpay.baseUrl}/gateway/integration-service/transactions/sale`,
    {
      serialNumber: config.netpay.serialNumber,
      storeId: config.netpay.storeId,
      amount,
      orderId,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 5000 }
  );

  return response.data;
}

async function cancelSale({ orderId }) {
  const token = await getAccessToken();
  // --- STUB: POST /gateway/integration-service/transactions/cancel ---
  throw new Error('NetPay: cancelSale() no implementado todavía');
}

async function reprintTicket({ orderId }) {
  const token = await getAccessToken();
  // --- STUB: POST /gateway/integration-service/transactions/reprint ---
  throw new Error('NetPay: reprintTicket() no implementado todavía');
}

module.exports = { getAccessToken, createSale, cancelSale, reprintTicket };
