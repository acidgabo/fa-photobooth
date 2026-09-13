# Backend Cabina de Fotos

Orquesta: Frontend (pantalla táctil) → NetPay A910 → dslrBooth (LumaBooth for Windows).

Incluye también un frontend de pantalla táctil (`public/index.html`, un
solo archivo HTML/CSS/JS sin build) que el propio backend sirve en
`http://localhost:4000/`.

**Estado actual del proyecto:** la integración con dslrBooth (LumaBooth)
está **validada contra hardware real y con las credenciales reales** (API
activada, password confirmado, endpoints de `start`, `print` y
`lockscreen` probados contra el booth real — ver `claude/Integración
dslrbooth.md`, doc del proyecto). Lo que sigue pendiente es NetPay
(esperando credenciales de sandbox) y el hardening de robustez (timeout,
auth de eventos, monitoreo de hardware, convivencia de pantallas — ver
secciones de abajo).

El hardware real es una **laptop Windows** (Lenovo ThinkPad X13 G1) — el
proyecto ya no usa una NUC genérica; cualquier mención a "NUC" en
documentación vieja se refiere a esta laptop, que cumple el mismo rol.

Este backend soporta tres modos intercambiables por variable de entorno
(`BOOTH_MODE`), pensados para poder desarrollar y probar sin depender del
hardware final:

| `BOOTH_MODE`  | Dónde corre | Qué hace | Estado |
|---|---|---|---|
| `dslrbooth` | **Windows**, con LumaBooth instalado y licenciado | Llama al API real de LumaBooth (cámara + impresora + Triggers) | **Producción — validado con credenciales reales** |
| `direct` | **Linux** (Fedora), sin LumaBooth | Controla cámara (gphoto2) e impresora (CUPS) directo | Demo/desarrollo — no requiere Windows ni licencia |
| `windirect` | **Windows**, sin LumaBooth | Controla cámara (digiCamControl) e impresora (nativa de Windows) directo | Puente histórico — se usó para validar hardware en Windows antes de tener LumaBooth licenciado; ya superado por `dslrbooth`, se deja documentado por si hace falta de nuevo |

Los mocks (`mocks/mock-netpay.js` y `mocks/mock-dslrbooth.js`) simulan
NetPay y LumaBooth para poder correr el flujo completo **en cualquier
sistema operativo**, sin nada real conectado — es el punto de partida
recomendado para tocar el código sin tener a la mano ni la laptop Windows
ni el hardware.

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
2027) y es un respaldo válido si por algún motivo la laptop Windows real
ya trae esa versión instalada, pero para una instalación nueva usa 24.

Si usas `nvm` (Linux/macOS) o `nvm-windows`:

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

## Instalación (cualquier sistema operativo, con los mocks)

```bash
npm install
cp .env.example .env
npm run dev
```

Por default `.env` ya apunta a los mocks (`NETPAY_BASE_URL=http://localhost:5001`,
`DSLRBOOTH_BASE_URL=http://localhost:1500`), así que no hay que tocar nada
para empezar a probar — esto funciona igual en Linux, Windows o macOS.

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
    diagnostics.js           GET  /diagnostics/camera y /diagnostics/printer (solo direct/windirect)
  services/
    netpayService.js       llamadas a NetPay (implementado, apunta a mock o real según .env)
    dslrboothService.js    llamadas al API de LumaBooth — SOLO WINDOWS en la práctica
    windowFocusService.js  swap de foco kiosco <-> LumaBooth — SOLO WINDOWS (ver más abajo)
    cameraService.js       captura con gphoto2 — SOLO LINUX (BOOTH_MODE=direct)
    printerService.js      impresión con CUPS/lp — SOLO LINUX (BOOTH_MODE=direct)
    directBoothService.js  orquesta countdown -> captura -> impresión — SOLO LINUX
    windowsCameraService.js   captura vía digiCamControl — SOLO WINDOWS (BOOTH_MODE=windirect)
    windowsPrinterService.js  impresión nativa de Windows — SOLO WINDOWS (BOOTH_MODE=windirect)
    windirectBoothService.js  orquesta countdown -> captura -> impresión — SOLO WINDOWS (windirect)
  packages.js              catálogo de paquetes (nombre/precio/fotos) — ÚNICA fuente de verdad
public/
  index.html                frontend de pantalla táctil (sin build, lo sirve el backend;
                             corre igual en Linux o Windows, es solo un navegador)
