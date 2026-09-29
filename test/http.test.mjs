import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  assert.equal((await fetch(base + '/api/refresh', { method: 'POST', headers })).status, 202);
  assert.equal((await fetch(base + '/api/refresh', { method: 'POST', headers })).status, 429);
  assert.equal(monitor.refreshes, 1);
  const abort = new AbortController(); const stream = await fetch(base + '/api/events', { headers, signal: abort.signal });
  const reader = stream.body.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /codex-pulse/); await reader.cancel(); abort.abort();
});
