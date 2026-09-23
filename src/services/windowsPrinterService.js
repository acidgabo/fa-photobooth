/**
 * Impresión directa en Windows — SOLO para la demo con hardware real en
 * Windows sin dslrBooth (BOOTH_MODE=windirect). En producción esto lo hace
 * dslrBooth.
 *
 * Requisitos en la máquina (Windows):
 *   - La DNP RX1 (o la impresora que se use) instalada con su driver de
 *     Windows y agregada como impresora del sistema (Configuración >
 *     Impresoras y escáneres).
 *   - Imprimir usa PowerShell + System.Drawing.Printing (.NET) para mandar
 *     la imagen directo a la impresora por nombre, sin abrir ninguna
 *     ventana. Se intentó primero con "mspaint /pt <archivo> <impresora>"
 *     (switch legacy documentado desde Windows 2000), pero en la práctica
 *     falla en silencio en builds recientes de Windows 10/11 sin dar razón
 *     — System.Drawing.Printing da errores reales (impresora inválida,
 *     fuera de línea, etc.) y es el método recomendado aquí.
 *   - Listar impresoras usa el cmdlet de PowerShell "Get-Printer" (incluido
 *     de fábrica en Windows 10/11).
 */
const { execFile } = require('child_process');
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
 * Lista las impresoras que Windows conoce en esta máquina.
 * Útil para confirmar el nombre exacto que hay que poner en PRINTER_NAME.
 */
async function listPrinters() {
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Printer | Select-Object -ExpandProperty Name',
    ]);

    const printers = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    console.log(`[windowsPrinterService] Get-Printer detectó ${printers.length} impresora(s): ${printers.join(', ')}`);
    return printers;
  } catch (err) {
    console.error('[windowsPrinterService] Get-Printer falló:', err.message, err.stderr);
    return [];
  }
}

// Escapa un valor para meterlo dentro de una cadena de PowerShell con
// comillas simples (' -> '').
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

// Códigos de Win32_Printer.DetectedErrorState (WMI) que nos importan para
// decidir si la impresora puede imprimir ahora mismo. Ver documentación de
// DetectedErrorState en MSDN para la lista completa de valores.
const PRINTER_ERROR_STATES = {
  3: 'Poca tinta/tóner',
  4: 'Sin tinta/tóner',
  5: 'Papel atascado',
  6: 'Papel agotado',
  7: 'Poco papel',
  8: 'Puerta abierta',
  9: 'Cubierta abierta',
  10: 'Falla de interfaz',
  11: 'Fuera de línea',
  12: 'Fuera de servicio',
  15: 'Salida llena',
  16: 'No hay entrada de papel',
  17: 'Error de tóner/tinta',
  19: 'Voltaje bajo',
  20: 'Sobrecalentada',
  21: 'Atasco de nuevo',
  22: 'Puerto de salida atascado',
  23: 'Papel torcido',
  24: 'Fuera de memoria',
  25: 'Puerta abierta',
};

/**
 * Confirma que la impresora configurada en PRINTER_NAME está lista para
 * imprimir, vía WMI (Win32_Printer) — sin mandar nada a imprimir. Usado por
 * src/hardwareWatch.js (monitoreo de hardware), independiente de quién
 * mande el trabajo de impresión real (dslrBooth o este mismo servicio).
 */
async function getPrinterStatus() {
  if (!config.printer.name) {
    return { ok: false, detail: 'PRINTER_NAME no está configurado en .env' };
  }

  const psPrinter = psQuote(config.printer.name);
  const script = `
$ErrorActionPreference = 'Stop'
$p = Get-CimInstance -ClassName Win32_Printer -Filter "Name='${psPrinter}'"
if (-not $p) { Write-Output 'NOT_FOUND'; exit 0 }
Write-Output ("WorkOffline=" + $p.WorkOffline)
Write-Output ("DetectedErrorState=" + $p.DetectedErrorState)
`.trim();

  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const out = stdout.trim();

    if (out.startsWith('NOT_FOUND') || !out) {
      return { ok: false, detail: `No se encontró la impresora "${config.printer.name}" en Windows` };
    }

    const values = {};
    out.split('\n').forEach((line) => {
      const [key, val] = line.split('=');
      if (key) values[key.trim()] = (val || '').trim();
    });

    const workOffline = values.WorkOffline === 'True';
    const errorState = parseInt(values.DetectedErrorState, 10) || 0;
    const knownError = PRINTER_ERROR_STATES[errorState];

    if (workOffline) {
      return { ok: false, detail: `Impresora "${config.printer.name}" está fuera de línea (pausada en Windows)` };
    }
    if (knownError) {
      return { ok: false, detail: `Impresora "${config.printer.name}": ${knownError}` };
    }

    return { ok: true, detail: null };
  } catch (err) {
    console.error('[windowsPrinterService] getPrinterStatus falló:', err.message, err.stderr);
    return {
      ok: false,
      detail: `No se pudo consultar el estado de "${config.printer.name}" vía WMI: ${err.message}`,
    };
  }
}

