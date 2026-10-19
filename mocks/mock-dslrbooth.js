/**
 * Mock de LumaBooth (dslrBooth for Windows) + cámara e impresora simuladas.
 *
 * Para trabajar la integración con NetPay en una laptop (Linux incluido) sin
 * LumaBooth, cámara ni impresora, y aun así poder provocar cada caso de la
 * taxonomía de fallas (claude/Taxonomia_Fallas_Cancelacion_Automatica.md):
 * el ESCENARIO elegido decide qué Triggers manda "LumaBooth" al backend y
 * cómo se ven la cámara y la impresora cuando el backend las revisa
 * (HARDWARE_MODE=mock, ver src/services/mockHardwareService.js).
 *
 * Endpoints que imita de LumaBooth (los mismos que usa el backend real):
 *   GET /api/start?mode=&password=
 *   GET /api/lockscreen/show?password=
 *   GET /api/lockscreen/exit?password=
 *
 * Endpoints de control (solo existen en el mock):
 *   GET  /mock/escenarios             lista de escenarios y cuál está activo
 *   POST /mock/escenario {nombre}     cambia el escenario (también resetea el hardware)
 *   GET  /mock/escenario/:nombre      lo mismo, para usarlo desde el navegador
 *   GET  /mock/hardware               estado simulado de cámara e impresora
 *   POST /mock/hardware/clear-queue   el backend "limpia la cola de impresión"
 *
 * Uso:
 *   npm run mock:dslrbooth                      (escenario "normal")
 *   MOCK_DSLRBOOTH_ESCENARIO=sin_impresion npm run mock:dslrbooth
 *   node mocks/escenario.js sin_impresion       (cambiarlo con el mock corriendo)
 *
 * Puerto 1500, igual que LumaBooth, para que DSLRBOOTH_BASE_URL sea el mismo
 * en la laptop y en la cabina.
 */
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.MOCK_DSLRBOOTH_PORT || 1500;
const TRIGGER_URL = process.env.DSLRBOOTH_TRIGGER_CALLBACK || 'http://localhost:4000/dslrbooth/events';
const EXPECTED_PASSWORD = process.env.DSLRBOOTH_API_PASSWORD || '';

