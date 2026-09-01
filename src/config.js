require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,

  netpay: {
    baseUrl: process.env.NETPAY_BASE_URL || 'https://sandbox.netpay.com.mx',
    username: process.env.NETPAY_USERNAME || '',
    password: process.env.NETPAY_PASSWORD || '',
    authString: process.env.NETPAY_AUTH_STRING || '',
    grantType: process.env.NETPAY_GRANT_TYPE || 'password',
    serialNumber: process.env.NETPAY_SERIAL_NUMBER || '',
    storeId: process.env.NETPAY_STORE_ID || '',
    webhookPath: process.env.NETPAY_WEBHOOK_PATH || '/webhooks/netpay',
  },

  dslrbooth: {
    baseUrl: process.env.DSLRBOOTH_BASE_URL || 'http://localhost:1500',
    apiPassword: process.env.DSLRBOOTH_API_PASSWORD || '',
    triggerPort: process.env.DSLRBOOTH_TRIGGER_PORT || 8000,
  },

  // 'dslrbooth' = llama al API de dslrBooth (lo definitivo, Windows).
  // 'direct'    = controla cámara (gphoto2) e impresora (CUPS) directo en
  //               LINUX, SOLO para demo temporal mientras no hay NUC con
  //               dslrBooth (usa directBoothService.js).
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
};
