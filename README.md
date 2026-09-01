# Backend Cabina de Fotos — Esqueleto

Orquesta: Frontend (pantalla táctil) → NetPay A910 → dslrBooth (LumaBooth for Windows).

Este es un **esqueleto validable sin acceso real a NetPay ni a dslrBooth**:
incluye dos mocks (`mocks/mock-netpay.js` y `mocks/mock-dslrbooth.js`) que
simulan ambas APIs, para que puedas correr el flujo completo hoy mismo.
Cuando llegue el sandbox de NetPay o una PC con dslrBooth instalado, solo
cambias las URLs en `.env` — el código del backend no cambia.

Incluye también un frontend de pantalla táctil (`public/index.html`, un
solo archivo HTML/CSS/JS sin build) que el propio backend sirve en
`http://localhost:4000/`.

## Seguridad: el precio SIEMPRE lo decide el backend

`src/packages.js` es la única fuente de verdad de nombres y precios. El
frontend llama `GET /api/packages` para pintar las tarjetas, pero al pagar
solo manda el `packageId` — `POST /api/pay` busca el precio en el catálogo
del servidor. Nunca se confía en un monto que mande el navegador: si se
hiciera, cualquiera con las herramientas de desarrollador del navegador
podría pagar $1 por el paquete de $120. Para cambiar precios o agregar
paquetes, edita `src/packages.js` — no hay que tocar el frontend.

## Versión de Node.js

Este proyecto requiere **Node.js 24.x** (LTS activa; soporte de seguridad
hasta abril 2028). Node 18 y 20 ya no reciben actualizaciones de seguridad
a partir de 2026 — no usarlos. Node 22 sigue en mantenimiento (hasta abril
2027) y es un respaldo válido si por algún motivo la NUC ya trae esa versión
instalada, pero para una instalación nueva usa 24.

Si usas `nvm`:

```bash
nvm install
nvm use
```

(el `.nvmrc` del proyecto ya fija la versión). El `package.json` también
declara `"engines": { "node": ">=24.0.0" }` para que `npm install` avise si
alguien intenta correrlo con una versión vieja.

Cuando Node 26 pase a LTS (~octubre 2026), vale la pena reevaluar el salto,
pero no antes — mientras está en fase "Current" no es la recomendación para
producción.

## Instalación

```bash
npm install
cp .env.example .env
npm run dev
```

Por default `.env` ya apunta a los mocks (`NETPAY_BASE_URL=http://localhost:5001`,
`DSLRBOOTH_BASE_URL=http://localhost:1500`), así que no hay que tocar nada
para empezar a probar.

## Estructura

```
src/
  server.js             <- arranca Express, monta las rutas
  config.js              <- lee variables de entorno
  sessionState.js         <- estado en memoria de la sesión actual
  routes/
    payment.js             POST /api/pay            (frontend -> backend)
    webhook.js              POST /webhooks/netpay    (NetPay -> backend)
    dslrbooth.js             GET  /dslrbooth/events   (dslrBooth -> backend, triggers)
    session.js               GET  /api/session/status (frontend hace polling)
  services/
    netpayService.js       llamadas a NetPay (implementado, apunta a mock o real según .env)
    dslrboothService.js    llamadas a dslrBooth API (implementado, igual)
  packages.js              catálogo de paquetes (nombre/precio/fotos) — ÚNICA fuente de verdad
public/
  index.html                frontend de pantalla táctil (sin build, lo sirve el backend)
mocks/
  mock-netpay.js          simula OAuth + venta + webhook de confirmación
  mock-dslrbooth.js       simula /api/start + secuencia de eventos de una sesión
```

Además, para la demo temporal con cámara/impresora reales (`BOOTH_MODE=direct`):

```
src/
  services/
    cameraService.js      captura con gphoto2 (Nikon D7200 vía USB)
    printerService.js     impresión con CUPS/lp (DNP RX1 u otra impresora)
    directBoothService.js orquesta countdown -> captura -> impresión,
                           emitiendo los mismos eventos que dslrBooth
  routes/
    diagnostics.js         GET /diagnostics/camera y /diagnostics/printer
```

## Cómo probar el flujo completo YA (sin nada real)

Se necesitan 3 terminales:

```bash
# Terminal 1
npm run mock:netpay

# Terminal 2
npm run mock:dslrbooth

# Terminal 3
npm run dev
```

Con las tres corriendo, abre **http://localhost:4000/** en el navegador —
ese es el frontend real de la pantalla táctil, sirviéndose desde el mismo
backend. El flujo (diseño tipo kiosco, 5 pantallas): inicio → elegir
paquete → procesando pago → éxito/sesión de fotos → vuelta al inicio.
Todas las transiciones las dispara el estado real del backend vía polling,
no animaciones simuladas.

**Terminal simulada con botones:** la pantalla "Procesando pago" trae
botones "✓ Simular aprobación" y "✗ Simular error" que mandan al backend el
mismo webhook que NetPay mandaría en producción. Para que esos botones sean
la ÚNICA terminal (y el mock no se adelante confirmando solo a los 3s),
corre el mock de NetPay en modo timeout:

```bash
MOCK_NETPAY_RESULT=timeout npm run mock:netpay
```

