/**
 * Impresión directa vía CUPS — SOLO para la demo temporal
 * (BOOTH_MODE=direct). En producción esto lo hace dslrBooth.
 *
 * Requisitos en la máquina (Fedora):
 *   sudo dnf install cups system-config-printer
 *   sudo systemctl enable --now cups
 * Agregar la DNP RX1 como impresora CUPS (driver de DNP para Linux, se
 * descarga de su sitio — buscar "DNP DS-RX1 Linux driver"). Si no hay
 * driver oficial disponible a tiempo para la demo, cualquier impresora
 * normal conectada sirve para probar el flujo (solo no vas a tener la
 * calidad/foto 4x6 real, pero valida que el backend dispara la impresión).
 */
const { execFile } = require('child_process');
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
 * Lista las impresoras que CUPS conoce en esta máquina (`lpstat -p`).
 * Útil para confirmar el nombre exacto que hay que poner en PRINTER_NAME.
 */
async function listPrinters() {
  try {
    const { stdout, stderr } = await run('lpstat', ['-p']);
    if (!stdout.trim()) {
      console.warn('[printerService] lpstat -p retornó vacío; CUPS puede no estar corriendo o no hay impresoras');
      return [];
    }

    // Parseo locale-independent: busca líneas que contengan "impresora" o "printer"
    // y extrae el nombre (segunda palabra o palabra después de "impresora/printer")
    const printers = stdout
      .split('\n')
      .filter((l) => {
        const lower = l.toLowerCase();
        // Busca líneas que empiezan con "printer " (inglés) o contienen "impresora " (español)
        return lower.trim().startsWith('printer ') || lower.includes('impresora');
      })
      .map((l) => {
        const trimmed = l.trim();
        // Extrae el nombre de la impresora:
        // Inglés: "printer Dai_Nippon_Printing_DS-RX1 is idle..."
        // Español: "la impresora Dai_Nippon_Printing_DS-RX1 está inactiva..."
        const parts = trimmed.split(/\s+/);
        // Busca la palabra que parece un nombre de impresora (contiene guiones o números)
        const nameIndex = parts.findIndex((p) => p.includes('_') || /^[A-Za-z0-9\-_]+$/.test(p));
        if (nameIndex >= 0 && nameIndex < parts.length) {
          return parts[nameIndex];
        }
        // Fallback: devuelve la segunda palabra (compatible con "printer Name..." o "la impresora Name...")
        return parts[1] || null;
      })
      .filter(Boolean); // Remove nulls

    console.log(`[printerService] lpstat detectó ${printers.length} impresora(s): ${printers.join(', ')}`);
    return printers;
  } catch (err) {
    console.error('[printerService] lpstat falló:', err.message, err.stderr);
    // lpstat regresa código de error si no hay NINGUNA impresora configurada, o CUPS no está corriendo
    return [];
  }
}

async function printPhoto(filePath) {
  if (!config.printer.name) {
    throw new Error(
      'PRINTER_NAME no está configurado en .env — corre listPrinters()/`lpstat -p` para ver el nombre exacto de la cola CUPS'
    );
  }

  try {
    const { stdout } = await run('lp', [
      '-d',
      config.printer.name,
      '-n',
      String(config.printer.copies),
      filePath,
    ]);
    console.log(`[printerService] Impresión enviada a "${config.printer.name}": ${stdout.trim()}`);
    return { raw: stdout };
  } catch (err) {
    // Mensajes de error comunes de CUPS
    const stderr = err.stderr || '';
    if (stderr.includes('disabled') || stderr.includes('inactiva')) {
      throw new Error(
        `Impresora "${config.printer.name}" está INACTIVA — activarla con: sudo cupsenable ${config.printer.name}`
      );
    }
    if (stderr.includes('not found') || stderr.includes('no existe')) {
      throw new Error(
        `Impresora "${config.printer.name}" no existe en CUPS — correr "lpstat -p" para ver nombres válidos`
      );
    }
    throw new Error(
      `lp falló al imprimir en "${config.printer.name}": ${stderr || err.message}`
    );
  }
}

module.exports = { listPrinters, printPhoto };
