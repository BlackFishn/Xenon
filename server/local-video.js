'use strict';

// Native picker grants and bounded browser file imports both become opaque IDs.
// Browser requests never supply filesystem paths; only the local dashboard can
// reach this API.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { receiveStream } = require('./file-transfer');

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.webm', '.avi']);
const SUBTITLE_EXTS = new Set(['.srt', '.ass', '.ssa', '.vtt']);
const TEXT_SUBTITLES = new Set(['ass', 'ssa', 'subrip', 'webvtt', 'mov_text', 'text']);
const INPUT_FORMATS = 'matroska,webm,mov,avi';
const SUBTITLE_MAX = 8 * 1024 * 1024;
const MAX_FILES = 32;
const IMPORT_MAX = 16 * 1024 * 1024 * 1024;
const IMPORT_TOTAL_MAX = 32 * 1024 * 1024 * 1024;
const DISK_HEADROOM = 1024 * 1024 * 1024;
const OWNER_RE = /^[a-zA-Z0-9_-]{8,80}$/;

function mediaError(code) {
  return Object.assign(new Error(code), { code });
}

function label(value, fallback = '') {
  return String(value || fallback).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
}

async function validateFile(candidate, subtitles = false) {
  if (typeof candidate !== 'string' || candidate.length > 32767 || !path.isAbsolute(candidate)
      || /[\x00-\x1f]/.test(candidate) || /^[/\\]{2}/.test(candidate)
      || candidate.slice(process.platform === 'win32' ? 2 : 0).includes(':')) throw mediaError('invalid_file');
  const ext = path.extname(candidate).toLowerCase();
  if (!(subtitles ? SUBTITLE_EXTS : VIDEO_EXTS).has(ext)) throw mediaError('unsupported_file');
  const stat = await fs.promises.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw mediaError('invalid_file');
  if (subtitles && stat.size > SUBTITLE_MAX) throw mediaError('subtitle_too_large');
  const real = await fs.promises.realpath(candidate);
  const normalized = path.normalize(candidate);
  const equal = process.platform === 'win32' ? real.toLowerCase() === normalized.toLowerCase() : real === normalized;
  if (!equal) throw mediaError('invalid_file');
  return { path: real, size: stat.size, mtimeMs: stat.mtimeMs, ext };
}

function metadata(probe, record) {
  const streams = Array.isArray(probe.streams) ? probe.streams.slice(0, 128) : [];
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video || !Number.isInteger(video.index)) throw mediaError('no_video');
  const duration = Number(probe.format?.duration || video.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 24 * 3600) throw mediaError('invalid_duration');
  const tracks = type => streams.filter(s => s.codec_type === type && Number.isInteger(s.index)).map(s => ({
    id: String(s.index), language: label(s.tags?.language, 'und'),
    label: label(s.tags?.title, `${s.tags?.language || 'Track'} ${s.index}`),
    codec: label(s.codec_name, 'unknown'),
    ...(type === 'audio' ? { channels: Number(s.channels) || 0 } : {
      supported: TEXT_SUBTITLES.has(s.codec_name), delivery: 'vtt',
      ...(TEXT_SUBTITLES.has(s.codec_name) ? {} : { reason: 'bitmap_subtitle_unsupported' }),
      ...(s.codec_name === 'ass' || s.codec_name === 'ssa' ? { note: 'ass_text_only', styling: 'plain' } : {})
    })
  }));
  const audioTracks = tracks('audio');
  const defaultAudio = streams.find(s => s.codec_type === 'audio' && s.disposition?.default)?.index;
  record.formatStart = Number(probe.format?.start_time) || 0;
  record.video = { index: video.index, codec: video.codec_name, copy: video.codec_name === 'h264'
    && (!video.pix_fmt || ['yuv420p', 'yuvj420p', 'nv12'].includes(video.pix_fmt)) };
  record.info = {
    id: record.id, name: label(path.basename(record.path)), duration,
    width: Number(video.width) || 0, height: Number(video.height) || 0,
    audioTracks, subtitleTracks: tracks('subtitle'),
    defaultAudio: defaultAudio === undefined ? (audioTracks[0]?.id || 'off') : String(defaultAudio),
    defaultSubtitle: 'off', playbackMode: record.video.copy ? 'copy' : 'transcode'
  };
  return record.info;
}

