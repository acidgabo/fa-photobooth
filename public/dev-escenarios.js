/**
 * Panel de escenarios de prueba en el kiosco — SOLO en la laptop de
 * desarrollo (HARDWARE_MODE=mock). index.html lo carga únicamente cuando
 * GET /api/config regresa devScenarios:true; en la cabina no se descarga.
 *
 * Elige el escenario del mock de LumaBooth (cámara que se desconecta,
 * impresora sin papel, sesión colgada, etc.). El escenario aplica a la
 * SIGUIENTE sesión: se elige aquí y luego se paga normal en el kiosco.
 * Habla con el backend (/api/dev/...), que lo reenvía al mock.
 */
(function () {
  const POLL_MS = 3000;

  const css = `
    /* El kiosco le da a todos los <button> fuente Lazydog, nowrap, gradiente
       y escala al pasar el mouse; aquí se neutraliza para el panel. */
    .devsc-tab, .devsc-close, .devsc-card {
      white-space: normal; letter-spacing: normal; transform: none !important;
      font-family: 'Segoe UI', Tahoma, sans-serif; transition: none;
    }
    .devsc-close, .devsc-card { box-shadow: none; }
    .devsc-tab {
      position: fixed; left: 12px; bottom: 12px; z-index: 9000;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; min-height: 44px; border-radius: 999px;
      background: #2b2724; color: #fff; border: 2px dashed #e0a43a;
      font: 600 14px/1.2 'Segoe UI', Tahoma, sans-serif; cursor: pointer; white-space: nowrap;
      box-shadow: 0 4px 14px rgba(0,0,0,.25);
    }
    .devsc-tab .devsc-dot { width: 10px; height: 10px; border-radius: 50%; background: #3fbf72; flex: none; }
    .devsc-tab .devsc-dot.bad { background: #e05252; }
    .devsc-bg { position: fixed; inset: 0; z-index: 9001; background: rgba(20,18,16,.5); display: none; }
    .devsc-bg.open { display: block; }
    .devsc-sheet {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 9002;
      max-height: 85vh; overflow-y: auto;
      background: #f4f4f4; color: #1c1c1c; border-radius: 18px 18px 0 0;
      padding: 18px 16px 24px; transform: translateY(105%); transition: transform .2s ease;
      font: 15px/1.4 'Segoe UI', Tahoma, sans-serif; text-align: left;
      user-select: none;
    }
    .devsc-sheet.open { transform: none; }
    .devsc-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 4px; }
    .devsc-head h3 { font-size: 18px; margin: 0; flex: 1; }
    .devsc-head small { display: block; font-weight: 400; color: #6b6560; font-size: 13px; margin-top: 2px; }
    .devsc-close { flex: none; font-size: 15px; background: #fff; border: 1.5px solid #46413d; color: #46413d; border-radius: 10px; padding: 8px 14px; font: inherit; font-weight: 600; min-height: 44px; cursor: pointer; }
    .devsc-hw { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 6px; }
    .devsc-chip { padding: 5px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; background: #e5f3ea; color: #2f7d4f; }
    .devsc-chip.bad { background: #fbe6e6; color: #a83232; }
    .devsc-note { font-size: 13px; color: #6b6560; margin: 4px 0 12px; }
    .devsc-warn { background: #fff1d6; color: #9a5b00; border-radius: 10px; padding: 10px 12px; font-weight: 600; margin-bottom: 12px; display: none; }
    .devsc-warn.show { display: block; }
    .devsc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
    .devsc-card {
      display: flex; flex-direction: column; justify-content: flex-start; align-items: stretch; width: 100%; text-align: left; cursor: pointer;
      background: #fff; border: 1.5px solid #e2dfdc; border-radius: 12px; padding: 12px 14px;
      font: inherit; color: inherit; min-height: 44px; font-size: 15px;
    }
    .devsc-card:disabled { opacity: .5; cursor: not-allowed; }
    .devsc-card.active { border: 2.5px solid #46413d; background: #fffdf8; }
    .devsc-card strong { display: flex; justify-content: space-between; gap: 8px; font-size: 15px; }
    .devsc-card .devsc-on { font-size: 12px; background: #46413d; color: #fff; border-radius: 999px; padding: 2px 8px; font-weight: 600; }
    .devsc-card p { margin: 6px 0 0; font-size: 13.5px; }
    .devsc-card .devsc-exp { color: #6b6560; }
    .devsc-msg { margin-top: 12px; font-weight: 600; min-height: 20px; }
    .devsc-msg.bad { color: #a83232; }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const tab = document.createElement('button');
  tab.className = 'devsc-tab';
  tab.type = 'button';
  tab.innerHTML = '<span class="devsc-dot"></span><span>Pruebas · <b class="devsc-name">…</b></span>';

  const bg = document.createElement('div');
  bg.className = 'devsc-bg';

  const sheet = document.createElement('div');
  sheet.className = 'devsc-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Escenarios de prueba');
  sheet.innerHTML = `
    <div class="devsc-head">
      <h3>Escenarios de prueba<small>Hardware simulado (HARDWARE_MODE=mock). Aplica a la siguiente sesión: elige el escenario y luego paga normal.</small></h3>
      <button type="button" class="devsc-close">Cerrar</button>
    </div>
    <div class="devsc-hw"></div>
    <div class="devsc-warn"></div>
    <div class="devsc-grid"></div>
    <div class="devsc-msg"></div>`;

  document.body.append(tab, bg, sheet);

  const $ = (sel) => sheet.querySelector(sel);
  let data = null;
  let pollTimer = null;
  let busy = false;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function request(path, options) {
    const res = await fetch('/api/dev' + path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  }

  function hwOk(hw) {
    return hw && hw.camera && hw.camera.present && hw.printer && hw.printer.ok;
  }

  function render() {
    tab.querySelector('.devsc-name').textContent = data ? data.activo : 'sin conexión';
    tab.querySelector('.devsc-dot').classList.toggle('bad', !data || !hwOk(data.hardware));
    if (!data) return;

    const hw = data.hardware;
    $('.devsc-hw').innerHTML =
      `<span class="devsc-chip ${hw.camera.present ? '' : 'bad'}">Cámara: ${hw.camera.present ? 'conectada' : 'ausente'}</span>` +
      `<span class="devsc-chip ${hw.printer.ok ? '' : 'bad'}">Impresora: ${hw.printer.ok ? 'OK' : esc(hw.printer.detail || 'con falla')}${hw.printer.pendingJobs ? ` · ${hw.printer.pendingJobs} en cola` : ''}</span>`;

    const inSession = ['awaiting_payment', 'payment_confirmed', 'booth_running'].includes(data.session);
    const warn = $('.devsc-warn');
    warn.classList.toggle('show', inSession || !hwOk(hw));
    warn.textContent = inSession
      ? 'Hay una venta o sesión en curso: el escenario se puede cambiar cuando regrese al inicio.'
      : 'La cabina está fuera de servicio por el hardware simulado. Elige "normal" para volver a cobrar.';

    $('.devsc-grid').innerHTML = data.escenarios
      .map(
        (s) => `<button type="button" class="devsc-card ${s.nombre === data.activo ? 'active' : ''}" data-name="${esc(s.nombre)}" ${inSession || busy ? 'disabled' : ''}>
          <strong>${esc(s.nombre)}${s.nombre === data.activo ? '<span class="devsc-on">activo</span>' : ''}</strong>
          <p>${esc(s.descripcion)}</p>
          <p class="devsc-exp">Se espera: ${esc(s.esperado)}</p>
        </button>`
      )
      .join('');
  }

  async function refresh() {
    clearTimeout(pollTimer);
    try {
      const { ok, body } = await request('/escenarios');
      if (ok) {
        data = body;
      } else {
        data = null;
        setMsg(body.message || 'No se pudo leer el mock', true);
      }
    } catch (err) {
      data = null;
      setMsg('No se pudo leer el mock: ' + err.message, true);
    }
    render();
    pollTimer = setTimeout(refresh, POLL_MS);
  }

  function setMsg(text, bad) {
    const el = $('.devsc-msg');
    el.textContent = text || '';
    el.classList.toggle('bad', !!bad);
  }

  async function choose(name) {
    if (busy) return;
    busy = true;
    render();
    setMsg('Cambiando a "' + name + '"…');
    try {
      const { ok, body } = await request('/escenario', { method: 'POST', body: JSON.stringify({ nombre: name }) });
      if (ok) {
        setMsg('Escenario "' + body.activo + '" listo. Ahora paga normal en el kiosco.');
        setTimeout(close, 900);
      } else {
        setMsg(body.message || body.error || 'No se pudo cambiar', true);
      }
    } catch (err) {
      setMsg('No se pudo cambiar: ' + err.message, true);
    }
    busy = false;
    refresh();
  }

  function open() {
    bg.classList.add('open');
    sheet.classList.add('open');
    setMsg('');
    refresh();
  }

  function close() {
    bg.classList.remove('open');
    sheet.classList.remove('open');
  }

  tab.addEventListener('click', open);
  bg.addEventListener('click', close);
  $('.devsc-close').addEventListener('click', close);
  $('.devsc-grid').addEventListener('click', (ev) => {
    const card = ev.target.closest('.devsc-card');
    if (card && !card.disabled) choose(card.dataset.name);
  });

  refresh();
})();