// Sesión completa, tal como la manda LumaBooth (timings parecidos a una real).
const FULL_SESSION = [
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

// La misma sesión pero sin el Trigger "printing" (LumaBooth cierra la sesión
// aunque algo haya fallado a medio camino — visto en pruebas reales, 19-sep).
const SESSION_WITHOUT_PRINTING = [
  ...FULL_SESSION.filter((e) => e.event_type !== 'printing' && e.event_type !== 'session_end'),
  { delay: 5500, event_type: 'session_end' },
];

const HW_OK = () => ({
  camera: { present: true, detail: null },
  printer: { ok: true, detail: null, pendingJobs: 0 },
});

/**
 * Cada escenario: qué Triggers manda al iniciar la sesión, cómo cambia el
 * hardware durante la sesión (hwChanges, por delay) y cómo arranca el
 * hardware (initialHardware). `esperado` es lo que debe hacer el backend.
 */
const SCENARIOS = {
  normal: {
    descripcion: 'Sesión completa con impresión.',
    esperado: 'Flujo normal: pago confirmado → fotos → impresión → regreso al inicio. Sin cancelación.',
    events: FULL_SESSION,
  },
  sin_impresion: {
    descripcion: 'La cámara se desconecta a media sesión; LumaBooth cierra la sesión sin "printing".',
    esperado: 'Grupo 4a: session_end sin printing + cámara ausente → CANCELACIÓN AUTOMÁTICA. Después la cabina queda fuera de servicio (cámara ausente) hasta volver a "normal".',
    events: SESSION_WITHOUT_PRINTING,
    hwChanges: [{ delay: 3500, camera: { present: false, detail: 'Cámara (VID_04B0&PID_0439) no detectada por USB — simulado' } }],
  },
  sin_impresion_camara_ok: {
    descripcion: 'La sesión termina sin "printing" pero la cámara sigue conectada.',
    esperado: 'Solo aviso de "sesión probablemente incompleta". NO se cancela (la causa no está confirmada).',
    events: SESSION_WITHOUT_PRINTING,
  },
  falla_impresora: {
    descripcion: 'LumaBooth manda "printing", pero la impresora se queda sin papel con el trabajo en cola.',
    esperado: 'Grupo 4b: impresora con problema + trabajo pendiente → CANCELACIÓN AUTOMÁTICA y se limpia la cola. Después la cabina queda fuera de servicio hasta volver a "normal".',
    events: FULL_SESSION,
    hwChanges: [{ delay: 5600, printer: { ok: false, detail: 'Impresora DS-RX1: sin papel — simulado', pendingJobs: 1 } }],
  },
  colgada: {
    descripcion: 'LumaBooth arranca la sesión y deja de mandar Triggers.',
    esperado: 'Grupo 3: el watchdog vence en booth_running (BOOTH_TIMEOUT_MS) → CANCELACIÓN AUTOMÁTICA. Tip: baja BOOTH_TIMEOUT_MS en el .env de la laptop (p.ej. 60000).',
    events: FULL_SESSION.slice(0, 3),
  },
  falla_inicio: {
    descripcion: 'El API de LumaBooth responde que no pudo iniciar la sesión.',
    esperado: 'Grupo 2: startSession falla después del cobro → CANCELACIÓN AUTOMÁTICA.',
    startFails: 'Simulado: LumaBooth no está en la pantalla de inicio',
  },
  camara_desconectada: {
    descripcion: 'La cámara está desconectada desde antes de cobrar.',
    esperado: 'La cabina se marca fuera de servicio y el kiosco NO deja cobrar (no hay nada que cancelar).',
    events: FULL_SESSION,
    initialHardware: { camera: { present: false, detail: 'Cámara (VID_04B0&PID_0439) no detectada por USB — simulado' } },
  },
  impresora_sin_papel: {
    descripcion: 'La impresora está sin papel desde antes de cobrar.',
    esperado: 'La cabina se marca fuera de servicio y el kiosco NO deja cobrar.',
    events: FULL_SESSION,
    initialHardware: { printer: { ok: false, detail: 'Impresora DS-RX1: sin papel — simulado', pendingJobs: 0 } },
  },
};

let scenarioName = process.env.MOCK_DSLRBOOTH_ESCENARIO || 'normal';
if (!SCENARIOS[scenarioName]) {
  console.warn(`[mock-dslrbooth] escenario "${scenarioName}" no existe — se usa "normal"`);
  scenarioName = 'normal';
}
let hardware = HW_OK();
let pendingTimers = [];

function applyHardware(change) {
  if (change.camera) hardware.camera = { ...hardware.camera, ...change.camera };
  if (change.printer) hardware.printer = { ...hardware.printer, ...change.printer };
}

function setScenario(name) {
  pendingTimers.forEach(clearTimeout);
  pendingTimers = [];
  scenarioName = name;
  hardware = HW_OK();
  if (SCENARIOS[name].initialHardware) applyHardware(SCENARIOS[name].initialHardware);
  console.log(`[mock-dslrbooth] escenario → "${name}": ${SCENARIOS[name].descripcion}`);
  console.log(`[mock-dslrbooth]   se espera: ${SCENARIOS[name].esperado}`);
}

function schedule(fn, delay) {
  const t = setTimeout(() => {
    pendingTimers = pendingTimers.filter((x) => x !== t);
    fn();
  }, delay);
  pendingTimers.push(t);
}

function passwordOk(req) {
  return !EXPECTED_PASSWORD || req.query.password === EXPECTED_PASSWORD;
}

function lumaResponse(res, command, ok, error = '') {
  res.json({ ApiVersion: 1, Command: command, IsSuccessful: ok, ErrorMessage: error });
}

// ---------------------------------------------------------------------
// API de LumaBooth
// ---------------------------------------------------------------------
app.get('/api/start', (req, res) => {
  const scenario = SCENARIOS[scenarioName];
  console.log(`[mock-dslrbooth] /api/start mode=${req.query.mode} — escenario "${scenarioName}"`);

  if (!passwordOk(req)) return lumaResponse(res, `start?mode=${req.query.mode}`, false, 'Invalid password');
  if (scenario.startFails) return lumaResponse(res, `start?mode=${req.query.mode}`, false, scenario.startFails);

  lumaResponse(res, `start?mode=${req.query.mode}`, true);

  (scenario.hwChanges || []).forEach((change) =>
    schedule(() => {
      applyHardware(change);
      console.log(`[mock-dslrbooth] hardware simulado cambió: ${JSON.stringify(hardware)}`);
    }, change.delay)
  );

  (scenario.events || []).forEach(({ delay, ...event }) =>
    schedule(async () => {
      try {
        await axios.get(TRIGGER_URL, { params: event });
        console.log(`[mock-dslrbooth] Trigger enviado: ${event.event_type}`);
      } catch (err) {
        console.error(`[mock-dslrbooth] no se pudo mandar ${event.event_type}: ${err.message}`);
      }
    }, delay)
  );
});

app.get('/api/lockscreen/show', (req, res) => lumaResponse(res, 'lockscreen/show', passwordOk(req)));
app.get('/api/lockscreen/exit', (req, res) => lumaResponse(res, 'lockscreen/exit', passwordOk(req)));

// ---------------------------------------------------------------------
// Control del mock
// ---------------------------------------------------------------------
function listScenarios() {
  return {
    activo: scenarioName,
    escenarios: Object.entries(SCENARIOS).map(([nombre, s]) => ({ nombre, descripcion: s.descripcion, esperado: s.esperado })),
  };
}

function changeScenario(name, res) {
  if (!SCENARIOS[name]) {
    return res.status(404).json({ ok: false, error: `No existe el escenario "${name}"`, ...listScenarios() });
  }
  setScenario(name);
  res.json({ ok: true, activo: name, ...SCENARIOS[name], events: undefined, hwChanges: undefined, hardware });
}

app.get('/mock/escenarios', (req, res) => res.json(listScenarios()));
app.post('/mock/escenario', (req, res) => changeScenario(String((req.body && req.body.nombre) || ''), res));
app.get('/mock/escenario/:nombre', (req, res) => changeScenario(req.params.nombre, res));

app.get('/mock/hardware', (req, res) => res.json({ escenario: scenarioName, ...hardware }));
app.post('/mock/hardware/clear-queue', (req, res) => {
  const cleared = hardware.printer.pendingJobs || 0;
  hardware.printer.pendingJobs = 0;
  console.log(`[mock-dslrbooth] cola de impresión limpiada por el backend (${cleared} trabajo(s))`);
  res.json({ ok: true, cleared });
});

app.listen(PORT, () => {
  console.log(`[mock-dslrbooth] escuchando en http://localhost:${PORT} — Triggers hacia ${TRIGGER_URL}`);
  setScenario(scenarioName);
});
