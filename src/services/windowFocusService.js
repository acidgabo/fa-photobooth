const { execFile } = require('child_process');
const config = require('../config');

/**
 * Swap de foco a nivel de Windows entre la ventana de LumaBooth (dslrBooth)
 * y la del navegador en kiosco.
 *
 * Por qué existe: LumaBooth es una app nativa de Windows con su propia
 * ventana (no se puede embeber). El navegador del kiosco y LumaBooth
 * tienen que turnarse el mismo espacio de pantalla física dos veces por
 * sesión — ver "Convivencia visual/de foco..." en
 * claude/Integración dslrbooth.md (doc del proyecto) para el diseño
 * completo.
 *
 * CONFIRMADO EN HARDWARE REAL (13-sep-2026): funciona en los dos
 * sentidos. Historial: con solo ShowWindow + SetForegroundWindow, Windows
 * bloqueaba el cambio de foco de forma consistente. Se reforzó con
 * AttachThreadInput + keybd_event(Alt) +
 * SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0), lo que destrabó
 * el sentido kiosco -> LumaBooth, pero LumaBooth -> kiosco seguía
 * fallando (attached=False, spiSetOk=False) específicamente cuando el
 * lockscreen de LumaBooth ya estaba visible — esa ventana de bloqueo
 * parece resistir los mecanismos de "activación". La pieza que lo
 * resolvió fue agregar SetWindowPos con HWND_TOPMOST/HWND_NOTOPMOST como
 * respaldo independiente: a diferencia de SetForegroundWindow, es una
 * operación de **orden en Z** (qué ventana se dibuja encima de cuál), no
 * de "activación" — Windows la restringe mucho menos. No garantiza que
 * la ventana reciba el teclado, pero sí la trae visualmente al frente,
 * que es lo que más importa en un kiosco táctil: que el cliente nunca
 * vea LumaBooth de fondo (un toque real del cliente sobre la ventana ya
 * visible la activa sin restricción, porque cuenta como input real del
 * usuario, no programático). Detalle completo de la prueba en
 * "Convivencia visual/de foco..." en claude/Integración dslrbooth.md
 * (doc del proyecto).
 *
 * Todos los mecanismos siguen siendo best-effort — ninguno puede tirar
 * el flujo de pago/sesión si falla. La red de seguridad real contra ese
 * posible fallo sigue siendo el lockscreen de LumaBooth (ver
 * dslrboothService.js), no este módulo.
 *
 * Activar/desactivar con KIOSK_WINDOW_FOCUS_ENABLED en .env. Nombres de
 * proceso configurables con KIOSK_DSLRBOOTH_PROCESS_NAME y
 * KIOSK_BROWSER_PROCESS_NAME (confirmar el nombre exacto con
 * `Get-Process` en la máquina real).
 */

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Escapa un valor para meterlo dentro de una cadena de PowerShell con
// comillas simples (' -> '').
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

// Busca el proceso por nombre (sin ".exe") con una ventana principal
// visible, la restaura por si estaba minimizada, y la trae al frente con
// SetForegroundWindow (P/Invoke a user32.dll).
async function focusProcessWindow(processName) {
  const psProcess = psQuote(processName);

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FaPhotoboothWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name '${psProcess}' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $proc) {
  Write-Output "NOT_FOUND"
  exit 0
}

$targetHwnd = $proc.MainWindowHandle
$VK_MENU = 0x12       # Alt
$KEYEVENTF_KEYUP = 0x2
$SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
$SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
$SPIF_SENDCHANGE = 0x2

# 0) Bajar a 0 el "foreground lock timeout" del sistema mientras dura esta
#    llamada — es una preferencia por usuario (no requiere admin), y es la
#    forma más directa (documentada por Microsoft) de permitir que un
#    proceso que no es el actual foreground se vuelva foreground. Se
#    restaura el valor original al final, pase lo que pase.
$originalTimeout = [uint32]0
$gotOriginal = [FaPhotoboothWin32]::SystemParametersInfo($SPI_GETFOREGROUNDLOCKTIMEOUT, 0, [ref]$originalTimeout, 0)
$zero = [uint32]0
$spiSetOk = [FaPhotoboothWin32]::SystemParametersInfo($SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [ref]$zero, $SPIF_SENDCHANGE)

# 1) Simular Alt (arriba/abajo) — refresca el "último input" de este
#    proceso, uno de los requisitos que Windows revisa antes de permitir
#    SetForegroundWindow.
[FaPhotoboothWin32]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
[FaPhotoboothWin32]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)

# 2) Unir el hilo de este proceso (PowerShell/Node vía execFile) al hilo
#    dueño de la ventana que hoy tiene el foco — mientras dura la unión,
#    Windows nos deja robarle el foco como si fuéramos esa misma app.
$dummyPid = [uint32]0
$fgWnd = [FaPhotoboothWin32]::GetForegroundWindow()
$fgThreadId = [FaPhotoboothWin32]::GetWindowThreadProcessId($fgWnd, [ref]$dummyPid)
$curThreadId = [FaPhotoboothWin32]::GetCurrentThreadId()

