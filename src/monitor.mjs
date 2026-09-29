import { EventEmitter } from 'node:events';
import { AppServer } from './app-server.mjs';
import { probeNetwork } from './network.mjs';
export function normalizeLimits(raw) {
  const map = raw?.rateLimitsByLimitId;
  const buckets = map && Object.keys(map).length ? Object.entries(map) : raw?.rateLimits ? [[raw.rateLimits.limitId || 'codex', raw.rateLimits]] : [];
  return buckets.map(([id, b]) => ({ id, name: b.limitName || id, plan: b.planType || null,
    windows: ['primary', 'secondary'].flatMap(key => {
      const w = b[key]; if (!w) return [];
      return [{ key, usedPercent: Number.isFinite(w.usedPercent) ? w.usedPercent : null,
        remainingPercent: Number.isFinite(w.usedPercent) ? Math.max(0, Math.min(100, 100 - w.usedPercent)) : null,
        minutes: w.windowDurationMins ?? null, resetsAt: w.resetsAt ?? null }];
    }), credits: b.credits ? { balance: b.credits.balance ?? null, unlimited: b.credits.unlimited === true, hasCredits: b.credits.hasCredits === true } : null }));
}
export function safeError(e) {
  if (e?.code === -32601 || /unknown variant|method not found/i.test(e?.message || '')) return '当前 Codex 版本不支持此接口';
  if (/401|unauthorized|not authenticated|login|auth required/i.test(e?.message || '')) return '登录状态不可用，请在 Codex CLI 登录后重试';
  if (/429|rate limit/i.test(e?.message || '')) return '查询被限流，稍后自动重试';
  if (/timeout|超时/i.test(e?.message || '')) return '请求超时，稍后自动重试';
  return '查询失败，请检查 Codex 登录状态和网络连接';
}
export class Monitor extends EventEmitter {
  constructor({ client = new AppServer(), probe = probeNetwork } = {}) {
    super(); this.client = client; this.probe = probe; this.stopped = false; this.timers = []; this.jobs = {};
    this.state = { account: null, quotas: { data: [], updatedAt: null, error: null }, usage: { data: null, updatedAt: null, error: null }, network: null };
    client.on('notification', msg => {
      if (msg.method === 'account/rateLimits/updated') this.setLimits(msg.params, true);
      if (msg.method === 'account/updated') { this.state.account = null; this.state.quotas = { data: [], updatedAt: null, error: null }; this.state.usage = { data: null, updatedAt: null, error: null }; this.emit('update'); void this.refreshAccount(); }
    });
  }
  snapshot() {
    const now = Date.now();
    return { service: 'codex-pulse', version: '0.1.0', now, ...this.state,
      quotas: { ...this.state.quotas, stale: !!this.state.quotas.error || !this.state.quotas.updatedAt || now - this.state.quotas.updatedAt > 120000 },
      usage: { ...this.state.usage, stale: !!this.state.usage.error || !this.state.usage.updatedAt || now - this.state.usage.updatedAt > 600000 },
      network: this.state.network ? { ...this.state.network, stale: now - this.state.network.checkedAt > 45000 } : null };
  }
  setLimits(raw, merge = false) {
    let data = normalizeLimits(raw);
    if (merge) { const map = new Map(this.state.quotas.data.map(b => [b.id, b])); data.forEach(b => map.set(b.id, b)); data = [...map.values()]; }
    this.state.quotas = { data, updatedAt: Date.now(), error: null }; this.emit('update');
  }
  single(key, fn) {
    if (this.jobs[key]) return this.jobs[key];
    this.jobs[key] = fn().finally(() => { delete this.jobs[key]; this.emit('update'); }); return this.jobs[key];
  }
  refreshAccount() { return this.single('account', async () => {
    try {
      await this.client.connect();
      const response = await this.client.request('account/read', { refreshToken: false });
      const account = response?.account;
      const identity = `${account?.type || ''}/${account?.email || ''}`;
      if (this.identity && this.identity !== identity) { this.state.quotas = { data: [], updatedAt: null, error: null }; this.state.usage = { data: null, updatedAt: null, error: null }; }
      this.identity = identity;
      this.state.account = account ? { type: account.type, plan: account.planType || null, email: account.email ? account.email.replace(/^(.).*(@.*)$/, '$1•••$2') : null } : null;
      if (account?.type !== 'chatgpt') throw new Error('auth required');
      const started = Date.now();
      this.setLimits(await this.client.request('account/rateLimits/read', { excludeResetCreditDetails: true }));
      this.state.quotaConnection = { checkedAt: Date.now(), status: 'reachable', elapsedMs: Date.now() - started };
      if (!this.state.usage.updatedAt || Date.now() - this.state.usage.updatedAt > 300000) {
        try {
          const raw = await this.client.request('account/usage/read');
          this.state.usage = { data: { summary: raw.summary ?? null, dailyUsageBuckets: raw.dailyUsageBuckets ?? null }, updatedAt: Date.now(), error: null };
        } catch (e) { this.state.usage.error = safeError(e); }
      }
    } catch (e) { this.state.quotas.error = safeError(e); this.state.quotaConnection = { checkedAt: Date.now(), status: 'error', elapsedMs: null }; }
  }); }
  refreshNetwork() { return this.single('network', async () => {
    try { this.state.network = await this.probe(this.state.account?.type); }
    catch { this.state.network = { checkedAt: Date.now(), status: 'network_error', elapsedMs: null, note: '网络探测不可用' }; }
  }); }
  start() {
    const loop = async (fn, delay) => { if (this.stopped) return; await fn(); if (!this.stopped) { const timer = setTimeout(() => loop(fn, delay), delay()); this.timers.push(timer); if (this.timers.length > 20) this.timers.shift(); } };
    let failures = 0;
    void loop(() => this.refreshAccount(), () => this.state.quotas.error ? Math.min(300000, 60000 * 2 ** Math.min(++failures, 3)) : (failures = 0, 60000));
    void loop(() => this.refreshNetwork(), () => this.state.network?.transportReachable ? 15000 : 30000);
  }
  close() { this.stopped = true; this.timers.forEach(clearTimeout); this.client.close(); }
}