En modo normal (`npm run mock:netpay` a secas) el mock confirma solo a los
~3s, como lo haría la terminal real cuando el cliente pasa su tarjeta.

Si prefieres probarlo por línea de comandos en vez del navegador:

```bash
curl -X POST http://localhost:4000/api/pay \
  -H "Content-Type: application/json" \
  -d '{"packageId":"premium"}'

watch -n1 curl -s http://localhost:4000/api/session/status
```

(los `packageId` válidos son los que regresa `GET /api/packages` — por
default `basico`, `premium`, `vip`; se editan en `src/packages.js`)

Casos de error a probar cambiando el modo del mock de NetPay:

```bash
MOCK_NETPAY_RESULT=reject npm run mock:netpay    # pago rechazado
MOCK_NETPAY_RESULT=timeout npm run mock:netpay   # NetPay nunca confirma
```

## Demo temporal con cámara e impresora reales (`BOOTH_MODE=direct`)

Esto reemplaza SOLO la parte de dslrBooth — el pago se queda simulado con
`mock-netpay` tal cual. Pensado para Fedora, con la Nikon D7200 y la DNP RX1
(o cualquier impresora, si la DNP no tiene driver a tiempo) conectadas por USB.

### 1. Instalar dependencias del sistema

```bash
sudo dnf install gphoto2 cups system-config-printer
sudo systemctl enable --now cups
```

### 2. Conectar la cámara y confirmar que gphoto2 la ve

Enciende la D7200, conéctala por USB, y confirma que esté en modo **PTP**
(no "Mass Storage" / almacenamiento masivo — se cambia en el menú Setup de
la cámara). Luego:

```bash
gphoto2 --auto-detect
```

Si sale vacío o dice "Could not claim the USB device", probablemente el
gestor de archivos de GNOME/KDE la montó automático — libérala con:

```bash
killall gvfsd-gphoto2 gvfs-gphoto2-volume-monitor 2>/dev/null
```

Prueba una captura manual antes de meter el backend de por medio:

```bash
gphoto2 --capture-image-and-download --filename=test.jpg
```

### 3. Conectar la impresora y agregarla a CUPS

Con la DNP RX1 (o la impresora que tengas a mano) conectada, ábrela desde
`system-config-printer` o desde `http://localhost:631` (interfaz web de
CUPS) y agrégala. Confirma el nombre exacto de la cola:

```bash
lpstat -p
```

Prueba imprimir algo directo, sin el backend, para descartar problemas de
driver:

```bash
lp -d <nombre-de-la-cola> test.jpg
```

Si no tienes el driver oficial de DNP a tiempo para la demo: cualquier
impresora normal sirve para **validar el flujo** (que el backend sí dispara
la impresión en el momento correcto) — solo no vas a tener la calidad ni el
tamaño 4x6 real todavía.

### 4. Configurar el backend

```bash
cp .env.example .env
```

Edita `.env`: `BOOTH_MODE=direct`, y `PRINTER_NAME=<lo que te dio lpstat -p>`.

### 5. Levantar backend + mock de NetPay (dslrBooth ya no hace falta)

```bash
# Terminal 1
npm run mock:netpay

# Terminal 2
npm run dev
```

Antes de disparar un pago completo, confirma que el backend también ve el
hardware:

```bash
curl http://localhost:4000/diagnostics/camera
curl http://localhost:4000/diagnostics/printer
```

Y ya, el flujo completo con hardware real:

```bash
curl -X POST http://localhost:4000/api/pay \
  -H "Content-Type: application/json" \
  -d '{"amount":80,"packageName":"Premium"}'

watch -n1 curl -s http://localhost:4000/api/session/status
```

Deberías ver `awaiting_payment` → `payment_confirmed` → `booth_running` →
countdown real de 3 segundos → la cámara disparando de verdad →
`printing` → la impresora sacando la foto → de vuelta a `idle`.

### Volver al modo normal (dslrBooth real o mocks)

Solo cambia `BOOTH_MODE` de vuelta a `dslrbooth` en `.env` — nada más se
toca. `cameraService.js`, `printerService.js` y `directBoothService.js`
simplemente dejan de usarse.

## Cuando lleguen los accesos reales

- **NetPay:** cambiar `NETPAY_BASE_URL` a `https://sandbox.netpay.com.mx` y
  llenar `NETPAY_USERNAME`, `NETPAY_PASSWORD`, `NETPAY_AUTH_STRING`,
  `NETPAY_SERIAL_NUMBER`, `NETPAY_STORE_ID`. Re-validar el shape exacto del
  request/response de `/oauth/token` y `/transactions/sale` contra la doc
  real — el mock asume la forma documentada pero puede haber diferencias.
- **dslrBooth:** cambiar `DSLRBOOTH_API_PASSWORD` al password real (Settings
  → General → API) y configurar el Trigger URL de dslrBooth apuntando a
  `http://<ip-de-la-NUC>:4000/dslrbooth/events`.

En ningún caso hay que tocar `routes/` ni `sessionState.js` — esa parte ya
quedó validada con los mocks.

## Qué falta para producción

- Validar origen/firma de `POST /webhooks/netpay` antes de confiar en el body.
- Manejo de timeouts/reintentos si NetPay no confirma en ~1 minuto.
- Logging persistente de transacciones (por ahora todo vive en memoria).