mocks/
  mock-netpay.js          simula OAuth + venta + webhook de confirmación (cualquier SO)
  mock-dslrbooth.js       simula /api/start + secuencia de eventos de una sesión (cualquier SO)
```

`server.js`, `sessionState.js`, `config.js` y todas las `routes/` son
agnósticas de sistema operativo — el mismo código corre en Linux o
Windows. Lo que cambia entre plataformas son los **servicios** que hablan
con hardware/apps nativas, señalados arriba.

---

## Cómo probar el flujo completo (mocks, cualquier SO)

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

---

## 🪟 Modo Windows — producción (`BOOTH_MODE=dslrbooth`)

Este es el modo real del negocio: LumaBooth Professional para Windows
instalado y licenciado en la laptop, controlando la Nikon D7200 y la DNP
DS-RX1. **Ya validado con las credenciales reales** — ver
`claude/Integración dslrbooth.md` (doc del proyecto) para el detalle
completo de la validación y los endpoints confirmados.

### Configuración

En `.env` (ver `.env.example`):

```
BOOTH_MODE=dslrbooth
DSLRBOOTH_BASE_URL=http://localhost:1500
DSLRBOOTH_API_PASSWORD=<password real, Settings → General → API en LumaBooth>
```

Y en LumaBooth: Settings → General → Triggers → URL Trigger apuntando a
`http://localhost:4000/dslrbooth/events` (o la IP de la laptop si el
backend corre en otra máquina de la misma red).

### Endpoints de LumaBooth confirmados por prueba directa

La doc oficial en Postman tiene inconsistencias entre el header de cada
request, el ejemplo de `curl`, y el campo `Command` de la respuesta — estos
son los que **sí funcionan probados contra el booth real** (`200 OK`,
`IsSuccessful: true`):

```
GET /api/start?mode=print&password=<PASSWORD>       → inicia sesión (print/gif/boomerang/video)
GET /api/print?count=1&password=<PASSWORD>          → reimprime N copias de la última foto
GET /api/lockscreen/show?password=<PASSWORD>        → muestra la pantalla de bloqueo
GET /api/lockscreen/exit?password=<PASSWORD>         → oculta la pantalla de bloqueo
```

Paths que la doc sugiere pero **no funcionan** (`Invalid command
specified`): `/api/showlockscreen`, `/api/exitlockscreen`,
`/api/lockscreen?mode=show`, `/api/lock`, `/api/unlock`,
`/api/show/lockscreen`. Detalle completo en `claude/Integración
dslrbooth.md`.

### Convivencia de pantallas: kiosco ↔ LumaBooth

LumaBooth es una app nativa de Windows con su propia ventana (no se puede
embeber) — el navegador del kiosco y LumaBooth se turnan el mismo espacio
de pantalla física dos veces por sesión: al disparar `/api/start`
(LumaBooth debe tomar el primer plano) y al recibir `session_end` (el
navegador debe recuperarlo). Diseño completo en `claude/Integración
dslrbooth.md` (sección "Convivencia visual/de foco...").

Implementación (`src/services/windowFocusService.js` +
`src/services/dslrboothService.js`):

- En los dos puntos donde el backend ya tiene la señal exacta —
  `routes/webhook.js` (justo antes de `startSession()`) y
  `routes/dslrbooth.js` (al recibir `session_end`) — se dispara un swap de
  foco vía PowerShell (`SetForegroundWindow`) hacia el proceso
  correspondiente.
- Antes de intentar ese swap, se llama primero al lockscreen de LumaBooth
  (`/api/lockscreen/show` o `/api/lockscreen/exit`) — así, si el robo de
  foco falla o tarda, el cliente ve la pantalla de bloqueo en vez de la
  interfaz real de LumaBooth a medio transicionar.
- Todo esto es **best-effort**: ninguna de estas llamadas puede romper el
  flujo de pago/sesión si falla (nunca lanzan error hacia quien las llama
  — solo loguean un warning).

**Pendiente de confirmar en hardware real** (no se puede validar por API ni
documentación): si `SetForegroundWindow` desde un proceso de Node logra
robarle el foco a una app que ya está en pantalla completa — Windows tiene
protecciones anti-"robo de foco" que a veces lo bloquean. Mientras se
prueba, `KIOSK_WINDOW_FOCUS_ENABLED=false` en `.env` desactiva solo el swap
de foco (el lockscreen se sigue usando igual). Confirmar también con
`Get-Process` en la laptop real los nombres exactos para
`KIOSK_DSLRBOOTH_PROCESS_NAME` y `KIOSK_BROWSER_PROCESS_NAME`.

