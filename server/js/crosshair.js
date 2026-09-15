'use strict';

window.XenonCrosshair = (() => {
  let state = null;
  let busy = false;
  let statusRequest = null;
  let toggling = false;
  const dialog = () => document.getElementById('crosshair-dialog');
  const tr = (key, fallback) => { const value = typeof t === 'function' ? t(key) : ''; return value && value !== key ? value : fallback; };
  const field = name => dialog()?.querySelector('[data-crosshair-' + name + ']');

  function message(text) { const el = field('message'); if (el) el.textContent = text; }
  function render() {
    const on = !!(state?.online && state.visible && state.enabled);
    document.querySelectorAll('[data-crosshair-toggle]').forEach(button => {
      button.textContent = 'Crosshair ' + (on ? 'ON' : 'OFF');
      button.setAttribute('aria-pressed', String(on));
      button.disabled = busy || toggling;
      button.classList.toggle('active', on);
    });
    if (!dialog()?.open) return;
    field('color').value = state?.color || '#65f5ba';
    field('size').value = state?.size || 20;
    field('size-value').textContent = String(state?.size || 20);
    const preview = field('preview');
    preview.style.setProperty('--crosshair-color', state?.color || '#65f5ba');
    preview.style.setProperty('--crosshair-size', (state?.size || 20) + 'px');
    field('badge').textContent = !state?.installed ? tr('crosshair_not_installed', 'Not installed')
      : !state.online || !state.visible ? tr('crosshair_open_hint', 'Open Win + G → Xenon Crosshair')
      : !state.pinned ? tr('crosshair_pin_hint', 'Pin the widget in Game Bar')
      : !state.clickThrough ? tr('crosshair_click_hint', 'Enable click-through in Game Bar')
      : tr('crosshair_ready', 'Game Bar connected');
    dialog().querySelectorAll('[data-crosshair-setting]').forEach(el => { el.disabled = busy || !state?.online || !state?.visible; });
  }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(SERVER + path, {
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Crosshair request failed.');
      return result;
    } finally { clearTimeout(timeout); }
  }
  async function refresh() {
    if (busy) return;
    if (statusRequest) return statusRequest;
    statusRequest = request('/api/crosshair').then(result => { state = result; render(); })
      .catch(e => { state = null; render(); if (dialog()?.open) message(e.message); })
      .finally(() => { statusRequest = null; });
    return statusRequest;
  }
  async function open() {
    if (!dialog().open) dialog().showModal();
    message('');
    await refresh();
  }
  async function apply(patch) {
    if (busy) return;
    busy = true;
    message('');
    render();
    try { state = await request('/api/crosshair', patch); }
    catch (e) {
      if (!dialog().open) dialog().showModal();
      message(e.name === 'AbortError' ? tr('crosshair_timeout', 'Game Bar did not respond. Open Win + G and try again.') : e.message);
      state = await request('/api/crosshair').catch(() => null);
    } finally { busy = false; render(); }
  }
  async function toggle() {
    if (busy || toggling) return;
    toggling = true;
    render();
    try {
      await refresh();
      if (!state?.online || !state?.visible) { await open(); return; }
      await apply({ enabled: !state.enabled });
    } finally { toggling = false; render(); }
  }
  async function openGameBar() {
    try { await request('/api/crosshair/open', {}); }
    catch (e) { message(e.message); }
  }
  function refreshVisible() {
    if (document.hidden) return;
    if (dialog()?.open || [...document.querySelectorAll('[data-crosshair-toggle]')].some(el => el.getClientRects().length)) refresh();
  }
  document.addEventListener('visibilitychange', refreshVisible);
  document.addEventListener('xenon:page-change', refreshVisible);
  setInterval(refreshVisible, 5000);
  refreshVisible();
  return { toggle, open, apply, openGameBar, close: () => dialog().close() };
})();
