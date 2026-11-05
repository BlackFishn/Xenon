'use strict';
(function () {
  const el = makeEl;
  const t = key => window.t(key);
  const names = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };
  // Each provider's own mark, monochrome and drawn in its accent colour.
  // Shapes from OpenUsage's ProviderIcons (MIT, docs/licenses/openusage.txt);
  // the marks themselves belong to Anthropic, OpenAI and xAI. Inline rather
  // than files so currentColor works and the copied image keeps them.
  const LOGOS = {
    claude: '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path fill="currentColor" d="M25.7146 63.2153L41.4393 54.3917L41.7025 53.6226L41.4393 53.1976H40.6705L38.0394 53.0359L29.054 52.7929L21.2624 52.4691L13.7134 52.0644L11.8111 51.6594L10.0303 49.3118L10.2123 48.138L11.8111 47.0657L14.0981 47.2681L19.1574 47.6119L26.7467 48.138L32.2516 48.4618L40.4073 49.3118H41.7025L41.8846 48.7857L41.4393 48.4618L41.0955 48.138L33.243 42.8155L24.7432 37.1894L20.2909 33.9513L17.8824 32.3119L16.6684 30.774L16.1422 27.4147L18.328 25.0062L21.2624 25.2088L22.0112 25.4112L24.9861 27.6979L31.3407 32.616L39.6381 38.7273L40.8525 39.7391L41.3381 39.395L41.399 39.1523L40.8525 38.2415L36.3394 30.0858L31.5227 21.7883L29.3775 18.3478L28.811 16.2837C28.6087 15.4334 28.4669 14.7252 28.4669 13.8549L30.9563 10.4753L32.3321 10.0303L35.6515 10.4756L37.0479 11.6897L39.112 16.4052L42.4513 23.8327L47.6321 33.9313L49.15 36.9265L49.9594 39.6991L50.2632 40.5491H50.7894V40.0632L51.2141 34.3766L52.0035 27.3944L52.7726 18.4087L53.0358 15.8793L54.2905 12.8435L56.7795 11.2041L58.7224 12.135L60.3212 14.422L60.0986 15.899L59.1474 22.0718L57.2857 31.7458L56.0713 38.2218H56.7795L57.5892 37.4121L60.8677 33.061L66.3723 26.18L68.801 23.448L71.6342 20.4325L73.4556 18.9957H76.8962L79.4255 22.7601L78.2926 26.6456L74.7509 31.1384L71.8163 34.943L67.607 40.6097L64.9758 45.1431L65.2188 45.5072L65.8464 45.4466L75.358 43.4228L80.4984 42.4917L86.6304 41.4393L89.4033 42.7346L89.7065 44.0502L88.6135 46.7419L82.0566 48.3607L74.3662 49.8989L62.9118 52.6109L62.77 52.7121L62.9321 52.9144L68.0925 53.4L70.2987 53.5214H75.7021L85.7601 54.2702L88.3912 56.0108L89.9697 58.1358L89.7065 59.7545L85.6589 61.8189L80.1949 60.5236L67.4452 57.4881L63.0735 56.3952H62.4665V56.7596L66.1093 60.3213L72.7877 66.3523L81.1461 74.1236L81.5707 76.0462L80.4984 77.5638L79.3649 77.4021L72.0186 71.8772L69.1854 69.3879L62.77 63.9844H62.3453V64.5509L63.8223 66.7164L71.6342 78.4544L72.0389 82.0567L71.4725 83.2308L69.4487 83.939L67.2222 83.534L62.6485 77.1189L57.9333 69.8937L54.1284 63.4177L53.6631 63.6809L51.4167 87.8651L50.3644 89.0995L47.9356 90.0303L45.9121 88.4924L44.8392 86.0031L45.9118 81.0852L47.2071 74.6701L48.2594 69.5699L49.2106 63.2356L49.7773 61.131L49.7367 60.9892L49.2715 61.0498L44.4954 67.607L37.23 77.4224L31.4825 83.5746L30.1063 84.1211L27.7181 82.8864L27.9408 80.6805L29.2763 78.7177L37.2297 68.5988L42.026 62.3248L45.1227 58.7025L45.1024 58.176H44.9204L23.7917 71.8975L20.0274 72.3831L18.4083 70.8655L18.6106 68.3761L19.3798 67.5664L25.7343 63.195L25.7146 63.2153Z"/></svg>',
    codex: '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path fill="currentColor" d="M83.7733 42.8087C84.6678 40.1149 84.9771 37.2613 84.6807 34.4385C84.3843 31.6156 83.489 28.8885 82.0544 26.4394C77.6908 18.8436 68.9203 14.9365 60.3548 16.7725C57.9831 14.1344 54.9591 12.1668 51.5864 11.0673C48.2137 9.96772 44.611 9.77498 41.1402 10.5084C37.6694 11.2418 34.4527 12.8755 31.8132 15.2455C29.1736 17.6155 27.204 20.6383 26.1024 24.0103C23.3212 24.5806 20.6938 25.738 18.3958 27.405C16.0977 29.0721 14.1819 31.2104 12.7765 33.6772C8.36538 41.2609 9.3669 50.8267 15.2527 57.3327C14.3549 60.0251 14.0424 62.8782 14.3361 65.7012C14.6298 68.5241 15.523 71.2518 16.9558 73.7017C21.325 81.3002 30.1011 85.207 38.6712 83.3686C40.5554 85.4904 42.8707 87.1858 45.4623 88.3416C48.0539 89.4975 50.8622 90.0871 53.6999 90.0713C62.4793 90.079 70.2575 84.4114 72.9393 76.0515C75.7201 75.4802 78.347 74.3225 80.6449 72.6555C82.9427 70.9886 84.8587 68.8507 86.2649 66.3846C90.6227 58.8145 89.6172 49.3005 83.7733 42.8087ZM53.6999 84.8356C50.1955 84.8411 46.801 83.6129 44.1116 81.3661L44.5848 81.098L60.5123 71.9043C60.9087 71.6718 61.2379 71.3402 61.4674 70.942C61.6969 70.5439 61.8189 70.0929 61.8215 69.6333V47.1769L68.5553 51.072C68.6225 51.1063 68.6694 51.1707 68.6814 51.2456V69.854C68.6641 78.1208 61.9667 84.8183 53.6999 84.8356ZM21.4977 71.0843C19.7402 68.0497 19.1092 64.4925 19.7156 61.0386L20.1885 61.3225L36.1321 70.5165C36.5266 70.748 36.9757 70.87 37.4331 70.87C37.8905 70.87 38.3396 70.748 38.7341 70.5165L58.21 59.2883V67.0628C58.2081 67.1031 58.1973 67.1424 58.1782 67.1779C58.1591 67.2134 58.1322 67.2441 58.0996 67.2678L41.9671 76.5722C34.798 80.7022 25.6388 78.2463 21.4977 71.0843ZM17.3026 36.3898C19.0723 33.3357 21.8655 31.0062 25.1878 29.8138V48.7376C25.1818 49.1949 25.2986 49.6453 25.5261 50.042C25.7535 50.4387 26.0833 50.7671 26.4809 50.9928L45.8622 62.1739L39.1283 66.069C39.0919 66.0883 39.0513 66.0984 39.0101 66.0984C38.9689 66.0984 38.9283 66.0883 38.8919 66.069L22.7908 56.7809C15.6359 52.6337 13.1822 43.4816 17.3026 36.3112V36.3898ZM72.624 49.2426L53.1792 37.9512L59.8976 34.0718C59.9341 34.0524 59.9747 34.0423 60.016 34.0423C60.0573 34.0423 60.0979 34.0524 60.1344 34.0718L76.2355 43.3761C78.6973 44.7966 80.7043 46.8882 82.0221 49.4065C83.3398 51.9249 83.914 54.7661 83.6775 57.5985C83.4411 60.431 82.4038 63.1377 80.6867 65.4027C78.9696 67.6677 76.6436 69.3975 73.9803 70.3901V51.466C73.9663 51.0096 73.834 50.5647 73.5962 50.1749C73.3584 49.7851 73.0234 49.4638 72.624 49.2426ZM79.3261 39.1657L78.8529 38.8815L62.9411 29.6089C62.5442 29.376 62.0924 29.2532 61.6322 29.2532C61.172 29.2532 60.7202 29.376 60.3233 29.6089L40.8629 40.8374V33.0628C40.8587 33.0233 40.8654 32.9834 40.882 32.9473C40.8987 32.9113 40.9248 32.8803 40.9575 32.8579L57.0586 23.5692C59.5263 22.1476 62.3478 21.458 65.193 21.5811C68.0382 21.7042 70.7896 22.6348 73.1253 24.2642C75.461 25.8936 77.2845 28.1543 78.3825 30.782C79.4806 33.4097 79.8077 36.2957 79.3257 39.1025V39.1657H79.3261ZM37.1888 52.9484L30.455 49.069C30.4213 49.0487 30.3925 49.0212 30.3707 48.9884C30.3488 48.9557 30.3345 48.9186 30.3286 48.8797V30.3188C30.3323 27.4714 31.1466 24.6839 32.6761 22.2822C34.2057 19.8805 36.3874 17.9639 38.9661 16.7564C41.5448 15.549 44.4139 15.1005 47.2381 15.4636C50.0622 15.8267 52.7247 16.9862 54.9141 18.8067L54.4409 19.0748L38.5134 28.2686C38.117 28.5011 37.7879 28.8327 37.5584 29.2308C37.329 29.629 37.207 30.0799 37.2045 30.5395L37.1888 52.9487V52.9484ZM40.8472 45.0632L49.5209 40.0643L58.21 45.0635V55.0615L49.5523 60.0608L40.8632 55.0615L40.8472 45.0632Z"/></svg>',
    grok: '<svg viewBox="0 0 34.06 33" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436"/><path fill="currentColor" d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341"/></svg>',
  };
  const states = new WeakMap();
  const layouts = ['auto', '1', '2', '3', '4', 'list'];
  function layoutKey(mount) {
    return 'xenon.aiusage.layout.' + (mount.closest('[data-dashboard-widget]')?.dataset.dashboardInstance || 'aiusage');
  }
  function readLayout(mount) {
    try { const v = localStorage.getItem(layoutKey(mount)); return layouts.includes(v) ? v : 'auto'; } catch { return 'auto'; }
  }
  // Which providers a tile shows, and in what order. Per widget instance and per
  // device, like the layout: the Edge and a phone can want different cards. Only
  // known provider ids survive a read, so a corrupted or hand-edited entry can
  // neither invent a card nor hide one it does not name.
  function prefsKey(mount) {
    return 'xenon.aiusage.providers.' + (mount.closest('[data-dashboard-widget]')?.dataset.dashboardInstance || 'aiusage');
  }
  function cleanIds(value) {
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && Object.hasOwn(names, id)))] : [];
  }
  function readPrefs(mount) {
    try {
      const raw = JSON.parse(localStorage.getItem(prefsKey(mount)) || 'null');
      return { order: cleanIds(raw && raw.order), hidden: cleanIds(raw && raw.hidden) };
    } catch { return { order: [], hidden: [] }; }
  }
  function savePrefs(mount, state) {
    try { localStorage.setItem(prefsKey(mount), JSON.stringify(state.prefs)); state.saveFailed = false; }
    catch { state.saveFailed = true; }
  }
  // The saved order first, then anything it does not mention (a provider that
  // appeared later, e.g. Grok signed in after the order was set) in the order
  // the server sends. Pure.
  function arrangeProviders(providers, prefs) {
    const rank = id => { const i = prefs.order.indexOf(id); return i < 0 ? prefs.order.length : i; };
    return providers.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.id) - rank(b.p.id) || a.i - b.i).map(x => x.p);
  }
  // What the tile draws: the arranged list without the hidden ones. Never empty
  // while there is something to show: the menu keeps the last one switched on,
  // and a saved state that hides everything (another device's) is ignored. Pure.
  function shownProviders(providers, prefs) {
    const arranged = arrangeProviders(providers, prefs);
    const shown = arranged.filter(p => !prefs.hidden.includes(p.id));
    return shown.length ? shown : arranged;
  }
  // Swap a provider with its neighbour among the ones this tile has now. The
  // saved order also keeps providers that are absent at the moment, at the end,
  // so a card that comes back later returns to where it was put.
  function moveProvider(mount, state, id, step) {
    const ids = arrangeProviders(payload.providers, state.prefs).map(p => p.id);
    const at = ids.indexOf(id), to = at + step;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    state.prefs.order = ids.concat(state.prefs.order.filter(x => !ids.includes(x)));
    savePrefs(mount, state); render(mount);
  }
  function toggleProvider(mount, state, id, on) {
    const hidden = state.prefs.hidden.filter(x => x !== id);
    state.prefs.hidden = on ? hidden : hidden.concat(id);
    savePrefs(mount, state); render(mount);
  }
  function providerControls(mount, state) {
    const box = el('div', 'aiu-provider-prefs');
    box.append(el('span', 'aiu-pref-heading', t('aiu_providers')));
    const arranged = arrangeProviders(payload.providers, state.prefs);
    const visibleCount = arranged.filter(p => !state.prefs.hidden.includes(p.id)).length;
    arranged.forEach((p, index) => {
      const shown = !state.prefs.hidden.includes(p.id);
      const row = el('div', 'aiu-pref-row aiu-' + p.id + (shown ? '' : ' is-off'));
      const label = el('label', 'aiu-pref-toggle');
      const check = el('input', 'aiu-pref-check');
      check.type = 'checkbox'; check.checked = shown;
      check.dataset.aiuFocus = 'pref-show-' + p.id;
      // The last card on is kept on: an AI Usage tile showing nothing at all
      // reads as broken, and the way back would be a menu on an empty tile.
      check.disabled = shown && visibleCount <= 1;
      if (check.disabled) label.title = t('aiu_providers_last');
      check.addEventListener('change', () => toggleProvider(mount, state, p.id, check.checked));
      label.append(check, el('i', 'aiu-dot'), el('span', '', names[p.id]));
      const up = button('↑', 'aiu-pref-move', () => moveProvider(mount, state, p.id, -1));
      up.disabled = index === 0; up.dataset.aiuFocus = 'pref-up-' + p.id;
      up.setAttribute('aria-label', names[p.id] + ' · ' + t('aiu_move_up')); up.title = t('aiu_move_up');
      const down = button('↓', 'aiu-pref-move', () => moveProvider(mount, state, p.id, 1));
      down.disabled = index === arranged.length - 1; down.dataset.aiuFocus = 'pref-down-' + p.id;
      down.setAttribute('aria-label', names[p.id] + ' · ' + t('aiu_move_down')); down.title = t('aiu_move_down');
      row.append(label, up, down);
      box.append(row);
    });
    return box;
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
    label.append(select); panel.append(label);
    if (payload) panel.append(providerControls(mount, state));
    box.append(summary, panel); return box;
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
    const mark = el('span', 'aiu-mark');
    mark.innerHTML = LOGOS[provider.id] || '';   // static, trusted SVG
    mark.setAttribute('aria-hidden', 'true');
    const title = el('div', 'aiu-provider-title');
    const name = el('div', 'aiu-line');
    name.append(el('h3', '', names[provider.id]));
    const plan = provider.limits.find(l => l.plan)?.plan;
    if (plan) name.append(el('span', 'aiu-plan', plan));
    const observed = Math.max(0, ...provider.limits.map(l => l.observedAt || 0));
    const source = el('span', 'aiu-source aiu-muted', observed ? t('aiu_observed') + ' ' + age(Date.now() - observed) + ' ' + t('aiu_ago') : t('aiu_local_history'));
    if (provider.connection?.source === 'local_cache') source.textContent = t(provider.id === 'grok' ? 'aiu_grok_cache' : 'aiu_claude_cache') + ' · ' + source.textContent;
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
    if (!main.length) card.append(provider.id === 'claude' ? claudeConnection(provider) : el('p', 'aiu-hint', t(provider.id === 'grok' ? 'aiu_grok_hint' : 'aiu_codex_hint')));
    const liveStatus = provider.connection?.liveStatus;
    if (['sign_in_required', 'rate_limited', 'unavailable', 'no_personal_quota'].includes(liveStatus)) card.append(el('p', 'aiu-warning', t('aiu_live_' + liveStatus)));
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
    if (!state) { state = { period: 'today', open: {}, layout: readLayout(mount), prefs: readPrefs(mount) }; states.set(mount, state); }
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
      // A hidden provider is out of the ring, the legend and the totals too, not
      // just its card: the overview describes what the tile shows.
      const providers = shownProviders(payload.providers, state.prefs);
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
