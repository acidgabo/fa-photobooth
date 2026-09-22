const express = require('express');
const router = express.Router();
const config = require('../config');
const sessionState = require('../sessionState');
const dslrboothService = require('../services/dslrboothService');
const windowFocusService = require('../services/windowFocusService');

// dslrBooth manda aquí sus Triggers (event_type, param1, param2...) durante
// la sesión: session_start, countdown_start, countdown, capture_start,
// file_download, processing_start, printing, session_end.
// Configurar en dslrBooth: Settings > General > Triggers > URL Trigger
// apuntando a http://127.0.0.1:<DSLRBOOTH_TRIGGER_PORT>
router.get('/events', (req, res) => {
  const { event_type: eventType, param1, param2 } = req.query;

  sessionState.recordBoothEvent(eventType, param1, param2);

  // Convivencia de pantallas (ver "Convivencia visual/de foco..." en
  // claude/Integración dslrbooth.md): al terminar la sesión, LumaBooth debe
  // ceder el primer plano al navegador del kiosco. En ese orden: primero se
  // bloquea LumaBooth con su propia pantalla de bloqueo (API confiable, ya
  // confirmada) — así, si el robo de foco falla o tarda, el cliente ve esa
  // pantalla en vez de la interfaz real de LumaBooth a medio transicionar —
  // y solo después se intenta el cambio de foco a nivel de SO
  // (best-effort, con reintentos — ver tryFocusBrowserPersistent en
  // windowFocusService.js: un solo intento no bastaba cuando la sesión
  // terminaba por una falla de hardware, ver Guía de Pruebas — Monitoreo de
  // Hardware, 19-sep-2026). No se espera esta respuesta (fire-and-forget):
  // dslrBooth solo necesita el 200 OK, no le importa cuánto tarde lo que
  // hagamos con el evento.
  if (eventType === 'session_end' && config.booth.mode === 'dslrbooth') {
    dslrboothService.tryShowLockscreen().then(() => windowFocusService.tryFocusBrowserPersistent());
  }

  res.send('ok');
});

module.exports = router;
