const express = require('express');
const router = express.Router();
const config = require('../config');
const linuxCameraService = require('../services/cameraService');
const linuxPrinterService = require('../services/printerService');
const windowsCameraService = require('../services/windowsCameraService');
const windowsPrinterService = require('../services/windowsPrinterService');

// Solo tiene sentido en BOOTH_MODE=direct (Linux, gphoto2/CUPS) o
// BOOTH_MODE=windirect (Windows, digiCamControl/impresora nativa) —
// confirma que el hardware está detectado ANTES de disparar un pago
// completo para probar. Úsalo en cuanto conectes el hardware:
//   curl http://localhost:4000/diagnostics/camera
//   curl http://localhost:4000/diagnostics/printer
function getCameraService() {
  return config.booth.mode === 'windirect' ? windowsCameraService : linuxCameraService;
}

function getPrinterService() {
  return config.booth.mode === 'windirect' ? windowsPrinterService : linuxPrinterService;
}

router.get('/camera', async (req, res) => {
  try {
    const result = await getCameraService().detectCamera();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/printer', async (req, res) => {
  try {
    const printers = await getPrinterService().listPrinters();
    res.json({ printers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
