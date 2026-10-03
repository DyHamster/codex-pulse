import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
class Stub extends EventEmitter {
  refreshes = 0;
  snapshot() { return { service: 'codex-pulse', quotas: { data: [], stale: true } }; }
  start() {} close() {} async refreshAccount() { this.refreshes++; } async refreshNetwork() {}
}
test('HTTP access key, origin check, refresh throttling and SSE snapshot', async t => {
  const monitor = new Stub(); const port = 44300 + Math.floor(Math.random() * 1000);
  const s = await startServer({ monitor, listenPort: port, persist: false }); t.after(() => s.close());
  const base = `http://127.0.0.1:${port}`; const headers = { Authorization: `Bearer ${s.token}` };
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/api/status', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => { const req = http.get(base + '/api/status', { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(badHost, 403);
  assert.equal((await fetch(base + '/api/status', { headers })).status, 200);
  const response = await fetch(base + '/'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.ok((await response.text()).includes('Codex Pulse'));
  assert.equal((await fetch(base + '/api/refresh', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/api/refresh', { method: 'POST', headers })).status, 429);
  assert.equal(monitor.refreshes, 1);
  const abort = new AbortController(); const stream = await fetch(base + '/api/events', { headers, signal: abort.signal });
  const reader = stream.body.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /codex-pulse/); await reader.cancel(); abort.abort();
});

test('refresh waits for fresh quota, joins concurrent requests, does not wait for network', async t => {
  const monitor = new Stub(); let resolveQuota;
  monitor.refreshAccount = () => { monitor.refreshes++; return new Promise(resolve => { resolveQuota = resolve; }); };
  monitor.refreshNetwork = () => new Promise(() => {});
  const s = await startServer({ monitor, listenPort: 0, persist: false, idleTimeoutMs: 0 }); t.after(() => s.close());
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const headers = { Authorization: `Bearer ${s.token}` };
  let finished = false;
  const first = fetch(base + '/api/refresh', { method: 'POST', headers }).then(r => { finished = true; return r.json(); });
  while (!resolveQuota) await delay(5);
  const second = fetch(base + '/api/refresh', { method: 'POST', headers });
  await delay(30); assert.equal(finished, false); assert.equal(monitor.refreshes, 1);
  resolveQuota(); assert.equal((await first).completed, true); assert.equal((await second).status, 200);
});

test('idle service frees its port, while a connected dashboard keeps it alive', async t => {
  const s = await startServer({ monitor: new Stub(), listenPort: 0, persist: false, idleTimeoutMs: 120 });
  t.after(() => s.close()); const port = s.server.address().port;
  const stream = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { Authorization: `Bearer ${s.token}` } });
  const reader = stream.body.getReader(); await reader.read(); await delay(200); assert.equal(s.server.listening, true);
  const closed = once(s.server, 'close'); await reader.cancel(); await closed;
  const replacement = await startServer({ monitor: new Stub(), listenPort: port, persist: false, idleTimeoutMs: 0 });
  assert.equal(replacement.server.listening, true); await replacement.close();
});

test('a lost descriptor is repaired and removed when the service stops', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-descriptor-test-')); const path = join(dir, 'service.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await startServer({ monitor: new Stub(), listenPort: 0, persist: true, descriptorPath: path, idleTimeoutMs: 0 });
  t.after(() => s.close()); await unlink(path);
  const deadline = Date.now() + 4500; let data;
  while (Date.now() < deadline) { data = await readFile(path, 'utf8').catch(() => null); if (data) break; await delay(30); }
  assert.equal(JSON.parse(data).token, s.token); await s.close();
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});
