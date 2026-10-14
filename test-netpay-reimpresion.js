/**
 * Prueba aislada de reimpresión contra la terminal NetPay real.
 * NO cobra nada — solo pide a la terminal que reenvíe el resultado de una
 * transacción ya hecha.
 *
 * Uso (desde la raíz del repo, con el backend corriendo en OTRA terminal y
 * NETPAY_DEBUG_LOG=true en .env, porque la respuesta real llega por el
 * webhook, no aquí):
 *
 *   node test-netpay-reimpresion.js --folio order_1790296797272
 *   node test-netpay-reimpresion.js --order 260924184008-2840746993
 *   node test-netpay-reimpresion.js --folio order_1790296797272 --print
 *
 *   --folio   reimpresión por folio (nuestro folioNumber). Obligatoria para
 *             certificar y la base del manejo de reversos.
 *   --order   reimpresión por orderId (el que genera la terminal).
 *   --print   además imprime el ticket en la terminal (por default NO, solo
 *             manda el JSON por webhook).
 *
 * Multi-instancias: si ya hay una reimpresión de la misma venta enviada hace
 * menos de 60 s y sin respuesta, el script NO manda otra ("BLOQUEADA").
 *
 * Qué revisar en la consola del backend: un "[webhook] body completo..." con
 * isRePrint: true, y la línea "[webhook] respuesta de REIMPRESIÓN" con el
 * reprintModule. Todo queda también en logs/netpay-transacciones.log.
 */
const netpayService = require('./src/services/netpayService');
const netpayLog = require('./src/services/netpayLog');

function parseArgs(argv) {
  const args = { print: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folio') args.folio = argv[++i];
    else if (argv[i] === '--order') args.order = argv[++i];
    else if (argv[i] === '--print') args.print = true;
  }
  return args;
}

(async () => {
  const { folio, order, print } = parseArgs(process.argv.slice(2));

  if ((!folio && !order) || (folio && order)) {
    console.error('Indica exactamente uno: --folio <folioNumber> o --order <orderId de la terminal>');
    process.exit(1);
  }

  // Bloqueo de multi-instancias (escenarios 9 y 10 de la certificación):
  // si ya se mandó una reimpresión de esta misma venta hace menos de 60 s
  // y la terminal todavía no contesta, no se manda otra. Queda registrado
  // en la bitácora con sent:false.
  const inFlightMs = netpayLog.findReprintInFlight(folio ? { folio } : { orderId: order });
  if (inFlightMs !== null) {
    const id = folio ? `folio "${folio}"` : `orderId "${order}"`;
    netpayLog.append({
      kind: 'request',
      op: 'reprint',
      endpoint: '/integration-service/transactions/reprint',
      folioNumber: folio || undefined,
      orderId: order || undefined,
      print,
      ok: false,
      sent: false,
      error: 'reprint_in_progress',
      message: `ya hay una reimpresión en curso para ${id}`,
    });
    console.error(
      `BLOQUEADA: ya hay una reimpresión en curso para ${id} (enviada hace ${Math.round(inFlightMs / 1000)} s, ` +
        'sin respuesta todavía). No se envía otra; espera la respuesta en la consola del backend.'
    );
    process.exit(1);
  }

  try {
    const result = folio
      ? await netpayService.reprintByFolio({ folioId: folio, print })
      : await netpayService.reprintByOrderId({ orderId: order, print });

    console.log(`Reimpresión ${folio ? `por folio "${folio}"` : `por orderId "${order}"`} enviada a la terminal (print=${print}).`);
    console.log('Respuesta de NetPay al push:', JSON.stringify(result));
    console.log('El resultado real llega por el webhook — revisa la consola del backend.');
  } catch (err) {
    console.error('La reimpresión FALLÓ al enviarse:', err.message);
    if (err.response) console.error('Respuesta HTTP:', err.response.status, JSON.stringify(err.response.data));
    process.exit(1);
  }
})();
