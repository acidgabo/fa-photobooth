/**
 * Cancelación manual de una venta en la terminal NetPay real.
 * SÍ tiene efecto: cancela (devuelve) un cobro aprobado. Pide confirmación
 * antes de enviar, salvo que se pase --yes.
 *
 * Para qué sirve:
 *  - La sesión de certificación ("Cancelación de venta del mismo día").
 *  - Cancelar a mano un cobro que la cabina no canceló sola (p. ej. con
 *    HARDWARE_MONITOR_ENABLED=false no hay cancelación automática por
 *    cámara/impresora).
 *
 * Uso (desde la raíz del repo, con el backend corriendo en OTRA terminal,
 * porque el resultado real llega por el webhook, no aquí):
 *
 *   node test-netpay-cancelacion.js --list
 *   node test-netpay-cancelacion.js --folio order_1790533514915
 *   node test-netpay-cancelacion.js --order 260927122539-2840746993
 *   node test-netpay-cancelacion.js --folio order_1790533514915 --yes
 *
 *   --list    ventas aprobadas de HOY (hora CDMX) según
 *             logs/netpay-transacciones.log, y si ya se cancelaron.
 *   --folio   nuestro folioNumber; el orderId de la terminal se busca en
 *             el log (la cancelación de NetPay solo acepta orderId).
 *   --order   orderId de la terminal, directo.
 *   --yes     no preguntar antes de enviar.
 *
 * Reglas de NetPay (ver netpayService.cancelSale):
 *  - Solo ventas del mismo día y antes de las 8:00 p.m. CDMX; después el
 *    backend ni siquiera envía la petición (cancel_window_closed).
 *  - Siempre por el monto completo.
 *
 * Qué revisar en la consola del backend: un webhook con transType "V" y
 * responseCode "00". Como esta cancelación no la inició el backend, llega
 * a Discord como "⚠️ Cancelación recibida de la terminal que no fue
 * automática" — eso es lo esperado aquí. Queda en logs/netpay-transacciones.log.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const netpayService = require('./src/services/netpayService');

const LOG_PATH = path.join(__dirname, 'logs', 'netpay-transacciones.log');

function parseArgs(argv) {
  const args = { yes: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folio') args.folio = argv[++i];
    else if (argv[i] === '--order') args.order = argv[++i];
    else if (argv[i] === '--yes') args.yes = true;
    else if (argv[i] === '--list') args.list = true;
  }
  return args;
}

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs
    .readFileSync(LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

// Fecha YYYY-MM-DD en hora CDMX — "mismo día" para NetPay.
function cdmxDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(date);
}

// Ventas aprobadas (con orderId de la terminal) y los orderId ya cancelados.
function summarize(entries) {
  const sales = entries.filter((e) => e.kind === 'sale' && e.responseCode === '00' && e.orderId);
  const cancelled = new Set(
    entries
      .filter(
        (e) =>
          (e.kind === 'cancel' && e.responseCode === '00') ||
          (e.kind === 'reprint' && e.reprintModule === 'V')
      )
      .map((e) => e.orderId)
      .filter(Boolean)
  );
  return { sales, cancelled };
}

function describe(sale, cancelled) {
  const when = new Date(sale.at).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' });
  const state = cancelled.has(sale.orderId) ? 'CANCELADA' : 'vigente';
  return `${when}  folio=${sale.folioNumber}  orderId=${sale.orderId}  $${sale.amount}  ****${sale.cardNumber || '?'}  [${state}]`;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    })
  );
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const entries = readLog();
  const { sales, cancelled } = summarize(entries);
  const today = cdmxDate(new Date());

  if (args.list) {
    const todays = sales.filter((s) => cdmxDate(new Date(s.at)) === today);
    if (todays.length === 0) {
      console.log(`Sin ventas aprobadas hoy (${today}) en ${LOG_PATH}.`);
      return;
    }
    console.log(`Ventas aprobadas hoy (${today}):`);
    for (const sale of todays) console.log(`  ${describe(sale, cancelled)}`);
    if (netpayService.isPastCancelCutoff()) {
      console.log('\nOJO: ya pasaron las 8:00 p.m. CDMX — NetPay ya no acepta cancelaciones hoy.');
    }
    return;
  }

  if ((!args.folio && !args.order) || (args.folio && args.order)) {
    console.error('Indica exactamente uno: --folio <folioNumber> o --order <orderId de la terminal> (o usa --list)');
    process.exit(1);
  }

  let orderId = args.order;
  let sale = sales.find((s) => (args.folio ? s.folioNumber === args.folio : s.orderId === args.order));

  if (args.folio) {
    if (!sale) {
      console.error(
        `No encontré una venta APROBADA con folio "${args.folio}" en ${LOG_PATH}. ` +
          'Si la venta no está en el log, usa --order con el orderId del ticket.'
      );
      process.exit(1);
    }
    orderId = sale.orderId;
  }

  if (sale) {
    console.log(`Venta: ${describe(sale, cancelled)}`);
    if (cdmxDate(new Date(sale.at)) !== today) {
      console.warn('OJO: la venta no es de hoy — NetPay solo cancela ventas del mismo día; probablemente la rechace.');
    }
    if (cancelled.has(orderId)) {
      console.warn('OJO: según el log esta venta YA fue cancelada.');
    }
  } else {
    console.log(`orderId=${orderId} (no está en el log local; se envía tal cual).`);
  }

  if (!args.yes) {
    const answer = await ask('¿Cancelar esta venta por el monto completo? (s/N) ');
    if (answer !== 's' && answer !== 'si' && answer !== 'sí') {
      console.log('No se envió nada.');
      return;
    }
  }

  try {
    const result = await netpayService.cancelSale({
      orderId,
      folioNumber: sale ? sale.folioNumber : undefined,
      reason: 'manual',
    });
    console.log(`Cancelación de orderId "${orderId}" enviada a la terminal.`);
    console.log('Respuesta de NetPay al push:', JSON.stringify(result));
    console.log('El resultado real llega por el webhook (transType "V") — revisa la consola del backend.');
  } catch (err) {
    if (err.code === 'cancel_window_closed') {
      console.error('No se envió: ya pasaron las 8:00 p.m. CDMX. Esta venta requiere reverso manual con NetPay.');
    } else {
      console.error('La cancelación FALLÓ al enviarse:', err.message);
      if (err.response) console.error('Respuesta HTTP:', err.response.status, JSON.stringify(err.response.data));
    }
    process.exit(1);
  }
})();