Complementario a esto (se configura en la propia app, no desde este
backend): LumaBooth debe correr con "Iniciar la Aplicación en Pantalla
Completa" + PIN de seguridad activados (Settings → General), y el
navegador del kiosco con `--kiosk` real de Chrome/Edge (no solo CSS
fullscreen).

### `windirect` — modo puente (Windows, sin LumaBooth)

`BOOTH_MODE=windirect` controla la cámara vía digiCamControl
(`CameraControlCmd.exe`) y la impresora nativa de Windows vía PowerShell +
`System.Drawing.Printing`, sin pasar por LumaBooth — se usó como paso
intermedio para validar hardware en Windows antes de tener LumaBooth
licenciado. Ya superado ahora que `dslrbooth` está validado con
credenciales reales, pero se deja documentado/funcional por si hace falta
de nuevo (ej. mientras se recupera una licencia). Variables relevantes en
`.env.example`: `DIGICAM_CONTROL_PATH`, `DIGICAM_SESSION_FOLDER`,
`PRINTER_NAME`, `WINDOWS_PRINT_COPY_DELAY_MS`.

---

## 🐧 Modo Linux — demo/desarrollo (`BOOTH_MODE=direct`)

Esto reemplaza SOLO la parte de LumaBooth — el pago se queda simulado con
`mock-netpay` tal cual. Pensado para Fedora, con la Nikon D7200 y la DNP
RX1 (o cualquier impresora, si la DNP no tiene driver a tiempo) conectadas
por USB. Útil para desarrollar y probar cambios de código sin necesitar la
laptop Windows a la mano.

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

### 5. Levantar backend + mock de NetPay (LumaBooth ya no hace falta)

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

Problemas comunes (impresora no listada, cámara no detectada) están
documentados paso a paso en `TROUBLESHOOTING_HARDWARE.md` (también
Linux/`direct` únicamente).

### Volver al modo Windows (LumaBooth real o mocks)

Solo cambia `BOOTH_MODE` de vuelta a `dslrbooth` en `.env` — nada más se
toca. `cameraService.js`, `printerService.js` y `directBoothService.js`
simplemente dejan de usarse.

---

## Cuando lleguen los accesos reales

- **dslrBooth / LumaBooth:** ✅ **listo** — ya se cuenta con el password
  real (Settings → General → API en LumaBooth) y el Trigger URL
  configurado apuntando a `http://localhost:4000/dslrbooth/events`. Ver
  `claude/Integración dslrbooth.md` para el detalle de la validación.
- **NetPay:** pendiente — cuando llegue el sandbox, cambiar
  `NETPAY_BASE_URL` a `https://sandbox.netpay.com.mx` y llenar
  `NETPAY_USERNAME`, `NETPAY_PASSWORD`, `NETPAY_AUTH_STRING`,
  `NETPAY_SERIAL_NUMBER`, `NETPAY_STORE_ID`. Re-validar el shape exacto del
  request/response de `/oauth/token` y `/transactions/sale` contra la doc
  real — el mock asume la forma documentada pero puede haber diferencias.

En ningún caso hay que tocar `routes/` ni `sessionState.js` — esa parte ya
quedó validada con los mocks.

## Qué falta para producción

- Validar origen/firma de `POST /webhooks/netpay` antes de confiar en el body.
- Manejo de timeouts/reintentos si NetPay no confirma en ~1 minuto.
- Logging persistente de transacciones (por ahora todo vive en memoria).
- Confirmar en hardware real (Windows) el swap de foco kiosco <-> LumaBooth
  (ver sección "Modo Windows" de arriba) y ajustar
  `KIOSK_DSLRBOOTH_PROCESS_NAME` / `KIOSK_BROWSER_PROCESS_NAME` según lo
  que muestre `Get-Process`.
- Timeout/watchdog si LumaBooth se cuelga a medio evento.
- Autenticación de origen en `GET /dslrbooth/events`.
- Monitoreo de disponibilidad de cámara/impresora (ver
  `claude/Propuesta_Monitoreo_Camara_Impresora.md`, doc del proyecto).
