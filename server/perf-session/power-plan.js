'use strict';
// The Windows power plan, straight from powercfg.exe: 13 ms and no CPU to speak of,
// where the same question through PowerShell took 730 ms and 1400 ms of CPU, three
// times at the start of every session, just as the game was loading.

const path = require('path');
const { execFile } = require('child_process');

const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const ULTIMATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ONLY_GUID = new RegExp('^' + GUID.source + '$', 'i');
const TIMEOUT_MS = 6000;

function powercfg(args) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'powercfg.exe');
  return new Promise((resolve, reject) => {
    // latin1: the words around the GUID follow the system language, the GUID does not.
    execFile(exe, args, { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'latin1' }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

function createPowerPlan({ run = powercfg } = {}) {
  async function active() {
    const found = GUID.exec(await run(['/getactivescheme']));
    return found ? found[0].toLowerCase() : '';
  }

  async function get() {
    try {
      const guid = await active();
      return guid ? { ok: true, guid } : { ok: false, error: 'could not read active scheme' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // 'high', 'ultimate' or a saved GUID. `unchanged` means the plan was already on,
  // so there is nothing to undo when the session ends.
  async function set(value) {
    const wanted = String(value == null ? '' : value).trim();
    const target = wanted === 'high' ? HIGH : wanted === 'ultimate' ? ULTIMATE : wanted.toLowerCase();
    if (!ONLY_GUID.test(target)) return { ok: false, error: 'bad_value' };
    try {
      if (await active() === target) return { ok: true, guid: target, unchanged: true };
      // Ultimate is hidden on many editions. Naming the copy after the original keeps
      // it to one plan: without the second GUID every session added a new one.
      if (wanted === 'ultimate') await run(['/duplicatescheme', ULTIMATE, ULTIMATE]).catch(() => {});
      await run(['/setactive', target]);
      const now = await active();
      return now === target ? { ok: true, guid: now } : { ok: false, error: 'scheme not applied' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Every installed scheme and the active one, for this fork's System-tile
  // power-plan picker. `powercfg /list` lines read: Power Scheme GUID: <guid>
  // (<name>) [*]. The words are localized, so only the GUID, the name in
  // brackets and the trailing asterisk are read.
  async function list() {
    try {
      const plans = [];
      let guid = '';
      for (const line of String(await run(['/list'])).split(/\r?\n/)) {
        const found = GUID.exec(line);
        if (!found) continue;
        const id = found[0].toLowerCase();
        const name = (/\(([^)]+)\)/.exec(line) || [])[1];
        const isActive = line.trimEnd().endsWith('*');
        if (isActive) guid = id;
        plans.push({ guid: id, name: name ? name.trim() : '', active: isActive });
      }
      return plans.length ? { ok: true, guid, plans } : { ok: false, error: 'could not read power schemes' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  return { get, set, list };
}

module.exports = { createPowerPlan, HIGH, ULTIMATE };
