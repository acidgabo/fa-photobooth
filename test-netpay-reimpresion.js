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
 * Qué revisar en la consola del backend: un "[webhook] body completo..." con
 * isRePrint: true, y la línea "[webhook] respuesta de REIMPRESIÓN" con el
 * reprintModule. Todo queda también en logs/netpay-transacciones.log.
 */
const netpayService = require('./src/services/netpayService');

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
