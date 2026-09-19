const express = require('express');
const router = express.Router();
const sessionState = require('../sessionState');
const hardwareWatch = require('../hardwareWatch');

// El frontend hace polling aquí (cada 1-2s) para saber en qué paso va
// la cabina y actualizar la pantalla táctil. "hardware" viaja siempre en la
// respuesta (no solo en idle) para que el frontend pueda mostrar/ocultar la
// pantalla de "Cabina fuera de servicio" (ver src/hardwareWatch.js) sin
// necesitar un segundo polling aparte.
router.get('/status', (req, res) => {
  res.json({ ...sessionState.get(), hardware: hardwareWatch.getStatus() });
});

router.post('/reset', (req, res) => {
  res.json(sessionState.reset());
});

module.exports = router;
