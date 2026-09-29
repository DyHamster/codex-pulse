import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeLimits, Monitor, safeError } from '../src/monitor.mjs';
import { classifyNetwork } from '../src/network.mjs';
const raw = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1790619847 }, secondary: { usedPercent: 22, windowDurationMins: 10080 } } } };
test('quota: missing is unknown, zero is real, multiple buckets and clamping', () => {
  assert.equal(normalizeLimits(raw)[0].windows[0].remainingPercent, 60);
  assert.deepEqual(normalizeLimits(null), []);
  const result = normalizeLimits({ rateLimitsByLimitId: { a: { primary: {} }, b: { primary: { usedPercent: 0 }, secondary: { usedPercent: 105 } } } });
  assert.equal(result[0].windows[0].remainingPercent, null);
  assert.equal(result[1].windows[0].remainingPercent, 100);
  assert.equal(result[1].windows[1].remainingPercent, 0);
  assert.equal(normalizeLimits({ rateLimits: raw.rateLimitsByLimitId.codex })[0].id, 'codex');
});
test('HTTP auth and rate limiting are not a transport outage', () => {
  assert.equal(classifyNetwork(0, 401, 200), 'auth_required');
  assert.equal(classifyNetwork(0, 403, 200), 'access_denied');
  assert.equal(classifyNetwork(0, 429, 200), 'rate_limited');
  assert.equal(classifyNetwork(6, 0, 0), 'dns_error');
  assert.equal(classifyNetwork(60, 0, 0), 'tls_error');
  assert.equal(classifyNetwork(28, 0, 8000), 'timeout');
  assert.equal(classifyNetwork(0, 200, 1800), 'slow');
});
class FakeClient extends EventEmitter {
  fail = false; calls = 0;
  async connect() {}
  async request(method) { this.calls++; if (this.fail) throw new Error('timeout'); if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus', email: 'someone@example.com' } }; if (method === 'account/usage/read') return { summary: { lifetimeTokens: null }, dailyUsageBuckets: null }; return raw; }
  close() {}
}
test('keep last good quota on failure, mark stale, mask account email', async () => {
  const client = new FakeClient(); const m = new Monitor({ client });
  await m.refreshAccount(); assert.equal(m.snapshot().quotas.stale, false); assert.equal(m.snapshot().account.email, 's•••@example.com');
  client.fail = true; await m.refreshAccount(); assert.equal(m.snapshot().quotas.stale, true); assert.equal(m.snapshot().quotas.data[0].windows[0].remainingPercent, 60);
  assert.equal(m.snapshot().usage.data.summary.lifetimeTokens, null); m.close();
});
test('deduplicate concurrent refresh and preserve unrelated event buckets', async () => {
  const client = new FakeClient(); const m = new Monitor({ client });
  await Promise.all([m.refreshAccount(), m.refreshAccount(), m.refreshAccount()]); assert.equal(client.calls, 3);
  m.setLimits({ rateLimitsByLimitId: { extra: { primary: { usedPercent: 10 } } } }, true);
  assert.equal(m.snapshot().quotas.data.length, 2); m.close();
});
test('errors do not leak server message contents', () => { assert.equal(safeError(new Error('secret credentials')), '查询失败，请检查 Codex 登录状态和网络连接'); });
