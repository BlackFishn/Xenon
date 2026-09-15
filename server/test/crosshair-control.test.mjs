import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCrosshairControl, validateCommand } = require('../crosshair-control');
const statusName = 'xenon-crosshair-status.json';
const commandName = 'xenon-crosshair-command.json';
const clock = 2_000_000;
const good = { version: 1, updatedAt: clock, running: true, enabled: false, pinned: true,
  visible: true, clickThrough: true, color: '#65F5BA', size: 20, commandId: '', error: '' };

async function fixture(t) {
  const parent = path.resolve('.tmp');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'crosshair-test-'));
  const folder = path.join(root, 'Packages', 'Xenon.Crosshair_0123456789abc', 'LocalState');
  await fs.mkdir(folder, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('crosshair-test-'));
    await fs.rm(root, { recursive: true });
  });
  const write = value => fs.writeFile(path.join(folder, statusName), JSON.stringify(value));
  await write(good);
  return { root, folder, write, options: { platform: 'win32', localAppData: root, now: () => clock } };
}

test('accepts only bounded crosshair settings', () => {
  assert.deepEqual(validateCommand({ enabled: true, color: '#aAbBcc', size: 48 }), { enabled: true, color: '#AABBCC', size: 48 });
  for (const value of [null, [], {}, { enabled: 'true' }, { size: 7 }, { size: 49 }, { size: 20.5 },
    { color: '#fff' }, { color: '<script>' }, { center: false }, { path: '../other' }, { enabled: true, shell: 'anything' }]) {
    assert.throws(() => validateCommand(value), e => e.statusCode === 400);
  }
});

test('unsupported platforms do not launch or read package state', async () => {
  let launches = 0;
  const api = createCrosshairControl({ platform: 'linux', openGameBar: async () => launches++ });
  assert.equal((await api.status()).supported, false);
  await assert.rejects(api.open(), e => e.statusCode === 409);
  assert.equal(launches, 0);
});

test('reads UWP UTF-8 BOM state and reports stale state as offline', async t => {
  const f = await fixture(t);
  const api = createCrosshairControl(f.options);
  await fs.writeFile(path.join(f.folder, statusName), '\ufeff' + JSON.stringify({ ...good, enabled: true }));
  assert.equal((await api.status()).enabled, true);
  await f.write({ ...good, enabled: true, updatedAt: clock - 9000 });
  const state = await api.status();
  assert.equal(state.online, false);
  assert.equal(state.enabled, false);
});

test('closed, hidden, or missing widgets cannot accept commands', async t => {
  const f = await fixture(t);
  const api = createCrosshairControl(f.options);
  for (const patch of [{ running: false }, { visible: false }, { updatedAt: clock - 9000 }]) {
    await f.write({ ...good, ...patch });
    await assert.rejects(api.send({ enabled: false }), e => e.statusCode === 409);
  }
  await fs.unlink(path.join(f.folder, statusName));
  assert.equal((await api.status()).online, false);
  await assert.rejects(fs.stat(path.join(f.folder, commandName)), { code: 'ENOENT' });
});

test('success requires matching acknowledgement, not merely a written command', async t => {
  const f = await fixture(t);
  let writes = 0;
  const api = createCrosshairControl({ ...f.options, sleep: async () => {
    const command = JSON.parse(await fs.readFile(path.join(f.folder, commandName), 'utf8'));
    assert.equal(command.version, 1);
    assert.equal(command.expiresAt, clock + 5000);
    assert.match(command.id, /^[0-9a-f-]{36}$/);
    await f.write({ ...good, enabled: command.enabled, commandId: ++writes === 1 ? 'old-command' : command.id });
  } });
  const result = await api.send({ enabled: true });
  assert.equal(writes, 2);
  assert.equal(result.enabled, true);
});

test('an unacknowledged command times out without reporting ON', async t => {
  const f = await fixture(t);
  let waited = 0;
  const api = createCrosshairControl({ ...f.options, sleep: async ms => {
    assert.ok(ms <= 25, 'acknowledgement checks should not add a 100 ms delay');
    waited += ms;
  } });
  await assert.rejects(api.send({ enabled: true }), e => e.statusCode === 504);
  assert.equal(waited, 5000, 'faster polling must retain the full command timeout');
  assert.equal((await api.status()).enabled, false);
});

test('simultaneous commands are serialized and retain their own acknowledgements', async t => {
  const f = await fixture(t);
  const seen = [];
  let current = { ...good };
  const api = createCrosshairControl({ ...f.options, sleep: async () => {
    const command = JSON.parse(await fs.readFile(path.join(f.folder, commandName), 'utf8'));
    seen.push(command.id);
    for (const key of ['enabled', 'color', 'size']) if (key in command) current[key] = command[key];
    current.commandId = command.id;
    await f.write(current);
  } });
  const [on, color] = await Promise.all([api.send({ enabled: true }), api.send({ color: '#abcdef', size: 30 })]);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(on.enabled, true);
  assert.equal(color.enabled, true);
  assert.equal(color.color, '#ABCDEF');
  assert.equal(color.size, 30);
});

