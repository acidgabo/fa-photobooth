const express = require('express');
const router = express.Router();
const sessionState = require('../sessionState');

// El frontend hace polling aquí (cada 1-2s) para saber en qué paso va
// la cabina y actualizar la pantalla táctil.
router.get('/status', (req, res) => {
  res.json(sessionState.get());
});

router.post('/reset', (req, res) => {
  res.json(sessionState.reset());
});

module.exports = router;
