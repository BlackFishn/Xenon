'use strict';
// Local files stay on the backend. Only picker-issued IDs cross this boundary;
// FFmpeg supplies browser-compatible video and the selected audio/subtitle track.
(function () {
  const el = makeEl;
  const labels = {
    open: 'Open files', focus: 'Focus', restore: 'Restore layout', queue: 'Queue',
    empty_title: 'Your files. Your cinema.', empty_hint: 'Open a video from this PC. MKV, MP4 and more, with selectable audio and subtitles.',
    audio: 'Audio', subtitles: 'Subtitles', tracks: 'Audio & subtitles', off: 'Off',
    load_subtitle: 'Load subtitle file', close: 'Close', play: 'Play', pause: 'Pause',
    previous: 'Previous video', next: 'Next video', seek: 'Seek', volume: 'Volume',
    speed: 'Playback speed', repeat: 'Repeat video', loading: 'Preparing video…',
    failed: 'This video could not be played. Try another file or audio track.',
    unavailable: 'Local video needs FFmpeg and ffprobe installed on this PC.',
    unsupported: 'Local video is available on the Windows PC running Xenon.',
    denied: 'Open local videos from the dashboard on this PC.',
    pick_failed: 'Could not open the file picker. Please try again.',
    sub_failed: 'Could not load that subtitle file.', queue_empty: 'Open files to build your queue.',
    unsupported_track: 'Unsupported', files_limit: 'The queue is full. Clear the queue before opening more videos.', clear_queue: 'Clear queue',
    audio_track: 'Audio track', subtitle_track: 'Subtitle track', ass_plain: 'ASS (text only)',
    compatibility: 'Compatibility · up to 720p', compatibility_hint: 'This codec needs video conversion, which uses more CPU. Compatible H.264 files play without video conversion.',
    skipped_files: 'Some files could not be opened',
  };
  function t(key) {
    const id = 'local_video_' + key;
    const value = typeof window.t === 'function' ? window.t(id) : id;
    return value === id ? labels[key] || key : value;
  }
  const icons = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5h2v14H5zm14 0v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 5h2v14h-2zM5 5l10 7-10 7z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 5h6l2 3h8v11H4z"/><path d="m10 11 5 3-5 3z"/></svg>',
    tracks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 8a5 5 0 0 1 0 8"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4M20 7H7a4 4 0 0 0-4 4m5 10-4-4 4-4M4 17h13a4 4 0 0 0 4-4"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5"/></svg>',
  };
  const formatTime = seconds => {
    const whole = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(whole / 3600), m = Math.floor(whole % 3600 / 60), s = whole % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  const token = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID().replace(/-/g, '') :
    Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  async function post(path, body) {
    try { return await apiJson('/media/local/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(['stop', 'release'].includes(path) ? { keepalive: true } : {}) }); }
    catch { return null; }
  }
  function create({ mount, wrap, onPlay, onChange }) {
    const owner = token();
    const state = { files: [], index: -1, audio: '', subtitle: 'off', offset: 0, position: 0, initialSeek: 0, generation: '', active: false, focused: false, filled: false, loading: false, picking: false, destroyed: false, repeat: false, revision: 0 };
    let focusTrigger = null;
    let posterUrl = '', posterEpoch = 0;
    const root = el('div', 'lv-root'); root.hidden = true;
    const body = el('div', 'lv-body');
    const stage = el('dialog', 'lv-stage'); stage.tabIndex = -1;
    stage.setAttribute('role', 'group'); stage.setAttribute('aria-label', 'Video');
    const screen = el('div', 'lv-screen');
    const video = el('video', 'lv-video'); video.playsInline = true; video.preload = 'metadata';
    video.disablePictureInPicture = true; video.setAttribute('aria-label', 'Video');
    const empty = el('div', 'lv-empty');
    const mark = el('span', 'lv-empty-icon'); mark.innerHTML = icons.file;
    empty.append(mark, el('strong', '', t('empty_title')), el('span', '', t('empty_hint')));
    const notice = el('div', 'lv-notice'); notice.hidden = true; notice.setAttribute('role', 'status');
    screen.append(video, empty, notice);

    function button(cls, icon, key, action, text = false) {
      const node = el('button', 'yt-ib ' + cls); node.type = 'button'; node.innerHTML = icons[icon] || '';
      node.title = t(key); node.setAttribute('aria-label', t(key)); node.dataset.lvLabel = key;
      if (text) { const label = el('span', '', t(key)); label.dataset.lvText = key; node.append(label); }
      node.addEventListener('click', action); return node;
    }
    const openEmpty = button('lv-open-empty', 'file', 'open', openFiles, true); empty.append(openEmpty);
    const transport = el('div', 'lv-transport');
    const now = el('div', 'lv-now');
    const filename = el('strong', 'lv-filename', t('empty_title'));
    const compatibility = el('span', 'lv-compatibility', t('compatibility')); compatibility.hidden = true; compatibility.title = t('compatibility_hint');
    const trackButton = button('lv-tracks-toggle', 'tracks', 'tracks', () => setTracks(trackPanel.hidden), true);
    trackButton.setAttribute('aria-expanded', 'false');
    const restore = button('lv-focus-restore', 'restore', 'restore', () => setFocus(false), true); restore.hidden = true;
    now.append(filename, compatibility, trackButton, restore);
    const timeline = el('div', 'lv-timeline');
    const elapsed = el('span', 'lv-time', '0:00'), total = el('span', 'lv-time', '0:00');
    const seek = el('input', 'lv-seek'); seek.type = 'range'; seek.min = '0'; seek.max = '0'; seek.step = '.1'; seek.value = '0'; seek.setAttribute('aria-label', t('seek'));
    let scrubbing = false;
    seek.addEventListener('input', () => { scrubbing = true; elapsed.textContent = formatTime(seek.value); fillRange(seek); });
    seek.addEventListener('change', () => { scrubbing = false; startAt(Number(seek.value), !video.paused); });
    timeline.append(elapsed, seek, total);
    const controls = el('div', 'lv-controls');
    const volumeBox = el('label', 'lv-volume');
    const volumeIcon = el('span', ''); volumeIcon.innerHTML = icons.volume;
    const volume = el('input', ''); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.01'; volume.value = '1'; volume.setAttribute('aria-label', t('volume'));
    const volumeText = el('span', 'lv-volume-value', '100%');
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = false; volumeText.textContent = Math.round(video.volume * 100) + '%'; fillRange(volume); });
    volumeBox.append(volumeIcon, volume, volumeText);
    const playback = el('div', 'lv-playback');
    const previous = button('lv-previous', 'prev', 'previous', () => selectFile(state.index - 1));
    const play = button('lv-play', 'play', 'play', togglePlay);
    const next = button('lv-next', 'next', 'next', () => selectFile(state.index + 1));
    playback.append(previous, play, next);
    const tail = el('div', 'lv-tail');
    const rate = el('select', 'lv-rate'); rate.setAttribute('aria-label', t('speed'));
    [.5, .75, 1, 1.25, 1.5, 2].forEach(value => { const option = el('option', '', value + '×'); option.value = value; rate.append(option); }); rate.value = '1';
    rate.addEventListener('change', () => { startAt(position(), !video.paused); });
    const repeat = button('lv-repeat', 'repeat', 'repeat', () => { state.repeat = !state.repeat; repeat.setAttribute('aria-pressed', String(state.repeat)); }); repeat.setAttribute('aria-pressed', 'false');
    tail.append(rate, repeat); controls.append(volumeBox, playback, tail);
    transport.append(now, timeline, controls);

    const trackPanel = el('div', 'lv-track-panel'); trackPanel.hidden = true; trackPanel.setAttribute('role', 'group'); trackPanel.setAttribute('aria-label', t('tracks'));
    const trackHead = el('div', 'lv-track-heading'); trackHead.append(el('strong', '', t('tracks')), button('lv-track-close', 'close', 'close', () => setTracks(false)));
    function trackField(key) {
      const label = el('label', 'lv-track-field'); const title = el('span', '', t(key)); title.dataset.lvText = key;
      const select = el('select', 'lv-' + key); select.setAttribute('aria-label', t(key)); label.append(title, select); trackPanel.append(label); return select;
    }
    trackPanel.append(trackHead);
    const audio = trackField('audio'), subtitles = trackField('subtitles');
    audio.addEventListener('change', () => { state.audio = audio.value; startAt(position(), !video.paused); });
    subtitles.addEventListener('change', () => { state.subtitle = subtitles.value; applySubtitle(); });
    const subLoad = button('lv-sub-load', 'file', 'load_subtitle', loadSubtitle, true); trackPanel.append(subLoad);
    stage.append(screen, transport, trackPanel);
    const queue = el('aside', 'lv-queue'); queue.hidden = true;
    const queueHead = el('div', 'lv-queue-head'); const queueTitle = el('strong', '', t('queue')); queueTitle.dataset.lvText = 'queue';
    const count = el('span', 'lv-queue-count', '0'); queueHead.append(queueTitle, count, button('lv-clear-queue', 'close', 'clear_queue', clearQueue));
    const list = el('div', 'lv-queue-list'); list.setAttribute('aria-label', t('queue'));
    const selectionNote = el('div', 'lv-selection-note'); selectionNote.hidden = true; selectionNote.setAttribute('role', 'status');
    queue.append(queueHead, list); body.append(stage, queue); root.append(body, selectionNote); wrap.append(root);

    function current() { return state.files[state.index] || null; }
    function position() { return Math.max(0, Math.min(current()?.duration || Infinity, state.generation ? state.offset + (Number(video.currentTime) || 0) : state.position)); }
    function message(value, error = false) { notice.textContent = value; notice.hidden = !value; notice.classList.toggle('is-error', error); }
    function fillRange(input) { input.style.setProperty('--lv-value', Math.min(100, Math.max(0, Number(input.value) / (Number(input.max) || 1) * 100)) + '%'); }
    function release() {
      state.position = position();
      const generation = state.generation;
      if (!generation) return;
      clearTracks();
      state.generation = ''; state.initialSeek = 0; video.pause(); video.removeAttribute('src'); video.load();
      void post('stop', { owner, generation });
    }
    function clearPoster() {
      posterEpoch += 1;
      if (posterUrl) URL.revokeObjectURL(posterUrl);
      posterUrl = ''; video.removeAttribute('poster');
    }
    function capturePausedFrame() {
      clearPoster();
      if (!video.videoWidth || !video.videoHeight) return;
      const epoch = posterEpoch, canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      try {
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (!blob || state.destroyed || !state.active || state.generation || epoch !== posterEpoch) return;
          posterUrl = URL.createObjectURL(blob); video.poster = posterUrl;
        }, 'image/jpeg', .82);
      } catch { /* A missing decoded frame should never prevent pausing. */ }
    }
    function setTracks(on) { trackPanel.hidden = !on; trackButton.setAttribute('aria-expanded', String(on)); if (on) audio.focus(); else trackButton.focus(); }
    function paint() {
      if (state.destroyed) return;
      const file = current(), has = !!file;
      empty.hidden = has; transport.hidden = !has;
      filename.textContent = file?.name || t('empty_title'); filename.title = file?.name || '';
      compatibility.hidden = file?.playbackMode !== 'transcode';
      seek.max = String(file?.duration || 0); seek.disabled = !has || state.loading;
      if (!scrubbing) { seek.value = String(position()); elapsed.textContent = formatTime(position()); fillRange(seek); }
      total.textContent = formatTime(file?.duration);
      previous.disabled = state.index <= 0 || state.loading; next.disabled = state.index < 0 || state.index >= state.files.length - 1 || state.loading;
      play.disabled = !has || state.loading;
      const paused = video.paused;
      play.innerHTML = icons[paused ? 'play' : 'pause']; play.title = t(paused ? 'play' : 'pause'); play.setAttribute('aria-label', play.title);
      trackButton.disabled = !has; subLoad.disabled = !has || state.picking;
      openEmpty.disabled = state.picking;
      if (onChange) onChange();
    }
    function trackLabel(track, kind) {
      return [track.label || track.language || t(kind) + ' ' + track.id, track.styling === 'plain' ? t('ass_plain') : track.codec, track.channels ? track.channels + 'ch' : ''].filter(Boolean).join(' · ');
    }
    function paintTracks() {
      const file = current(); audio.replaceChildren(); subtitles.replaceChildren();
      for (const track of file?.audioTracks || []) { const option = el('option', '', trackLabel(track, 'audio_track')); option.value = track.id; audio.append(option); }
      if (!audio.options.length) { const option = el('option', '', '—'); option.value = ''; audio.append(option); }
      audio.value = state.audio; audio.disabled = !file?.audioTracks?.length;
      const off = el('option', '', t('off')); off.value = 'off'; subtitles.append(off);
      for (const track of file?.subtitleTracks || []) { const option = el('option', '', trackLabel(track, 'subtitle_track') + (track.supported === false ? ' · ' + t('unsupported_track') : '')); option.value = track.id; option.disabled = track.supported === false; subtitles.append(option); }
      subtitles.value = state.subtitle;
    }
    function paintQueue() {
      count.textContent = String(state.files.length); list.replaceChildren();
      if (!state.files.length) list.append(el('p', 'lv-queue-empty', t('queue_empty')));
      state.files.forEach((file, index) => {
        const row = el('button', 'lv-queue-row'); row.type = 'button'; row.setAttribute('aria-pressed', String(index === state.index));
        const mark = el('span', 'lv-queue-mark', String(index + 1).padStart(2, '0'));
        const copy = el('span', 'lv-queue-copy'); copy.append(el('strong', '', file.name), el('span', '', formatTime(file.duration)));
        row.append(mark, copy); row.addEventListener('click', () => selectFile(index)); list.append(row);
      });
    }
    async function startAt(seconds, shouldPlay = true) {
      const file = current(); if (!file || state.destroyed || !state.active) return;
      release();
      clearPoster();
      state.offset = Math.max(0, Math.min(Number(seconds) || 0, Math.max(0, file.duration - .1))); state.position = state.offset;
      // A paused seek/track change is only a selection; start the decoder on Play.
      if (!shouldPlay) { state.loading = false; message(''); paint(); return; }
      state.generation = token(); state.loading = true;
      const generation = state.generation;
      const requested = state.offset;
      message(t('loading')); paint();
      let prepared;
      try { prepared = await apiJson('/media/local/prepare?' + new URLSearchParams({ id: file.id, start: String(requested), audio: state.audio })); } catch { prepared = null; }
      if (state.destroyed || !state.active || generation !== state.generation) return;
      if (!prepared?.ok || !Number.isFinite(prepared.start) || prepared.start < 0 || !Number.isFinite(prepared.actualStart) || prepared.actualStart < -2 || !Number.isFinite(prepared.seekOffset) || prepared.seekOffset < 0) {
        release(); state.loading = false; message(t('failed'), true); paint(); return;
      }
      state.offset = prepared.actualStart; state.initialSeek = prepared.seekOffset;
      const params = new URLSearchParams({ id: file.id, audio: state.audio, start: String(prepared.start), rate: rate.value, owner, generation });
      video.src = '/media/local/stream?' + params; video.playbackRate = Number(rate.value);
      applySubtitle();
      paint();
      if (shouldPlay) { onPlay?.(); const expected = state.generation; Promise.resolve(video.play()).catch(() => { if (expected !== state.generation) return; release(); state.loading = false; message(t('play')); paint(); }); }
    }
    function selectFile(index) {
      if (index < 0 || index >= state.files.length) return;
      release(); state.index = index;
      const file = current(); state.audio = String(file.defaultAudio ?? file.audioTracks?.[0]?.id ?? ''); state.subtitle = 'off';
      paintTracks(); paintQueue(); return startAt(0);
    }
    function togglePlay() {
      if (!current()) return;
      if (!state.generation) { startAt(state.position >= current().duration - .1 ? 0 : state.position); return; }
      if (video.paused) { onPlay?.(); video.play().catch(() => message(t('failed'), true)); }
      else pause(true);
    }
    function applySubtitle() {
      clearTracks();
      const file = current(), selected = file?.subtitleTracks?.find(track => String(track.id) === state.subtitle);
      if (!selected || selected.supported === false || !state.generation) return;
      const track = el('track', ''); track.kind = 'subtitles'; track.label = selected.label || selected.language || t('subtitles');
      track.src = '/media/local/subtitle?' + new URLSearchParams({ id: file.id, track: state.subtitle, start: String(state.offset) });
      track.default = true; video.append(track); if (track.track) track.track.mode = 'showing';
      track.addEventListener('error', () => { if (track.isConnected && state.subtitle === String(selected.id)) message(t('sub_failed'), true); });
    }
    function clearTracks() {
      for (const track of Array.from(video.textTracks || [])) track.mode = 'disabled';
      video.querySelectorAll('track').forEach(track => { if (track.track) track.track.mode = 'disabled'; track.remove(); });
    }
    async function openFiles() {
      if (state.picking || state.destroyed) return;
      state.picking = true; const revision = state.revision; paint();
      let status;
      try { status = await apiJson('/media/local/status'); } catch { status = null; }
      if (state.destroyed || revision !== state.revision) return;
      if (!status?.available || status.pickerSupported === false) {
        const key = status?.pickerSupported === false || ['unsupported_platform'].includes(status?.error) ? 'unsupported' : ['forbidden', 'remote_denied'].includes(status?.error) ? 'denied' : 'unavailable';
        state.picking = false; message(t(key), true); paint(); return;
      }
      const result = await post('pick', {});
      state.picking = false;
      if (state.destroyed || revision !== state.revision) {
        const ids = (result?.files || []).map(file => file.id); if (ids.length) void post('release', { ids });
        return;
      }
      if (!result?.ok) { message(t(result?.error === 'library_full' ? 'files_limit' : 'pick_failed'), true); paint(); return; }
      const skipped = Array.isArray(result.errors) ? result.errors.length : 0;
      selectionNote.textContent = skipped ? t('skipped_files') + ' (' + skipped + ')' : ''; selectionNote.hidden = !skipped;
      if (result.cancelled || !result.files?.length) { paint(); return; }
      const oldLength = state.files.length;
      const valid = result.files.filter(file => /^[a-f0-9]{32}$/.test(file?.id || '') && typeof file.name === 'string' && Number.isFinite(file.duration) && file.duration >= 0);
      state.files.push(...valid.slice(0, 32 - oldLength));
      paintQueue();
      if (state.index < 0 && state.files.length) await selectFile(0);
      else { message(state.files.length < oldLength + valid.length ? t('files_limit') : ''); paint(); }
    }
    async function loadSubtitle() {
      const file = current(); if (!file || state.picking) return;
      const id = file.id; state.picking = true; paint();
      const result = await post('subtitle', { id }); state.picking = false;
      if (state.destroyed || current()?.id !== id) return;
      if (result?.cancelled) { paint(); return; }
      if (!result?.ok || result.file?.id !== id) { message(t('sub_failed'), true); paint(); return; }
      const oldIds = new Set(file.subtitleTracks.map(track => track.id));
      state.files[state.index] = result.file;
      const added = result.file.subtitleTracks.find(track => !oldIds.has(track.id));
      if (added?.supported !== false && added) state.subtitle = String(added.id);
      paintTracks(); applySubtitle(); paint();
    }
    function setFocus(on, trigger) {
      if (!on) {
        if (!state.focused) return false;
        state.focused = false;
        if (stage.open) stage.close();
        stage.classList.remove('is-focused'); stage.setAttribute('role', 'group'); stage.removeAttribute('aria-modal'); restore.hidden = true;
        document.body.classList.remove('lv-focused');
        if (focusTrigger?.isConnected) focusTrigger.focus({ preventScroll: true });
        paint(); return true;
      }
      if (!current() || !state.active || state.focused || typeof stage.showModal !== 'function') return false;
      focusTrigger = trigger || document.activeElement; state.focused = true;
      stage.classList.add('is-focused'); stage.setAttribute('role', 'dialog'); stage.setAttribute('aria-modal', 'true'); restore.hidden = false;
      document.body.classList.add('lv-focused');
      try { stage.showModal(); } catch { setFocus(false); return false; }
      stage.focus({ preventScroll: true }); paint(); return true;
    }
    stage.addEventListener('cancel', event => { event.preventDefault(); setFocus(false); });
    stage.addEventListener('close', () => { if (state.focused && !stage.open) setFocus(false); });
    stage.addEventListener('click', event => {
      if (!state.focused) return;
      const rect = stage.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
      event.preventDefault(); event.stopPropagation(); setFocus(false);
    });
    stage.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!trackPanel.hidden) { event.preventDefault(); event.stopPropagation(); setTracks(false); }
    });
    video.addEventListener('timeupdate', paint);
    function applyInitialSeek() {
      if (!state.generation || !state.initialSeek) return;
      try { video.currentTime = state.initialSeek; state.initialSeek = 0; } catch { /* The next canplay retries once metadata exposes a seekable range. */ }
    }
    video.addEventListener('loadedmetadata', applyInitialSeek);
    for (const type of ['playing', 'canplay']) video.addEventListener(type, () => { if (!state.generation) return; applyInitialSeek(); state.loading = false; message(''); paint(); });
    for (const type of ['play', 'volumechange']) video.addEventListener(type, paint);
    video.addEventListener('pause', () => { if (state.generation && !state.loading && !video.ended) pause(true); else paint(); });
    video.addEventListener('waiting', () => { if (state.generation) message(t('loading')); });
    video.addEventListener('error', () => { if (!state.generation) return; release(); state.loading = false; message(t('failed'), true); paint(); });
    video.addEventListener('ended', () => {
      if (!state.generation || !state.active) return;
      if (state.repeat) startAt(0);
      else if (state.index + 1 < state.files.length) selectFile(state.index + 1);
      else { release(); state.position = current()?.duration || 0; paint(); }
    });
    function pause(snapshot = false) { if (snapshot) capturePausedFrame(); else clearPoster(); release(); state.loading = false; message(''); paint(); }
    function clearQueue() {
      state.revision += 1; state.picking = false;
      setFocus(false); release(); fill(false);
      clearPoster();
      const ids = state.files.map(file => file.id); state.files = []; state.index = -1;
      state.position = 0; state.offset = 0; state.loading = false; trackPanel.hidden = true;
      selectionNote.hidden = true; selectionNote.textContent = '';
      if (ids.length) void post('release', { ids });
      message(''); paintQueue(); paintTracks(); paint();
    }
    function fill(on) { state.filled = !!on && !!current(); wrap.classList.toggle('is-video-filled', state.filled && state.active); paint(); }
    function setActive(on) {
      state.active = !!on; root.hidden = !on;
      if (!on) { state.revision += 1; state.picking = false; setFocus(false); pause(); fill(false); }
      paint();
    }
    function relabel() {
      root.querySelectorAll('[data-lv-label]').forEach(node => { node.title = t(node.dataset.lvLabel); node.setAttribute('aria-label', node.title); });
      root.querySelectorAll('[data-lv-text]').forEach(node => { node.textContent = t(node.dataset.lvText); });
    }
    function syncHeader() {
      if (!state.active) return;
      const has = !!current();
      mount.querySelectorAll('.yt-focus').forEach(button => { button.disabled = !has; button.setAttribute('aria-pressed', String(state.focused)); });
      mount.querySelector('.yt-fill').disabled = !has;
      mount.querySelector('.yt-fill').setAttribute('aria-pressed', String(state.filled));
      mount.querySelector('.yt-filled-actions').hidden = !state.filled;
      mount.querySelector('.yt-restore').hidden = !state.filled;
      const viewport = mount.querySelector('.yt-viewport'); if (viewport) viewport.hidden = true;
      mount.querySelector('.media-open-files').disabled = state.picking;
    }
    function destroy() { state.destroyed = true; clearQueue(); root.remove(); }
    fillRange(volume); paintQueue(); paint();
    return { root, openFiles, setActive, setFocus, fill, pause, clearQueue, restore() { setFocus(false); fill(false); }, toggleQueue() { queue.hidden = !queue.hidden; body.classList.toggle('has-queue', !queue.hidden); return !queue.hidden; }, syncHeader, relabel, destroy, isActive: () => state.active, isFocused: () => state.focused, isFilled: () => state.filled };
  }
  window.LocalVideoPlayer = { create };
})();