function streamArgs(record, audio, start, rate = 1) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2',
    '-readrate', String(rate), '-ss', String(start), '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', INPUT_FORMATS, '-i', record.path, '-map', `0:${record.video.index}`];
  if (audio) args.push('-map', `0:${audio.id}`);
  else args.push('-an');
  // H.264 is sent unchanged: ordinary playback and language changes must not
  // continuously encode the picture. Other codecs use a bounded fallback.
  if (record.video.copy) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2',
    '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-pix_fmt', 'yuv420p', '-crf', '23');
  if (audio) {
    if (audio.codec === 'aac') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-threads', '2');
  }
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1');
  return args;
}

function shiftVtt(text, start) {
  const seconds = stamp => {
    const parts = stamp.split(':').map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  };
  const stamp = value => {
    const ms = Math.max(0, Math.round(value * 1000));
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const blocks = String(text).replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);
  return blocks.map(block => {
    const match = block.match(/((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})/);
    if (!match) return block;
    if (seconds(match[2]) <= start) return '';
    return block.replace(match[0], `${stamp(seconds(match[1]) - start)} --> ${stamp(seconds(match[2]) - start)}`);
  }).filter(Boolean).join('\n\n').trimEnd() + '\n';
}

function createLocalVideo(deps = {}) {
  const run = deps.execFile || promisify(execFile);
  const launch = deps.spawn || spawn;
  const platform = deps.platform || process.platform;
  const files = new Map();
  const active = new Map();
  const pendingStarts = new Map();
  const cancelledGenerations = new Set();
  const operations = new Set();
  const operationFiles = new Map();
  const subtitleCache = new Map();
  const subtitlePending = new Map();
  const positions = new Map();
  const pendingPositions = new Map();
  const imports = new Set();
  const ownedTemps = new Map();
  const cleanupJobs = new Set();
  let tempDirectory;
  let pickerBusy = false;
  let enginePromise;
  let closed = false;

  async function tempDir() {
    if (!tempDirectory) tempDirectory = (async () => {
      const base = await fs.promises.realpath(deps.tempRoot || os.tmpdir());
      // Reap only old, abandoned directories from this importer. Never follow
      // links or recursively delete arbitrary temp contents.
      const entries = await fs.promises.readdir(base, { withFileTypes: true });
      let reaped = 0;
      for (const entry of entries) {
        const match = entry.name.match(/^xenon-local-video-(\d+)-[A-Za-z0-9]+$/);
        if (!match || !entry.isDirectory() || ++reaped > 8) continue;
        const dir = path.resolve(base, entry.name);
        if (path.dirname(dir) !== base) continue;
        try {
          const stat = await fs.promises.lstat(dir);
          if (stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 24 * 3600 * 1000) continue;
          try { process.kill(Number(match[1]), 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
          const children = await fs.promises.readdir(dir, { withFileTypes: true });
          if (children.length > 96 || children.some(child => !child.isFile() || !/^[a-f0-9]{32}\.(mkv|mp4|m4v|mov|webm|avi|srt|ass|ssa|vtt)(?:\.part)?$/.test(child.name))) continue;
          for (const child of children) await fs.promises.unlink(path.join(dir, child.name));
          await fs.promises.rmdir(dir);
        } catch { /* a locked or unfamiliar directory is left alone */ }
      }
      return fs.promises.mkdtemp(path.join(base, `xenon-local-video-${process.pid}-`));
    })();
    return tempDirectory;
  }

  function removeOwned(file) {
    if (!ownedTemps.has(file)) return Promise.resolve();
    const job = (async () => {
      for (const delay of [0, 100, 500]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        try { await fs.promises.unlink(file); ownedTemps.delete(file); return; }
        catch (error) {
          if (error.code === 'ENOENT') { ownedTemps.delete(file); return; }
          if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) return;
        }
      }
    })();
    cleanupJobs.add(job);
    job.finally(() => cleanupJobs.delete(job)).catch(() => {});
    return job;
  }

  async function runProcess(file, args, options, fileId) {
    if (closed) throw mediaError('closed');
    if (operations.size >= 4) throw mediaError('player_busy');
    const operation = run(file, args, options);
    operations.add(operation);
    if (fileId) operationFiles.set(operation, fileId);
    try { return await operation; }
    finally { operations.delete(operation); operationFiles.delete(operation); }
  }

  async function engines() {
    if (!enginePromise) enginePromise = (async () => {
      if (platform !== 'win32') return { ok: false, available: false, error: 'unsupported_platform' };
      const ffmpeg = deps.getFfmpegPath?.() || 'ffmpeg.exe';
      const ffprobe = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
      try { await runProcess(ffmpeg, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 65536 }); }
      catch { return { ok: false, available: false, error: 'ffmpeg_missing' }; }
      try { await runProcess(ffprobe, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 65536 }); }
      catch { return { ok: false, available: false, error: 'ffprobe_missing' }; }
      return { ok: true, available: true, engine: 'ffmpeg', platform, ffmpeg, ffprobe };
    })();
    return enginePromise;
  }

  async function status() {
    const { ffmpeg, ffprobe, ...safe } = await engines();
    return { ...safe, pickerSupported: platform === 'win32', importSupported: true,
      maxImportBytes: IMPORT_MAX, maxImportTotalBytes: IMPORT_TOTAL_MAX, maxSubtitleBytes: SUBTITLE_MAX,
      activeStreams: active.size };
  }

  async function pick(kind) {
    if (closed) throw mediaError('closed');
    if (pickerBusy) throw mediaError('picker_busy');
    pickerBusy = true;
    try {
      const engine = await engines();
      if (!engine.ok) throw mediaError(engine.error);
      if (closed) throw mediaError('closed');
      const result = deps.pickFiles ? await deps.pickFiles(kind) : JSON.parse((await runProcess(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'local-video-picker.ps1'), '-Kind', kind],
        { windowsHide: true, timeout: 120000, maxBuffer: 128 * 1024, encoding: 'utf8' }
      )).stdout);
      if (!Array.isArray(result) || result.length > MAX_FILES || result.some(x => typeof x !== 'string')) throw mediaError('invalid_selection');
      return result;
    } catch (error) {
      if (['invalid_selection', 'closed', 'ffmpeg_missing', 'ffprobe_missing', 'unsupported_platform'].includes(error.code)) throw error;
      throw mediaError('picker_failed');
    } finally { pickerBusy = false; }
  }

  async function pickVideos() {
    const selected = await pick('Videos');
    if (!selected.length) return { ok: true, files: [], cancelled: true };
    const engine = await engines();
    const result = [];
    const errors = [];
    for (const chosen of selected) {
      if (closed) throw mediaError('closed');
      try {
        result.push(await registerVideo(chosen, path.basename(chosen), engine));
      } catch (error) {
        errors.push({ name: label(path.basename(chosen)), error: ['invalid_file', 'unsupported_file', 'library_full', 'no_video', 'invalid_duration'].includes(error.code) ? error.code : 'probe_failed' });
      }
    }
    return { ok: result.length > 0, files: result, ...(errors.length ? { errors, error: result.length ? undefined : errors[0].error } : {}) };
  }

  async function registerVideo(selected, name, engine, ticket) {
    const validated = await validateFile(selected);
    if (files.size >= MAX_FILES) throw mediaError('library_full');
    const id = ticket?.id || crypto.randomBytes(16).toString('hex');
    const { stdout } = await runProcess(engine.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', INPUT_FORMATS, '-show_streams', '-show_format', '-of', 'json', validated.path],
    { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, id);
    if (files.size >= MAX_FILES) throw mediaError('library_full');
    if (closed || ticket?.cancelled) throw mediaError('import_aborted');
    const record = { ...validated, id, external: new Map(), imported: !!ticket };
    const info = metadata(JSON.parse(stdout), record);
    info.name = label(name);
    files.set(record.id, record);
    return info;
  }

  function getFile(id) {
    const record = files.get(id);
    if (!record || closed) throw mediaError('unknown_file');
    return record;
  }

  async function unchanged(record, subtitles = false) {
    const current = await validateFile(record.path, subtitles);
    if (current.size !== record.size || current.mtimeMs !== record.mtimeMs) throw mediaError('file_changed');
  }

  async function pickSubtitle(id) {
    const record = getFile(id);
    if (record.external.size >= 8) throw mediaError('subtitle_limit');
    const selected = await pick('Subtitle');
    if (!selected.length) return { ok: true, cancelled: true };
    const file = await validateFile(selected[0], true);
    return addSubtitle(record, file, path.basename(file.path));
  }

  function addSubtitle(record, file, name) {
    if (!files.has(record.id) || closed) throw mediaError('unknown_file');
    if (record.external.size >= 8) throw mediaError('subtitle_limit');
    const track = { id: `external-${crypto.randomBytes(16).toString('hex')}`, label: label(name),
      language: 'und', codec: file.ext.slice(1), supported: true, delivery: 'vtt', external: true,
      ...(['.ass', '.ssa'].includes(file.ext) ? { note: 'ass_text_only', styling: 'plain' } : {}) };
    record.external.set(track.id, file);
    record.info.subtitleTracks.push(track);
    return { ok: true, file: record.info };
  }

  async function importFile(req, params = {}) {
    const name = params.name;
    const size = Number(params.size);
    const isSubtitle = params.id !== undefined && params.id !== '';
    if (typeof name !== 'string' || !name || Buffer.byteLength(name, 'utf8') > 255 || /[\x00-\x1f\x7f\\/:]/.test(name)
        || !Number.isSafeInteger(size) || size <= 0) throw mediaError('invalid_file');
    const ext = path.extname(name).toLowerCase();
    if (!(isSubtitle ? SUBTITLE_EXTS : VIDEO_EXTS).has(ext)) throw mediaError('unsupported_file');
    if (size > (isSubtitle ? SUBTITLE_MAX : IMPORT_MAX)) throw mediaError('import_too_large');
    if (req.headers?.['content-length'] !== undefined && Number(req.headers['content-length']) !== size) throw mediaError('invalid_file');
    if (closed || req.aborted || req.destroyed) throw mediaError('import_aborted');
    if (imports.size >= 2) throw mediaError('import_busy');
    const record = isSubtitle ? getFile(params.id) : null;
    if (record && record.external.size + [...imports].filter(job => job.parentId === record.id).length >= 8) throw mediaError('subtitle_limit');
    if (!record && files.size + [...imports].filter(job => !job.parentId).length >= MAX_FILES) throw mediaError('library_full');
    const reserved = [...imports].reduce((sum, job) => sum + job.reserved, 0);
    const stored = [...ownedTemps.values()].reduce((sum, value) => sum + value, 0);
    if (stored + reserved + size > IMPORT_TOTAL_MAX) throw mediaError('import_quota');
    const ticket = { id: crypto.randomBytes(16).toString('hex'), parentId: record?.id, req, cancelled: false, reserved: size, received: 0 };
    ticket.done = new Promise(resolve => { ticket.finish = resolve; });
    imports.add(ticket);
    let target;
    let idle;
    const abort = () => {
      ticket.cancelled = true;
      for (const operation of operations) {
        if (operationFiles.get(operation) === ticket.id) {
          try { operation.child?.kill(); } catch { /* already exited */ }
        }
      }
    };
    const cancel = () => { abort(); req.emit('aborted'); };
    ticket.cancel = cancel;
    req.on('aborted', abort);
    req.on('error', abort);
    req.socket?.on('close', abort);
    try {
      const engine = await engines();
      if (!engine.ok) throw mediaError(engine.error);
      const dir = await tempDir();
      const disk = await (deps.statfs || fs.promises.statfs)(dir);
      const remaining = [...imports].filter(job => job !== ticket).reduce((sum, job) => sum + Math.max(0, job.reserved - job.received), 0);
      if (Number(disk.bavail) * Number(disk.bsize) < size + remaining + DISK_HEADROOM) throw mediaError('no_space');
      if (closed || ticket.cancelled || req.aborted || req.destroyed) throw mediaError('import_aborted');
      target = path.join(dir, ticket.id + ext);
      const refresh = () => { clearTimeout(idle); idle = setTimeout(cancel, deps.importIdleMs || 60000); idle.unref?.(); };
      refresh();
      const result = await receiveStream(req, target, { limit: size, onProgress(bytes) { ticket.received = bytes; refresh(); } });
      clearTimeout(idle);
      ownedTemps.set(target, result.bytes);
      ticket.reserved = 0;
      if (result.bytes !== size || closed || ticket.cancelled) throw mediaError('import_aborted');
      if (record) {
        const file = await validateFile(target, true);
        if (ticket.cancelled) throw mediaError('import_aborted');
        const result = addSubtitle(record, { ...file, imported: true }, name);
        return { ...result, importedTrackId: result.file.subtitleTracks.at(-1).id };
      }
      return { ok: true, files: [await registerVideo(target, name, engine, ticket)] };
    } catch (error) {
      if (target) await removeOwned(target);
      const known = ['invalid_file', 'unsupported_file', 'import_too_large', 'no_space', 'import_quota', 'import_aborted', 'library_full', 'subtitle_limit', 'unknown_file', 'ffmpeg_missing', 'ffprobe_missing', 'unsupported_platform'];
      if (known.includes(error.code)) throw error;
      if (ticket.cancelled || error.code === 'XFER_ABORTED') throw mediaError('import_aborted');
      if (error.code === 'XFER_TOO_BIG') throw mediaError('import_too_large');
      if (error.code === 'ENOSPC') throw mediaError('no_space');
      throw mediaError('import_failed');
    } finally {
      clearTimeout(idle);
      imports.delete(ticket);
      req.off('aborted', abort);
      req.off('error', abort);
      req.socket?.off('close', abort);
      ticket.finish();
    }
  }

  function position(value, record) {
    const result = value === undefined || value === null || value === '' ? 0 : Number(value);
    if (!Number.isFinite(result) || result < 0 || result >= record.info.duration) throw mediaError('invalid_position');
    return result;
  }

  async function prepare(params) {
    const record = getFile(params.id);
    const start = position(params.start, record);
    await unchanged(record);
    if (!record.video.copy) return { ok: true, start, actualStart: start, seekOffset: 0 };
    const key = `${record.id}:${start}`;
    if (positions.has(key)) return positions.get(key);
    if (!pendingPositions.has(key)) {
      if (pendingPositions.size >= 2) throw mediaError('player_busy');
      const pending = (async () => {
        const engine = await engines();
        if (!engine.ok) throw mediaError(engine.error);
        // Copy one packet at the identical seek point used by playback. Its
        // real DTS accounts for B-frame reordering and variable frame rates;
        // no picture is decoded/encoded and no full-file index is constructed.
        const { stdout } = await runProcess(engine.ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(start),
          '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', record.path,
          '-map', `0:${record.video.index}`, '-c', 'copy', '-frames:v', '1', '-copyts', '-f', 'framecrc', 'pipe:1'],
        { windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' }, record.id);
        const timebase = stdout.match(/^#tb 0:\s*(\d+)\/(\d+)/m);
        const packet = stdout.match(/^0,\s*(-?\d+),\s*(-?\d+),/m);
        if (!timebase || !packet) throw mediaError('seek_failed');
        const actualStart = Number(packet[1]) * Number(timebase[1]) / Number(timebase[2]) - record.formatStart;
        if (!Number.isFinite(actualStart) || actualStart < -2 || actualStart > start + 0.1 || start - actualStart > 30) throw mediaError('seek_failed');
        const result = { ok: true, start, actualStart, seekOffset: Math.max(0, start - actualStart) };
        if (closed || !files.has(record.id)) throw mediaError('unknown_file');
        if (positions.size >= 32) positions.delete(positions.keys().next().value);
        positions.set(key, result);
        return result;
      })();
      pendingPositions.set(key, pending);
      pending.finally(() => pendingPositions.delete(key)).catch(() => {});
    }
    try { return await pendingPositions.get(key); }
    catch { throw mediaError('seek_failed'); }
  }

  async function subtitles(params) {
    const record = getFile(params.id);
    const track = record.info.subtitleTracks.find(t => t.id === String(params.track));
    if (!track || !track.supported) throw mediaError('unsupported_subtitle');
    const start = params.start === undefined || params.start === '' ? 0 : Number(params.start);
    if (!Number.isFinite(start) || start < -2 || start >= record.info.duration) throw mediaError('invalid_position');
    const external = record.external.get(track.id);
    await unchanged(external || record, !!external);
    const key = `${record.id}:${track.id}`;
    if (!subtitleCache.has(key) && !subtitlePending.has(key)) {
      // Cache text only, not another copy of the video. Coalesce concurrent tab
      // requests and keep at most four bounded subtitle tracks in memory.
      if (subtitlePending.size >= 2) throw mediaError('player_busy');
      const pending = (async () => {
        const engine = await engines();
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
          '-format_whitelist', external ? 'srt,ass,webvtt' : INPUT_FORMATS, '-i', (external || record).path];
        if (!external) args.push('-map', `0:${track.id}`);
        args.push('-vn', '-an', '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1');
        const { stdout } = await runProcess(engine.ffmpeg, args, { windowsHide: true, timeout: 30000, maxBuffer: SUBTITLE_MAX, encoding: 'utf8' }, record.id);
        if (closed || !files.has(record.id)) throw mediaError('closed');
        if (subtitleCache.size >= 4) subtitleCache.delete(subtitleCache.keys().next().value);
        subtitleCache.set(key, stdout);
        return stdout;
      })();
      subtitlePending.set(key, pending);
      pending.finally(() => subtitlePending.delete(key)).catch(() => {});
    }
    try { return shiftVtt(subtitleCache.has(key) ? subtitleCache.get(key) : await subtitlePending.get(key), start); }
    catch { throw mediaError('subtitle_failed'); }
  }

  function stop(params = {}) {
    if (!OWNER_RE.test(String(params.owner || ''))) throw mediaError('invalid_owner');
    if (params.generation && !OWNER_RE.test(String(params.generation))) throw mediaError('invalid_owner');
    if (params.generation) {
      cancelledGenerations.add(params.generation);
      if (cancelledGenerations.size > 64) cancelledGenerations.delete(cancelledGenerations.values().next().value);
    }
    const pending = pendingStarts.get(params.owner);
    if (pending && (!params.generation || params.generation === pending.generation)) {
      pending.cancelled = true;
      pendingStarts.delete(params.owner);
      if (!pending.res.destroyed) pending.res.destroy();
    }
    const session = active.get(params.owner);
    if (session && (!params.generation || params.generation === session.generation)) session.stop();
    return { ok: true };
  }

  async function stream(req, res, params) {
    const owner = String(params.owner || '');
    const generation = String(params.generation || '');
    if (!OWNER_RE.test(owner) || !OWNER_RE.test(generation)) throw mediaError('invalid_owner');
    if (params.subtitle && params.subtitle !== 'off') throw mediaError('use_subtitle_track');
    const record = getFile(params.id);
    const start = position(params.start, record);
    const audioId = String(params.audio === undefined || params.audio === '' ? record.info.defaultAudio : params.audio);
    const audio = audioId === 'off' ? null : record.info.audioTracks.find(t => t.id === audioId);
    if (audioId !== 'off' && !audio) throw mediaError('invalid_audio');
    const rate = params.rate === undefined || params.rate === '' ? 1 : Number(params.rate);
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw mediaError('invalid_rate');
    if (closed || req.aborted || res.destroyed || cancelledGenerations.has(generation)) {
      if (!res.destroyed) res.destroy();
      return;
    }
    if (pendingStarts.size >= 32) throw mediaError('player_busy');
    const ticket = { generation, cancelled: false, fileId: record.id, res };
    const previous = pendingStarts.get(owner);
    if (previous) { previous.cancelled = true; if (!previous.res.destroyed) previous.res.destroy(); }
    pendingStarts.set(owner, ticket);
    let engine;
    try {
      await unchanged(record);
      engine = await engines();
      if (!engine.ok) throw mediaError(engine.error);
    } catch (error) {
      if (pendingStarts.get(owner) === ticket) pendingStarts.delete(owner);
      throw error;
    }
    if (closed || ticket.cancelled || req.aborted || res.destroyed || pendingStarts.get(owner) !== ticket) {
      if (pendingStarts.get(owner) === ticket) pendingStarts.delete(owner);
      if (!res.destroyed) res.destroy();
      return;
    }
    pendingStarts.delete(owner);
    active.get(owner)?.stop();
    if (active.size >= 2) throw mediaError('player_busy');
    const child = launch(engine.ffmpeg, streamArgs(record, audio, start, rate), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let finished = false;
    let started = false;
    const session = { generation, fileId: record.id, stop: () => {
      if (finished) return;
      finished = true;
      clearTimeout(startup);
      if (active.get(owner) === session) active.delete(owner);
      try { child.kill(); } catch { /* already exited */ }
      if (!res.writableEnded && !res.destroyed) res.destroy();
    } };
    const startup = setTimeout(session.stop, 20000);
    startup.unref?.();
    active.set(owner, session);
    req.once('aborted', session.stop);
    res.once('close', session.stop);
    res.once('error', session.stop);
    child.once('error', session.stop);
    child.stdout.once('error', session.stop);
    child.stdout.once('data', () => {
      started = true;
      clearTimeout(startup);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'X-Xenon-Video-Mode': record.info.playbackMode });
    });
    child.once('close', code => {
      if (!started || code !== 0) session.stop();
      else {
        finished = true;
        clearTimeout(startup);
        if (active.get(owner) === session) active.delete(owner);
        if (!res.writableEnded && !res.destroyed) res.end();
      }
    });
    child.stdout.pipe(res);
  }

  function close() {
    closed = true;
    const pendingImports = [...imports].map(ticket => ticket.done);
    for (const ticket of imports) ticket.cancel();
    for (const session of active.values()) session.stop();
    for (const ticket of pendingStarts.values()) { ticket.cancelled = true; if (!ticket.res.destroyed) ticket.res.destroy(); }
    pendingStarts.clear();
    for (const operation of operations) {
      try { operation.child?.kill(); } catch { /* already exited */ }
    }
    files.clear();
    subtitleCache.clear();
    for (const file of ownedTemps.keys()) void removeOwned(file);
    return (async () => {
      await Promise.allSettled(pendingImports);
      await Promise.allSettled([...cleanupJobs]);
      if (tempDirectory) {
        try { await fs.promises.rmdir(await tempDirectory); } catch { /* an in-flight atomic writer still owns its part */ }
      }
    })();
  }

  function releaseFiles(ids) {
    if (!Array.isArray(ids) || ids.length > MAX_FILES || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) throw mediaError('invalid_files');
    const released = new Set(ids);
    const releasedFiles = [];
    for (const id of released) {
      const record = files.get(id);
      if (record?.imported) releasedFiles.push(record.path);
      for (const external of record?.external.values() || []) if (external.imported) releasedFiles.push(external.path);
      files.delete(id);
    }
    for (const ticket of imports) if (released.has(ticket.parentId)) ticket.cancel();
    for (const session of active.values()) if (released.has(session.fileId)) session.stop();
    for (const [owner, ticket] of pendingStarts) {
      if (released.has(ticket.fileId)) {
        ticket.cancelled = true;
        pendingStarts.delete(owner);
        if (!ticket.res.destroyed) ticket.res.destroy();
      }
    }
    for (const operation of operations) {
      if (released.has(operationFiles.get(operation))) {
        try { operation.child?.kill(); } catch { /* already exited */ }
      }
    }
    for (const cache of [subtitleCache, positions]) {
      for (const key of cache.keys()) if (released.has(key.split(':')[0])) cache.delete(key);
    }
    for (const file of releasedFiles) void removeOwned(file);
    return { ok: true };
  }

  function discardImport(result) {
    if (Array.isArray(result?.files)) return releaseFiles(result.files.map(file => file.id));
    const record = files.get(result?.file?.id);
    const id = result?.importedTrackId;
    const external = record?.external.get(id);
    if (external?.imported) {
      record.external.delete(id);
      record.info.subtitleTracks = record.info.subtitleTracks.filter(track => track.id !== id);
      subtitleCache.delete(`${record.id}:${id}`);
      void removeOwned(external.path);
    }
    return { ok: true };
  }

  return { status, pickVideos, pickSubtitle, importFile, discardImport, stream, subtitles, prepare, releaseFiles, stop, close };
}

module.exports = { createLocalVideo, validateFile, streamArgs, metadata, shiftVtt };