// Cuántos trabajos hay ahora mismo en la cola de Windows para la impresora
// configurada. Win32_PrintJob.Name viene en formato "NombreImpresora,JobId"
// — de ahí el filtro LIKE 'NombreImpresora,%'. Usado SOLO para el chequeo
// post-sesión de src/sessionState.js (confirmar que una impresión
// realmente no salió) — nunca gatea pagos por sí solo, siempre se combina
// con getPrinterStatus() (ver hardwareMonitorService.js#checkPrintFailure).
async function getPendingJobCount() {
  if (!config.printer.name) return 0;

  const psPrinter = psQuote(config.printer.name);
  const script = `
$ErrorActionPreference = 'Stop'
$jobs = Get-CimInstance -ClassName Win32_PrintJob -Filter "Name LIKE '${psPrinter},%'"
Write-Output ("COUNT=" + (@($jobs)).Count)
`.trim();

  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const match = stdout.match(/COUNT=(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch (err) {
    console.error('[windowsPrinterService] getPendingJobCount falló:', err.message, err.stderr);
    return 0; // ante la duda de la consulta, no bloquear la decisión con un falso positivo
  }
}

// Cancela/remueve todos los trabajos pendientes de la impresora configurada
// — se usa cuando ya se confirmó que una impresión falló (getPrinterStatus
// con problema + un trabajo seguía en cola) y la venta correspondiente se
// va a cancelar: evita que ese trabajo salga impreso solo más tarde, cuando
// la impresora se reconecte, para una venta que ya no existe.
async function clearPrintQueue() {
  if (!config.printer.name) return { cleared: 0 };

  const psPrinter = psQuote(config.printer.name);
  const script = `
$ErrorActionPreference = 'Stop'
$jobs = Get-CimInstance -ClassName Win32_PrintJob -Filter "Name LIKE '${psPrinter},%'"
$count = 0
foreach ($j in $jobs) {
  try {
    Remove-CimInstance -InputObject $j -ErrorAction Stop
    $count++
  } catch {
    # seguimos con los demás aunque uno en particular no se pueda remover
  }
}
Write-Output ("CLEARED=" + $count)
`.trim();

  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const match = stdout.match(/CLEARED=(\d+)/);
    const cleared = match ? parseInt(match[1], 10) : 0;
    console.log(
      `[windowsPrinterService] cola de impresión limpiada — ${cleared} trabajo(s) removido(s) de "${config.printer.name}"`
    );
    return { cleared };
  } catch (err) {
    console.error('[windowsPrinterService] clearPrintQueue falló:', err.message, err.stderr);
    return { cleared: 0, error: err.message };
  }
}

async function printPhoto(filePath) {
  if (!config.printer.name) {
    throw new Error(
      'PRINTER_NAME no está configurado en .env — corre GET /diagnostics/printer para ver el nombre exacto de la impresora en Windows'
    );
  }

  const copies = config.printer.copies || 1;
  const psFile = psQuote(filePath);
  const psPrinter = psQuote(config.printer.name);
  const delayMs = config.windows.printCopiesDelayMs || 0;

  // Manda la imagen directo a la impresora vía System.Drawing.Printing, sin
  // abrir ninguna ventana. Márgenes de página en 0 y se dibuja sobre
  // PageBounds (el área física completa de la hoja/papel), no MarginBounds
  // — MarginBounds usaba los márgenes default de impresión (~1 pulgada por
  // lado), que es de donde venía el marco blanco grande alrededor de la
  // foto. Ajustar tamaño/orientación de papel en las propiedades de la
  // impresora en Windows si el recorte no queda como se espera.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${psFile}')
try {
  for ($i = 0; $i -lt ${copies}; $i++) {
    $pd = New-Object System.Drawing.Printing.PrintDocument
    $pd.PrinterSettings.PrinterName = '${psPrinter}'
    if (-not $pd.PrinterSettings.IsValid) {
      throw "Impresora no válida o no encontrada en Windows: ${psPrinter}"
    }
    $pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
    $pd.OriginAtMargins = $false
    $pd.add_PrintPage({
      param($sender, $e)
      $e.Graphics.DrawImage($img, $e.PageBounds)
    })
    $pd.Print()
    if ($i -lt (${copies} - 1) -and ${delayMs} -gt 0) {
      Start-Sleep -Milliseconds ${delayMs}
    }
  }
} finally {
  $img.Dispose()
}
`.trim();

  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    console.log(
      `[windowsPrinterService] ${copies} copia(s) enviada(s) a "${config.printer.name}" (System.Drawing.Printing)`
    );
  } catch (err) {
    throw new Error(
      `Falló la impresión en "${config.printer.name}" vía PowerShell/System.Drawing: ` +
        `${err.stderr || err.message} — confirma que el nombre coincide EXACTO con el de ` +
        'GET /diagnostics/printer y que la impresora no está pausada/fuera de línea en Windows'
    );
  }

  return { copies };
}

module.exports = { listPrinters, printPhoto, getPrinterStatus, getPendingJobCount, clearPrintQueue };
