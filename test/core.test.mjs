import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeLimits, Monitor, safeError, isAuthenticationError } from '../src/monitor.mjs';
import { classifyNetwork, normalizeSystemProbe } from '../src/network.mjs';
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

test('slow Token statistics never delay quota refresh, account reads are cached', async () => {
  const client = new FakeClient(); const original = client.request.bind(client); let resolveUsage; let accounts = 0;
  client.request = method => {
    if (method === 'account/read') accounts++;
    if (method === 'account/usage/read') return new Promise(resolve => { resolveUsage = resolve; });
    return original(method);
  };
  const m = new Monitor({ client });
  await m.refreshAccount(); assert.equal(m.snapshot().quotas.stale, false); assert.equal(m.snapshot().usage.data, null);
  await m.refreshAccount(); assert.equal(accounts, 1);
  resolveUsage({ summary: { lifetimeTokens: 123 }, dailyUsageBuckets: [] }); await m.jobs.usage;
  assert.equal(m.snapshot().usage.data.summary.lifetimeTokens, 123); m.close();
});

class ExpiredClient extends FakeClient {
  closes = 0; forceReads = 0; persistent = false; needsRefresh = false; renewed = false;
  close() { this.closes++; }
  async request(method, params) {
    if (method === 'account/read' && params?.refreshToken) { this.forceReads++; this.renewed = true; }
    if (method === 'account/rateLimits/read' && (this.persistent || this.closes === 0 || (this.needsRefresh && !this.renewed))) {
      throw Object.assign(new Error('401 Unauthorized: expired access token'), { code: 401 });
    }
    return super.request(method, params);
  }
}
test('expired long-lived connection reloads credentials once and coalesces callers', async () => {
  const client = new ExpiredClient(); const m = new Monitor({ client });
  await Promise.all([m.refreshAccount(), m.refreshAccount(), m.refreshAccount()]);
  assert.equal(client.closes, 1); assert.equal(client.forceReads, 0);
  assert.equal(m.snapshot().quotas.stale, false); assert.equal(m.snapshot().quotaConnection.status, 'reachable'); m.close();
});
test('credentials still expired after reconnect get one Codex-managed token refresh', async () => {
  const client = new ExpiredClient(); client.needsRefresh = true; const m = new Monitor({ client });
  await m.refreshAccount(); assert.equal(client.closes, 1); assert.equal(client.forceReads, 1);
  assert.equal(m.snapshot().quotas.stale, false); m.close();
});
test('persistent auth failure preserves quota and cooldown prevents restart storms', async () => {
  const client = new ExpiredClient(); client.closes = 1; const m = new Monitor({ client });
  await m.refreshAccount(); const good = m.snapshot().quotas.data;
  client.persistent = true; await m.refreshAccount();
  assert.deepEqual(m.snapshot().quotas.data, good); assert.equal(m.snapshot().quotas.stale, true);
  assert.match(m.snapshot().quotas.error, /登录状态不可用/);
  const closes = client.closes, forced = client.forceReads;
  await Promise.all([m.refreshAccount(), m.refreshAccount()]);
  assert.equal(client.closes, closes); assert.equal(client.forceReads, forced); m.close();
});
test('network failures and limits do not trigger authentication recovery', async () => {
  for (const message of ['timeout', '429 rate limit', '403 access denied']) {
    const client = new ExpiredClient(); client.request = async () => { throw new Error(message); };
    const m = new Monitor({ client }); await m.refreshAccount(); assert.equal(client.closes, 0); m.close();
  }
  assert.equal(isAuthenticationError(new Error('Your refresh token was already used')), true);
});

const systemSample = () => ({ checkedAt: Date.now(), elapsedMs: 355, httpStatus: 200, viaProxy: true, proxyConfigured: true, failure: null });
test('system network is authoritative even when the environment route times out', () => {
  const m = new Monitor({ client: new FakeClient() });
  m.state.network = { checkedAt: Date.now(), status: 'timeout', httpStatus: null, transportReachable: false };
  assert.equal(m.setSystemNetwork(systemSample()), true);
  const s = m.snapshot(); assert.equal(s.network.source, 'system'); assert.equal(s.network.httpStatus, 200);
  assert.equal(s.network.proxy, 'system'); assert.equal(s.environmentNetwork.status, 'timeout');
  m.systemNetwork.checkedAt -= 66000;
  assert.equal(m.snapshot().network.stale, true); assert.equal(m.snapshot().network.source, 'system'); m.close();
});
test('system probe validates timestamps, proxy evidence and failures', () => {
  const raw = systemSample();
  assert.equal(normalizeSystemProbe({ ...raw, checkedAt: raw.checkedAt - 70000 }), null);
  assert.equal(normalizeSystemProbe({ ...raw, checkedAt: raw.checkedAt + 10000 }), null);
  assert.equal(normalizeSystemProbe({ ...raw, viaProxy: 'yes' }), null);
  assert.equal(normalizeSystemProbe({ ...raw, httpStatus: 0 }), null);
  assert.equal(normalizeSystemProbe({ ...raw, failure: 'secret-error' }), null);
  const direct = normalizeSystemProbe({ ...raw, viaProxy: false }); assert.equal(direct.proxy, 'direct');
  const failure = normalizeSystemProbe({ ...raw, failure: 'timeout', httpStatus: null });
  assert.equal(failure.routeVerified, false); assert.equal(failure.proxy, 'unconfirmed');
  assert.equal(normalizeSystemProbe({ ...raw, httpStatus: 403 }).transportReachable, true);
  assert.equal(normalizeSystemProbe({ ...raw, httpStatus: 407 }).transportReachable, false);
});
