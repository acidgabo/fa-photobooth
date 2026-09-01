/**
 * Mock de la API local de dslrBooth (LumaBooth for Windows) — para probar
 * el flujo completo sin tener todavía una PC Windows con dslrBooth instalado.
 *
 * Simula:
 *   GET /api/start?mode=&password=   -> responde IsSuccessful:true
 *      y luego "dispara" los mismos eventos que dslrBooth manda por Triggers
 *      (session_start, countdown_start, capture_start, printing,
 *      session_end...) hacia el backend, con timings parecidos a una
 *      sesión real.
 *
 * Uso:
 *   node mocks/mock-dslrbooth.js
 *   (en el puerto 1500, igual que el real, para no tener que tocar el .env;
 *    el backend ya apunta ahí por default con DSLRBOOTH_BASE_URL)
 */
const express = require('express');
const axios = require('axios');

const app = express();

const PORT = process.env.MOCK_DSLRBOOTH_PORT || 1500;
const TRIGGER_URL =
  process.env.DSLRBOOTH_TRIGGER_CALLBACK || 'http://localhost:4000/dslrbooth/events';

const EVENT_SEQUENCE = [
  { delay: 0, event_type: 'session_start', param1: 'PrintAndGIF' },
  { delay: 300, event_type: 'countdown_start', param1: '3' },
  { delay: 1000, event_type: 'countdown', param1: '33' },
  { delay: 2000, event_type: 'countdown', param1: '66' },
  { delay: 3000, event_type: 'capture_start' },
  { delay: 3800, event_type: 'file_download', param1: 'mock_photo.jpg' },
  { delay: 4200, event_type: 'processing_start' },
  { delay: 5500, event_type: 'printing', param1: 'mock_photo.jpg', param2: '1' },
  { delay: 7000, event_type: 'session_end' },
];

app.get('/api/start', (req, res) => {
  const { mode, password } = req.query;
  console.log(`[mock-dslrbooth] /api/start mode=${mode} password=${password ? '(dado)' : '(vacío)'}`);

  res.json({
    ApiVersion: 1,
    Command: `start?mode=${mode}`,
    IsSuccessful: true,
    ErrorMessage: '',
  });

  EVENT_SEQUENCE.forEach(({ delay, ...event }) => {
    setTimeout(async () => {
      try {
        await axios.get(TRIGGER_URL, { params: event });
        console.log(`[mock-dslrbooth] evento enviado: ${event.event_type}`);
      } catch (err) {
        console.error(`[mock-dslrbooth] no se pudo mandar ${event.event_type}:`, err.message);
      }
    }, delay);
  });
});

app.listen(PORT, () => {
  console.log(`[mock-dslrbooth] escuchando en http://localhost:${PORT}`);
});
