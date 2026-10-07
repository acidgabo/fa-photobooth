/**
 * Evidencia para la certificación NetPay: junta del log todo lo que tenga
 * que ver con UNA transacción (las peticiones que mandó este sistema y las
 * respuestas completas de la terminal) y lo guarda en un archivo JSON.
 * No manda nada a NetPay ni a la terminal; solo lee el log.
 *
 * Por qué: cada escenario se entrega con la foto del ticket + el JSON de
 * respuesta de ESA MISMA transacción. Mezclar el ticket de una prueba con
 * el JSON de otra es la observación más frecuente de la certificación.
 *
 * Uso (desde la raíz del repo):
 *
 *   node evidencia-netpay.js --list
 *   node evidencia-netpay.js --folio order_1790533514915
 *   node evidencia-netpay.js --order 260927122539-2840746993
 *   node evidencia-netpay.js --folio order_1790533514915 --name "05 contactless visa mayor 1200"
 *
 *   --list   transacciones de HOY (hora CDMX): folio, orderId, monto,
 *            responseCode y si ya tienen archivo de evidencia.
 *   --folio  nuestro folioNumber. También incluye todo lo que comparta el
 *            orderId de la terminal (cancelación, reimpresión por orderId).
 *   --order  orderId de la terminal (para cancelaciones / reimpresiones).
 *   --name   nombre del escenario, se usa en el nombre del archivo.
 *
 * Salida: evidencias/<fecha>_<nombre o folio>.json (la carpeta está en
 * .gitignore). En "respuestas" va cada body tal como lo mandó la terminal
 * (campo "raw" del log). Las respuestas registradas antes de que existiera
 * "raw" solo traen los campos resumidos.
 */
const fs = require('fs');
const path = require('path');
const netpayLog = require('./src/services/netpayLog');

const OUT_DIR = path.join(__dirname, 'evidencias');

function parseArgs(argv) {
  const args = { list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folio') args.folio = argv[++i];
    else if (argv[i] === '--order') args.order = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--list') args.list = true;
  }
  return args;
}

function cdmxDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(date);
}

function cdmxTime(iso) {
  return new Date(iso).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' });
}

function slug(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

// Folio de una línea del log: en peticiones y respuestas es folioNumber; en
// la reimpresión por folio la petición lo lleva igual (describeRequest).
function folioOf(e) {
  return e.folioNumber || (e.raw && e.raw.folioNumber) || undefined;
}

function collect(entries, { folio, order }) {
  const folios = new Set(folio ? [folio] : []);
  const orders = new Set(order ? [order] : []);
  // Dos pasadas: el folio lleva al orderId de la terminal (venta aprobada)
  // y el orderId lleva al folio (cancelación sin folio en la petición).
  for (let pass = 0; pass < 2; pass++) {
    for (const e of entries) {
      const f = folioOf(e);
      if ((f && folios.has(f)) || (e.orderId && orders.has(e.orderId))) {
        if (f) folios.add(f);
        if (e.orderId) orders.add(e.orderId);
      }
    }
  }
  return entries.filter((e) => {
    const f = folioOf(e);
    return (f && folios.has(f)) || (e.orderId && orders.has(e.orderId));
  });
}

function toEvidence(related, args) {
  const peticiones = related
    .filter((e) => e.kind === 'request')
    .map(({ at, op, stage, endpoint, folioNumber, orderId, amount, print, traceability, ok, sent, code, message, httpStatus, error }) => ({
      at, op, stage, endpoint, folioNumber, orderId, amount, print, traceability, ok, sent, code, message, httpStatus, error,
    }));
  const respuestas = related
    .filter((e) => e.kind !== 'request')
    .map((e) => ({ at: e.at, tipo: e.kind, json: e.raw || { ...e, nota: 'registrada antes de guardar el body completo (sin "raw")' } }));
  return {
    escenario: args.name || null,
    folio: args.folio || null,
    orderId: args.order || null,
    generado: new Date().toISOString(),
    peticiones,
    respuestas,
  };
}

function existingEvidenceFor(id) {
  if (!fs.existsSync(OUT_DIR)) return false;
  return fs.readdirSync(OUT_DIR).some((f) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
      return data.folio === id || data.orderId === id;
    } catch (_) {
      return false;
    }
  });
}

function list(entries) {
  const today = cdmxDate(new Date());
  const rows = entries.filter((e) => e.kind !== 'request' && cdmxDate(new Date(e.at)) === today);
  if (rows.length === 0) {
    console.log(`Sin respuestas de la terminal hoy (${today}) en ${netpayLog.TRANSACTIONS_LOG_PATH}.`);
    return;
  }
  console.log(`Respuestas de la terminal hoy (${today}):`);
  for (const e of rows) {
    const id = folioOf(e) || e.orderId || '';
    const mark = id && existingEvidenceFor(id) ? '  [evidencia guardada]' : '';
    const status = e.kind === 'reprint' ? `reprintModule=${e.reprintModule}` : `responseCode=${e.responseCode}`;
    console.log(
      `  ${cdmxTime(e.at)}  ${e.kind.padEnd(17)} folio=${folioOf(e) || '-'}  orderId=${e.orderId || '-'}  ` +
        `$${e.amount || '-'}  ${status}  "${e.message || ''}"${mark}`
    );
  }
}

(() => {
  const args = parseArgs(process.argv.slice(2));
  const entries = netpayLog.readEntries();

  if (args.list) {
    list(entries);
    return;
  }

  if ((!args.folio && !args.order) || (args.folio && args.order)) {
    console.error('Indica exactamente uno: --folio <folioNumber> o --order <orderId de la terminal> (o usa --list)');
    process.exit(1);
  }

  const related = collect(entries, args);
  if (related.length === 0) {
    console.error(`No hay nada en ${netpayLog.TRANSACTIONS_LOG_PATH} para ${args.folio || args.order}.`);
    process.exit(1);
  }

  const evidence = toEvidence(related, args);
  const date = cdmxDate(new Date(related[0].at));
  const fileName = `${date}_${slug(args.name || args.folio || args.order)}.json`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`${evidence.peticiones.length} petición(es) y ${evidence.respuestas.length} respuesta(s) de la terminal.`);
  for (const r of evidence.respuestas) {
    const j = r.json;
    const status = r.tipo === 'reprint' ? `reprintModule=${j.reprintModule}` : `responseCode=${j.responseCode}`;
    console.log(`  ${cdmxTime(r.at)}  ${r.tipo}  ${status}  "${j.message || ''}"`);
  }
  console.log(`Guardado en ${outPath}`);
})();
