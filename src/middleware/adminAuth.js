/**
 * Acceso al panel de reimpresiones y reversos (src/routes/admin.js).
 *
 * El panel se usa de forma REMOTA (el kiosco es desatendido): Gabo lo abre
 * desde su celular o laptop y la petición llega al backend de la cabina por
 * el túnel de Cloudflare. Dos capas, las dos obligatorias para lo que llega
 * por el túnel:
 *
 *  1. Cloudflare Access (Zero Trust): la aplicación de Access frente al
 *     hostname del panel pide un código por correo y solo deja pasar los
 *     emails autorizados. Cloudflare agrega a cada petición el header
 *     "Cf-Access-Jwt-Assertion" (un JWT firmado). Aquí se VERIFICA ese JWT
 *     (firma RS256 con las llaves públicas del equipo, audiencia = AUD de la
 *     aplicación, emisor y vigencia). Así, si alguien publica por error otra
 *     ruta del túnel hacia /admin sin Access, el backend la rechaza igual.
 *     Configuración: CF_ACCESS_TEAM_DOMAIN y CF_ACCESS_AUD en el .env.
 *     Sin esas dos variables, TODO lo que llega por el túnel se rechaza.
 *
 *  2. Token del backend (ADMIN_TOKEN): cada petición trae
 *     "Authorization: Bearer <token>". El panel lo pide una vez y lo guarda
 *     en el navegador. Sin ADMIN_TOKEN definido, el panel está apagado.
 *
 * Lo que NO llega por el túnel (alguien en la misma PC o en la red local)
 * solo necesita el token. "Llega por el túnel" = trae el header
 * cf-connecting-ip, que cloudflared siempre agrega.
 *
 * Además: tras varios tokens incorrectos seguidos desde la misma IP se
 * bloquea un rato (429).
 */
const crypto = require('crypto');
const axios = require('axios');

const CERTS_TTL_MS = 60 * 60 * 1000;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

let certsCache = { keys: null, fetchedAt: 0, team: null };
const failures = new Map(); // ip -> { count, first }

function teamDomain() {
  const raw = (process.env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function getKeys(force = false) {
  const team = teamDomain();
  const fresh = certsCache.team === team && Date.now() - certsCache.fetchedAt < CERTS_TTL_MS;
  if (!force && fresh && certsCache.keys) return certsCache.keys;
  const { data } = await axios.get(`${team}/cdn-cgi/access/certs`, { timeout: 5000 });
  const keys = new Map();
  for (const jwk of data.keys || []) {
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch (_) {
      // llave con formato no soportado: se ignora
    }
  }
  certsCache = { keys, fetchedAt: Date.now(), team };
  return keys;
}

/**
 * Verifica el JWT de Cloudflare Access. Regresa el payload (con `email`) o
 * lanza un Error con el motivo.
 */
async function verifyAccessJwt(token) {
  const team = teamDomain();
  const aud = (process.env.CF_ACCESS_AUD || '').trim();
  if (!team || !aud) throw new Error('Cloudflare Access no está configurado (CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD)');
  if (!token) throw new Error('falta el header Cf-Access-Jwt-Assertion (¿la ruta no pasa por Cloudflare Access?)');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT mal formado');
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error(`algoritmo no permitido: ${header.alg}`);

  let keys = await getKeys();
  if (!keys.has(header.kid)) keys = await getKeys(true); // rotación de llaves
  const key = keys.get(header.kid);
  if (!key) throw new Error('llave del JWT desconocida');

  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64url')
  );
  if (!valid) throw new Error('firma del JWT inválida');

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('el JWT es de otra aplicación de Access (aud no coincide)');
  if (payload.iss !== team) throw new Error('emisor del JWT inesperado');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) throw new Error('JWT vencido');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) throw new Error('JWT todavía no es válido');
  return payload;
}

function tokenMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  return req.get('cf-connecting-ip') || req.socket.remoteAddress || '?';
}

function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILS;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count += 1;
}

async function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) {
    return res.status(503).json({
      error: 'panel_disabled',
      message: 'El panel está apagado: define ADMIN_TOKEN en el .env del backend',
    });
  }

  const ip = clientIp(req);
  if (tooManyFailures(ip)) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Demasiados intentos fallidos. Espera unos minutos' });
  }

  // 1) Cloudflare Access, para todo lo que llega por el túnel.
  const viaTunnel = !!req.get('cf-connecting-ip');
  if (viaTunnel) {
    try {
      const payload = await verifyAccessJwt(req.get('cf-access-jwt-assertion'));
      req.adminUser = payload.email || payload.sub || 'cloudflare-access';
    } catch (err) {
      console.warn(`[adminAuth] petición por el túnel rechazada (${ip}): ${err.message}`);
      return res.status(403).json({ error: 'access_required', message: 'Acceso no autorizado (Cloudflare Access)' });
    }
  } else {
    req.adminUser = 'local';
  }

  // 2) Token del backend.
  const auth = req.get('authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!given || !tokenMatches(given, expected)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'token_required', message: given ? 'Token incorrecto' : 'Falta el token del panel' });
  }
  failures.delete(ip);
  next();
}

module.exports = { adminAuth, verifyAccessJwt, _resetCertsCache: () => (certsCache = { keys: null, fetchedAt: 0, team: null }) };
