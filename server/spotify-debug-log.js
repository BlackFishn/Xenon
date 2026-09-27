'use strict';

const fs = require('fs');
const MAX_BYTES = 2 * 1024 * 1024;
const FIXED_PATHS = new Set([
  '/api/token', '/me', '/me/player', '/me/player/queue', '/me/player/devices',
  '/me/player/currently-playing', '/me/player/recently-played', '/me/player/play',
  '/me/player/pause', '/me/player/next', '/me/player/previous', '/me/player/shuffle',
  '/me/player/repeat', '/me/player/volume', '/me/player/seek', '/me/playlists',
  '/me/albums', '/me/tracks', '/me/tracks/contains', '/me/following', '/search',
]);

// Only known endpoint templates leave this boundary; unknown paths and every
// query string disappear rather than becoming a new source of personal data.
function endpointTemplate(input) {
  try {
    const url = new URL(input);
    if (!['api.spotify.com', 'accounts.spotify.com'].includes(url.hostname)) return '/other';
    const pathname = url.hostname === 'api.spotify.com' ? url.pathname.replace(/^\/v1(?=\/)/, '') : url.pathname;
    if (FIXED_PATHS.has(pathname)) return pathname;
    if (/^\/artists\/[^/]+\/albums$/.test(pathname)) return '/artists/:id/albums';
    if (/^\/albums\/[^/]+\/tracks$/.test(pathname)) return '/albums/:id/tracks';
    if (/^\/playlists\/[^/]+\/tracks$/.test(pathname)) return '/playlists/:id/tracks';
    if (/^\/tracks\/[^/]+$/.test(pathname)) return '/tracks/:id';
  } catch { /* unknown shape */ }
  return '/other';
}

function rateLimitReason(data) {
  const reason = data && data.error && data.error.reason;
  return ['QUOTA_EXCEEDED', 'RATE_LIMITED', 'RATE_LIMIT_EXCEEDED'].includes(reason) ? reason : 'unknown';
}

// No queue or background timer: this optional diagnostic file is small, bounded,
// and best effort. A failed append/rotation must never affect Spotify controls.
function createSpotifyDebugLog(file, instanceId, now = Date.now) {
  const enabled = typeof file === 'string' && file.length > 0;
  return {
    enabled,
    write(event, fields) {
      if (!enabled) return;
      try {
        const line = JSON.stringify({ timestamp: new Date(now()).toISOString(), pid: process.pid, instanceId, event, ...fields }) + '\n';
        const bytes = Buffer.byteLength(line);
        if (bytes > MAX_BYTES) return;
        let size = 0;
        try { size = fs.statSync(file).size; } catch { /* first append */ }
        if (size + bytes > MAX_BYTES) {
          try { fs.unlinkSync(file + '.1'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          fs.renameSync(file, file + '.1');
        }
        fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      } catch { /* diagnostics are fail-open */ }
    },
  };
}

module.exports = { createSpotifyDebugLog, endpointTemplate, rateLimitReason, MAX_BYTES };
