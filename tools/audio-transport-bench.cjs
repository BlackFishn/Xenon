'use strict';
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { createAudioControl } = require('../server/audio-control');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const probeExe = path.join(root, '.codex/audio-build/probe/xenon-audio-probe.exe');
const helperExe = process.argv[2] || path.join(root, '.codex/audio-build/candidate-v2/xenon-helper.exe');
const svv = path.join(root, 'server/soundvolumeview-x64/SoundVolumeView.exe');
const wait = ms => new Promise(r => setTimeout(r, ms));
const nodeMs = before => { const cpu = process.cpuUsage(before); return (cpu.user + cpu.system) / 1000; };
let helperProcess;
const control = createAudioControl({ exe: helperExe, spawn: (...args) => { helperProcess = spawn(...args); return helperProcess; } });
const cpu = async () => Number((await run(probeExe, ['--cpu', String(helperProcess.pid)], { windowsHide: true })).stdout.trim());
const measured = async args => {
  const result = JSON.parse((await run(probeExe, ['--measure', svv, ...args], { windowsHide: true })).stdout);
  if (result.exitCode !== 0) throw new Error('Legacy command failed');
  return result;
};
const report = {};
let probeProcess, temp;
(async () => {
  try {
    await control.rows();
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-audio-transport-'));
    const csv = path.join(temp, 'audio.csv');
    let events = 0;
    control.onChange(() => { events++; });
    console.log('Comparing idle audio transport, 32 seconds per backend...');
    let helperBefore = await cpu();
    let before = process.cpuUsage();
    const eventBefore = events;
    await wait(32000);
    const nativeNodeIdle = nodeMs(before);
    report.nativeIdle = { nodeCpuMs: nativeNodeIdle, helperCpuMs: await cpu() - helperBefore, events: events - eventBefore };
    before = process.cpuUsage();
    let legacyCpu = 0;
    for (let i = 0; i < 4; i++) {
      const stamp = Date.now();
      const result = await measured(['/scomma', csv, '/AvoidPrompts']);
      legacyCpu += result.cpuMs;
      // Exercise the same UTF-8 CSV read and field split as the old collector.
      const rows = (await fs.readFile(csv, 'utf8')).split('\n').filter(Boolean).map(line => line.split(','));
      JSON.stringify(rows);
      await wait(Math.max(0, 8000 - (Date.now() - stamp)));
    }
    report.legacyIdle = { nodeCpuMs: nodeMs(before), soundVolumeViewCpuMs: legacyCpu, spawns: 4 };
    probeProcess = spawn(probeExe, [], { windowsHide: true });
    await new Promise((resolve, reject) => { probeProcess.stdout.once('data', resolve); probeProcess.once('error', reject); });
    await wait(200);
    const levels = [20, 40, 60, 80, 35, 55, 75, 25, 45, 65];
    before = process.cpuUsage(); legacyCpu = 0;
    for (const level of levels) {
      legacyCpu += (await measured(['/SetVolume', 'xenon-audio-probe.exe', String(level)])).cpuMs;
      legacyCpu += (await measured(['/Unmute', 'xenon-audio-probe.exe'])).cpuMs;
    }
    report.legacyWrites = { count: levels.length, nodeCpuMs: nodeMs(before), soundVolumeViewCpuMs: legacyCpu };
    helperBefore = await cpu(); before = process.cpuUsage();
    const latencies = [];
    for (const level of levels) {
      const start = performance.now();
      await control.command(['/SetVolume', 'xenon-audio-probe.exe', String(level)]);
      await control.command(['/Unmute', 'xenon-audio-probe.exe']);
      latencies.push(performance.now() - start);
    }
    report.nativeWrites = { count: levels.length, nodeCpuMs: nodeMs(before), helperCpuMs: await cpu() - helperBefore, latencyMs: latencies };
    report.notes = 'Isolated Node audio transport plus native/legacy child CPU. Test-driver process CPU excluded. Idle sample 32s/backend; old backend polls at 8s. Measures transport, not the whole dashboard or WebView rendering.';
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (probeProcess) probeProcess.stdin.end();
    control.stop();
    if (temp) { await fs.unlink(path.join(temp, 'audio.csv')).catch(() => {}); await fs.rmdir(temp); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
