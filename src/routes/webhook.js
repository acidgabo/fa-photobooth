const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const config = require('../config');
const sessionState = require('../sessionState');
const dslrboothService = require('../services/dslrboothService');
const directBoothService = require('../services/directBoothService');
const windirectBoothService = require('../services/windirectBoothService');
const windowFocusService = require('../services/windowFocusService');
const { autoCancelSale, resolveCancelResult } = require('../services/autoCancelService');

// Registro en archivo aparte de los cobros huérfanos (ver COBRO HUÉRFANO más
// abajo) — para que quede constancia aunque nadie esté viendo la consola en
// el momento que pasa. "*.log" ya está en .gitignore, así que este archivo
// nunca se sube al repo (son datos operativos/sensibles, no código).
const ORPHAN_LOG_PATH = path.join(__dirname, '..', '..', 'logs', 'cobros-huerfanos.log');

// Bitácora de TODAS las respuestas que manda la terminal (ventas,
// cancelaciones y reimpresiones), una línea JSON por evento — cubre el
// requisito de certificación de NetPay "Implementación de logging en el
// punto de venta" y deja evidencia consultable después sin depender de
// NETPAY_DEBUG_LOG. Solo campos útiles para conciliar; nada de datos
// sensibles de la tarjeta (cardNumber ya son solo los últimos 4).
const TRANSACTIONS_LOG_PATH = path.join(__dirname, '..', '..', 'logs', 'netpay-transacciones.log');
const LOGGED_FIELDS = [
  'transType', 'isRePrint', 'reprintModule', 'responseCode', 'message', 'folioNumber', 'orderId',
  'amount', 'authCode', 'cardNumber', 'transactionId', 'rrnNumber', 'transDate',
];

