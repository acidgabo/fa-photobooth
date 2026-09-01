# Troubleshooting: Hardware Direct Mode (Cámara + Impresora)

## Problema: Diagnostico de impresora retorna lista vacía

El endpoint `/diagnostics/printer` debe listar todas las impresoras conocidas por CUPS, pero está retornando `{"printers":[]}` vacío.

### Paso 1: Verificar que CUPS esté corriendo

```bash
sudo systemctl status cups
```

Si dice "inactive", activarlo:

```bash
sudo systemctl enable --now cups
```

### Paso 2: Verificar output de lpstat

```bash
# Raw output (lo que el backend intenta parsear)
lpstat -p

# Con detalles de conexión
lpstat -p -v

# Todos los trabajos pendientes
lpstat -o
```

El output debería verse algo como:

```
printer Dai_Nippon_Printing_DS-RX1 disabled since Mon 20 Aug 2026 08:59:58 CEST
  reason unknown
printer HPprinter idle Xerox_WorkCentre...
```

La línea que empieza con `printer` es lo que el backend parsea — extrae la segunda palabra como nombre de la impresora.

### Paso 3: Verificar PRINTER_NAME en .env

```bash
grep PRINTER_NAME .env
```

Debe coincidir **exactamente** con lo que `lpstat -p` muestra. Si `lpstat -p` dice `printer Dai_Nippon_Printing_DS-RX1 ...`, entonces:

```bash
PRINTER_NAME=Dai_Nippon_Printing_DS-RX1
```

### Paso 4: Si lpstat retorna vacío

**Posibilidad 1:** No hay impresoras dadas de alta en CUPS.

```bash
# Agregar la DNP RX1 a CUPS vía interfaz gráfica
system-config-printer

# O vía web
http://localhost:631
```

**Posibilidad 2:** La impresora se desconectó o está deshabilitada.

```bash
# Habilitar impresora (reemplaza 'Dai_Nippon_Printing_DS-RX1' con el nombre real)
sudo cupsctl --remote-admin --share-printers --user-cancel-any --no-user-cancel-any

# Reiniciar CUPS
sudo systemctl restart cups

# Verificar de nuevo
lpstat -p -v
```

### Paso 5: Test de impresión manual

```bash
# Reemplaza 'Dai_Nippon_Printing_DS-RX1' con el nombre real
lp -d Dai_Nippon_Printing_DS-RX1 /path/to/test/image.jpg
```

Si sale error, verifica el log de CUPS:

```bash
tail -50 /var/log/cups/error_log
```

---

## Problema: Cámara no se detecta

El endpoint `/diagnostics/camera` retorna `detected: false`.

### Paso 1: Verificar hardware

```bash
# Conectar la cámara USB, encenderla, en modo PTP (no Mass Storage)
# Correr:
gphoto2 --auto-detect
```

Si sale vacío, la cámara no se ve — posibles causas:

1. **Otro proceso tiene el USB**: El gestor de archivos o un deamon automático pueden montarla como almacenamiento.

```bash
# Matar procesos que compiten por el USB
killall gvfsd-gphoto2 gvfs-gphoto2-volume-monitor
killall gphoto2

# Esperar 2s, intentar de nuevo
sleep 2
gphoto2 --auto-detect
```

2. **Cámara en modo incorrecto**: Revisar en el menú de la cámara: `Setup > USB Connection > PTP` (no "Mass Storage" / "Almacenamiento masivo").

3. **Cable USB roto**: Probar con otro cable o puerto USB.

### Paso 2: Una vez detectada, test de captura

```bash
# Crear carpeta para fotos
mkdir -p /tmp/photobooth-captures

# Test manual de captura
gphoto2 --capture-image-and-download --filename=/tmp/photobooth-captures/test.jpg
```

Si funciona, el archivo debe aparecer:

```bash
ls -la /tmp/photobooth-captures/
```

---

## Paso 3: Verificar que el backend vea todo

Una vez que `lpstat -p` y `gphoto2 --auto-detect` funcionan en terminal, reinicia el backend y prueba:

```bash
# Terminal 1: mock de NetPay
npm run mock:netpay

# Terminal 2: backend (con .env configurado: BOOTH_MODE=direct, PRINTER_NAME correcto)
npm run dev

# Terminal 3: diagnostics
curl http://localhost:4000/diagnostics/camera
curl http://localhost:4000/diagnostics/printer
```

Si siguen retornando vacío, verifica logs del backend (`npm run dev` output) — debería decir si CUPS o gphoto2 fallaron.

---

## Paso 4: Full Hardware Flow

Una vez que ambos diagnostics funcionen, puedes hacer el full flow:

```bash
# Terminal 1: mock NetPay en modo timeout (para controlar pagos con botones)
MOCK_NETPAY_RESULT=timeout npm run mock:netpay

# Terminal 2: backend con hardware directo
BOOTH_MODE=direct PRINTER_NAME=Dai_Nippon_Printing_DS-RX1 npm run dev

# Terminal 3: browser
open http://localhost:4000/
```

1. Toca "TOCA PARA INICIAR"
2. Selecciona "PREMIUM"
3. Toca "Simular aprobación" (o espera a que auto-simule)
4. Backend hace countdown → dispara cámara → imprime
5. Frontend mostrará "¡ÉXITO!"

Si algo falla en los pasos 4, el backend te dará logs detallados:

```
[directBoothService] Iniciando sesión directa (BOOTH_MODE=direct)
[directBoothService] Iniciando countdown: 3s
[directBoothService] Countdown: 33%
[directBoothService] Countdown: 66%
[directBoothService] Countdown: 100%
[directBoothService] Disparando captura...
[cameraService] gphoto2 --auto-detect detectó 1 cámara(s)
[directBoothService] Foto capturada: /tmp/photobooth-captures/photo_1724175234567.jpg
[directBoothService] Enviando a impresora: Dai_Nippon_Printing_DS-RX1
[directBoothService] Impresión completada
[directBoothService] Sesión finalizada exitosamente
```

---

## Debug: Logs detallados del backend

El backend ahora emite logs a `console` (visible en terminal). Para más contexto sobre fallos:

1. **Cámara:** mira `[cameraService]` lines
2. **Impresora:** mira `[printerService]` lines  
3. **Orquestación:** mira `[directBoothService]` lines

Si un comando falla (p.ej., `lpstat` no es encontrado), verás:

```
[printerService] lpstat falló: command not found
```

En ese caso, instala: `sudo dnf install cups` y reinicia.

---

## Checklist rápido antes de hacer el test

- [ ] CUPS running: `sudo systemctl status cups` → "active (running)"
- [ ] Impresora listada: `lpstat -p` → muestra "printer Dai_Nippon_..."
- [ ] Cámara detectada: `gphoto2 --auto-detect` → muestra "Nikon D7200"
- [ ] .env tiene `BOOTH_MODE=direct` y `PRINTER_NAME=Dai_Nippon_Printing_DS-RX1`
- [ ] Backend puede listar impresoras: `curl http://localhost:4000/diagnostics/printer`
- [ ] Backend puede detectar cámara: `curl http://localhost:4000/diagnostics/camera`

Si todos los ✓, el flow debería funcionar.

