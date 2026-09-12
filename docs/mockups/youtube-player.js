'use strict';

// Standalone design prototype: no YouTube embed, API calls, or saved preferences.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const sample = { id: 'sample', title: 'Take the long way home — a sunset chill mix', channel: 'Slow Days', scene: 'sunset', art: 'Slow days', duration: 2538 };
const queue = [
  { id: 'forest', title: 'A cabin in the woods · cozy jazz', channel: 'The Quiet Corner', scene: 'forest', art: 'Forest hours', duration: 3612 },
  { id: 'night', title: 'Midnight coding — deep focus mix', channel: 'Soft Signal', scene: 'night', art: 'After hours', duration: 2755 },
  { id: 'coast', title: 'Somewhere by the sea | 4K', channel: 'Wander Often', scene: 'coast', art: 'Somewhere', duration: 1470 },
  { id: 'rose', title: 'Sunday morning, nothing to do', channel: 'Slow Days', scene: 'rose', art: 'Sunday slow', duration: 2164 },
];
const favorites = [];
const recent = [sample];
let current = sample;
let playing = true;
let tab = 'queue';
let toastTimer;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

function formatTime(seconds) {
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function paintRange(input) {
  input.style.setProperty('--progress', (Number(input.value) / Number(input.max)) * 100 + '%');
}

function paintPlay() {
  $$('.stage-play, #play-toggle').forEach(button => {
    button.replaceChildren(icon(playing ? 'pause' : 'play'));
    button.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
    button.disabled = !current;
  });
  $('.video-stage').classList.toggle('paused', !playing);
  $('.video-stage').classList.toggle('empty', !current);
  revealControls();
  $('#play-state').textContent = playing ? 'Playing' : 'Paused';
}

function paintFavorite() {
  const saved = !!current && favorites.some(video => video.id === current.id);
  $('#favorite').setAttribute('aria-pressed', String(saved));
  $('#favorite').setAttribute('aria-label', saved ? 'Remove from favorites' : 'Save to favorites');
  $('#favorite').title = saved ? 'Remove from favorites' : 'Save to favorites';
  $('#favorite').disabled = !current;
}

function selectVideo(video) {
  current = video;
  playing = true;
  $('.empty-stage').hidden = true;
  $('.video-stage').dataset.scene = video.scene;
  $('#video-title').textContent = video.title;
  $('#video-channel').textContent = video.channel + ' · Design preview';
  $('#seek').max = video.duration;
  $('#seek').value = 0;
  $('#duration').textContent = formatTime(video.duration);
  $('#elapsed').textContent = '0:00';
  paintRange($('#seek'));
  if (!recent.some(item => item.id === video.id)) recent.unshift(video);
  paintPlay();
  paintFavorite();
  paintLibrary();
}

function paintLibrary() {
  const list = $('#video-list');
  list.replaceChildren();
  const videos = tab === 'favorites' ? favorites : tab === 'recent' ? recent : queue;
  $('#queue-count').textContent = queue.length;
  $('#next').disabled = queue.length === 0;
  $('#list-label').textContent = tab === 'queue' ? 'UP NEXT' : tab === 'favorites' ? 'SAVED FOR LATER' : 'RECENTLY PLAYED';
  const minutes = Math.round(videos.reduce((total, video) => total + video.duration, 0) / 60);
  $('#list-meta').textContent = videos.length + ' video' + (videos.length === 1 ? '' : 's') + (videos.length ? ' · ' + (minutes >= 60 ? Math.floor(minutes / 60) + 'h ' : '') + (minutes % 60) + 'm' : '');
  if (!videos.length) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = tab === 'favorites' ? 'Tap the heart on a video to keep it here.' : tab === 'recent' ? 'Videos you play will appear here.' : 'A little room for your next favorite. Paste a link to add it.';
    list.append(empty);
  }
  videos.forEach(video => {
    const row = document.createElement('div');
    row.className = 'video-row';
    const play = document.createElement('button');
    play.className = 'row-select';
    play.setAttribute('aria-label', 'Play ' + video.title);
    const thumbnail = document.createElement('span');
    thumbnail.className = 'thumbnail';
    thumbnail.dataset.scene = video.scene;
    thumbnail.innerHTML = '<span class="landscape"><span class="sun"></span><span class="mountain far"></span><span class="mountain middle"></span><span class="mountain near"></span></span>';
    const art = document.createElement('span');
    art.className = 'thumbnail-label';
    art.textContent = video.art;
    const time = document.createElement('span');
    time.className = 'thumbnail-time';
    time.textContent = formatTime(video.duration);
    thumbnail.append(art, time);
    const copy = document.createElement('span');
    copy.className = 'row-copy';
    const title = document.createElement('strong');
    title.textContent = video.title;
    const channel = document.createElement('span');
    channel.textContent = video.channel;
    copy.append(title, channel);
    play.append(thumbnail, copy);
    play.addEventListener('click', () => {
      if (tab === 'queue') queue.splice(queue.indexOf(video), 1);
      selectVideo(video);
    });
    row.append(play);
    if (tab !== 'recent') {
      const remove = document.createElement('button');
      remove.className = 'icon-button remove-video';
      remove.setAttribute('aria-label', 'Remove ' + video.title + ' from ' + tab);
      remove.append(icon('close'));
      remove.addEventListener('click', () => { videos.splice(videos.indexOf(video), 1); paintLibrary(); paintFavorite(); });
      row.append(remove);
    }
    list.append(row);
  });
}

