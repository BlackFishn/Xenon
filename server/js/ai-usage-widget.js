'use strict';
(function () {
  const el = makeEl;
  const t = key => window.t(key);
  const names = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
  const states = new WeakMap();
  const layouts = ['auto', '1', '2', '3', '4', 'list'];
  function layoutKey(mount) {
    return 'xenon.aiusage.layout.' + (mount.closest('[data-dashboard-widget]')?.dataset.dashboardInstance || 'aiusage');
  }
  function readLayout(mount) {
    try { const v = localStorage.getItem(layoutKey(mount)); return layouts.includes(v) ? v : 'auto'; } catch { return 'auto'; }
  }
  function layoutControls(mount, state) {
    const box = el('details', 'aiu-layout');
    box.open = !!state.layoutOpen;
    box.addEventListener('toggle', () => { state.layoutOpen = box.open; });
    const summary = el('summary', 'aiu-icon-btn', '⋯');
    summary.setAttribute('aria-label', t('aiu_layout'));
    summary.dataset.aiuFocus = 'layout-menu';
    const panel = el('div', 'aiu-layout-options');
    const label = el('label', '', t('aiu_layout'));
    const select = el('select', 'aiu-layout-select');
    select.setAttribute('aria-label', t('aiu_layout'));
    select.dataset.aiuFocus = 'layout-select';
    for (const mode of layouts) {
      const option = el('option', '', t('aiu_layout_' + mode));
      option.value = mode; option.selected = state.layout === mode; select.append(option);
    }
    select.value = state.layout;
    select.addEventListener('change', () => {
      if (!layouts.includes(select.value)) return;
      state.layout = select.value;
      try { localStorage.setItem(layoutKey(mount), state.layout); state.saveFailed = false; } catch { state.saveFailed = true; }
      render(mount);
    });
    label.append(select); panel.append(label); box.append(summary, panel); return box;
  }
  let payload = null, loading = false, failed = false, lastFetch = 0;
  let activeTrend = null, trendId = 0;
  let connecting = false, connectionFailed = false;
  const count = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const money = n => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n || 0);
  const age = ms => {
    const mins = Math.max(1, Math.ceil(ms / 60000));
    if (mins < 60) return mins + 'm';
    const hours = Math.floor(mins / 60);
    return hours < 24 ? hours + 'h ' + mins % 60 + 'm' : Math.floor(hours / 24) + 'd ' + hours % 24 + 'h';
  };
  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="aiusage"]')).filter(n => n.closest('.pager-page'));
  }
  function visible() {
    return !document.hidden && tiles().some(n => n.getClientRects().length && !n.closest('.is-parked') && n.dataset.dashboardHidden !== 'true');
  }
  function button(text, className, action) {
    const b = el('button', className, text);
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  }
  function stat(label, value) {
    const node = el('div', 'aiu-stat');
    node.append(el('span', 'aiu-muted', label), el('strong', 'aiu-number', value));
    return node;
  }
  function quota(value, label) {
    const node = el('div', 'aiu-quota');
    const head = el('div', 'aiu-line');
    const expired = value && value.resetsAt > 0 && value.resetsAt * 1000 <= Date.now();
    const stale = value && (Date.now() - value.observedAt > 15 * 60000 || expired);
    const remaining = value ? Math.max(0, 100 - value.usedPercent) : null;
    head.append(el('span', '', label), el('strong', 'aiu-number', value && !expired ? Math.round(remaining) + '% ' + t('aiu_left') : '—'));
    const track = el('div', 'aiu-track');
    if (value && !expired) {
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', label + ' · ' + t('aiu_left'));
      track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(remaining)));
      const fill = el('div', 'aiu-fill');
      fill.style.width = remaining + '%';
      track.append(fill);
      if (remaining <= 10) node.classList.add('is-critical');
      else if (remaining <= 25) node.classList.add('is-low');
    } else track.classList.add('is-empty');
    const foot = el('div', 'aiu-line aiu-muted aiu-quota-foot');
    foot.append(el('span', '', !value ? t('aiu_no_data') : expired ? t('aiu_reset_pending') : stale ? t('aiu_old_reading') : Math.round(value.usedPercent) + '% ' + t('aiu_used')));
    const reset = el('span', 'aiu-reset');
    if (value && value.resetsAt > 0) {
      reset.dataset.aiuReset = String(value.resetsAt);
      reset.textContent = expired ? t('aiu_wait_update') : t('aiu_resets') + ' ' + age(value.resetsAt * 1000 - Date.now());
      reset.title = new Date(value.resetsAt * 1000).toLocaleString();
    }
    foot.append(reset);
    node.append(head, track, foot);
    return node;
  }
  function closeTrend() {
    if (!activeTrend) return;
    activeTrend.close();
    activeTrend = null;
  }
  function trend(provider) {
    const wrap = el('div', 'aiu-trend');
    const head = el('div', 'aiu-line aiu-muted');
    head.append(el('span', '', t('aiu_trend')), el('span', '', '30d'));
    const chart = el('div', 'aiu-bars');
    chart.setAttribute('role', 'group');
    chart.setAttribute('aria-label', names[provider.id] + ': ' + t('aiu_trend') + ', ' + count(provider.periods.month.tokens) + ' tokens');
    const tip = el('div', 'aiu-trend-tip');
    tip.id = 'aiu-trend-tip-' + ++trendId;
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    const slots = [];
    let selected = null;
    function show(day, slot, index) {
      const wasSelected = selected === slot;
      closeTrend();
      if (wasSelected) return;
      const date = new Date(day.day + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const total = stat(t('aiu_tokens'), new Intl.NumberFormat().format(day.tokens));
      const cost = el('div', 'aiu-line aiu-trend-tip-cost');
      cost.append(el('span', 'aiu-muted', t('aiu_equivalent')), el('strong', 'aiu-number', day.unpriced && !day.cost ? '—' : (day.unpriced ? '≥ ' : '≈ ') + money(day.cost)));
      tip.replaceChildren(el('strong', 'aiu-trend-tip-date', date), total, cost);
      if (day.unpriced) tip.append(el('span', 'aiu-trend-tip-note', t('aiu_partial')));
      tip.style.left = 'clamp(0px, calc(' + (index + .5) / slots.length * 100 + '% - 116px), max(0px, calc(100% - 232px)))';
      tip.style.top = '';
      tip.style.bottom = '';
      tip.style.transform = '';
      tip.hidden = false;
      selected = slot;
      slot.setAttribute('aria-expanded', 'true');
      slot.setAttribute('aria-describedby', tip.id);
      for (const item of slots) item.tabIndex = item === slot ? 0 : -1;
      wrap.classList.add('has-selection');
      // A scrolled chart may be near the tile's top edge. Keep its detail visible.
      const bounds = wrap.closest('.ai-usage-widget-mount').getBoundingClientRect();
      if (tip.getBoundingClientRect().top < bounds.top + 8) {
        tip.style.top = 'calc(100% + 8px)';
        tip.style.bottom = 'auto';
      }
      const box = tip.getBoundingClientRect();
      const shift = Math.max(bounds.top + 8 - box.top, Math.min(0, bounds.bottom - 8 - box.bottom));
      tip.style.transform = 'translateY(' + shift + 'px)';
      activeTrend = { wrap, close() {
        tip.hidden = true;
        selected.setAttribute('aria-expanded', 'false');
        selected.removeAttribute('aria-describedby');
        selected = null;
        wrap.classList.remove('has-selection');
      } };
    }
    const peak = Math.max(1, ...provider.daily.map(d => d.tokens));
    provider.daily.forEach((day, index) => {
      const slot = button('', 'aiu-bar-button', () => show(day, slot, index));
      slot.tabIndex = index === provider.daily.length - 1 ? 0 : -1;
      slot.dataset.aiuFocus = 'trend-' + provider.id + '-' + day.day;
      slot.setAttribute('aria-label', day.day + ' · ' + new Intl.NumberFormat().format(day.tokens) + ' tokens');
      slot.setAttribute('aria-expanded', 'false');
      slot.setAttribute('aria-controls', tip.id);
      slot.addEventListener('keydown', event => {
        const next = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(slots.length - 1, index + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? slots.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        slots[next].focus({ preventScroll: true });
        if (selected !== slots[next]) show(provider.daily[next], slots[next], next);
      });
      const bar = el('span', 'aiu-bar' + (day.tokens ? '' : ' is-zero'));
      bar.style.height = Math.max(4, day.tokens / peak * 100) + '%';
      bar.setAttribute('aria-hidden', 'true');
      slot.append(bar);
      slots.push(slot);
      chart.append(slot);
    });
    wrap.append(head, chart, tip);
    return wrap;
  }
  function claudeConnection(provider) {
    const status = provider.connection?.status || 'not_linked';
    const box = el('div', 'aiu-connection');
    box.append(el('strong', '', t('aiu_connection_' + status)));
    box.append(el('p', 'aiu-hint', t(status === 'waiting' ? 'aiu_claude_waiting' : status === 'unavailable' ? 'aiu_connection_retry' : 'aiu_claude_connect_hint')));
    if (status === 'not_linked') {
      const connect = button(t(connecting ? 'aiu_connecting' : 'aiu_connect_claude'), 'aiu-connect-btn', connectClaude);
      connect.disabled = connecting || loading;
      connect.dataset.aiuFocus = 'connect-claude';
      box.append(connect);
    }
    if (connectionFailed) box.append(el('p', 'aiu-warning', t('aiu_connect_failed')));
    return box;
  }
  function providerCard(provider, state) {
    const card = el('section', 'aiu-provider aiu-' + provider.id);
    card.setAttribute('aria-label', names[provider.id] + ' usage');
    const data = provider.periods[state.period];
    const head = el('div', 'aiu-provider-head');
    const mark = el('span', 'aiu-mark', provider.id === 'claude' ? '✳' : provider.id === 'codex' ? '⌘' : '›_');
    mark.setAttribute('aria-hidden', 'true');
    const title = el('div', 'aiu-provider-title');
    const name = el('div', 'aiu-line');
    name.append(el('h3', '', names[provider.id]));
    const plan = provider.limits.find(l => l.plan)?.plan;
    if (plan) name.append(el('span', 'aiu-plan', plan));
    const observed = Math.max(0, ...provider.limits.map(l => l.observedAt || 0));
    const source = el('span', 'aiu-source aiu-muted', observed ? t('aiu_observed') + ' ' + age(Date.now() - observed) + ' ' + t('aiu_ago') : t('aiu_local_history'));
    if (provider.connection?.source === 'local_cache') source.textContent = t('aiu_claude_cache') + ' · ' + source.textContent;
    if (provider.connection?.source === 'provider_api') source.textContent = t('aiu_provider_api') + ' · ' + source.textContent;
    if (observed) source.title = new Date(observed).toLocaleString();
    title.append(name, source);
    head.append(mark, title, el('strong', 'aiu-provider-cost aiu-number', provider.historyUnavailable || (data.unpriced && !data.cost) ? '—' : (data.unpriced ? '≥ ' : '≈ ') + money(data.cost)));
    card.append(head);
    const windows = provider.limits.flatMap(limit => limit.windows.map(w => ({ ...w, bucket: limit.id, bucketName: limit.name })));
    const main = windows.filter(w => w.bucket === provider.id);
    const quotas = el('div', 'aiu-quotas');
    for (const minutes of [300, 10080]) {
      const window = main.find(w => w.windowMinutes === minutes);
      quotas.append(quota(window, t(minutes === 300 ? 'aiu_session' : 'aiu_weekly')));
    }
    // Windows are classified by their duration, never by primary/secondary order.
    for (const w of main.filter(w => ![300, 10080].includes(w.windowMinutes))) {
      quotas.append(quota(w, w.windowMinutes ? age(w.windowMinutes * 60000) + ' ' + t('aiu_window') : t('aiu_other_window')));
    }
    card.append(quotas);
    if (!main.length) card.append(provider.id === 'claude' ? claudeConnection(provider) : el('p', 'aiu-hint', t(provider.id === 'opencode' ? 'aiu_opencode_hint' : 'aiu_codex_hint')));
    const liveStatus = provider.connection?.liveStatus;
    if (['sign_in_required', 'rate_limited', 'unavailable'].includes(liveStatus)) card.append(el('p', 'aiu-warning', t('aiu_live_' + liveStatus)));
    if (provider.incomplete) card.append(el('p', 'aiu-warning', t('aiu_incomplete')));
    if (!provider.found) card.append(el('p', 'aiu-hint', t('aiu_not_found')));
    if (provider.historyUnavailable) {
      card.append(el('p', 'aiu-hint', t('aiu_history_unavailable')));
      return card;
    }
    card.append(trend(provider));
    const details = el('details', 'aiu-details');
    details.open = !!state.open[provider.id];
    details.addEventListener('toggle', () => { state.open[provider.id] = details.open; });
    const summary = el('summary', '', t('aiu_details'));
    summary.dataset.aiuFocus = 'details-' + provider.id;
    details.append(summary);
    const metrics = el('div', 'aiu-metrics');
    metrics.append(stat(t('aiu_input'), count(data.input)), stat(t('aiu_output'), count(data.output)),
      stat(t('aiu_cache_read'), count(data.cacheRead)), stat(t('aiu_cache_write'), count(data.cacheWrite)));
    details.append(metrics);
    for (const w of windows.filter(w => w.bucket !== provider.id)) {
      details.append(quota(w, w.bucketName + (w.windowMinutes ? ' · ' + age(w.windowMinutes * 60000) : '')));
    }
    const extra = el('div', 'aiu-line aiu-extra');
    const credits = provider.limits.find(l => l.credits)?.credits;
    extra.append(el('span', 'aiu-muted', t('aiu_credits')),
      el('strong', 'aiu-number', credits?.unlimited ? t('aiu_unlimited') : credits?.balance != null ? count(credits.balance) + ' credits' : t('aiu_not_reported')));
    details.append(extra, el('div', 'aiu-model-heading aiu-muted', t('aiu_models')));
    for (const model of data.models) {
      const row = el('div', 'aiu-model');
      const modelName = el('span', '', model.model);
      modelName.title = model.model;
      row.append(modelName, el('span', 'aiu-muted aiu-number', count(model.tokens)),
        el('span', 'aiu-number', model.unpriced ? '—' : money(model.cost)));
      details.append(row);
    }
    if (!data.models.length) details.append(el('p', 'aiu-hint', t('aiu_no_activity')));
    if (data.unpriced) details.append(el('p', 'aiu-warning', t('aiu_unpriced')));
    card.append(details);
    return card;
  }
  function compactCard(provider, state) {
    const expanded = providerCard(provider, state);
    const row = el('details', 'aiu-provider aiu-' + provider.id + ' aiu-compact');
    row.open = !!state.open['list-' + provider.id];
    row.addEventListener('toggle', () => { state.open['list-' + provider.id] = row.open; });
    const summary = el('summary', 'aiu-compact-summary');
    summary.dataset.aiuFocus = 'list-' + provider.id;
    summary.setAttribute('aria-label', names[provider.id] + ' · ' + t('aiu_details'));
    const head = expanded.querySelector('.aiu-provider-head');
    const cost = head.querySelector('.aiu-provider-cost');
    cost.remove();
    summary.append(head);
    const windows = provider.limits.filter(l => l.id === provider.id).flatMap(l => l.windows);
    for (const [minutes, key] of [[300, 'aiu_session'], [10080, 'aiu_weekly'], [43200, 'aiu_monthly']]) {
      const value = windows.find(w => w.windowMinutes === minutes);
      const cell = quota(value, t(key));
      cell.classList.add('aiu-compact-quota');
      const reset = cell.querySelector('.aiu-reset');
      if (value && value.resetsAt * 1000 > Date.now()) {
        reset.dataset.aiuCompact = 'true';
        reset.textContent = '↻ ' + age(value.resetsAt * 1000 - Date.now());
      }
      summary.append(cell);
    }
    summary.append(cost, el('span', 'aiu-chevron', '›'));
    const warnings = expanded.querySelectorAll('.aiu-warning');
    if (warnings.length) {
      const warning = el('span', 'aiu-compact-alert', '!');
      warning.title = Array.from(warnings, n => n.textContent).join(' ');
      warning.setAttribute('aria-label', warning.title);
      head.append(warning);
    }
    const body = el('div', 'aiu-compact-body');
    for (const child of Array.from(expanded.children)) {
      if (child === head) continue;
      if (child.classList.contains('aiu-quotas') && !windows.some(w => ![300, 10080, 43200].includes(w.windowMinutes))) continue;
      if (child.classList.contains('aiu-details')) {
        for (const detail of Array.from(child.children)) if (detail.tagName !== 'SUMMARY') body.append(detail);
        continue;
      }
      body.append(child);
    }
    row.append(summary, body);
    return row;
  }
  // Only this widget's local text and CSS are captured, including scrolled content.
  async function capturePng(mount) {
    const source = mount.querySelector('.aiu-wrap');
    const feedback = source.querySelector('.aiu-copy-result');
    const width = source.offsetWidth;
    const height = source.scrollHeight - (feedback ? feedback.offsetHeight + parseFloat(getComputedStyle(feedback).marginBottom) : 0);
    if (!width || !height) throw new Error('Widget is not visible');
    const copy = source.cloneNode(true);
    const originals = [source, ...source.querySelectorAll('*')];
    const clones = [copy, ...copy.querySelectorAll('*')];
    originals.forEach((node, i) => {
      const style = getComputedStyle(node);
      for (const prop of style) {
        // Used values are resolved; omit theme variables and external assets.
        const value = style.getPropertyValue(prop);
        if (!prop.startsWith('--') && !value.includes('url(')) clones[i].style.setProperty(prop, value);
      }
      clones[i].style.transition = 'none';
      clones[i].style.animation = 'none';
      clones[i].style.caretColor = 'transparent';
      clones[i].style.outline = 'none';
    });
    for (const node of copy.querySelectorAll('.aiu-controls')) node.style.display = 'none';
    for (const node of copy.querySelectorAll('.aiu-copy-result')) node.style.display = 'none';
    // Pseudo-elements do not belong to the cloned DOM.
    for (const summary of copy.querySelectorAll('summary')) {
      summary.append(el('span', '', summary.parentNode.open ? '−' : '+'));
    }
    const background = getComputedStyle(source).getPropertyValue('--panel-solid').trim()
      || getComputedStyle(source).getPropertyValue('--bg').trim() || '#151a20';
    copy.style.background = background;
    copy.style.boxSizing = 'border-box';
    copy.style.width = width + 'px';
    copy.style.height = height + 'px';
    copy.style.borderRadius = '18px';
    copy.style.overflow = 'hidden';
    const markup = new XMLSerializer().serializeToString(copy);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height
      + '"><foreignObject width="100%" height="100%">' + markup + '</foreignObject></svg>';
    const img = new Image();
    // A self-contained data URL keeps foreignObject rendering origin-clean.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(2, 8192 / width, 16384 / height, Math.sqrt(16000000 / (width * height)));
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob); else reject(new Error('Image encoding failed'));
    }, 'image/png'));
  }
  async function copyImage(mount) {
    const state = states.get(mount);
    if (!payload || state.copying) return;
    state.copying = true; state.copyResult = null; render(mount);
    try {
      if (!navigator.clipboard?.write || typeof window.ClipboardItem !== 'function') {
        state.copyResult = 'aiu_copy_unavailable';
        return;
      }
      const png = capturePng(mount);
      // A denial can happen before the clipboard consumes the PNG promise.
      png.catch(() => {});
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png })]);
      state.copyResult = 'aiu_copied';
    } catch { state.copyResult = 'aiu_copy_failed'; }
    finally { state.copying = false; render(mount); }
  }
  function render(mount) {
    if (activeTrend && mount.contains(activeTrend.wrap)) closeTrend();
    let state = states.get(mount);
    if (!state) { state = { period: 'today', open: {}, layout: readLayout(mount) }; states.set(mount, state); }
    const scroll = mount.scrollTop;
    const focus = mount.contains(document.activeElement) ? document.activeElement.dataset.aiuFocus : null;
    const wrap = el('div', 'aiu-wrap');
    wrap.dataset.layout = state.layout;
    const head = el('div', 'aiu-header');
    const title = el('div', 'aiu-title');
    title.append(el('span', 'aiu-eyebrow', 'WORKSPACE / INSIGHTS'), el('h2', '', 'AI Usage'));
    const controls = el('div', 'aiu-controls');
    controls.append(el('span', 'aiu-local', t('aiu_local')));
    const refresh = button('', 'aiu-icon-btn aiu-refresh-btn', () => fetchUsage(true));
    refresh.append(el('span', 'aiu-refresh-icon', '↻'), el('span', 'aiu-refresh-label', t(loading ? 'aiu_refreshing' : 'aiu_refresh_short')));
    refresh.title = t('aiu_refresh'); refresh.setAttribute('aria-label', refresh.title);
    refresh.dataset.aiuFocus = 'refresh'; refresh.disabled = loading || connecting;
    const copy = button('', 'aiu-icon-btn aiu-copy-btn', () => copyImage(mount));
    const camera = el('span', 'aiu-camera');
    camera.setAttribute('aria-hidden', 'true');
    copy.append(camera);
    copy.title = t(state.copying ? 'aiu_copying' : 'aiu_copy_image');
    copy.setAttribute('aria-label', copy.title);
    copy.dataset.aiuFocus = 'copy-image'; copy.disabled = !payload || !!state.copying;
    controls.append(copy, refresh, layoutControls(mount, state)); head.append(title, controls); wrap.append(head);
    if (state.copying || state.copyResult) {
      const feedback = el('div', 'aiu-copy-result' + (state.copyResult && state.copyResult !== 'aiu_copied' ? ' is-failed' : ''),
        t(state.copying ? 'aiu_copying' : state.copyResult));
      feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
      wrap.append(feedback);
    }
    const periods = el('div', 'aiu-periods');
    periods.setAttribute('role', 'group'); periods.setAttribute('aria-label', t('aiu_period'));
    for (const period of ['today', 'yesterday', 'month']) {
      const b = button(t('aiu_' + period), 'aiu-period', () => { state.period = period; render(mount); });
      b.setAttribute('aria-pressed', String(state.period === period)); b.dataset.aiuFocus = period;
      periods.append(b);
    }
    wrap.append(periods);
    if (state.saveFailed) wrap.append(el('p', 'aiu-warning', t('aiu_layout_save_failed')));
    if (failed) {
      const error = el('div', 'aiu-warning', t(payload ? 'aiu_refresh_failed' : 'aiu_load_failed'));
      error.setAttribute('role', 'status'); wrap.append(error);
    }
    if (!payload) wrap.append(el('div', 'aiu-loading', t(loading ? 'aiu_loading' : 'aiu_no_data')));
    else {
      const providers = payload.providers;
      const total = providers.reduce((sum, p) => sum + p.periods[state.period].cost, 0);
      const tokens = providers.reduce((sum, p) => sum + p.periods[state.period].tokens, 0);
      const cached = providers.reduce((sum, p) => sum + p.periods[state.period].cacheRead, 0);
      const input = providers.reduce((sum, p) => { const d = p.periods[state.period]; return sum + d.input + d.cacheRead + d.cacheWrite; }, 0);
      const partial = providers.some(p => p.historyUnavailable || p.periods[state.period].unpriced || p.incomplete);
      const grid = el('div', 'aiu-grid');
      const overview = el('section', 'aiu-overview');
      const cost = el('div', 'aiu-cost-view');
      const ring = el('div', 'aiu-ring');
      let share = 0;
      const stops = providers.map(p => {
        const start = share;
        share += total ? p.periods[state.period].cost / total * 100 : 0;
        return 'var(--aiu-' + p.id + ') ' + start + '% ' + share + '%';
      });
      if (total) ring.style.background = 'conic-gradient(from -90deg, ' + stops.join(', ') + ')';
      if (!total) ring.classList.add('is-empty');
      ring.setAttribute('role', 'img'); ring.setAttribute('aria-label', t('aiu_equivalent') + ': ' + (partial ? t('aiu_partial') + ' ' : '') + money(total));
      const center = el('div', 'aiu-ring-center');
      const totalLabel = partial && !total ? '—' : money(total);
      const totalNode = el('strong', 'aiu-total aiu-number', totalLabel);
      totalNode.style.setProperty('--aiu-digits', String(Math.max(1, Array.from(totalLabel).length)));
      totalNode.title = totalLabel;
      center.append(el('span', 'aiu-muted', t('aiu_' + state.period)), totalNode, el('span', 'aiu-currency', partial ? t('aiu_partial') : 'USD / EST.'));
      ring.append(center);
      const legend = el('div', 'aiu-legend');
      legend.append(el('span', 'aiu-section-label', t('aiu_equivalent')));
      for (const p of providers) {
        const line = el('div', 'aiu-legend-row aiu-' + p.id);
        const d = p.periods[state.period];
        line.append(el('i', 'aiu-dot'), el('span', '', names[p.id]), el('strong', 'aiu-number', p.historyUnavailable || (d.unpriced && !d.cost) ? '—' : money(d.cost)));
        legend.append(line);
      }
      cost.append(ring, legend); overview.append(cost);
      const metrics = el('div', 'aiu-overview-metrics');
      metrics.append(stat(t('aiu_tokens'), count(tokens)), stat(t('aiu_cache_hit'), input ? Math.round(cached / input * 100) + '%' : '—'));
      overview.append(metrics, el('p', 'aiu-estimate-note', t('aiu_estimate_note')));
      grid.append(overview);
      const cards = el('div', 'aiu-providers');
      cards.style.setProperty('--aiu-columns', state.layout === 'auto' ? '4' : state.layout === 'list' ? '1' : state.layout);
      for (const p of providers) cards.append(state.layout === 'list' ? compactCard(p, state) : providerCard(p, state));
      grid.append(cards);
      wrap.append(grid);
      const foot = el('div', 'aiu-footer');
      foot.append(el('span', '', t('aiu_checked') + ' ' + new Date(payload.checkedAt || payload.generatedAt).toLocaleTimeString([], timeParts({ second: '2-digit' }))),
        el('span', '', (payload.timeZone || '') + ' · 60s'));
      wrap.append(foot);
    }
    mount.setAttribute('aria-busy', String(loading));
    mount.replaceChildren(wrap);
    mount.scrollTop = scroll;
    if (focus) Array.from(mount.querySelectorAll('[data-aiu-focus]')).find(n => n.dataset.aiuFocus === focus)?.focus({ preventScroll: true });
  }
  function paint() {
    for (const tile of tiles()) {
      const mount = tile.querySelector('.ai-usage-widget-mount');
      if (mount) render(mount);
    }
  }
  async function connectClaude() {
    if (connecting) return;
    connecting = true; connectionFailed = false; paint();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/claude/link-usage', { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error('Connection failed');
      const data = await response.json();
      if (!data.ok || !data.usageLinked) throw new Error('Connection failed');
      await fetchUsage(true);
    } catch { connectionFailed = true; }
    finally { clearTimeout(timeout); connecting = false; paint(); }
  }
  async function fetchUsage(manual = false) {
    if (loading || (connecting && !manual)) return;
    loading = true; lastFetch = Date.now(); paint();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/ai-usage' + (manual ? '?refresh=1' : ''), { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Usage unavailable');
      const data = await response.json();
      if (!Array.isArray(data.providers) || !data.providers.length || data.providers.some(p => !p || !Object.hasOwn(names, p.id)) || new Set(data.providers.map(p => p.id)).size !== data.providers.length) throw new Error('Invalid usage');
      payload = data; failed = false;
    } catch { failed = true; }
    finally { clearTimeout(timeout); loading = false; paint(); }
  }
  function renderWidgets() {
    paint();
    if (visible() && Date.now() - lastFetch >= 60000) fetchUsage();
  }
  // No file scans while the tile is absent, parked, or the browser is hidden.
  setInterval(() => {
    if (!visible()) return;
    if (Date.now() - lastFetch >= 60000) { fetchUsage(); return; }
    for (const tile of tiles()) for (const reset of tile.querySelectorAll('[data-aiu-reset]')) {
      const left = Number(reset.dataset.aiuReset) * 1000 - Date.now();
      if (left <= 0 && reset.textContent !== t('aiu_wait_update')) { paint(); return; }
      reset.textContent = left > 0 ? (reset.dataset.aiuCompact ? '↻' : t('aiu_resets')) + ' ' + age(left) : t('aiu_wait_update');
    }
  }, 15000);
  document.addEventListener('visibilitychange', () => { if (visible()) renderWidgets(); });
  document.addEventListener('pointerdown', event => {
    if (activeTrend && !activeTrend.wrap.contains(event.target)) closeTrend();
  });
  document.addEventListener('focusin', event => {
    if (activeTrend && !activeTrend.wrap.contains(event.target)) closeTrend();
  });
  document.addEventListener('keydown', event => {
    if (activeTrend && event.key === 'Escape') { closeTrend(); event.preventDefault(); }
  });
  document.addEventListener('scroll', closeTrend, true);
  window.addEventListener('resize', closeTrend);
  window.AIUsageWidget = { renderWidgets };
})();