test('oversized state and redirected package storage are rejected', async t => {
  const f = await fixture(t);
  const api = createCrosshairControl(f.options);
  await fs.writeFile(path.join(f.folder, statusName), ' '.repeat(5000));
  await assert.rejects(api.status(), e => e.statusCode === 502);
  await fs.rename(f.folder, f.folder + '-real');
  await fs.symlink(f.folder + '-real', f.folder, 'junction');
  assert.equal((await api.status()).installed, false);
});

test('centering failures are reported even when the command is acknowledged', async t => {
  const f = await fixture(t);
  const api = createCrosshairControl({ ...f.options, sleep: async () => {
    const command = JSON.parse(await fs.readFile(path.join(f.folder, commandName), 'utf8'));
    await f.write({ ...good, commandId: command.id, error: 'center_failed' });
  } });
  await assert.rejects(api.send({ center: true }), e => e.statusCode === 502);
});

test('opening targets only the discovered widget identity, with a Game Bar fallback', async t => {
  const f = await fixture(t);
  const launches = [];
  await f.write({ ...good, running: false });
  const api = createCrosshairControl({ ...f.options, openGameBar: async uri => { launches.push(uri); if (uri !== 'ms-gamebar:') await f.write(good); } });
  assert.equal((await api.open()).online, true);
  assert.deepEqual(launches, ['ms-gamebar://launchForeground/activate/Xenon.Crosshair_0123456789abc_App_Crosshair']);
  await fs.rename(f.folder, f.folder + '-missing');
  await api.open();
  assert.equal(launches[1], 'ms-gamebar:');
});

test('launch errors reach the caller without reporting success', async t => {
  const f = await fixture(t);
  await f.write({ ...good, running: false });
  const api = createCrosshairControl({ ...f.options, openGameBar: async () => { throw Error('launch failed'); } });
  await assert.rejects(api.open(), /launch failed/);
});

test('ON opens a closed widget once, waits for visibility, then requires its command acknowledgement', async t => {
  const f = await fixture(t);
  await f.write({ ...good, running: false });
  let launches = 0, startupPolls = 0, commands = 0;
  const api = createCrosshairControl({ ...f.options,
    openGameBar: async () => { launches++; await f.write({ ...good, visible: false }); },
    sleep: async ms => {
      if (ms === 250) {
        assert.equal(await fs.stat(path.join(f.folder, commandName)).catch(() => null), null);
        if (++startupPolls === 2) await f.write(good);
      } else {
        const command = JSON.parse(await fs.readFile(path.join(f.folder, commandName), 'utf8'));
        assert.equal(command.enabled, true);
        commands++;
        await f.write({ ...good, enabled: true, commandId: command.id });
      }
    }
  });
  const [opened, enabled] = await Promise.all([api.open(), api.send({ enabled: true })]);
  assert.equal(launches, 1);
  assert.equal(startupPolls, 2);
  assert.equal(opened.enabled, false);
  assert.equal(commands, 1);
  assert.equal(enabled.enabled, true);
});

test('a failed startup is bounded, writes no command and can be retried', async t => {
  const f = await fixture(t);
  await f.write({ ...good, running: false });
  let launches = 0, waited = 0;
  const api = createCrosshairControl({ ...f.options,
    openGameBar: async () => { if (++launches === 2) await f.write(good); },
    sleep: async ms => {
      if (ms === 250) waited += ms;
      else {
        const command = JSON.parse(await fs.readFile(path.join(f.folder, commandName), 'utf8'));
        await f.write({ ...good, enabled: true, commandId: command.id });
      }
    }
  });
  await assert.rejects(api.send({ enabled: true }), e => e.statusCode === 504);
  assert.equal(waited, 8000);
  assert.equal(await fs.stat(path.join(f.folder, commandName)).catch(() => null), null);
  assert.equal((await api.send({ enabled: true })).enabled, true);
  assert.equal(launches, 2);
});

test('an already visible widget does not launch again; OFF and design edits never launch a closed widget', async t => {
  const f = await fixture(t);
  let launches = 0;
  const api = createCrosshairControl({ ...f.options, openGameBar: async () => { launches++; } });
  assert.equal((await api.open()).online, true);
  await f.write({ ...good, running: false });
  for (const command of [{ enabled: false }, { color: '#ABCDEF' }])
    await assert.rejects(api.send(command), e => e.statusCode === 409);
  await fs.unlink(path.join(f.folder, statusName));
  await fs.rename(f.folder, f.folder + '-removed');
  await assert.rejects(api.send({ enabled: true }), e => e.statusCode === 409);
  assert.equal(launches, 0);
});