function readVideoLink() {
  const input = $('#video-link');
  const value = input.value.trim();
  let id = '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Invalid URL');
    if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
    else if (hosts.includes(url.hostname)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else id = /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1] || '';
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Invalid video ID');
  } catch {
    $('#link-error').textContent = 'Paste a YouTube video link, such as youtube.com/watch?v=… or youtu.be/…';
    $('#link-error').hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return null;
  }
  $('#link-error').hidden = true;
  input.removeAttribute('aria-invalid');
  return { id, title: 'YouTube video · ' + id, channel: 'Pasted link', scene: 'sunset', art: 'Your next watch', duration: 2538, url: 'https://www.youtube.com/watch?v=' + id };
}

$('#link-form').addEventListener('submit', event => {
  event.preventDefault();
  const video = readVideoLink();
  if (!video) return;
  selectVideo(video);
  $('#video-link').value = '';
  notify('Link loaded in the mockup. Video playback is simulated.');
});

$('#add-queue').addEventListener('click', () => {
  const video = readVideoLink();
  if (!video) return;
  queue.push(video);
  $('#video-link').value = '';
  setTab('queue');
  notify('Added to your preview queue.');
});

$('#paste').addEventListener('click', async () => {
  try {
    $('#video-link').value = await navigator.clipboard.readText();
    $('#video-link').focus();
  } catch {
    $('#video-link').focus();
    notify('Press Ctrl+V or ⌘V to paste your YouTube link.');
  }
});
$('#add-another').addEventListener('click', () => $('#video-link').focus());
$('#video-link').addEventListener('input', () => { $('#link-error').hidden = true; $('#video-link').removeAttribute('aria-invalid'); });
$$('.stage-play, #play-toggle').forEach(button => button.addEventListener('click', () => { playing = !playing; paintPlay(); }));
$('#seek').addEventListener('input', event => { paintRange(event.target); $('#elapsed').textContent = formatTime(Number(event.target.value)); });
$('#next').addEventListener('click', () => { if (queue.length) selectVideo(queue.shift()); });
$('#volume').addEventListener('input', event => {
  paintRange(event.target);
  const muted = Number(event.target.value) === 0;
  $('#mute').setAttribute('aria-pressed', String(muted));
  $('#mute').setAttribute('aria-label', muted ? 'Unmute preview' : 'Mute preview');
  $('#mute').replaceChildren(icon(muted ? 'muted' : 'volume'));
});
let previousVolume = 65;
$('#mute').addEventListener('click', () => {
  if (Number($('#volume').value)) { previousVolume = Number($('#volume').value); $('#volume').value = 0; }
  else $('#volume').value = previousVolume;
  $('#volume').dispatchEvent(new Event('input'));
});
$('#favorite').addEventListener('click', () => {
  if (!current) return;
  const index = favorites.findIndex(video => video.id === current.id);
  if (index >= 0) favorites.splice(index, 1);
  else favorites.push(current);
  paintFavorite();
  paintLibrary();
  notify(index >= 0 ? 'Removed from favorites.' : 'Saved to your preview favorites.');
});
$('#loop').addEventListener('click', event => {
  const button = event.currentTarget;
  const enabled = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(enabled));
  notify(enabled ? 'Loop enabled in the preview.' : 'Loop disabled.');
});
$('#autoplay').addEventListener('click', event => {
  const button = event.currentTarget;
  button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
});
$('#speed').addEventListener('change', event => notify('Preview playback speed: ' + event.target.selectedOptions[0].textContent));
// Fill-widget changes only the surrounding layout; a real iframe stays mounted.
function setFocused(focused) {
  const widget = $('.widget');
  if (focused) {
    widget.style.setProperty('--focus-height', Math.min(widget.getBoundingClientRect().height, Math.max(360, window.innerHeight - 130)) + 'px');
  }
  widget.classList.toggle('focused', focused);
  $('.focus-toolbar').hidden = !focused;
  $('#expand').setAttribute('aria-pressed', String(focused));
  if (!focused) widget.style.removeProperty('--focus-height');
  (focused ? $('#exit-focus') : $('#expand')).focus({ preventScroll: true });
  revealControls();
}
$('#expand').addEventListener('click', () => setFocused(true));
$('#exit-focus').addEventListener('click', () => setFocused(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.fullscreenElement && $('.widget').classList.contains('focused')) setFocused(false);
});

