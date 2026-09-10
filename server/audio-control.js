'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// One sleeping native process replaces the repeated SoundVolumeView launches.
// The old path remains available on other platforms and with older helpers.
function createAudioControl(options = {}) {
  const exe = options.exe || path.join(__dirname, 'helper', 'xenon-helper.exe');
  const launch = options.spawn || spawn;
  const supported = options.supported ?? (process.platform === 'win32' && fs.existsSync(exe));
  const timeoutMs = options.timeoutMs || 5000;
  let child = null, starting = null, ready = false, disabled = !supported, buffer = '';
  let nextId = 0, onChange = null, lastRows = null;
  const pending = new Map();

  function rejectAll(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  function stop(disable = false) {
    disabled ||= disable;
    const old = child;
    child = null; ready = false; starting = null; lastRows = null; buffer = '';
    rejectAll(new Error('Native audio disconnected'));
    if (old) {
      old.stdin.end();
      const timer = setTimeout(() => { try { old.kill(); } catch {} }, 1500);
      timer.unref();
      old.once('exit', () => clearTimeout(timer));
    }
  }
  function validRows(rows) {
    return Array.isArray(rows) && rows.length <= 4096 && rows.every(row =>
      Array.isArray(row) && row.length === 22 && row.every(field => typeof field === 'string' && field.length <= 32768));
  }
  function ensure() {
    if (disabled) return Promise.resolve(false);
    if (ready) return Promise.resolve(true);
    if (starting) return starting;
    starting = new Promise(resolve => {
      let settled = false;
      const finish = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => { finish(false); stop(true); }, timeoutMs);
      let proc;
      try { proc = launch(exe, ['audio-control-serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { disabled = true; finish(false); return; }
      child = proc;
      proc.stdout.setEncoding('utf8');
      proc.stdin.on('error', () => { /* close/error owns recovery */ });
      proc.stderr.on('data', () => {});
      const failed = () => {
        finish(false);
        if (child === proc) stop(true);
      };
      proc.on('error', failed);
      proc.on('exit', failed);
      proc.stdout.on('data', chunk => {
        if (child !== proc) return;
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) { failed(); return; }
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          let message;
          try { message = JSON.parse(line); } catch { failed(); return; }
          if (message.event === 'unavailable') { failed(); return; }
          if (message.rows !== undefined && !validRows(message.rows)) { failed(); return; }
          if (message.event === 'audio' && message.rows) {
            lastRows = message.rows; ready = true; finish(true);
            if (onChange) onChange();
          } else if (pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id); clearTimeout(request.timer);
            if (message.ok === true) request.resolve(message);
            else request.reject(new Error(message.error || 'Native audio command failed'));
          }
        }
      });
    });
    return starting;
  }
  function request(action, args) {
    if (!ready || !child) return Promise.reject(new Error('Native audio unavailable'));
    if (pending.size >= 128) return Promise.reject(new Error('Too many audio commands'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(true); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, action, args }) + '\n', error => {
        if (error) stop(true);
      });
    });
  }
  async function rows() {
    if (!await ensure()) return null;
    // Explicit reads (including post-write verification) cross the command
    // queue; they cannot return a cached value from before the user's command.
    const result = await request('snapshot');
    if (!validRows(result.rows)) throw new Error('Missing audio snapshot');
    return result.rows;
  }
  async function command(args) {
    if (!['/SetVolume', '/Mute', '/Unmute', '/Switch'].includes(args[0])) return false;
    if (!await ensure()) return false;
    await request('command', args);
    // Never replay a dispatched write through a fallback: a timed-out toggle
    // may already have applied, and replay would reverse it.
    return true;
  }
  return { ensure, rows, command, stop, running: () => ready, onChange: fn => { onChange = fn; }, latest: () => lastRows };
}

module.exports = { createAudioControl };
