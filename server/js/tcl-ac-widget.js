'use strict';
// Dedicated TCL AC dashboard widget. It shares HA transport, never Smart Home's
// selection, layout or renderer. Mounted cards survive every SSE state update.
(function () {
  const TCL = window.Xenon && window.Xenon.tclAc;
  if (!TCL) return;
  const el = makeEl;
  const t = (key, fallback) => {
    const value = typeof window.t === 'function' ? window.t(key) : key;
    return value === key && fallback != null ? fallback : value;
  };
  const prettify = (value) => { const text = String(value ?? '').replace(/_/g, ' ').trim(); return text ? text[0].toUpperCase() + text.slice(1) : text; };
  const fmtNum = (value) => String(Math.round(Number(value) * 10) / 10);
  const fmtHvac = (mode) => t('smarthome_hvac_' + mode, prettify(mode));
  let state = { configured: false, connected: false, entities: [] };
  let seedInFlight = false;
  let stateVersion = 0;
  const mounted = new WeakSet();
  const entityById = (id) => state.entities.find((entity) => entity.id === id);

  // Command state belongs to the device, shared across duplicated dashboard tiles.
  const ac = { pending: null, uncertain: false, refreshing: false, error: '', lastMode: null, expanded: false };
  function acText(key, fallback) {
    const value = t('smarthome_ac_' + key);
    return value === 'smarthome_ac_' + key ? fallback : value;
  }
  function acEntities() { return state.entities.filter((e) => TCL.ids.includes(e.id)); }
  function acClimate() { return entityById(TCL.profile.climate); }
  function acOnline() { return state.connected && TCL.available(acClimate()); }
  function acBusy() { return !acOnline() || !!ac.pending || ac.uncertain || ac.refreshing; }
  function updateAcCards() {
    document.querySelectorAll('.sh-tcl-ac').forEach((card) => { if (card._updateAc) card._updateAc(); });
  }
  function reconcileAc() {
    if (!TCL) return;
    const climate = acClimate();
    if (acOnline() && climate.state !== 'off' && TCL.modes(climate).includes(climate.state)) ac.lastMode = climate.state;
    const p = ac.pending;
    const e = p && entityById(p.id);
    if (p && p.ack && acOnline() && TCL.available(e) && e[p.property] === p.value) {
      clearTimeout(p.timer); ac.pending = null; ac.error = '';
    }
  }
  async function acRequest(path, options) {
    const response = await fetchWithDeadline(path, 12000, options);
    const result = await response.json();
    if (!response.ok || !result || result.ok === false) throw new Error((result && result.error) || 'HTTP ' + response.status);
    return result;
  }
  async function refreshAc() {
    if (ac.refreshing || ac.pending) return;
    ac.refreshing = true; updateAcCards();
    const version = stateVersion;
    try {
      const result = await acRequest('/api/homeassistant/state?refresh=1');
      if (version === stateVersion) onSSE(result);
      if (!acOnline()) throw new Error(acText('unavailable', 'Air conditioner unavailable'));
      ac.uncertain = false; ac.error = '';
    } catch (error) { ac.error = error.message; }
    finally { ac.refreshing = false; updateAcCards(); }
  }
  async function sendAc(id, service, data) {
    if (acBusy()) return;
    const domain = id.split('.')[0];
    const error = TCL.validate(domain, service, id, data, acEntities());
    if (error) { ac.error = error; updateAcCards(); return; }
    const property = service === 'set_temperature' ? 'target' : 'state';
    const value = data.temperature ?? data.hvac_mode ?? data.option ?? (service === 'turn_on' ? 'on' : 'off');
    if (entityById(id)[property] === value) return;
    const pending = { id, property, value, ack: false, timer: null };
    ac.pending = pending; ac.error = ''; updateAcCards();
    try {
      await acRequest('/api/homeassistant/service', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, service, entityId: id, data, profile: 'tcl-ac' }),
      });
      pending.ack = true;
      reconcileAc();
      if (ac.pending === pending) pending.timer = setTimeout(() => {
        if (ac.pending !== pending) return;
        ac.pending = null; ac.uncertain = true;
        ac.error = acText('unconfirmed', 'No matching state from Home Assistant. Refresh before retrying.');
        updateAcCards();
      }, 18000);
    } catch (error) {
      ac.pending = null; ac.uncertain = true;
      ac.error = acText('failed', 'Command failed or unconfirmed. Refresh before retrying.') + ' ' + error.message;
    }
    updateAcCards();
  }

  function buildAcCard() {
    const card = el('div', 'sh-tcl-ac');
    card.setAttribute('aria-label', 'TCL ' + acText('controls', 'air conditioner'));
    const header = el('div', 'sh-ac-header');
    const heading = el('div');
    const title = el('strong', 'sh-ac-title');
    heading.append(title, el('div', 'sh-ac-caption', 'TCL Home'));
    const button = (label, action, name) => {
      const b = el('button', 'sh-ac-button', label); b.type = 'button';
      b.dataset.acControl = name; b.addEventListener('click', action); return b;
    };
    const power = button('', () => {
      const climate = acClimate(), modes = TCL.modes(climate);
      const mode = climate.state !== 'off' ? 'off' : modes.includes(ac.lastMode) ? ac.lastMode : modes.includes('cool') ? 'cool' : modes.find((m) => m !== 'off');
      sendAc(TCL.profile.climate, 'set_hvac_mode', { hvac_mode: mode });
    }, 'power');
    header.append(heading, power);
    const thermo = el('div', 'sh-ac-thermo');
    const temperature = el('div', 'sh-ac-temperature');
    const target = el('strong'), unit = el('small'); temperature.append(target, unit);
    const step = (direction) => {
      const range = TCL.temperature(acClimate());
      if (range.usable) sendAc(TCL.profile.climate, 'set_temperature', {
        temperature: Number(Math.min(range.max, Math.max(range.min, range.target + direction * range.step)).toFixed(4)),
      });
    };
    const minus = button('−', () => step(-1), 'minus'), plus = button('+', () => step(1), 'plus');
    minus.setAttribute('aria-label', acText('decrease', 'Decrease target temperature'));
    plus.setAttribute('aria-label', acText('increase', 'Increase target temperature'));
    thermo.append(minus, temperature, plus);
    const room = el('div', 'sh-ac-room'), status = el('div', 'sh-ac-state');
    const modes = el('div', 'sh-ac-modes'); modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', acText('mode', 'AC mode'));
    const main = el('div', 'sh-ac-fields'), extra = el('div', 'sh-ac-fields sh-ac-extra');
    const fields = new Map();
    const labels = { fan: 'Fan speed', vertical: 'Vertical swing', horizontal: 'Horizontal swing', sleep: 'Sleep mode', eco: 'ECO', soft: 'Soft wind', display: 'Display light', beep: 'Beep' };
    for (const field of ['fan', 'vertical', 'horizontal', 'eco', 'soft', 'sleep', 'display', 'beep']) {
      const id = TCL.profile[field], label = acText(field, labels[field]);
      const parent = ['sleep', 'display', 'beep'].includes(field) ? extra : main;
      if (id.startsWith('select.')) {
        const row = el('label', 'sh-ac-field'), select = el('select'); select.dataset.acControl = field;
        select.setAttribute('aria-label', label);
        select.addEventListener('change', () => sendAc(id, 'select_option', { option: select.value }));
        row.append(el('span', '', label), select); parent.append(row); fields.set(field, select);
      } else {
        const toggle = button(label, () => {
          const e = entityById(id);
          if (e) sendAc(id, e.state === 'on' ? 'turn_off' : 'turn_on', {});
        }, field);
        parent.append(toggle); fields.set(field, toggle);
      }
    }
    const more = button(acText('more', 'More settings'), () => { ac.expanded = !ac.expanded; updateAcCards(); }, 'more');
    more.classList.add('sh-ac-more');
    const busy = el('div', 'sh-ac-feedback'); busy.setAttribute('role', 'status');
    const error = el('div', 'sh-ac-error'); error.setAttribute('role', 'alert');
    const refresh = button(acText('refresh', 'Refresh state'), refreshAc, 'refresh');
    card.append(header, el('div', 'sh-ac-caption sh-ac-center', acText('target', 'Target temperature')), thermo, room, status, modes, main, more, extra, busy, error, refresh);
    card._updateAc = () => {
      const climate = acClimate(), online = acOnline(), blocked = acBusy(), supported = TCL.modes(climate);
      const range = TCL.temperature(climate), on = online && climate.state !== 'off';
      title.textContent = TCL.title;
      title.title = climate ? climate.name : TCL.profile.climate;
      card.classList.toggle('is-offline', !online);
      power.textContent = on ? t('smarthome_on', 'On') : t('smarthome_off', 'Off');
      power.setAttribute('aria-pressed', String(on));
      power.setAttribute('aria-label', on ? acText('power_off', 'Turn AC off') : acText('power_on', 'Turn AC on'));
      power.disabled = blocked || (on ? !supported.includes('off') : !supported.some((m) => m !== 'off'));
      target.textContent = online && Number.isFinite(climate.target) ? fmtNum(climate.target) : '—';
      const sensor = entityById(TCL.profile.current);
      const unitText = (climate && climate.unit) || (sensor && sensor.unit) || '';
      unit.textContent = unitText;
      const current = online && Number.isFinite(climate.current) ? climate.current
        : online && TCL.available(sensor) && sensor.state.trim() !== '' ? Number(sensor.state) : NaN;
      room.textContent = acText('room', 'Room temperature') + ' · ' + (Number.isFinite(current) ? fmtNum(current) : '—') + ' ' + unitText;
      status.textContent = !state.configured ? acText('setup', 'Connect Home Assistant in Settings → Smart Home')
        : online ? fmtHvac(climate.state) : acText('unavailable', 'Air conditioner unavailable');
      minus.disabled = blocked || !range.usable || range.target - range.step < range.min;
      plus.disabled = blocked || !range.usable || range.target + range.step > range.max;
      const signature = supported.filter((m) => m !== 'off').join('|');
      if (modes.dataset.options !== signature) {
        modes.dataset.options = signature; modes.replaceChildren();
        supported.filter((m) => m !== 'off').forEach((mode) => {
          const b = button(fmtHvac(mode), () => sendAc(TCL.profile.climate, 'set_hvac_mode', { hvac_mode: mode }), mode);
          modes.append(b);
        });
      }
      for (const b of modes.children) { b.disabled = blocked; b.setAttribute('aria-pressed', String(online && b.dataset.acControl === climate.state)); }
      for (const [field, control] of fields) {
        const e = entityById(TCL.profile[field]), available = TCL.available(e);
        control.disabled = blocked || !available;
        control.title = available ? e.state : acText('unavailable_control', 'Control unavailable');
        if (control.tagName === 'SELECT') {
          const options = available && Array.isArray(e.options) ? e.options : [];
          const signature = JSON.stringify(options);
          if (control.dataset.options !== signature) {
            control.dataset.options = signature;
            const unknown = el('option', '', '—'); unknown.value = ''; unknown.disabled = true;
            control.replaceChildren(unknown, ...options.map((raw) => { const o = el('option', '', prettify(raw)); o.value = raw; return o; }));
          }
          control.value = available && options.includes(e.state) ? e.state : '';
          control.disabled = control.disabled || !options.length;
        } else {
          control.setAttribute('aria-pressed', String(available && e.state === 'on'));
          control.disabled = control.disabled || !['on', 'off'].includes(e && e.state);
        }
      }
      more.setAttribute('aria-expanded', String(ac.expanded)); extra.hidden = !ac.expanded;
      busy.textContent = ac.refreshing ? acText('refreshing', 'Refreshing state…') : ac.pending
        ? ac.pending.ack ? acText('waiting', 'Waiting for Home Assistant confirmation…') : acText('sending', 'Sending command…') : '';
      busy.hidden = !busy.textContent; error.textContent = ac.error; error.hidden = !ac.error;
      refresh.hidden = !ac.uncertain; refresh.disabled = ac.refreshing || !!ac.pending;
    };
    card._updateAc(); return card;
  }

  function mounts() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="tcl-ac"] .tcl-ac-widget-mount'))
      .filter((mount) => mount.closest('.pager-page'));
  }

  function onSSE(data) {
    if (!data || typeof data !== 'object') return;
    stateVersion++;
    state = { configured: !!data.configured, connected: !!data.connected, entities: Array.isArray(data.tclAc) ? data.tclAc : [] };
    reconcileAc();
    updateAcCards();
  }

  function disconnected() {
    stateVersion++;
    state.connected = false;
    updateAcCards();
  }

  async function seed() {
    if (seedInFlight) return;
    seedInFlight = true;
    const version = stateVersion;
    try {
      const snapshot = await acRequest('/api/homeassistant/state');
      if (version === stateVersion) onSSE(snapshot);
    }
    catch (error) {
      if (version === stateVersion) { disconnected(); ac.error = error.message; ac.uncertain = true; updateAcCards(); }
    }
    finally { seedInFlight = false; }
  }

  function scan() {
    let added = false;
    for (const mount of mounts()) {
      if (mounted.has(mount) && mount.firstChild) continue;
      // Dashboard duplication clones markup, not listeners or element properties.
      mount.replaceChildren(buildAcCard()); mounted.add(mount); added = true;
    }
    if (added) seed();
  }

  function renderWidgets() {
    let added = false;
    for (const mount of mounts()) {
      if (!mounted.has(mount)) added = true;
      const focused = mount.contains(document.activeElement) && document.activeElement.dataset.acControl;
      mount.replaceChildren(buildAcCard());
      mounted.add(mount);
      if (focused) {
        const next = Array.from(mount.querySelectorAll('[data-ac-control]')).find((node) => node.dataset.acControl === focused);
        if (next && !next.disabled) next.focus({ preventScroll: true });
      }
    }
    if (added) seed();
  }

  function init() {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    }).observe(document.body, { childList: true, subtree: true });
    scan();
  }
  window.TclAcWidget = { onSSE, disconnected, renderWidgets };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
