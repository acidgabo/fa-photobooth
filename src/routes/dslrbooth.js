const express = require('express');
const router = express.Router();
const sessionState = require('../sessionState');

// dslrBooth manda aquí sus Triggers (event_type, param1, param2...) durante
// la sesión: session_start, countdown_start, countdown, capture_start,
// file_download, processing_start, printing, session_end.
// Configurar en dslrBooth: Settings > General > Triggers > URL Trigger
// apuntando a http://127.0.0.1:<DSLRBOOTH_TRIGGER_PORT>
router.get('/events', (req, res) => {
  const { event_type: eventType, param1, param2 } = req.query;

  sessionState.recordBoothEvent(eventType, param1, param2);

  res.send('ok');
});

module.exports = router;
