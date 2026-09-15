'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
function launchGameBar(uri) {
  // ShellExecute resolves the registered protocol; Explorer can return before
  // delivering it (or exit with code 1 even after a successful handoff).
  return runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Start-Process -FilePath '" + uri + "'"], { windowsHide: true, timeout: 4000 });
}
const PACKAGE_RE = /^Xenon\.Crosshair_[a-z0-9]{13}$/i;
const STATUS_FILE = 'xenon-crosshair-status.json';
const COMMAND_FILE = 'xenon-crosshair-command.json';
const FRESH_MS = 8000;
const COMMAND_MS = 5000;

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function validateCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid crosshair command.');
  const keys = Object.keys(value);
  if (!keys.length || keys.some(k => !['enabled', 'color', 'size', 'center'].includes(k))) throw fail('Unknown crosshair setting.');
  if ('enabled' in value && typeof value.enabled !== 'boolean') throw fail('Enabled must be true or false.');
  if ('center' in value && value.center !== true) throw fail('Center must be true.');
  if ('color' in value && (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color))) throw fail('Use a six-digit hex color.');
  if ('size' in value && (!Number.isInteger(value.size) || value.size < 8 || value.size > 48)) throw fail('Size must be 8–48.');
  return { ...value, ...('color' in value ? { color: value.color.toUpperCase() } : {}) };
}

async function readJson(file) {
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > 4096) throw fail('Invalid widget state.', 502);
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function createCrosshairControl({ platform = process.platform, localAppData = process.env.LOCALAPPDATA,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  openGameBar = launchGameBar } = {}) {
  let queue = Promise.resolve();

  async function folder() {
    if (platform !== 'win32' || !localAppData) return null;
    const packages = path.join(localAppData, 'Packages');
    const entries = await fs.readdir(packages, { withFileTypes: true }).catch(e => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    const matches = entries.filter(e => e.isDirectory() && PACKAGE_RE.test(e.name));
    if (matches.length !== 1) return null;
    const location = path.join(packages, matches[0].name, 'LocalState');
    const real = await fs.realpath(location).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    // No caller chooses a file path; reject redirected package storage as well.
    if (!real || path.resolve(real).toLowerCase() !== path.resolve(location).toLowerCase()) return null;
    return location;
  }

  async function statusAt(location) {
    let state;
    try { state = await readJson(path.join(location, STATUS_FILE)); }
    catch (e) { if (e.code !== 'ENOENT') throw fail('Cannot read the Game Bar widget state.', 502); }
    const valid = state && state.version === 1 && typeof state.enabled === 'boolean'
      && typeof state.pinned === 'boolean' && typeof state.visible === 'boolean'
      && typeof state.clickThrough === 'boolean' && Number.isFinite(state.updatedAt)
      && Number.isInteger(state.size) && state.size >= 8 && state.size <= 48
      && typeof state.color === 'string' && /^#[0-9a-f]{6}$/i.test(state.color);
    const age = valid ? now() - state.updatedAt : Infinity;
    const online = valid && age >= -1000 && age <= FRESH_MS && state.running === true;
    return { supported: true, installed: true, online: !!online,
      enabled: !!(online && state.enabled), pinned: !!(online && state.pinned),
      visible: !!(online && state.visible), clickThrough: !!(online && state.clickThrough),
      color: valid ? state.color : '#65F5BA', size: valid ? state.size : 20,
      commandId: online && typeof state.commandId === 'string' ? state.commandId.slice(0, 64) : null,
      error: online && state.error === 'center_failed' ? 'Could not center the widget on this display.' : null };
  }

  async function status() {
    const location = await folder();
    return location ? statusAt(location) : { supported: platform === 'win32', installed: false, online: false, enabled: false };
  }

  async function send(command) {
    const patch = validateCommand(command);
    const operation = queue.catch(() => {}).then(async () => {
      const location = await folder();
      if (!location) throw fail('Install and open Xenon Crosshair from Win + G first.', 409);
      const before = await statusAt(location);
      if (!before.online || !before.visible) throw fail('Open Win + G and pin Xenon Crosshair first.', 409);
      const id = randomUUID();
      const payload = JSON.stringify({ version: 1, id, expiresAt: now() + COMMAND_MS, ...patch });
      const temp = path.join(location, COMMAND_FILE + '.' + id + '.tmp');
      try {
        await fs.writeFile(temp, payload, { flag: 'wx' });
        await fs.rename(temp, path.join(location, COMMAND_FILE));
      } finally { await fs.unlink(temp).catch(() => {}); }
      // Only an acknowledgement from Game Bar changes the displayed toggle state.
      for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(100);
        const state = await statusAt(location);
        if (state.online && state.commandId === id) {
          if (state.error) throw fail(state.error, 502);
          return state;
        }
      }
      throw fail('Game Bar has not confirmed the change. Open Win + G and try again.', 504);
    });
    queue = operation;
    return operation;
  }

  async function open() {
    if (platform !== 'win32') throw fail('Xbox Game Bar requires Windows.', 409);
    const location = await folder();
    const family = location && path.basename(path.dirname(location));
    await openGameBar(family ? 'ms-gamebar:activate/' + family + '_App_Crosshair' : 'ms-gamebar:');
    return { ok: true };
  }

  return { status, send, open };
}

module.exports = { createCrosshairControl, validateCommand };