// This mockup uses the browser API. Production keeps YouTube's fullscreen button.
$('#fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('.video-stage').requestFullscreen();
  } catch {
    notify('Fullscreen is unavailable in this browser. Use Fill widget instead.');
  }
});
document.addEventListener('fullscreenchange', () => {
  const fullscreen = !!document.fullscreenElement;
  $('#fullscreen').setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Fullscreen');
  $('#fullscreen').title = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
  revealControls();
});
let controlsTimer;
function revealControls() {
  $('.video-stage').classList.add('controls-visible');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => $('.video-stage').classList.remove('controls-visible'), 2400);
}
['pointermove', 'pointerdown', 'focusin'].forEach(type => $('.video-stage').addEventListener(type, revealControls));
$('#open-youtube').addEventListener('click', () => notify('In the finished widget, this opens the current video on YouTube.'));

function setTab(name) {
  tab = name;
  $$('[data-tab]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    button.tabIndex = button.dataset.tab === tab ? 0 : -1;
  });
  $('#library-panel').setAttribute('aria-labelledby', 'tab-' + tab);
  paintLibrary();
}
$$('[data-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
$('.library-tabs').addEventListener('keydown', event => {
  const tabs = $$('[data-tab]');
  let index = tabs.indexOf(document.activeElement);
  if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = tabs.length - 1;
  else return;
  event.preventDefault();
  setTab(tabs[index].dataset.tab);
  tabs[index].focus();
});
$$('button[data-layout]').forEach(button => button.addEventListener('click', () => {
  if ($('.widget').classList.contains('focused')) setFocused(false);
  $('.canvas').dataset.layout = button.dataset.layout;
  $$('button[data-layout]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));
$('#empty-preview').addEventListener('click', () => {
  current = null;
  playing = false;
  $('.empty-stage').hidden = false;
  $('#video-title').textContent = 'Your next watch starts here';
  $('#video-channel').textContent = 'Paste a link or choose a video from your queue.';
  $('#seek').value = 0;
  $('#elapsed').textContent = '0:00';
  $('#duration').textContent = '0:00';
  paintRange($('#seek'));
  paintPlay();
  paintFavorite();
  $('#video-link').focus();
});
$('#restore-demo').addEventListener('click', () => selectVideo(sample));
paintLibrary();
revealControls();
