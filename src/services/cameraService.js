/**
 * Control directo de la Nikon D7200 vía gphoto2 — SOLO para la demo
 * temporal (BOOTH_MODE=direct). En producción esto lo hace dslrBooth.
 *
 * Requisitos en la máquina (Fedora):
 *   sudo dnf install gphoto2
 * Cámara conectada por USB, encendida, en modo "PTP" (no "Mass Storage" /
 * "Almacenamiento masivo" — revisar en el menú de la cámara, Setup >
 * USB connection). Si otro proceso tiene el USB tomado (gvfs, gphoto2spy,
 * el gestor de archivos que la monta automático), gphoto2 falla con
 * "Could not claim the USB device" — matar ese proceso o correr:
 *   killall gvfsd-gphoto2 gvfs-gphoto2-volume-monitor
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Confirma que gphoto2 ve al menos una cámara conectada.
 * Útil para un endpoint de diagnóstico antes de intentar capturar.
 */
async function detectCamera() {
  try {
    const { stdout, stderr } = await run('gphoto2', ['--auto-detect']);
    const lines = stdout
      .split('\n')
      .slice(2) // las primeras 2 líneas son encabezado/separador
      .map((l) => l.trim())
      .filter(Boolean);

    console.log(`[cameraService] gphoto2 --auto-detect detectó ${lines.length} cámara(s)`);
    if (lines.length > 0) {
      console.log(`[cameraService] Cámaras: ${lines.join(' | ')}`);
    }

    return {
      detected: lines.length > 0,
      raw: stdout,
      cameras: lines,
      count: lines.length
    };
  } catch (err) {
    console.error('[cameraService] gphoto2 --auto-detect falló:', err.message, err.stderr);
    throw new Error(
      `No se pudo correr gphoto2 --auto-detect (¿está instalado? ¿PATH? ¿USB libre?): ${err.message}`
    );
  }
}

/**
 * Dispara una captura y descarga el archivo a config.camera.captureDir.
 * Devuelve la ruta del archivo descargado.
 */
async function capturePhoto() {
  const dir = path.resolve(config.camera.captureDir);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `photo_${Date.now()}.jpg`;
  const fullPath = path.join(dir, filename);

  try {
    await run('gphoto2', [
      '--capture-image-and-download',
      `--filename=${fullPath}`,
      '--force-overwrite',
    ]);
  } catch (err) {
    throw new Error(
      `gphoto2 falló al capturar (¿cámara en modo PTP? ¿USB libre?): ${err.stderr || err.message}`
    );
  }

  if (!fs.existsSync(fullPath)) {
    throw new Error('gphoto2 no reportó error pero el archivo no aparece en disco');
  }

  return fullPath;
}

module.exports = { detectCamera, capturePhoto };