function logTransaction(kind, body) {
  try {
    const entry = { at: new Date().toISOString(), kind };
    for (const field of LOGGED_FIELDS) {
      if (body[field] !== undefined) entry[field] = body[field];
    }
    fs.mkdirSync(path.dirname(TRANSACTIONS_LOG_PATH), { recursive: true });
    fs.appendFileSync(TRANSACTIONS_LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(`[webhook] no se pudo escribir en ${TRANSACTIONS_LOG_PATH}: ${err.message}`);
  }
}

// Qué tipo de respuesta mandó la terminal. Se decide ANTES de comparar
// contra la sesión activa, porque el mismo endpoint recibe tres cosas
// distintas (Referencia API, "9. Recibiendo la respuesta"):
// - Reimpresión: isRePrint === true. Va primero porque la reimpresión de
//   una cancelación también trae transType "V".
// - Cancelación: transType === "V".
// - Venta: todo lo demás (transType "A", o el payload viejo del mock sin
//   transType).
// Sin esta separación, la respuesta de una cancelación o reimpresión con
// responseCode "00" se confundía con un pago: o se registraba como COBRO
// HUÉRFANO (si ya no había sesión), o peor, arrancaba una sesión de fotos
// (si la sesión seguía en awaiting_payment con el mismo folio).
function classifyTerminalResponse(body) {
  if (body.isRePrint === true || body.isRePrint === 'true') return 'reprint';
  if (body.transType === 'V') return 'cancel';
  return 'sale';
}

function handleReprintResponse(body) {
  // Por ahora solo se registra. El manejo de reversos (reprintModule
  // "RV"/"PRV", voucher personalizado, folios pendientes) se construye
  // encima de esto en el siguiente paso.
  console.log(
    `[webhook] respuesta de REIMPRESIÓN — folio=${body.folioNumber} orderId=${body.orderId} ` +
      `responseCode=${body.responseCode} reprintModule=${body.reprintModule || '(ninguno)'} message="${body.message}"`
  );
}

function logOrphanCharge(detail) {
  try {
    fs.mkdirSync(path.dirname(ORPHAN_LOG_PATH), { recursive: true });
    fs.appendFileSync(ORPHAN_LOG_PATH, `${new Date().toISOString()} ${detail}\n`);
  } catch (err) {
    // No debe tumbar el manejo del webhook si falla la escritura a disco
    // (permisos, disco lleno, etc.) — el console.error de todas formas ya
    // corrió antes de llegar aquí.
    console.error(`[webhook] no se pudo escribir en ${ORPHAN_LOG_PATH}: ${err.message}`);
  }
}

// NetPay pega aquí cuando confirma (o rechaza) el cobro.
// TODO: cuando tengamos la doc de autorización de webhooks de NetPay,
// validar la firma/origen de la petición antes de confiar en el body.
//
// Confirmado contra la Referencia API (sección "9. Recibiendo la respuesta"):
// - La terminal real NO manda {orderId, success, errorCode} — eso es solo lo
//   que simula mocks/mock-netpay.js. Manda "responseCode" ("00" = éxito,
//   cualquier otro valor = declinada/error) junto con authCode, cardNumber,
//   amount, message, etc.
// - El campo que corresponde a NUESTRO orderId (el que generamos en
//   payment.js y mandamos como "folioNumber" al crear la venta, ver
//   netpayService.createSale) es "folioNumber" en la respuesta — el
//   "orderId" que manda la terminal es un identificador DISTINTO, generado
//   por ella misma, que solo sirve para operaciones futuras de
//   cancelación/reimpresión sobre esta transacción (lo guardamos como
//   terminalOrderId por si se necesita más adelante).
// - El ack de vuelta hacia la terminal debe ser EXACTAMENTE
//   {"code":"00","message":"Recibido"} con HTTP 200 en TODOS los casos
//   (match, duplicado, rechazo, etc.) — la doc advierte que si la terminal
//   nunca ve ese "Recibido" puede dejar de mandar transacciones
//   subsecuentes. {received:true} (lo que había antes) no cumple esto.
const NETPAY_ACK = { code: '00', message: 'Recibido' };

router.post('/netpay', async (req, res) => {
  // Log de diagnóstico del body completo recibido de Netpay — gateado por
  // NETPAY_DEBUG_LOG (ver .env / .env.example) para poder seguir usándolo
  // en pruebas contra la terminal real sin que corra en producción. Imprime
  // el body tal cual lo manda la terminal (los 41 campos documentados:
  // responseCode, authCode, cardNumber, transDate, hexSign, etc.) para ver
  // el detalle exacto de casos como "Falló en conexión" sin adivinar.
  if (config.netpay.debugLog) {
    console.log('[webhook] body completo recibido de Netpay:', JSON.stringify(req.body, null, 2));
  }

  const kind = classifyTerminalResponse(req.body);
  logTransaction(kind, req.body);

  if (kind === 'reprint') {
    handleReprintResponse(req.body);
    return res.status(200).json(NETPAY_ACK);
  }

  if (kind === 'cancel') {
    resolveCancelResult(req.body);
    return res.status(200).json(NETPAY_ACK);
  }

  // --- De aquí en adelante: respuesta de una VENTA ---
  const { folioNumber, orderId: terminalOrderId, responseCode, message: netpayMessage } = req.body;

  const current = sessionState.get();
  if (current.orderId !== folioNumber) {
    if (responseCode === '00') {
      // Cobro real y EXITOSO que no corresponde a ninguna sesión activa: el
      // cliente sí pagó, pero no hay ninguna sesión de fotos en curso a la
      // que entregarle el servicio. Es el único caso, de todos los webhooks
      // ignorados, que implica dinero real cobrado sin nada a cambio — se
      // loguea aparte (console.error + prefijo distinto) para que no se
      // pierda entre el resto de los "ignorado" rutinarios (duplicados,
      // rechazos, timeouts sintéticos) y alguien pueda revisar a mano si
      // hace falta reembolsar o entregar el servicio manualmente.
      const detail =
        `folioNumber="${folioNumber}" orderIdActual="${current.orderId}" ` +
        `amount=${req.body.amount || '?'} MXN authCode=${req.body.authCode || '?'} ` +
        `transactionId=${req.body.transactionId || '?'} cardNumber=****${req.body.cardNumber || '?'}`;
      console.error(
        `[webhook] COBRO HUÉRFANO — ${detail}. Revisar manualmente si se debe ` +
        `reembolsar o entregar el servicio. (también registrado en ${ORPHAN_LOG_PATH})`
      );
      logOrphanCharge(detail);
    } else {
      // Llegó una confirmación que no corresponde a la sesión activa (y no
      // fue un cobro exitoso) — rechazo, duplicado, o timeout. No implica
      // dinero cobrado, así que el log rutinario basta.
      console.log(`[webhook] webhook ignorado — folioNumber "${folioNumber}" no coincide con la sesión activa (orderId: ${current.orderId})`);
    }
    return res.status(200).json(NETPAY_ACK);
  }

  // Solo procesar si aún estamos esperando el pago.
  // Si ya hay un resultado (error, confirmado, o booth corriendo), ignorar
  // cualquier webhook duplicado — esto evita la condición de carrera donde
  // la terminal reintenta la entrega de la respuesta y el segundo webhook
  // sobrescribe al primero.
  if (current.status !== 'awaiting_payment') {
    console.log(`[webhook] webhook ignorado — estado ya es "${current.status}" (folioNumber: ${folioNumber})`);
    return res.status(200).json(NETPAY_ACK);
  }

  if (responseCode !== '00') {
    console.log(`[webhook] pago rechazado (folioNumber: ${folioNumber}, responseCode: ${responseCode}, message: ${netpayMessage})`);
    sessionState.set({ status: 'error', error: netpayMessage || `responseCode ${responseCode}` });
    return res.status(200).json(NETPAY_ACK);
  }

  sessionState.set({ status: 'payment_confirmed', terminalOrderId });

  if (config.booth.mode === 'direct') {
    // Modo demo (Linux): cámara/impresora reales, controladas por este
    // backend vía gphoto2 + CUPS. No se espera aquí (tarda varios segundos:
    // countdown + captura + impresión) — el estado avanza vía los eventos
    // que va emitiendo directBoothService, igual que pasaría con los
    // triggers de dslrBooth.
    sessionState.set({ status: 'booth_running' });
    directBoothService.runDirectSession().catch((err) => {
      sessionState.set({ status: 'error', error: `booth directo: ${err.message}` });
      // Grupo 2 de la taxonomía de fallas: el cobro ya se hizo y toda la
      // sesión (captura + impresión) truena — cero fotos entregadas.
      autoCancelSale(terminalOrderId, `booth directo: ${err.message}`, { folioNumber });
    });
  } else if (config.booth.mode === 'windirect') {
    // Modo demo (Windows): cámara/impresora reales, controladas por este
    // backend vía digiCamControl + impresión nativa de Windows. Mismo
    // patrón que 'direct' pero para cuando la demo con hardware corre en
    // la laptop Windows antes de tener dslrBooth instalado.
    sessionState.set({ status: 'booth_running' });
    windirectBoothService.runDirectSession().catch((err) => {
      sessionState.set({ status: 'error', error: `booth directo (Windows): ${err.message}` });
      autoCancelSale(terminalOrderId, `booth directo (Windows): ${err.message}`, { folioNumber });
    });
  } else {
    try {
      // Convivencia de pantallas (ver "Convivencia visual/de foco..." en
      // claude/Integración dslrbooth.md): antes de disparar la sesión,
      // LumaBooth debe recuperar el primer plano. Primero se le quita su
      // propia pantalla de bloqueo (API confiable) y luego se intenta el
      // cambio de foco a nivel de SO (best-effort). Ninguna de las dos
      // llamadas tira error — son hardening, no deben romper el flujo si
      // fallan (ver dslrboothService.js / windowFocusService.js).
      await dslrboothService.tryExitLockscreen();
      await windowFocusService.tryFocusDslrbooth();

      await dslrboothService.startSession({ mode: 'print' });
      sessionState.set({ status: 'booth_running' });
    } catch (err) {
      sessionState.set({ status: 'error', error: `dslrBooth: ${err.message}` });
      // Grupo 2 de la taxonomía de fallas: el cobro ya se hizo y
      // startSession() truena de inmediato, antes de que exista siquiera un
      // session_start — cero fotos, cero interacción del cliente. Candidato
      // limpio para cancelar automáticamente (ver docs del proyecto).
      // Fire-and-forget: nunca debe tirar el manejo del webhook si falla.
      autoCancelSale(terminalOrderId, `dslrBooth: ${err.message}`, { folioNumber });
    }
  }

  res.status(200).json(NETPAY_ACK);
});

module.exports = router;
