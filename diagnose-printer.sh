#!/bin/bash
# Diagnóstico de impresora CUPS — corre esto en tu máquina Fedora

echo "=== 1. Estado del demonio CUPS ==="
sudo systemctl status cups
echo ""

echo "=== 2. Output raw de lpstat -p ==="
lpstat -p
echo ""

echo "=== 3. Output de lpstat -p (con -v para más detalle) ==="
lpstat -p -v
echo ""

echo "=== 4. Listar todas las colas CUPS ==="
lpstat -l -p
echo ""

echo "=== 5. Verificar que PRINTER_NAME en .env coincida ==="
grep PRINTER_NAME .env || echo "PRINTER_NAME no configurado en .env"
echo ""

echo "=== 6. Verificar que la impresora esté habilitada ==="
lpstat -d
echo ""

echo "=== 7. Test: intentar enviar un job de prueba ==="
PRINTER_NAME=$(grep PRINTER_NAME .env | cut -d= -f2)
if [ -z "$PRINTER_NAME" ]; then
  echo "PRINTER_NAME vacío, salta test de impresión"
else
  echo "Intentando un job de prueba a: $PRINTER_NAME"
  echo "test" | lp -d "$PRINTER_NAME" -t "test-from-diagnostics" 2>&1 || echo "Error al enviar job"
  sleep 1
  lpstat -o
fi
