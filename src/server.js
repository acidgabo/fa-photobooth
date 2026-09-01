const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');

const paymentRoutes = require('./routes/payment');
const webhookRoutes = require('./routes/webhook');
const dslrboothRoutes = require('./routes/dslrbooth');
const sessionRoutes = require('./routes/session');
const diagnosticsRoutes = require('./routes/diagnostics');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', paymentRoutes);
app.use('/api/session', sessionRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/dslrbooth', dslrboothRoutes); // recibe los Triggers de dslrBooth
app.use('/diagnostics', diagnosticsRoutes); // solo relevante en BOOTH_MODE=direct

// Pantalla táctil: un solo archivo estático, sin build. Editar directo en
// public/index.html (o public/config.js para colores/textos).
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, () => {
  console.log(`Backend cabina de fotos escuchando en http://localhost:${config.port}`);
  console.log(`Frontend (pantalla táctil): http://localhost:${config.port}/`);
  console.log(`Modo de cabina (BOOTH_MODE): ${config.booth.mode}`);
  console.log('Endpoints:');
  console.log('  POST /api/pay              <- frontend inicia cobro');
  console.log('  GET  /api/session/status    <- frontend hace polling de estado');
  console.log('  POST /webhooks/netpay       <- NetPay confirma pago');
  console.log('  GET  /dslrbooth/events       <- dslrBooth manda triggers de sesión');
  console.log('  GET  /diagnostics/camera     <- (modo direct/windirect) confirma que la cámara está detectada');
  console.log('  GET  /diagnostics/printer    <- (modo direct/windirect) lista impresoras disponibles');
});
