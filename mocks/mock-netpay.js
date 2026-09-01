/**
 * Mock del NetPay Smart API — para probar el flujo completo del backend
 * sin cuenta de desarrollador real todavía.
 *
 * Simula:
 *   POST /oauth/token                                          -> access_token falso
 *   POST /gateway/integration-service/transactions/sale        -> "acepta" la venta
 *      y unos segundos después llama al webhook real de tu backend
 *      (NETPAY_WEBHOOK_CALLBACK) simulando la confirmación async de NetPay.
 *
 * Uso:
 *   node mocks/mock-netpay.js
 *   (por default en el puerto 5001; el backend debe apuntar
 *    NETPAY_BASE_URL=http://localhost:5001 en su .env)
 */
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.MOCK_NETPAY_PORT || 5001;
const WEBHOOK_CALLBACK =
  process.env.NETPAY_WEBHOOK_CALLBACK || 'http://localhost:4000/webhooks/netpay';

// Puedes forzar un resultado para probar los distintos casos:
//   MOCK_NETPAY_RESULT=timeout (default) | success | reject
// El default es timeout porque en producción la terminal espera que el
// cliente pase su tarjeta — no auto-confirma. Usa los botones del frontend
// para simular aprobación o rechazo. Para pruebas automáticas sin botones:
//   MOCK_NETPAY_RESULT=success npm run mock:netpay
const RESULT_MODE = process.env.MOCK_NETPAY_RESULT || 'timeout';

app.post('/oauth/token', (req, res) => {
  res.json({
    access_token: 'mock-access-token-' + Date.now(),
    expires_in: 3600,
    token_type: 'Bearer',
  });
});

app.post('/gateway/integration-service/transactions/sale', (req, res) => {
  const { orderId, amount } = req.body;
  console.log(`[mock-netpay] venta recibida: orderId=${orderId} amount=${amount} (modo=${RESULT_MODE})`);

  // NetPay responde rápido confirmando que RECIBIÓ la solicitud;
  // la confirmación real del pago llega después por webhook.
  res.status(200).json({ orderId, received: true });

  if (RESULT_MODE === 'timeout') {
    console.log('[mock-netpay] simulando timeout: no se manda webhook');
    return;
  }

  const delayMs = 3000; // simula el tiempo que tarda el usuario en pasar la tarjeta
  setTimeout(async () => {
    const success = RESULT_MODE !== 'reject';
    try {
      await axios.post(WEBHOOK_CALLBACK, {
        orderId,
        success,
        errorCode: success ? null : 'card_declined',
      });
      console.log(`[mock-netpay] webhook enviado: orderId=${orderId} success=${success}`);
    } catch (err) {
      console.error('[mock-netpay] no se pudo llamar al webhook del backend:', err.message);
    }
  }, delayMs);
});

app.listen(PORT, () => {
  console.log(`[mock-netpay] escuchando en http://localhost:${PORT} (modo=${RESULT_MODE})`);
});
