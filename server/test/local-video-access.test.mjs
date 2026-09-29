import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const remote = require('../remote-access.js');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const routes = ['status', 'pick', 'import', 'prepare', 'subtitle', 'stream', 'stop', 'release'];

test('paired devices cannot open, inspect, stream or stop local video sessions', () => {
  for (const route of [...routes, 'future-route']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
      const pathname = '/media/local/' + route;
      assert.equal(remote.remotePathAllowed(pathname, method), false, method + ' ' + pathname);
      assert.equal(remote.gateDecision({
        enabled: true, host: '192.168.1.42:3030', origin: 'http://192.168.1.42:3030',
        fetchSite: 'same-origin', fetchMode: 'cors', method, pathname, hasDevice: true,
        addresses: ['192.168.1.42'], port: 3030,
      }), 'remote_denied', 'a valid pairing must not grant local-file access');
    }
  }
  assert.equal(remote.remotePathAllowed('/media/playpause', 'POST'), true);
  assert.equal(remote.remotePathAllowed('/media/next', 'POST'), true);
});

// Requiring server.js would boot the real backend. Execute only the same pure
// guard that protects its routes, so this tests header behavior without a port.
function serverFunction(name) {
  const match = server.match(new RegExp('function ' + name + '\\([^]*?\\n}'));
  assert.ok(match, name + ' must remain independently testable');
  return vm.runInNewContext('(' + match[0] + ')', { URL });
}

test('local video accepts same-origin requests and rejects browser drive-bys', () => {
  const allowed = serverFunction('isAllowedLocalMediaRequest');
  const request = (headers = {}) => ({ headers: { host: '127.0.0.1:3031', ...headers } });
  assert.equal(allowed(request(), false), true, 'headerless loopback API clients remain supported');
  assert.equal(allowed(request({ origin: 'http://127.0.0.1:3031', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }), false), true);
  assert.equal(allowed(request({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors' }), false), true, 'video subresources do not send an Origin');
  assert.equal(allowed(request(), true), false, 'the paired-device door never grants local-file access');
  for (const headers of [
    { origin: 'null' }, { origin: 'https://evil.example' },
    { origin: 'http://127.0.0.1:4040' }, { origin: 'http://localhost:3031' },
    { origin: 'https://127.0.0.1:3031' }, { origin: 'not a URL' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'none' }, { 'sec-fetch-mode': 'navigate' },
    { origin: 'http://127.0.0.1:3031', 'sec-fetch-mode': 'navigate' },
  ]) assert.equal(allowed(request(headers), false), false, JSON.stringify(headers));
});

test('local video responses cannot be wrapped in readable cross-origin JSONP', () => {
  const match = server.match(/const JSONP_PATHS = new Set\(\[([^]*?)\]\);/);
  assert.ok(match);
  const allowedPaths = vm.runInNewContext('new Set([' + match[1] + '])');
  const matchFunction = server.match(/function isJsonpAllowed\([^]*?\n}/);
  assert.ok(matchFunction);
  const allowed = vm.runInNewContext('(' + matchFunction[0] + ')', { JSONP_PATHS: allowedPaths });
  for (const route of routes) assert.equal(allowed('/media/local/' + route), false, route);
  assert.equal(allowed('/media/playpause'), true, 'preserve the existing iCUE transport');
});

test('the real request preamble enforces the guard before exposing media or CORS', async () => {
  const start = server.indexOf('const handleRequest = async (req, res) => {');
  assert.ok(start > 0);
  const from = server.indexOf('\n', start) + 1;
  const end = server.indexOf("  if (req.method === 'OPTIONS')", from);
  assert.ok(end > from);
  const preamble = vm.runInNewContext('(async (req, res) => {' + server.slice(from, end) + '\nreturn true;})', {
    URL, isAllowedRequest: () => true, _remoteGate: () => ({ paired: true }),
    isAllowedLocalMediaRequest: serverFunction('isAllowedLocalMediaRequest'),
  });
  const response = () => ({
    headers: {}, status: 200,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status) { this.status = status; }, end() {},
  });
  for (const route of routes) {
    const req = { socket: {}, method: 'GET', url: '/media/local/' + route, headers: { host: '127.0.0.1:3031' } };
    const accepted = response();
    assert.equal(await preamble(req, accepted), true);
    assert.equal(accepted.headers['access-control-allow-origin'], undefined);
    assert.equal(accepted.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(accepted.headers['cache-control'], 'no-store');
    const refused = response();
    assert.equal(await preamble({ ...req, headers: { ...req.headers, origin: 'null' } }, refused), undefined);
    assert.equal(refused.status, 403);
    assert.equal(refused.headers['access-control-allow-origin'], undefined);
  }
  const existing = response();
  await preamble({ socket: {}, url: '/media/playpause', headers: {} }, existing);
  assert.equal(existing.headers['access-control-allow-origin'], '*', 'keep the iCUE compatibility surface unchanged');
});
