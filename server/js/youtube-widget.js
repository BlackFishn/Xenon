'use strict';
// Direct-link YouTube player with a local queue, favorites and recent videos.
// Connected-account lists keep using the existing server API. Playback controls
// belong to the embed; fill-widget changes CSS without moving the iframe.
// Player messages retain the existing source/origin checks and error handling.
(function () {
  const ICONS = {
    logo: '<svg viewBox="0 0 90 64" fill="none"><rect width="90" height="64" rx="18" fill="#ff0000"/><path d="M36 46V18l24 14z" fill="#0b0d10"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h2.2v12H7zM19 6v12l-8.5-6z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM5 6l8.5 6L5 18z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 8.5a4.5 4.5 0 0 1 0 7"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    subs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M6 3h12"/><path d="M11 11l4 2.5-4 2.5z" fill="currentColor" stroke="none"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 11v8"/><path d="M18 11l3-1v8" fill="none"/></svg>',
  };
  const t = (k, fb) => { const value = typeof window.t === 'function' ? window.t(k) : k; return value === k && fb != null ? fb : value; };
  const el = makeEl; // shared DOM factory from utils.js
  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it must NOT
  // poll the YouTube API. Adding the widget moves it into a page → polling starts
  // on the next layout pass; removing it parks it back → polling stops.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="youtube"]')).filter(el => el.closest('.pager-page')); }
  const api = apiJson; // shared fetch-JSON helper from utils.js

  let poll = null;
  let connected = null;     // null=unknown
  const POLL_MS = 30000;    // slow on purpose (YouTube Data API quota)

  // ── Library state ─────────────────────────────────────────────────────────
  // One shared model for every tile: what tab is open, what it holds, and which
  // playlist (if any) the user has drilled into.
  const LOCAL_TABS = ['queue', 'favorites', 'recent'];
  const TABS = ['queue', 'favorites', 'recent', 'liked', 'playlists', 'subs', 'search'];
  const TAB_LABEL = {
    queue: () => t('youtube_queue', 'Queue'),
    favorites: () => t('youtube_favorites', 'Favorites'),
    recent: () => t('youtube_recent', 'Recent'),
    liked: () => t('youtube_liked', 'Liked'),
    playlists: () => t('youtube_playlists', 'Playlists'),
    subs: () => t('youtube_tab_subs', 'Subscriptions'),
    search: () => t('youtube_tab_search', 'Search'),
  };
  const lib = {
    tab: 'queue',
    data: { liked: null, playlists: null, subs: null, search: null },   // null = never loaded
    loading: '',
    error: '',
    openPl: null,       // { id, title } while browsing inside a playlist
    plItems: null,      // videos of openPl
    query: '',
  };

  // ── Player state ──────────────────────────────────────────────────────────
  const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
  const PLAYER_ID = 'xenon-yt';
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const player = {
    frame: null, stage: null,
    queue: [], qi: -1,
    state: -1,          // YT player state: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    time: 0, duration: 0,
    muted: false,
    expanded: false,
    blocked: false,     // the embed refuses to play — offer the browser instead
    errCode: 0,         // the code YouTube gave, because they do not all mean the same thing
    heard: false,       // the current frame has answered us at least once
    hello: null,
  };
  const cur = () => (player.qi >= 0 ? player.queue[player.qi] : null) || null;
  const SAVED_KEY = 'xenon.youtube.library.v1';
  const MAX_QUEUE = 100;

  function normalizeVideo(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !VIDEO_ID_RE.test(raw.id)) return null;
    const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
    return {
      id: raw.id, title: text(raw.title, 300), channel: text(raw.channel, 150),
      seconds: Number.isFinite(raw.seconds) ? Math.max(0, Math.min(raw.seconds, 604800)) : 0,
      start: Number.isFinite(raw.start) ? Math.max(0, Math.min(Math.floor(raw.start), 604800)) : 0,
      image: 'https://i.ytimg.com/vi/' + raw.id + '/hqdefault.jpg',
      ...(raw.embeddable === false ? { embeddable: false } : {}),
    };
  }

  function parseVideoLink(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    const value = raw.trim();
    if (VIDEO_ID_RE.test(value)) return normalizeVideo({ id: value });
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
      let id = '';
      if (url.hostname === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1] || '';
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
        id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
      }
      if (!VIDEO_ID_RE.test(id || '')) return null;
      const time = url.searchParams.get('t') || url.searchParams.get('start') || new URLSearchParams(url.hash.slice(1)).get('t') || '';
      const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
      const start = /^\d+$/.test(time) ? Number(time) : parts ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0) : 0;
      return normalizeVideo({ id, start });
    } catch { return null; }
  }

  function readSaved() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(SAVED_KEY) || '{}'); } catch { raw = {}; }
    const list = (name, limit) => {
      const seen = new Set();
      return (Array.isArray(raw?.[name]) ? raw[name] : []).slice(0, 100).map(normalizeVideo)
        .filter(v => v && !seen.has(v.id) && seen.add(v.id)).slice(0, limit);
    };
    return { favorites: list('favorites', 100), recent: list('recent', 30), autoplay: raw?.autoplay !== false, loop: raw?.loop === true };
  }
  const saved = readSaved();
  function saveLibrary() {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); }
    catch { eachMount(mount => feedback(mount, t('youtube_storage_failed', 'Storage is unavailable. Changes last until this page closes.'), true)); }
  }
  function rememberVideo(video) {
    const clean = normalizeVideo(video);
    if (!clean) return;
    saved.recent = [clean, ...saved.recent.filter(v => v.id !== clean.id)].slice(0, 30);
    const index = saved.favorites.findIndex(v => v.id === clean.id);
    if (index >= 0) saved.favorites[index] = clean;
    saveLibrary();
  }
  function toggleFavorite() {
    const video = normalizeVideo(cur());
    if (!video) return;
    const index = saved.favorites.findIndex(v => v.id === video.id);
    if (index >= 0) saved.favorites.splice(index, 1);
    else {
      if (saved.favorites.length >= 100) { eachMount(mount => feedback(mount, t('youtube_list_full', 'This list is full. Remove a video first.'), true)); return; }
      saved.favorites.unshift(video);
    }
    saveLibrary(); paintPlayer(); paintLibrary();
  }
  function feedback(mount, message, error = false) {
    const note = mount.querySelector('.yt-feedback');
    if (!note) return;
    note.textContent = message; note.hidden = !message;
    note.classList.toggle('is-error', error);
  }
  function submitLink(mount, enqueue) {
    const input = mount.querySelector('.yt-link-input');
    const video = parseVideoLink(input.value);
    if (!video) {
      input.setAttribute('aria-invalid', 'true');
      feedback(mount, t('youtube_bad_link', 'Paste a valid YouTube video link.'), true); input.focus(); return;
    }
    const stage = mount.querySelector('.yt-player-stage');
    if (enqueue) {
      if (player.queue.length >= MAX_QUEUE) { feedback(mount, t('youtube_list_full', 'This list is full. Remove a video first.'), true); return; }
      player.queue.push(video);
      lib.tab = 'queue'; lib.openPl = null; paintLibrary();
      feedback(mount, t('youtube_queued', 'Added to queue.'));
    } else {
      if (stage?.closest('.yt-card--player')?.dataset.systemCardHidden === 'true') { feedback(mount, t('youtube_player_hidden'), true); return; }
      // A deliberate paste is a retry; never silently ignore a remembered refusal.
      refused.delete(video.id);
      playList([video], 0, stage);
      feedback(mount, '');
    }
    input.value = ''; input.removeAttribute('aria-invalid');
  }

  // Videos this dashboard has SEEN refuse to play, by id. YouTube's own answer to
  // "may this be embedded" is the owner's flag, and the player can still refuse a
  // video whose flag says yes — measured on a real one that every embed checker
  // reports as allowed and that returns error 150 on both youtube.com and
  // youtube-nocookie, with and without an origin, with and without autoplay. So
  // the flag alone marks almost none of the videos that actually fail. What the
  // player told us is the better source, and it is free. In memory only: a refusal
  // can be about where you are or about a claim that gets lifted, and a wrong mark
  // that survived a restart would hide a video that plays.
  const refused = new Set();
  const isRefused = (v) => !!v && (v.embeddable === false || refused.has(v.id));

  function openStreamingSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('streaming');
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
  }

  // Open a URL where the user can see it: a visible Browser tile first (which
  // re-validates the host), else the PC's default browser through the validated
  // openUrl action. Never window.open — a kiosk surface has nowhere to put a tab.
  async function openOut(url) {
    const bt = window.BrowserTile;
    const inTile = (bt && typeof bt.openFromSdk === 'function') ? bt.openFromSdk(url) : null;
    if (inTile && inTile.ok) return true;
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'openUrl', url }) });
    return !!(r && r.ok);
  }
  // Video ids come from our own server, but they end up inside a URL, so the
  // shape is re-checked here before one is ever built (scheme + id allowlist at
  // the boundary, same rule the rest of the dashboard follows).
  function watchUrl(id) {
    return VIDEO_ID_RE.test(String(id || '')) ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) : '';
  }

  // ── The embed, driven over postMessage ────────────────────────────────────
  function cmd(func, args) {
    const f = player.frame;
    if (!f || !f.contentWindow) return;
    try {
      f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [], id: PLAYER_ID, channel: 'widget' }), EMBED_ORIGIN);
    } catch { /* frame torn down mid-command */ }
  }
  // The embed only starts reporting back once we say we're listening. It can miss
  // the first message while it boots, so say it a few times and stop on the reply.
  // Giving up is a RESULT, not silence: a frame that never answers is one that
  // never became a player — YouTube has served its own error page inside it, and
  // that page speaks none of this protocol. Without the fallback below the user was
  // left looking at YouTube's raw "Video unavailable" rectangle with nothing from us
  // explaining it. Eight seconds, not the old five: the give-up is now user-visible,
  // so it has to outlast a slow embed on a cold start.
  function sayHello() {
    clearInterval(player.hello);
    let n = 0;
    const tick = () => {
      const f = player.frame;
      if (!f || !f.contentWindow) { clearInterval(player.hello); player.hello = null; return; }
      if (++n > 20) {
        clearInterval(player.hello); player.hello = null;
        if (!player.heard) { player.blocked = true; player.state = 2; paintPlayer(); }
        return;
      }
      try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: PLAYER_ID, channel: 'widget' }), EMBED_ORIGIN); } catch { /* gone */ }
    };
    player.hello = setInterval(tick, 400);
    tick();
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== EMBED_ORIGIN) return;
    const f = player.frame;
    if (!f || !f.contentWindow || e.source !== f.contentWindow) return;
    let d = null;
    try { d = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch { return; }
    if (!d || typeof d !== 'object') return;
    player.heard = true;
    if (player.hello) { clearInterval(player.hello); player.hello = null; }
    const info = d.info;
    if (d.event === 'onStateChange') {
      applyState(Number(info));
    } else if (d.event === 'onError') {
      // There is nothing to retry either way, so offer the browser instead of
      // leaving YouTube's own error rectangle on screen with no explanation. What
      // differs is whether the answer is about THIS VIDEO or about this whole
      // installation, and only the first kind may be remembered.
      //
      //   101 / 150 — the owner disallowed embedding. About the video, true
      //     everywhere, and the only trustworthy source we have for it: remember
      //     it so the list can mark it without the user tapping it again.
      //   153 — the embed did not like our referrer. Reported on macOS (#126)
      //     against a build where every list loads and no video plays. Nothing to
      //     do with the video: remembering it would mark the user's whole library
      //     unplayable one tap at a time, and those marks would outlive the fix.
      //   2 / 5 / 100 — bad parameter, player fault, video gone. Also not a
      //     statement about embedding, so also not remembered.
      player.blocked = true; player.state = 2;
      player.errCode = Number(info) || 0;
      const perVideo = player.errCode === 101 || player.errCode === 150;
      const v = cur();
      if (perVideo && v && v.id && !refused.has(v.id)) { refused.add(v.id); paintLibrary(); }
      paintPlayer();
    } else if (d.event === 'infoDelivery' || d.event === 'initialDelivery') {
      if (info && typeof info === 'object') {
        if (Number.isFinite(info.currentTime)) player.time = Math.max(0, info.currentTime);
        if (Number.isFinite(info.duration) && info.duration > 0) player.duration = info.duration;
        if (typeof info.muted === 'boolean') player.muted = info.muted;
        const video = cur();
        const data = info.videoData;
        if (video && data && data.video_id === video.id) {
          const title = typeof data.title === 'string' ? data.title.slice(0, 300) : video.title;
          const channel = typeof data.author === 'string' ? data.author.slice(0, 150) : video.channel;
          if (title !== video.title || channel !== video.channel || (player.duration > 0 && !video.seconds)) {
            video.title = title; video.channel = channel; video.seconds = Math.min(player.duration, 604800);
            rememberVideo(video); paintLibrary(); paintPlayer();
          }
        }
        if (typeof info.playerState === 'number') applyState(info.playerState);
        else paintPlayer();
      }
    }
  });

  // The embed reports its state inside infoDelivery, not as a separate
  // onStateChange event: measured against a real video, playing through to the
  // end produced thirty infoDelivery messages and zero onStateChange, so an
  // auto-advance that waited for the event name never fired once. Both routes
  // land here instead, and what matters is the TRANSITION — infoDelivery repeats
  // several times a second, so acting on the value would run the whole queue out
  // in a moment.
  let lastAdvance = 0;
  function applyState(next) {
    if (!Number.isFinite(next)) return;
    const prev = player.state;
    if (next === prev) return;
    player.state = next;
    if (next === 1) { player.blocked = false; player.errCode = 0; }
    if (next === 0) {
      // A video that has just been swapped in can still report the previous one's
      // ended state for a moment; without this the queue would skip a video.
      const now = Date.now();
      if (now - lastAdvance > 1500) {
        lastAdvance = now;
        if (saved.loop && cur()) { cmd('seekTo', [0, true]); cmd('playVideo'); player.state = 3; }
        else if (saved.autoplay) { playNext(); return; }
      }
    }
    paintPlayer();
  }

  function destroyFrame() {
    clearInterval(player.hello); player.hello = null;
    if (player.frame && player.frame.parentNode) player.frame.parentNode.removeChild(player.frame);
    player.frame = null; player.stage = null;
  }

  function mountFrame(stage, videoId) {
    destroyFrame();
    // A fresh frame has told us nothing yet. Only remounts reset this: swapping the
    // video inside a LIVE player keeps a partner that has already answered, and that
    // player is the thing that reports the next video's error.
    player.heard = false;
    const f = document.createElement('iframe');
    f.className = 'yt-frame';
    f.title = 'YouTube';
    // Native kiosks already own window fullscreen; browser fullscreen previously
    // broke their window state. Browsers get YouTube's fullscreen; native gets
    // the separate viewport expansion button without touching the kiosk window.
    const native = window.__XENON_NATIVE__ === true || window.isTauri === true;
    f.allow = 'autoplay; encrypted-media; picture-in-picture' + (native ? '' : '; fullscreen');
    if (!native) f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    const p = new URLSearchParams({
      enablejsapi: '1', autoplay: '1', rel: '0', playsinline: '1',
      controls: '1', fs: native ? '0' : '1', start: String(cur()?.start || 0),
      origin: location.origin, widget_referrer: location.origin,
    });
    f.src = EMBED_ORIGIN + '/embed/' + encodeURIComponent(videoId) + '?' + p.toString();
    f.addEventListener('load', sayHello);
    stage.insertBefore(f, stage.firstChild);
    player.frame = f; player.stage = stage;
    sayHello();
  }

  // Start playing `list` at `index`. The rest of the list is the queue, so a tap
  // on one video plays the whole thing from there, like YouTube's own lists.
  function playList(list, index, stage) {
    const src = Array.isArray(list) ? list : [];
    const wanted = src[index] && src[index].id;
    // Track the tapped video by id, not by position: the filter below can drop a
    // row, and an index into the unfiltered list would then start the wrong video.
    // Videos known to refuse are kept out of the QUEUE too, so "play this playlist"
    // plays the rest instead of stopping dead on the first one. They are visibly
    // marked in the list, so this skips nothing the user was not already told about.
    const q = src.map(normalizeVideo).filter(v => v && !isRefused(v)).slice(0, MAX_QUEUE);
    if (!q.length) return;
    const found = q.findIndex(v => v.id === wanted);
    const i = found >= 0 ? found : 0;
    player.queue = q; player.qi = i;
    player.time = 0; player.duration = q[i].seconds || 0; player.blocked = false; player.errCode = 0; player.state = 3;
    const target = stage || player.stage || document.querySelector('.yt-player-stage');
    if (!target) return;
    // Same frame, still alive, only a different video: swap it in place — that
    // keeps the playback permission the first tap earned, so the queue advances
    // without the browser blocking a fresh autoplay.
    if (player.frame && player.stage === target && player.frame.contentWindow) cmd('loadVideoById', [q[i].id, q[i].start || 0]);
    else mountFrame(target, q[i].id);
    rememberVideo(q[i]); paintPlayer(); paintLibrary();
  }
  function playAt(i) {
    if (i < 0 || i >= player.queue.length) return;
    player.qi = i; player.time = 0; player.duration = player.queue[i].seconds || 0;
    player.blocked = false; player.errCode = 0; player.state = 3;
    if (player.frame && player.stage) cmd('loadVideoById', [player.queue[i].id, player.queue[i].start || 0]);
    else { const stage = tiles()[0]?.querySelector('.yt-player-stage'); if (stage) mountFrame(stage, player.queue[i].id); }
    rememberVideo(player.queue[i]); paintPlayer(); paintLibrary();
  }
  function playNext() { if (player.qi + 1 < player.queue.length) playAt(player.qi + 1); else { player.state = 0; paintPlayer(); } }
  function stopPlayer() {
    destroyFrame();
    player.queue = []; player.qi = -1; player.state = -1;
    player.time = 0; player.duration = 0; player.blocked = false; player.errCode = 0;
    restorePlayer();
    paintPlayer(); paintLibrary();
  }
  // Resize in place: moving the iframe would reload it and lose playback.
  function setExpanded(on) {
    player.expanded = !!on && !!player.frame;
    eachMount(mount => {
      const owns = mount.contains(player.frame);
      const wrap = mount.querySelector('.yt-wrap');
      wrap.classList.toggle('is-filled', player.expanded && owns);
      mount.querySelector('.yt-restore').hidden = !(player.expanded && owns);
      mount.querySelector('.yt-fill').setAttribute('aria-pressed', String(player.expanded && owns));
      if (owns) (player.expanded ? mount.querySelector('.yt-restore') : mount.querySelector('.yt-fill')).focus({ preventScroll: true });
    });
    paintPlayer();
  }
  function setViewport(on) {
    const native = window.__XENON_NATIVE__ === true || window.isTauri === true;
    if (!native) return;
    const wrap = player.stage?.closest('.yt-wrap');
    if (!wrap) return;
    setExpanded(on);
    wrap.classList.toggle('is-viewport', !!on);
    document.body.classList.toggle('yt-expanded', !!on);
    wrap.closest('[data-dashboard-widget]')?.classList.toggle('yt-tile-expanded', !!on);
  }
  function restorePlayer() {
    setViewport(false);
    document.querySelectorAll('.yt-wrap.is-viewport').forEach(wrap => wrap.classList.remove('is-viewport'));
    document.querySelectorAll('.yt-tile-expanded').forEach(tile => tile.classList.remove('yt-tile-expanded'));
    document.body.classList.remove('yt-expanded');
    setExpanded(false);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && player.expanded && !document.fullscreenElement) restorePlayer(); });

  // ── Library loading ───────────────────────────────────────────────────────
  const LIB_PATH = { liked: '/stream/youtube/liked', playlists: '/stream/youtube/playlists', subs: '/stream/youtube/subscriptions' };

  async function loadTab(tab, force) {
    if (!connected || LOCAL_TABS.includes(tab)) return;
    if (tab === 'search' || !LIB_PATH[tab]) return;                       // explicit action only
    if (!force && lib.data[tab] !== null) return;
    if (lib.loading === tab) return;
    lib.loading = tab; lib.error = ''; paintLibrary();
    const r = await api(LIB_PATH[tab]);
    lib.loading = '';
    if (r && r.ok) lib.data[tab] = (tab === 'playlists' ? (r.playlists || []) : (r.videos || []));
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
  }

  async function openPlaylist(p) {
    lib.openPl = { id: p.id, title: p.title };
    lib.plItems = null; lib.error = ''; lib.loading = 'pl'; paintLibrary();
    const r = await api('/stream/youtube/playlist/items?id=' + encodeURIComponent(p.id));
    lib.loading = '';
    if (r && r.ok) lib.plItems = r.videos || [];
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
  }

  async function runSearch(q) {
    if (!connected) return;
    const query = String(q || '').trim();
    if (query.length < 2) return;
    lib.query = query; lib.loading = 'search'; lib.error = ''; paintLibrary();
    const r = await api('/stream/youtube/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query }) });
    lib.loading = '';
    if (r && r.ok) lib.data.search = r.videos || [];
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function textEl(tag, cls, key) {
    const node = el(tag, cls, t(key)); node.dataset.ytText = key; return node;
  }
  function actionButton(cls, icon, key, action) {
    const button = iconBtn(cls, icon, t(key), action);
    button.dataset.ytLabel = key;
    button.append(textEl('span', 'yt-button-label', key));
    return button;
  }
  function ensure(mount) {
    if (mount.dataset.ytBuilt === '4' && mount.firstChild) return;
    mount.dataset.ytBuilt = '4';
    const wrap = el('div', 'yt-wrap');
    const head = el('div', 'yt-head');
    const brand = el('div', 'yt-brand');
    const logo = el('span', 'yt-brand-icon'); logo.innerHTML = ICONS.logo;
    brand.append(logo, el('span', 'yt-logo', 'YouTube'));
    head.append(brand, actionButton('yt-fill', ICONS.expand, 'youtube_fill', () => setExpanded(true)));
    if (window.__XENON_NATIVE__ === true || window.isTauri === true) head.append(actionButton('yt-viewport', ICONS.expand, 'youtube_expand', () => setViewport(true)));
    const restore = actionButton('yt-restore', ICONS.shrink, 'youtube_restore', restorePlayer); restore.hidden = true;
    wrap.append(head, restore);

    const form = el('form', 'yt-link-form');
    const field = el('div', 'yt-link-field');
    const input = el('input', 'yt-link-input'); input.type = 'text'; input.inputMode = 'url'; input.maxLength = 2048;
    input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', t('youtube_link'));
    input.placeholder = t('youtube_link');
    input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); feedback(mount, ''); });
    const paste = actionButton('yt-paste', ICONS.list, 'youtube_paste', async () => {
      try { input.value = await navigator.clipboard.readText(); input.removeAttribute('aria-invalid'); feedback(mount, ''); }
      catch { feedback(mount, t('youtube_paste_hint', 'Paste your link here with Ctrl+V or the keyboard paste command.')); }
      input.focus();
    });
    field.append(input, paste);
    const play = actionButton('yt-play-link', ICONS.play, 'youtube_play_now', () => {}); play.type = 'submit';
    form.addEventListener('submit', e => { e.preventDefault(); submitLink(mount, false); });
    form.append(field, play, actionButton('yt-enqueue', ICONS.list, 'youtube_add_queue', () => submitLink(mount, true)));
    const note = el('div', 'yt-feedback'); note.hidden = true; note.setAttribute('role', 'status');
    const cards = el('div', 'yt-cards'); cards.append(buildPlayerCard(), buildLibraryCard());
    wrap.append(form, note, cards);
    mount.replaceChildren(wrap);
  }

  function iconBtn(cls, icon, label, onClick) {
    const b = el('button', 'yt-ib ' + cls); b.type = 'button';
    b.innerHTML = icon;                 // static, trusted SVG
    b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function buildPlayerCard() {
    const card = el('section', 'yt-card yt-card--player');
    card.dataset.systemCard = 'player'; card.dataset.systemCardGroup = 'youtube';
    const stage = el('div', 'yt-player-stage');
    const empty = el('div', 'yt-player-empty');
    const mark = el('span', 'yt-empty-icon'); mark.innerHTML = ICONS.play;
    empty.append(mark, textEl('strong', 'yt-empty-title', 'youtube_empty_title'), textEl('span', 'yt-empty-hint', 'youtube_empty_hint'));
    stage.append(empty, buildBlockedOverlay());
    const now = el('div', 'yt-now');
    const meta = el('div', 'yt-now-meta'); meta.append(el('div', 'yt-now-title'), el('div', 'yt-now-sub'));
    const favorite = iconBtn('yt-favorite', ICONS.heart, t('youtube_save'), toggleFavorite);
    const out = iconBtn('yt-out', ICONS.external, t('youtube_open_browser'), async () => { const url = cur() && watchUrl(cur().id); if (url) await openOut(url); });
    out.dataset.ytLabel = 'youtube_open_browser';
    const close = iconBtn('yt-stop', ICONS.close, t('youtube_close_player'), stopPlayer); close.dataset.ytLabel = 'youtube_close_player';
    now.append(meta, favorite, out, close);
    card.append(stage, now);
    return card;
  }

  // "This video cannot be played inside apps" is the right sentence for a video
  // the owner locked, and the wrong one for error 153, where every video fails
  // and none of them is at fault. Saying it anyway sent a macOS user hunting
  // through his library for one that would work (#126).
  function blockedText() {
    if (player.errCode === 153) {
      return t('youtube_embed_config', 'YouTube would not start the player here. This is not the video — open it in the browser.');
    }
    return t('youtube_no_embed', 'This video cannot be played inside apps.');
  }

  function buildBlockedOverlay() {
    const blocked = el('div', 'yt-blocked');
    blocked.append(el('span', 'yt-blocked-txt', blockedText()));
    const bb = el('button', 'yt-blocked-btn', t('youtube_open_browser', 'Open in the browser'));
    bb.type = 'button';
    bb.addEventListener('click', async () => { const v = cur(); const url = v && watchUrl(v.id); if (url) await openOut(url); });
    blocked.appendChild(bb);
    return blocked;
  }

  function buildLibraryCard() {
    const card = el('section', 'yt-card yt-card--library');
    card.dataset.systemCard = 'library'; card.dataset.systemCardGroup = 'youtube';

    const tabsRow = el('div', 'yt-tabs');
    tabsRow.setAttribute('role', 'tablist');
    tabsRow.setAttribute('aria-label', t('youtube_library'));
    const TAB_ICON = { queue: ICONS.list, favorites: ICONS.heart, recent: ICONS.play, liked: ICONS.heart, playlists: ICONS.list, subs: ICONS.subs, search: ICONS.search };
    const account = el('select', 'yt-account-tabs'); account.setAttribute('aria-label', t('youtube_account_library'));
    const option = el('option', '', t('youtube_account_library')); option.value = ''; account.append(option);
    account.addEventListener('change', () => { if (!account.value) return; lib.tab = account.value; lib.openPl = null; lib.error = ''; paintLibrary(); loadTab(lib.tab); });
    TABS.forEach(id => {
      if (!LOCAL_TABS.includes(id)) { const option = el('option', '', TAB_LABEL[id]()); option.value = id; account.append(option); return; }
      const b = el('button', 'yt-tab'); b.type = 'button'; b.dataset.ytTab = id; b.setAttribute('role', 'tab');
      const ico = el('span', 'yt-tab-ico'); ico.innerHTML = TAB_ICON[id];   // static, trusted SVG
      b.append(ico, el('span', 'yt-tab-lbl', TAB_LABEL[id]()));
      b.addEventListener('click', () => {
        lib.tab = id; lib.openPl = null; lib.plItems = null; lib.error = '';
        paintLibrary();
        loadTab(id);
      });
      tabsRow.appendChild(b);
    });
    tabsRow.addEventListener('keydown', e => {
      const tabs = Array.from(tabsRow.querySelectorAll('.yt-tab')); let index = tabs.indexOf(document.activeElement);
      if (e.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else return;
      e.preventDefault(); tabs[index].click(); tabs[index].focus();
    });
    card.append(tabsRow, account);
    const notice = actionButton('yt-setup', ICONS.subs, 'youtube_account_connect', openStreamingSettings);
    card.append(notice);

    const searchRow = el('div', 'yt-search-row');
    const inp = document.createElement('input');
    inp.type = 'search'; inp.className = 'yt-search-input'; inp.maxLength = 100;
    inp.placeholder = t('youtube_search_ph', 'Search on YouTube');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(inp.value); });
    const go = el('button', 'yt-search-go'); go.type = 'button';
    go.innerHTML = ICONS.search;                       // static, trusted SVG
    go.setAttribute('aria-label', t('youtube_tab_search', 'Search'));
    go.addEventListener('click', () => runSearch(inp.value));
    searchRow.append(inp, go);
    card.appendChild(searchRow);

    const crumb = el('button', 'yt-crumb'); crumb.type = 'button';
    const ci = el('span', 'yt-crumb-ico'); ci.innerHTML = ICONS.back;      // static, trusted SVG
    crumb.append(ci, el('span', 'yt-crumb-txt'));
    crumb.addEventListener('click', () => { lib.openPl = null; lib.plItems = null; paintLibrary(); });
    card.appendChild(crumb);

    const summary = el('div', 'yt-list-summary');
    summary.append(textEl('span', '', 'youtube_up_next'), el('span', 'yt-count'));
    const list = el('div', 'yt-list'); list.setAttribute('role', 'tabpanel'); list.setAttribute('aria-label', t('youtube_queue'));
    const options = el('div', 'yt-library-options');
    const autoplay = actionButton('yt-autoplay', ICONS.next, 'youtube_autoplay', () => { saved.autoplay = !saved.autoplay; saveLibrary(); paintLibrary(); });
    autoplay.setAttribute('role', 'switch');
    const repeat = actionButton('yt-repeat', ICONS.list, 'youtube_repeat', () => { saved.loop = !saved.loop; saveLibrary(); paintLibrary(); });
    options.append(autoplay, repeat, actionButton('yt-next', ICONS.next, 'youtube_next', playNext));
    card.append(summary, list, options);
    return card;
  }

  // ── Rows ──────────────────────────────────────────────────────────────────
  function videoRow(v, index, list) {
    const b = el('button', 'yt-row'); b.type = 'button';
    const art = el('span', 'yt-row-art');
    if (VIDEO_ID_RE.test(v.id)) art.style.backgroundImage = 'url("https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg")';
    if (v.seconds > 0) art.appendChild(el('span', 'yt-row-dur', fmtTime(v.seconds)));
    const meta = el('div', 'yt-row-meta');
    meta.append(el('span', 'yt-row-name', v.title || t('youtube_video') + ' · ' + v.id));
    // YouTube tells us in the same request that carries the duration whether a
    // video may play anywhere but youtube.com. Saying it here turns a tap that
    // ends in an error into a row that never promised to play in the first place.
    const sub = el('div', 'yt-row-subline');
    if (v.channel) sub.append(el('span', 'yt-row-sub', v.channel));
    if (isRefused(v)) sub.append(el('span', 'yt-row-tag', t('youtube_only_yt', 'YouTube only')));
    if (sub.childNodes.length) meta.append(sub);
    const play = el('span', 'yt-row-play'); play.innerHTML = ICONS.play;   // static, trusted SVG
    b.append(art, meta, play);
    b.addEventListener('click', async () => {
      // Nothing to try: this one is going to the browser either way, so go there
      // instead of loading a player only to explain why it refused.
      if (isRefused(v)) { const u = watchUrl(v.id); if (u) await openOut(u); return; }
      const wrap = b.closest('.yt-wrap');
      const stage = wrap ? wrap.querySelector('.yt-player-stage') : null;
      // The player card can be switched off in layout edit mode. Someone who did
      // that still expects a tap to play something, so fall back to the browser
      // rather than doing nothing.
      const card = stage?.closest('.yt-card--player');
      if (stage && card?.dataset.systemCardHidden !== 'true') {
        if (lib.tab === 'queue') {
          const at = player.qi + 1 + index;
          if (!player.frame || player.stage !== stage) playList(player.queue, at, stage);
          else playAt(at);
        } else playList(list, index, stage);
      }
      else { const url = watchUrl(v.id); if (url) await openOut(url); }
    });
    if (LOCAL_TABS.includes(lib.tab)) {
      const row = el('div', 'yt-local-row'); row.append(b);
      const remove = iconBtn('yt-remove', ICONS.close, t('youtube_remove'), () => {
        if (lib.tab === 'queue') player.queue.splice(player.qi + 1 + index, 1);
        else saved[lib.tab] = saved[lib.tab].filter(item => item.id !== v.id);
        saveLibrary(); paintLibrary(); paintPlayer();
      });
      remove.setAttribute('aria-label', t('youtube_remove') + ': ' + (v.title || v.id));
      row.append(remove); return row;
    }
    return b;
  }

  function playlistRow(p) {
    const b = el('button', 'yt-row yt-row--pl'); b.type = 'button';
    const art = el('span', 'yt-row-art');
    if (typeof p.image === 'string' && /^https:\/\/(?:i|i[1-4])\.ytimg\.com\/[A-Za-z0-9_./?=&%-]+$/.test(p.image)) art.style.backgroundImage = 'url("' + p.image + '")';
    const meta = el('div', 'yt-row-meta');
    meta.append(el('span', 'yt-row-name', p.title || '—'));
    if (p.count != null) meta.append(el('span', 'yt-row-sub', p.count + ' ' + t('youtube_videos', 'videos')));
    const chev = el('span', 'yt-row-play'); chev.innerHTML = ICONS.play;   // static, trusted SVG
    b.append(art, meta, chev);
    b.addEventListener('click', () => openPlaylist(p));
    return b;
  }

  // ── Painting ──────────────────────────────────────────────────────────────
  function eachMount(fn) {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.youtube-widget-mount');
      if (!mount) return;
      ensure(mount);
      fn(mount, tile);
    });
  }

  function paintPlayer() {
    const v = cur();
    eachMount(mount => {
      const card = mount.querySelector('.yt-card--player');
      const stage = card.querySelector('.yt-player-stage');
      const owns = !!(player.frame && player.stage === stage);
      const empty = stage.querySelector('.yt-player-empty');
      empty.hidden = owns;
      card.classList.toggle('is-playing', owns && !!v);
      const wrap = mount.querySelector('.yt-wrap');
      wrap.classList.toggle('is-filled', player.expanded && owns);
      mount.querySelector('.yt-restore').hidden = !(player.expanded && owns);
      mount.querySelector('.yt-fill').disabled = !owns || card.dataset.systemCardHidden === 'true';
      const viewport = mount.querySelector('.yt-viewport'); if (viewport) viewport.disabled = !owns;
      card.querySelector('.yt-now').hidden = !owns;
      card.querySelector('.yt-now-title').textContent = v ? (v.title || t('youtube_video') + ' · ' + v.id) : '';
      card.querySelector('.yt-now-sub').textContent = v ? (v.channel || t('youtube_video')) : '';
      const favorite = card.querySelector('.yt-favorite');
      const isSaved = !!v && saved.favorites.some(item => item.id === v.id);
      favorite.setAttribute('aria-pressed', String(isSaved));
      favorite.classList.toggle('is-on', isSaved);
      favorite.setAttribute('aria-label', t(isSaved ? 'youtube_unsave' : 'youtube_save'));
      favorite.title = favorite.getAttribute('aria-label');
      favorite.disabled = !owns;
      const blocked = card.querySelector('.yt-blocked');
      blocked.style.display = (owns && player.blocked) ? '' : 'none';
      blocked.querySelector('.yt-blocked-txt').textContent = blockedText();
      // Error UI replaces the failed embed, rather than intercepting a working
      // player's controls. The frame remains mounted for retry/recovery.
      if (owns) player.frame.style.visibility = player.blocked ? 'hidden' : '';
    });
  }

  function paintLibrary() {
    eachMount(mount => {
      const card = mount.querySelector('.yt-card--library');
      if (!card) return;
      const local = LOCAL_TABS.includes(lib.tab);
      card.querySelectorAll('.yt-tab').forEach(b => {
        const selected = b.dataset.ytTab === lib.tab;
        b.classList.toggle('is-on', selected); b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected || (!local && b.dataset.ytTab === 'queue') ? 0 : -1;
      });
      card.querySelector('.yt-account-tabs').value = local ? '' : lib.tab;
      card.querySelector('.yt-setup').hidden = local || connected === true;
      card.querySelector('.yt-list-summary').hidden = !local;
      card.querySelector('.yt-autoplay').setAttribute('aria-checked', String(saved.autoplay));
      card.querySelector('.yt-repeat').setAttribute('aria-pressed', String(saved.loop));
      card.querySelector('.yt-next').disabled = player.qi + 1 >= player.queue.length;
      card.querySelector('.yt-list').setAttribute('aria-label', TAB_LABEL[lib.tab]());
      card.querySelector('.yt-search-row').style.display = (lib.tab === 'search' && !lib.openPl) ? '' : 'none';
      const crumb = card.querySelector('.yt-crumb');
      crumb.style.display = lib.openPl ? '' : 'none';
      if (lib.openPl) crumb.querySelector('.yt-crumb-txt').textContent = lib.openPl.title || t('youtube_playlists', 'Playlists');

      const list = card.querySelector('.yt-list');
      // Rebuilding an unchanged list on every status poll would throw away the
      // user's scroll position every 30 seconds, so only rebuild on a real change.
      const rows = local ? (lib.tab === 'queue' ? player.queue.slice(player.qi + 1) : saved[lib.tab]) : lib.openPl ? lib.plItems : lib.data[lib.tab];
      card.querySelector('.yt-count').textContent = local ? String(rows.length) : '';
      card.querySelector('.yt-list-summary > span').textContent = lib.tab === 'queue' ? t('youtube_up_next') : TAB_LABEL[lib.tab]();
      // `refused.size` is in the signature because a refusal changes how an ALREADY
      // rendered row must look, and nothing else in here would have changed: without
      // it the mark only appeared on the next tab switch, which is the one moment the
      // user is no longer looking at the video that just failed.
      const sig = [connected, document.documentElement.lang, lib.tab, lib.openPl && lib.openPl.id, lib.loading, lib.error, refused.size,
        rows === null || rows === undefined ? 'n' : rows.map(r => [r.id, r.title, r.channel, r.seconds, r.embeddable]).join(';')].join('|');
      if (list.dataset.ytSig === sig) return;
      list.dataset.ytSig = sig;
      // Still waiting on the connection check: say so instead of leaving a blank
      // panel that reads as a broken widget. A definite "no account" is NOT that
      // and must not borrow the same line: it never resolves, so "Loading…" there
      // is a spinner that spins forever over an answer we already have.
      if (local) {
        const frag = document.createDocumentFragment();
        if (!rows.length) frag.append(el('div', 'yt-list-note', t(lib.tab === 'queue' ? 'youtube_queue_empty' : lib.tab === 'favorites' ? 'youtube_favorites_empty' : 'youtube_recent_empty')));
        rows.forEach((video, index) => frag.append(videoRow(video, index, rows)));
        list.replaceChildren(frag); return;
      }
      if (connected === false) { list.replaceChildren(el('div', 'yt-list-note', t('youtube_not_connected', 'Connect in Settings'))); return; }
      if (connected !== true) { list.replaceChildren(el('div', 'yt-list-note', t('browser_loading', 'Loading…'))); return; }
      if (lib.loading) { list.replaceChildren(el('div', 'yt-list-note', t('browser_loading', 'Loading…'))); return; }
      if (lib.error) { list.replaceChildren(el('div', 'yt-list-note yt-list-err', t('youtube_list_failed', 'Could not load this list.'))); return; }

      const frag = document.createDocumentFragment();
      if (lib.openPl) {
        const items = lib.plItems || [];
        if (!items.length) frag.appendChild(el('div', 'yt-list-note', t('youtube_nothing', 'Nothing here')));
        items.forEach((v, i) => frag.appendChild(videoRow(v, i, items)));
      } else if (lib.tab === 'playlists') {
        const pls = lib.data.playlists;
        if (pls === null) frag.appendChild(el('div', 'yt-list-note', t('browser_loading', 'Loading…')));
        else if (!pls.length) frag.appendChild(el('div', 'yt-list-note', t('youtube_no_playlists', 'No playlists on this account')));
        else pls.forEach(p => frag.appendChild(playlistRow(p)));
      } else if (lib.tab === 'search' && lib.data.search === null) {
        frag.appendChild(el('div', 'yt-list-note', t('youtube_search_hint', 'Type something and press search.')));
      } else {
        const vids = lib.data[lib.tab];
        if (vids === null) frag.appendChild(el('div', 'yt-list-note', t('browser_loading', 'Loading…')));
        else if (!vids.length) frag.appendChild(el('div', 'yt-list-note', t('youtube_nothing', 'Nothing here')));
        else vids.forEach((v, i) => frag.appendChild(videoRow(v, i, vids)));
      }
      list.replaceChildren(frag);
    });
  }

  // Labels are written into the DOM once at build time, but the language can
  // change under a widget that is mid-playback — and rebuilding to re-translate
  // would reload the iframe and restart the video. So the fixed labels are
  // re-applied on every paint instead (a handful of textContent writes), and the
  // list signature carries the language so its rows re-render too.
  function relabel(mount) {
    mount.querySelectorAll('.yt-tab').forEach(b => {
      const f = TAB_LABEL[b.dataset.ytTab];
      if (f) b.querySelector('.yt-tab-lbl').textContent = f();
    });
    const inp = mount.querySelector('.yt-search-input');
    if (inp) inp.placeholder = t('youtube_search_ph', 'Search on YouTube');
    const input = mount.querySelector('.yt-link-input');
    input.placeholder = t('youtube_link'); input.setAttribute('aria-label', t('youtube_link'));
    mount.querySelectorAll('[data-yt-text]').forEach(node => { node.textContent = t(node.dataset.ytText); });
    mount.querySelectorAll('[data-yt-label]').forEach(node => { node.title = t(node.dataset.ytLabel); node.setAttribute('aria-label', node.title); });
    mount.querySelectorAll('.yt-account-tabs option').forEach(option => { option.textContent = option.value ? TAB_LABEL[option.value]() : t('youtube_account_library'); });
    mount.querySelector('.yt-account-tabs').setAttribute('aria-label', t('youtube_account_library'));
  }

  function paint() {
    eachMount(mount => relabel(mount));
    paintPlayer();
    paintLibrary();
  }

  async function refresh() {
    if (!tiles().length) { stop(); return; }
    // "Is an account connected" reads our own token store and costs no YouTube
    // quota, so it runs even when nobody is looking at the tile. It used to sit
    // behind the visibility gate with everything else, and that gate is what left
    // the widget with no idea what to draw: an empty box with a logo in it, for as
    // long as the page stayed unseen. Everything below here does cost quota and
    // stays gated.
    const s = await api('/stream/youtube/status');
    const was = connected;
    if (s) connected = !!s.connected;
    if (connected) {
      // The open list loads ONCE and is what the tile is for, so it does not wait
      // for the page to be judged visible. Keyed on the list being empty rather
      // than on the connection having just come up, so a tab opened later fills
      // too — and on `loading` so a slow read is not fired twice.
      if (!LOCAL_TABS.includes(lib.tab) && lib.tab !== 'search' && lib.data[lib.tab] === null && !lib.loading) loadTab(lib.tab);
    } else if (connected === false && was !== false) {
      // Signed out (possibly to sign a different account in): drop everything the
      // previous account put on screen.
      lib.data = { liked: null, playlists: null, subs: null, search: null };
      lib.openPl = null; lib.plItems = null; lib.error = '';
      // Direct links and this browser's saved lists do not depend on OAuth.
    }
    paint();
  }
  function stop() {
    if (poll) { clearInterval(poll); poll = null; }
    // Same reason as the Twitch watching widget: the tile's DOM is MOVED to the
    // hidden widget pool rather than destroyed, and a display:none iframe keeps
    // playing — so removing the widget mid-video left the audio running with
    // nothing on screen left to stop it.
    if (player.frame) stopPlayer();
  }

  function renderWidgets() {
    if (!tiles().length) { stop(); return; }
    paint();
    if (!poll) { refresh(); poll = setInterval(refresh, POLL_MS); }
  }

  // ── SDK bridge ────────────────────────────────────────────────────────────
  // Play a video in this tile on behalf of a widget the user granted `watch`.
  // The id is re-validated against the same pattern the library rows use, because
  // this is where it becomes part of an embed URL. It plays as a queue of one:
  // the widget names a video, it does not get to load a playlist into the tile.
  function playFromSdk(raw) {
    const id = String(raw == null ? '' : raw).trim();
    if (!VIDEO_ID_RE.test(id)) return { ok: false, error: 'bad_video' };
    if (!tiles().length) return { ok: false, error: 'unavailable' };
    const stage = tiles()[0]?.querySelector('.yt-player-stage');
    if (!stage || stage.closest('.yt-card--player')?.dataset.systemCardHidden === 'true') return { ok: false, error: 'unavailable' };
    // Title left empty on purpose: nothing here knows it, and asking YouTube
    // would spend quota on a caption the embed itself already draws.
    playList([{ id, title: '', channel: '', seconds: 0 }], 0, stage);
    return { ok: true };
  }

  window.YouTubeWidget = { renderWidgets, playFromSdk };
})();
