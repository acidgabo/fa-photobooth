/**
 * Control directo de la cámara vía digiCamControl (CameraControlCmd.exe) —
 * SOLO para la demo con hardware real en Windows sin dslrBooth
 * (BOOTH_MODE=windirect). En producción esto lo hace dslrBooth.
 *
 * Requisitos en la máquina (Windows):
 *   - digiCamControl instalado (gratis): http://digicamcontrol.com/download
 *   - Cámara conectada por USB, encendida, en modo PC/PTP (no almacenamiento
 *     masivo — revisar en el menú de la cámara).
 *   - Confirmar la ruta de CameraControlCmd.exe (normalmente
 *     "C:\Program Files (x86)\digiCamControl\CameraControlCmd.exe") o
 *     ajustarla con la variable de entorno DIGICAM_CONTROL_PATH si se
 *     instaló en otro lado.
 *
 * IMPORTANTE — /folder y /filename NO funcionan como se esperaría cuando la
 * app principal (CameraControl.exe, la GUI) está abierta con una sesión
 * activa: la sesión de la GUI manda, y la foto siempre cae en la carpeta de
 * esa sesión (ver config.windows.sessionFolder / DIGICAM_SESSION_FOLDER en
 * .env), sin importar qué le pasemos por línea de comandos. Confirmado
 * probando en la máquina de la demo: CameraControlCmd.exe /capture SÍ toma
 * la foto (aparece en el carrete de la GUI) pero /folder+/filename se
 * ignoran.
 *
 * Por eso capturePhoto() no confía en una ruta fija: dispara /capture y
 * luego vigila la carpeta de sesión real hasta ver aparecer un archivo
 * nuevo, y lo copia a config.camera.captureDir con un nombre propio para
 * que el resto del flujo (impresión, etc.) no tenga que saber nada de esto.
 *
 * Si en otra máquina/versión de digiCamControl el comportamiento cambia,
 * correr "C:\Program Files (x86)\digiCamControl\CameraControlCmd.exe" /help
 * ahí y ajustar según haga falta.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000 }, (error, stdout, stderr) => {
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
 * Confirma que digiCamControl ve al menos una cámara conectada.
 * Útil para GET /diagnostics/camera antes de disparar un pago completo.
 */
async function detectCamera() {
  const exe = config.windows.digicamControlPath;

  if (!fs.existsSync(exe)) {
    throw new Error(
      `No se encontró CameraControlCmd.exe en "${exe}". Verifica que digiCamControl esté instalado ` +
        'o ajusta la ruta con la variable de entorno DIGICAM_CONTROL_PATH en .env'
    );
  }

  try {
    const { stdout } = await run(exe, ['/list', 'cameras']);
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    console.log(`[windowsCameraService] CameraControlCmd /list cameras detectó ${lines.length} línea(s)`);
    if (lines.length > 0) {
      console.log(`[windowsCameraService] Salida: ${lines.join(' | ')}`);
    }

    return {
      detected: lines.length > 0,
      raw: stdout,
      cameras: lines,
      count: lines.length,
    };
  } catch (err) {
    console.error('[windowsCameraService] CameraControlCmd /list cameras falló:', err.message, err.stderr);
    throw new Error(
      `No se pudo correr CameraControlCmd.exe /list cameras (¿cámara encendida y en modo PTP? ` +
        `¿otro programa tiene el USB tomado, como el propio digiCamControl GUI abierto?): ${err.message}`
    );
  }
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.nef', '.cr2', '.tiff', '.tif']);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listImageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()));
}

/**
 * Espera a que aparezca un archivo de imagen nuevo en `dir` que no estuviera
 * en `before` (snapshot tomado antes de disparar /capture). Necesario porque
 * la GUI de digiCamControl guarda con su propio conteo/nombre de sesión, no
 * con el nombre que le pidamos por CLI.
 */
async function waitForNewFile(dir, before, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = listImageFiles(dir);
    const fresh = current.filter((name) => !before.has(name));

    if (fresh.length > 0) {
      // Si hay varias, la más reciente por fecha de modificación.
      const withStats = fresh.map((name) => {
        const fullPath = path.join(dir, name);
        return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
      });
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return withStats[0].fullPath;
    }

    await delay(intervalMs);
  }

  return null;
}

/**
 * Espera a que el tamaño del archivo deje de cambiar (digiCamControl puede
 * seguir escribiendo el archivo por un momento después de que aparece).
 */
async function waitForStableSize(filePath, { intervalMs = 300, stableChecks = 2, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const { size } = fs.statSync(filePath);
    if (size > 0 && size === lastSize) {
      stableCount += 1;
      if (stableCount >= stableChecks) return;
    } else {
      stableCount = 0;
    }
    lastSize = size;
    await delay(intervalMs);
  }
}

/**
 * Dispara una captura y descarga el archivo a config.camera.captureDir.
 * Devuelve la ruta del archivo descargado.
 */
async function capturePhoto() {
  const exe = config.windows.digicamControlPath;

  if (!fs.existsSync(exe)) {
    throw new Error(
      `No se encontró CameraControlCmd.exe en "${exe}". Verifica DIGICAM_CONTROL_PATH en .env`
    );
  }

  const sessionDir = path.resolve(config.windows.sessionFolder);
  const dir = path.resolve(config.camera.captureDir);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(sessionDir)) {
    throw new Error(
      `La carpeta de sesión de digiCamControl "${sessionDir}" no existe. Confirma la ruta en el ` +
        'panel "Sesión" de la GUI (ícono de engrane, campo "Folder") y ajusta DIGICAM_SESSION_FOLDER en .env'
    );
  }

  const before = new Set(listImageFiles(sessionDir));

  try {
    await run(exe, ['/capture']);
  } catch (err) {
    throw new Error(
      `CameraControlCmd.exe falló al capturar (¿cámara en modo PTP? ¿USB libre? ¿GUI de digiCamControl ` +
        `abierta y compitiendo por el puerto?): ${err.stderr || err.message}`
    );
  }

  const capturedPath = await waitForNewFile(sessionDir, before);

  if (!capturedPath) {
    throw new Error(
      `CameraControlCmd.exe no reportó error pero no apareció ningún archivo nuevo en "${sessionDir}" — ` +
        'verifica que la cámara siga conectada en modo PTP, que la GUI de digiCamControl siga abierta con ' +
        'una sesión activa, y que DIGICAM_SESSION_FOLDER en .env apunte a la carpeta correcta (ver campo ' +
        '"Folder" en el panel "Sesión" de la GUI)'
    );
  }

  await waitForStableSize(capturedPath);

  const ext = path.extname(capturedPath) || '.jpg';
  const filename = `photo_${Date.now()}${ext}`;
  const fullPath = path.join(dir, filename);
  fs.copyFileSync(capturedPath, fullPath);

  console.log(`[windowsCameraService] Foto capturada: "${capturedPath}" -> copiada a "${fullPath}"`);

  return fullPath;
}

module.exports = { detectCamera, capturePhoto };
