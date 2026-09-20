require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,

  // Watchdog de sesión (ver src/sessionState.js): red de seguridad del lado
  // del backend para los dos estados en los que la sesión puede quedarse
  // colgada indefinidamente si el otro lado (NetPay o dslrBooth) nunca
  // avisa. El frontend YA tiene su propio timeout de pago (30s, ver
  // public/index.html) pero es best-effort del navegador — si el kiosco se
  // recarga, el JS truena, o alguien cierra la pestaña, ese timer se pierde
  // y el backend se quedaría esperando para siempre sin esto. Este watchdog
  // es la autoridad real, independiente del frontend.
  watchdog: {
    // Cuánto esperar en 'awaiting_payment' sin que llegue el webhook de
    // NetPay. Deliberadamente más largo que el timeout de 30s del frontend
    // — no debe competir con él en operación normal, solo debe rescatar la
    // sesión si el frontend nunca llegó a intentarlo.
    paymentTimeoutMs: parseInt(process.env.PAYMENT_TIMEOUT_MS || '180000', 10),
    // Cuánto esperar en 'booth_running' SIN NINGÚN evento nuevo de dslrBooth
    // (se reinicia con cada evento que llega — countdown, capture_start,
    // printing, etc. — así que esto detecta un cuelgue real a medio camino,
    // no solo la ausencia del session_end final). 2 minutos da margen de
    // sobra para el paso más lento normal (impresión en la DNP DS-RX1).
    boothTimeoutMs: parseInt(process.env.BOOTH_TIMEOUT_MS || '120000', 10),
  },

  netpay: {
    baseUrl: process.env.NETPAY_BASE_URL || 'https://sandbox.netpay.com.mx',
    username: process.env.NETPAY_USERNAME || '',
    password: process.env.NETPAY_PASSWORD || '',
    authString: process.env.NETPAY_AUTH_STRING || '',
    grantType: process.env.NETPAY_GRANT_TYPE || 'password',
    serialNumber: process.env.NETPAY_SERIAL_NUMBER || '',
    storeId: process.env.NETPAY_STORE_ID || '',
    webhookPath: process.env.NETPAY_WEBHOOK_PATH || '/webhooks/netpay',
    // Log temporal de diagnóstico en el webhook (imprime el body completo
    // recibido de la terminal) — activar con NETPAY_DEBUG_LOG=true en .env
    // mientras se sigue validando la integración contra la terminal real.
    // Debe quedar en false (o sin definir) en producción.
    debugLog: process.env.NETPAY_DEBUG_LOG === 'true',
    // true cuando NETPAY_BASE_URL apunta al mock local
    // (mocks/mock-netpay.js, por default http://localhost:5001) en vez de
    // al sandbox/producción real de NetPay. El frontend lo lee vía
    // GET /api/config para decidir si corre su propio timeout local de
    // 30s — ver "Timer de 30s" en Bitacora_Pruebas_Netpay_dslrBooth.md:
    // contra terminal real ese timer mandaba un webhook fantasma que
    // siempre se ignoraba en silencio, y combinado con un doble tap o un
    // reload dejaba cobros huérfanos. Contra terminal real basta con el
    // watchdog de arriba.
    isMock: /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(
      process.env.NETPAY_BASE_URL || 'https://sandbox.netpay.com.mx'
    ),
  },

  dslrbooth: {
    baseUrl: process.env.DSLRBOOTH_BASE_URL || 'http://localhost:1500',
    apiPassword: process.env.DSLRBOOTH_API_PASSWORD || '',
    triggerPort: process.env.DSLRBOOTH_TRIGGER_PORT || 8000,
  },

  // 'dslrbooth' = llama al API de dslrBooth (lo definitivo, Windows).
  // 'direct'    = controla cámara (gphoto2) e impresora (CUPS) directo en
  //               LINUX, SOLO para demo temporal mientras no hay laptop
  //               Windows con dslrBooth (usa directBoothService.js).
  // 'windirect' = controla cámara (digiCamControl) e impresora (Windows)
  //               directo en WINDOWS, SOLO para demo con hardware real
  //               antes de instalar dslrBooth (usa windirectBoothService.js).
  booth: {
    mode: process.env.BOOTH_MODE || 'dslrbooth',
  },

  camera: {
    // Usado por BOOTH_MODE=direct (gphoto2, Linux) y BOOTH_MODE=windirect
    // (digiCamControl, Windows).
    // Linux: gphoto2 debe estar instalado (dnf install gphoto2 en Fedora) y
    // la cámara conectada por USB en modo "PTP"/transferencia, no "Mass Storage".
    captureDir: process.env.CAMERA_CAPTURE_DIR || './captures',
    countdownSeconds: parseInt(process.env.CAMERA_COUNTDOWN_SECONDS || '3', 10),
    // VID/PID de la Nikon D7200 de producción (ver src/services/
    // hardwareMonitorService.js) — confirmados en Administrador de
    // dispositivos > D7200 > Detalles > Id. de hardware (13-sep-2026):
    // USB\VID_04B0&PID_0439. Se usan SOLO para confirmar presencia por WMI
    // (Win32_PnPEntity), sin abrir sesión PTP — no tiene relación con
    // digiCamControl/windowsCameraService.js (eso es solo windirect).
    vid: process.env.CAMERA_VID || '04B0',
    pid: process.env.CAMERA_PID || '0439',
  },

  printer: {
    // Usado por BOOTH_MODE=direct (nombre de cola CUPS, ver `lpstat -p`) y
    // BOOTH_MODE=windirect (nombre exacto de la impresora en Windows, ver
    // GET /diagnostics/printer). Si se deja vacío, el servicio de impresión
    // lanza un error explicando qué falta.
    name: process.env.PRINTER_NAME || '',
    copies: parseInt(process.env.PRINTER_COPIES || '1', 10),
  },

  // Solo se usa con BOOTH_MODE=windirect.
  windows: {
    // Ruta a CameraControlCmd.exe (digiCamControl). Ajustar si se instaló
    // en otra carpeta.
    digicamControlPath:
      process.env.DIGICAM_CONTROL_PATH ||
      'C:\\Program Files (x86)\\digiCamControl\\CameraControlCmd.exe',
    // Carpeta REAL donde digiCamControl guarda las fotos. Cuando la app
    // principal (CameraControl.exe, la GUI) está abierta con una sesión
    // activa, esa sesión manda sobre los flags /folder y /filename del CLI
    // — la foto siempre cae en la carpeta de la sesión de la GUI, sin
    // importar qué le pasemos por línea de comandos. Ver el campo "Folder"
    // en el panel "Sesión" de la GUI (ícono de engrane) para confirmar la
    // ruta exacta en esta máquina.
    sessionFolder:
      process.env.DIGICAM_SESSION_FOLDER ||
      'C:\\Users\\Photobooth\\Pictures\\digiCamControl\\Session1',
    // Pausa entre copias al imprimir con mspaint /pt (no soporta un
    // parámetro nativo de "número de copias").
    printCopiesDelayMs: parseInt(process.env.WINDOWS_PRINT_COPY_DELAY_MS || '2000', 10),
  },

  // Monitoreo de hardware (cámara + impresora) — ver src/hardwareWatch.js y
  // src/services/hardwareMonitorService.js. Solo corre en modos "Windows"
  // (dslrbooth, windirect), porque las consultas son vía WMI/PowerShell —
  // en BOOTH_MODE=direct (Linux) no se activa. Ver
  // claude/Propuesta_Monitoreo_Camara_Impresora.md (doc del proyecto) para
  // el diseño completo.
  hardwareMonitor: {
    // Apaga por completo el monitoreo (el loop de fondo Y el chequeo
    // síncrono en POST /api/pay) sin tener que tocar BOOTH_MODE — útil para
    // probar en una máquina sin cámara/impresora conectadas, o mientras se
    // valida en campo si el chequeo da falsos positivos. Con esto en false,
    // hardwareWatch.checkNow() siempre regresa { ok: true }, igual que en
    // BOOTH_MODE=direct. Default: activado.
    enabled: (process.env.HARDWARE_MONITOR_ENABLED || 'true') === 'true',
    // Cadencia normal: solo se revisa mientras la sesión está en "idle" (no
    // tiene caso interrumpir una sesión de fotos ya pagada/en curso a media
    // captura). Antes de aceptar un pago (POST /api/pay) SIEMPRE se hace
    // además un chequeo síncrono fresco, así que este intervalo es solo
    // para poder avisar (Discord) ANTES de que llegue un cliente.
    idlePollIntervalMs: parseInt(process.env.HARDWARE_IDLE_POLL_MS || '30000', 10),
    // Cadencia acelerada mientras la cabina está marcada "fuera de
    // servicio": para detectar la recuperación (p.ej. alguien reconectó la
    // cámara o destrabó la impresora) y reabrir la cabina solo, sin
    // necesitar que alguien reinicie el backend.
    retryPollIntervalMs: parseInt(process.env.HARDWARE_RETRY_POLL_MS || '10000', 10),
  },

  discord: {
    // Webhook de un canal de Discord (gratis) — Configuración del canal >
    // Integraciones > Webhooks > Nuevo webhook. Best-effort: si falla o no
    // está configurado, solo se loguea, nunca rompe el flujo de la cabina.
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },

  // Convivencia visual/de foco entre el navegador del kiosco y la ventana
  // de LumaBooth (dslrBooth) — solo aplica con BOOTH_MODE=dslrbooth. Ver
  // "Convivencia visual/de foco..." en claude/Integración dslrbooth.md
  // (doc del proyecto) para el diseño completo. El swap de foco a nivel de
  // Windows es best-effort (ver src/services/windowFocusService.js) —
  // Windows a veces bloquea el robo de foco a una app en pantalla completa,
  // por eso nunca debe poder romper el flujo de pago/sesión si falla.
  kiosk: {
    // Apagar por completo el swap de foco (no el lockscreen, que es
    // independiente) mientras se prueba en hardware real.
    windowFocusEnabled: (process.env.KIOSK_WINDOW_FOCUS_ENABLED || 'true') === 'true',
    // Nombre EXACTO del proceso (sin ".exe"), tal como aparece en
    // `Get-Process` en la máquina Windows real — confirmar ahí, puede ser
    // "dslrBooth" o "LumaBooth" según cómo se llame el .exe instalado.
    dslrboothProcessName: process.env.KIOSK_DSLRBOOTH_PROCESS_NAME || 'dslrBooth',
    // Nombre del proceso del navegador corriendo en modo kiosco
    // (p.ej. "chrome", "msedge") — confirmar también con `Get-Process`.
    browserProcessName: process.env.KIOSK_BROWSER_PROCESS_NAME || 'chrome',
  },
};
