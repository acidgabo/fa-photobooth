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

module.exports = { listPrinters, printPhoto };
