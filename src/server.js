const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');

const paymentRoutes = require('./routes/payment');
const webhookRoutes = require('./routes/webhook');
const dslrboothRoutes = require('./routes/dslrbooth');
const sessionRoutes = require('./routes/session');
const diagnosticsRoutes = require('./routes/diagnostics');
const devMockRoutes = require('./routes/devMock');
const adminRoutes = require('./routes/admin');
const hardwareWatch = require('./hardwareWatch');
const { lenientNetpayBody } = require('./middleware/netpayBody');

const app = express();
app.use(cors());
// Webhook de NetPay: se lee como texto y se parsea con tolerancia (ver
// middleware/netpayBody.js). Va ANTES de express.json(), que ya no lo
// vuelve a leer porque express.text() marca el body como consumido.
app.use('/webhooks/netpay', express.text({ type: () => true, limit: '1mb' }), lenientNetpayBody);
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', paymentRoutes);
app.use('/api/session', sessionRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/dslrbooth', dslrboothRoutes); // recibe los Triggers de dslrBooth
app.use('/diagnostics', diagnosticsRoutes); // solo relevante en BOOTH_MODE=direct
app.use('/api/dev', devMockRoutes); // escenarios de prueba — solo con HARDWARE_MODE=mock
// Panel remoto de reimpresiones y reversos. La página en sí no tiene datos
// (se sirve sin token); todo lo que trae datos o manda algo a la terminal
// vive en /admin/api/* y pasa por middleware/adminAuth.js.
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use('/admin', adminRoutes);

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
  console.log(
    `Panel de reimpresiones: http://localhost:${config.port}/admin ` +
      (process.env.ADMIN_TOKEN ? '(token configurado)' : '(APAGADO: falta ADMIN_TOKEN en .env)')
  );

  // Monitoreo de hardware (cámara + impresora) — ver src/hardwareWatch.js.
  // No bloquea el arranque: si BOOTH_MODE no lo soporta, se desactiva solo.
  hardwareWatch.start();
});