$attached = $false
if ($fgThreadId -ne 0 -and $fgThreadId -ne $curThreadId) {
  $attached = [FaPhotoboothWin32]::AttachThreadInput($curThreadId, $fgThreadId, $true)
}

[FaPhotoboothWin32]::ShowWindow($targetHwnd, 9) | Out-Null  # SW_RESTORE
Start-Sleep -Milliseconds 100
$ok = [FaPhotoboothWin32]::SetForegroundWindow($targetHwnd)

if ($attached) {
  [FaPhotoboothWin32]::AttachThreadInput($curThreadId, $fgThreadId, $false) | Out-Null
}

# Restaurar el foreground lock timeout original.
if ($gotOriginal) {
  $restore = $originalTimeout
  [FaPhotoboothWin32]::SystemParametersInfo($SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [ref]$restore, $SPIF_SENDCHANGE) | Out-Null
}

# 3) Respaldo independiente si SetForegroundWindow no lo logró: forzar el
#    orden en Z con SetWindowPos (HWND_TOPMOST=-1 y luego HWND_NOTOPMOST=-2
#    para no dejarla marcada como "siempre encima" permanentemente). Esto
#    no pide activación real, solo redibuja — Windows lo restringe mucho
#    menos que SetForegroundWindow.
$topmostOk = $false
if (-not $ok) {
  $HWND_TOPMOST = New-Object IntPtr(-1)
  $HWND_NOTOPMOST = New-Object IntPtr(-2)
  $SWP_NOMOVE = 0x0002
  $SWP_NOSIZE = 0x0001
  $SWP_SHOWWINDOW = 0x0040
  $flags = $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW
  $step1 = [FaPhotoboothWin32]::SetWindowPos($targetHwnd, $HWND_TOPMOST, 0, 0, 0, 0, $flags)
  Start-Sleep -Milliseconds 50
  $step2 = [FaPhotoboothWin32]::SetWindowPos($targetHwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, $flags)
  $topmostOk = $step1 -and $step2
}

Write-Output "RESULT:ok=$ok;topmostOk=$topmostOk;attached=$attached;spiSetOk=$spiSetOk;fgThread=$fgThreadId;curThread=$curThreadId;fgWndTitle=$($fgWnd)"
`.trim();

  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const result = stdout.trim();

  if (result === 'NOT_FOUND') {
    throw new Error(`No se encontró ninguna ventana visible para el proceso "${processName}"`);
  }
  if (result.startsWith('RESULT:ok=True')) {
    return; // SetForegroundWindow real — mejor caso, hay foco de teclado también.
  }
  if (result.includes('topmostOk=True')) {
    // No se logró la activación real, pero sí se forzó el orden en Z — la
    // ventana queda visible al frente (lo que más importa en el kiosco).
    return;
  }
  // Ninguno de los dos mecanismos funcionó — Windows bloqueó ambos.
  // El detalle (attached/spiSetOk/threads) es diagnóstico — ver la nota al
  // inicio de este archivo antes de agregar más workarounds.
  throw new Error(
    `No se pudo traer al frente la ventana de "${processName}" (ni SetForegroundWindow ni SetWindowPos) — ${result || '(sin salida)'}`
  );
}

async function focusDslrbooth() {
  return focusProcessWindow(config.kiosk.dslrboothProcessName);
}

async function focusBrowser() {
  return focusProcessWindow(config.kiosk.browserProcessName);
}

// Wrapper "silencioso": nunca tira error hacia quien lo llama, solo
// loguea. Es lo que se debe usar en el flujo real (webhook.js,
// routes/dslrbooth.js) — el swap de foco es hardening, no debe poder
// romper el flujo de pago/sesión si falla o si no estamos en Windows
// (por ejemplo, corriendo el backend en Linux/Fedora contra los mocks).
async function tryFocus(fn, label) {
  if (!config.kiosk.windowFocusEnabled) return;
  if (process.platform !== 'win32') {
    console.log(`[windowFocusService] ${label}: omitido (no es Windows)`);
    return;
  }
  try {
    await fn();
    console.log(`[windowFocusService] ${label}: foco cambiado OK`);
  } catch (err) {
    console.warn(`[windowFocusService] ${label}: no se pudo cambiar el foco (no bloqueante) — ${err.message}`);
  }
}

module.exports = {
  focusDslrbooth,
  focusBrowser,
  tryFocusDslrbooth: () => tryFocus(focusDslrbooth, 'focusDslrbooth'),
  tryFocusBrowser: () => tryFocus(focusBrowser, 'focusBrowser'),
};
