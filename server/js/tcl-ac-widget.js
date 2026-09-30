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
    const card = el('div', 'sh-wrap sh-tcl-ac');
    card.setAttribute('aria-label', 'TCL ' + acText('controls', 'air conditioner'));
    const icons = {
      climate: '<path d="M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0Z"/><path d="M12 13V8"/>',
      ac: '<rect x="3" y="4" width="18" height="9" rx="2"/><path d="M6 10h12M8 16v4M12 16v2M16 16v4"/>',
      fan: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-6 3-6s2 3-1 5M14 12c4 0 6 1 6 3s-3 2-5-1M12 14c0 4-1 6-3 6s-2-3 1-5M10 12c-4 0-6-1-6-3s3-2 5 1"/>',
      vertical: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
      horizontal: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
      eco: '<path d="M20 4C10 3 4 7 5 14c1 7 12 7 15-10ZM5 20l9-10"/>',
      soft: '<path d="M3 8h12a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h5"/>',
      sleep: '<path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z"/>',
      display: '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8M12 18v3"/>',
      beep: '<path d="m11 4-5 4H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
      chevron: '<path d="m8 10 4 4 4-4"/>',
    };
    const icon = (name, className = 'sh-item-ico') => {
      const node = el('span', className); node.setAttribute('aria-hidden', 'true');
      node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + icons[name] + '</svg>';
      return node;
    };
    const header = el('div', 'sh-head'), brand = el('div', 'sh-brand'), connection = el('span', 'sh-pill');
    brand.append(icon('ac', 'sh-logo'), el('span', 'sh-title', t('layout_widget_tcl-ac', 'TCL Air Conditioner')));
    header.append(brand, connection);
    const board = el('div', 'sh-board sh-ac-board');
    const section = (label, content) => {
      const group = el('div', 'sh-custom-section');
      group.append(el('div', 'sh-custom-section-title', label), content); return group;
    };
    const button = (label, action, name) => {
      const b = el('button', 'sh-ac-button', label); b.type = 'button';
      b.dataset.acControl = name; b.addEventListener('click', action); return b;
    };
    const toggleContents = (toggle, name, label) => {
      toggle.classList.add('sh-item', 'sh-item--toggle');
      const body = el('span', 'sh-item-body'), caption = el('span', 'sh-item-sub');
      body.append(el('span', 'sh-item-name', label), caption);
      const knob = el('span', 'sh-switch'); knob.setAttribute('aria-hidden', 'true');
      toggle.append(icon(name), body, knob); return caption;
    };
    const power = button('', () => {
      const climate = acClimate(), modes = TCL.modes(climate);
      const mode = climate.state !== 'off' ? 'off' : modes.includes(ac.lastMode) ? ac.lastMode : modes.includes('cool') ? 'cool' : modes.find((m) => m !== 'off');
      sendAc(TCL.profile.climate, 'set_hvac_mode', { hvac_mode: mode });
    }, 'power');
    const status = toggleContents(power, 'ac', TCL.title);
    const readings = el('div', 'sh-ac-readings');
    const setpoint = el('div', 'sh-item sh-item--value sh-ac-setpoint');
    setpoint.append(el('span', 'sh-item-name', acText('target', 'Target temperature')));
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
    minus.classList.add('sh-icobtn'); plus.classList.add('sh-icobtn');
    thermo.append(temperature, minus, plus); setpoint.append(thermo);
    const roomTile = el('div', 'sh-item sh-item--value sh-ac-room-tile'), room = el('div', 'sh-ac-room sh-item-val');
    roomTile.append(icon('climate'), room, el('span', 'sh-item-name', acText('room', 'Room temperature')));
    readings.append(setpoint, roomTile);
    const modes = el('div', 'sh-seg sh-ac-modes'); modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', acText('mode', 'AC mode'));
    const main = el('div', 'sh-ac-fields sh-ac-airflow'), comfort = el('div', 'sh-ac-fields'), extra = el('div', 'sh-ac-fields sh-ac-extra');
    const fields = new Map();
    const captions = new Map();
    const labels = { fan: 'Fan speed', vertical: 'Vertical swing', horizontal: 'Horizontal swing', sleep: 'Sleep mode', eco: 'ECO', soft: 'Soft wind', display: 'Display light', beep: 'Beep' };
    for (const field of ['fan', 'vertical', 'horizontal', 'eco', 'soft', 'sleep', 'display', 'beep']) {
      const id = TCL.profile[field], label = acText(field, labels[field]);
      const parent = ['sleep', 'display', 'beep'].includes(field) ? extra : ['eco', 'soft'].includes(field) ? comfort : main;
      if (id.startsWith('select.')) {
        const row = el('label', 'sh-item sh-ac-field'), body = el('span', 'sh-item-body'), select = el('select'); select.dataset.acControl = field;
        if (field === 'fan' || field === 'sleep') row.classList.add('sh-ac-wide');
        select.setAttribute('aria-label', label);
        select.addEventListener('change', () => sendAc(id, 'select_option', { option: select.value }));
        body.append(el('span', 'sh-item-sub', label), select);
        row.append(icon(field), body, icon('chevron', 'sh-ac-chevron')); parent.append(row); fields.set(field, select);
      } else {
        const toggle = button('', () => {
          const e = entityById(id);
          if (e) sendAc(id, e.state === 'on' ? 'turn_off' : 'turn_on', {});
        }, field);
        captions.set(field, toggleContents(toggle, field, label));
        parent.append(toggle); fields.set(field, toggle);
      }
    }
    const more = button(acText('more', 'More settings'), () => { ac.expanded = !ac.expanded; updateAcCards(); }, 'more');
    more.classList.add('sh-ac-more'); more.append(icon('chevron', 'sh-ac-chevron'));
    const busy = el('div', 'sh-ac-feedback'); busy.setAttribute('role', 'status');
    const error = el('div', 'sh-ac-error'); error.setAttribute('role', 'alert');
    const refresh = button(acText('refresh', 'Refresh state'), refreshAc, 'refresh');
    refresh.classList.add('sh-chip');
    board.append(power, readings, section(acText('mode', 'AC mode'), modes), section(acText('airflow', 'Airflow'), main), section(acText('comfort', 'Comfort'), comfort), more, extra, busy, error, refresh);
    card.append(header, board);
    card._updateAc = () => {
      const climate = acClimate(), online = acOnline(), blocked = acBusy(), supported = TCL.modes(climate);
      const range = TCL.temperature(climate), on = online && climate.state !== 'off';
      power.title = climate ? climate.name : TCL.profile.climate;
      connection.classList.toggle('on', online);
      connection.title = online ? t('online', 'Online') : acText('unavailable', 'Air conditioner unavailable');
      connection.setAttribute('aria-label', connection.title);
      card.classList.toggle('is-offline', !online);
      power.classList.toggle('is-on', on);
      power.setAttribute('aria-pressed', String(on));
      power.setAttribute('aria-label', on ? acText('power_off', 'Turn AC off') : acText('power_on', 'Turn AC on'));
      power.disabled = blocked || (on ? !supported.includes('off') : !supported.some((m) => m !== 'off'));
      target.textContent = online && Number.isFinite(climate.target) ? fmtNum(climate.target) : '—';
      const sensor = entityById(TCL.profile.current);
      const unitText = (climate && climate.unit) || (sensor && sensor.unit) || '';
      unit.textContent = unitText;
      const current = online && Number.isFinite(climate.current) ? climate.current
        : online && TCL.available(sensor) && sensor.state.trim() !== '' ? Number(sensor.state) : NaN;
      room.replaceChildren(document.createTextNode(Number.isFinite(current) ? fmtNum(current) : '—'), el('small', 'sh-item-unit', unitText));
      status.textContent = !state.configured ? acText('setup', 'Connect Home Assistant in Settings → Smart Home')
        : online ? fmtHvac(climate.state) : acText('unavailable', 'Air conditioner unavailable');
      minus.disabled = blocked || !range.usable || range.target - range.step < range.min;
      plus.disabled = blocked || !range.usable || range.target + range.step > range.max;
      const signature = supported.filter((m) => m !== 'off').join('|');
      if (modes.dataset.options !== signature) {
        modes.dataset.options = signature; modes.replaceChildren();
        supported.filter((m) => m !== 'off').forEach((mode) => {
          const b = button(fmtHvac(mode), () => sendAc(TCL.profile.climate, 'set_hvac_mode', { hvac_mode: mode }), mode);
          b.classList.add('sh-seg-btn');
          modes.append(b);
        });
      }
      for (const b of modes.children) {
        const active = online && b.dataset.acControl === climate.state;
        b.disabled = blocked; b.setAttribute('aria-pressed', String(active)); b.classList.toggle('is-active', active);
      }
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
          const active = available && e.state === 'on';
          control.setAttribute('aria-pressed', String(active)); control.classList.toggle('is-on', active);
          captions.get(field).textContent = available ? active ? t('smarthome_on', 'On') : t('smarthome_off', 'Off') : acText('unavailable_control', 'Control unavailable');
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
