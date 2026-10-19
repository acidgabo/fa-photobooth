/**
 * Escenarios de prueba desde el kiosco (public/dev-escenarios.js).
 *
 * Solo existe con HARDWARE_MODE=mock (laptop de desarrollo): reenvía al mock
 * de LumaBooth (mocks/mock-dslrbooth.js) la lista de escenarios y el cambio
 * de escenario, para que el navegador no tenga que hablar directo con el
 * puerto 1500. En la cabina (HARDWARE_MODE=windows) todas estas rutas
 * responden 404.
 */
const express = require('express');
const axios = require('axios');
const config = require('../config');
const sessionState = require('../sessionState');

const router = express.Router();

// Con una venta o una sesión de fotos en curso, cambiar el escenario
// cortaría a la mitad los Triggers que el mock ya programó.
const BUSY_STATUSES = new Set(['awaiting_payment', 'payment_confirmed', 'booth_running']);

router.use((req, res, next) => {
  if (config.hardwareMonitor.mode !== 'mock') return res.status(404).json({ error: 'not_found' });
  next();
});

function mockBase() {
  return config.dslrbooth.baseUrl;
}

function mockError(res, err) {
  res.status(502).json({
    ok: false,
    error: 'mock_unreachable',
    message: `No responde el mock de LumaBooth en ${mockBase()} (${err.message}). ¿Está corriendo "npm run mock:dslrbooth"?`,
  });
}

router.get('/escenarios', async (req, res) => {
  try {
    const [{ data: list }, { data: hardware }] = await Promise.all([
      axios.get(`${mockBase()}/mock/escenarios`, { timeout: 3000 }),
      axios.get(`${mockBase()}/mock/hardware`, { timeout: 3000 }),
    ]);
    res.json({ ok: true, ...list, hardware, session: sessionState.get().status });
  } catch (err) {
    mockError(res, err);
  }
});

router.post('/escenario', async (req, res) => {
  const nombre = String((req.body && req.body.nombre) || '');
  const status = sessionState.get().status;
  if (BUSY_STATUSES.has(status)) {
    return res.status(409).json({
      ok: false,
      error: 'session_in_progress',
      message: 'Hay una venta o sesión en curso; cambia el escenario cuando regrese al inicio',
    });
  }
  try {
    const { data } = await axios.post(`${mockBase()}/mock/escenario`, { nombre }, { timeout: 3000 });
    console.log(`[devMock] escenario de prueba → "${data.activo}"`);
    res.json(data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    mockError(res, err);
  }
});

module.exports = router;
