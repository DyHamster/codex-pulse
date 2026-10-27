import { EventEmitter } from 'node:events';
import { AppServer } from './app-server.mjs';
import { probeNetwork, normalizeSystemProbe } from './network.mjs';
import { version } from './version.mjs';
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
export function isAuthenticationError(e) {
  return e?.code === 401 || /\b401\b|unauthori[sz]ed|not authenticated|auth required|authentication|sign in|log(?:ged)?[ -]?in|(?:access|refresh)[ _-]?token.*(?:expired|revoked|invalid|refresh|used)/i.test(e?.message || '');
}
export function safeError(e) {
  if (e?.code === -32601 || /unknown variant|method not found/i.test(e?.message || '')) return '当前 Codex 版本不支持此接口';
  if (isAuthenticationError(e)) return '登录状态不可用，请在 Codex CLI 登录后重试';
  if (/429|rate limit/i.test(e?.message || '')) return '查询被限流，稍后自动重试';
  if (/timeout|超时/i.test(e?.message || '')) return '请求超时，稍后自动重试';
  return '查询失败，请检查 Codex 登录状态和网络连接';
}
export class Monitor extends EventEmitter {
  constructor({ client = new AppServer(), probe = probeNetwork } = {}) {
    super(); this.client = client; this.probe = probe; this.stopped = false; this.timers = new Set(); this.jobs = {}; this.accountAt = 0; this.usageAttemptAt = 0;
    this.lastAuthRecoveryAt = 0; this.connectionGeneration = 0;
    this.systemNetwork = null; this.systemProbeRequestedAt = null;
    this.state = { account: null, quotas: { data: [], updatedAt: null, error: null }, usage: { data: null, updatedAt: null, error: null }, network: null };
    client.on('notification', msg => {
      if (msg.method === 'account/rateLimits/updated') this.setLimits(msg.params, true);
      if (msg.method === 'account/updated') { this.accountAt = 0; this.usageAttemptAt = 0; this.state.account = null; this.state.quotas = { data: [], updatedAt: null, error: null }; this.state.usage = { data: null, updatedAt: null, error: null }; this.emit('update'); void this.refreshAccount(); }
    });
  }
  snapshot() {
    const now = Date.now();
    const environmentNetwork = this.state.network ? { ...this.state.network, source: 'environment', stale: now - this.state.network.checkedAt > 135000 } : null;
    return { service: 'codex-pulse', version, now, ...this.state,
      quotas: { ...this.state.quotas, stale: !!this.state.quotas.error || !this.state.quotas.updatedAt || now - this.state.quotas.updatedAt > 120000 },
      usage: { ...this.state.usage, stale: !!this.state.usage.error || !this.state.usage.updatedAt || now - this.state.usage.updatedAt > 600000 },
      network: this.systemNetwork ? { ...this.systemNetwork, stale: now - this.systemNetwork.checkedAt > 65000 } : environmentNetwork,
      environmentNetwork, systemProbeRequestedAt: this.systemProbeRequestedAt };
  }
  setSystemNetwork(raw) {
    const sample = normalizeSystemProbe(raw);
    if (!sample || (this.systemNetwork && sample.checkedAt <= this.systemNetwork.checkedAt)) return false;
    this.systemNetwork = sample; this.emit('update'); return true;
  }
  requestSystemProbe() { this.systemProbeRequestedAt = Date.now(); this.emit('update'); }
  setLimits(raw, merge = false) {
    let data = normalizeLimits(raw);
    if (merge) { const map = new Map(this.state.quotas.data.map(b => [b.id, b])); data.forEach(b => map.set(b.id, b)); data = [...map.values()]; }
    this.state.quotas = { data, updatedAt: Date.now(), error: null }; this.emit('update');
  }
  single(key, fn) {
    if (this.jobs[key]) return this.jobs[key];
    this.jobs[key] = fn().finally(() => { delete this.jobs[key]; this.emit('update'); }); return this.jobs[key];
  }
  async readAccountAndQuota(refreshToken = false) {
      await this.client.connect();
      if (this.stopped) return;
      if (refreshToken || !this.state.account || Date.now() - this.accountAt > 300000) {
      const response = await this.client.request('account/read', { refreshToken });
      const account = response?.account;
      const identity = `${account?.type || ''}/${account?.email || ''}`;
      if (this.identity && this.identity !== identity) { this.state.quotas = { data: [], updatedAt: null, error: null }; this.state.usage = { data: null, updatedAt: null, error: null }; }
      this.identity = identity;
      this.state.account = account ? { type: account.type, plan: account.planType || null, email: account.email ? account.email.replace(/^(.).*(@.*)$/, '$1•••$2') : null } : null;
      this.accountAt = Date.now();
      }
      if (!this.state.account) throw new Error('auth required');
      if (this.state.account.type !== 'chatgpt') throw new Error('当前登录方式不提供 ChatGPT 额度');
      const started = Date.now();
      const limits = await this.client.request('account/rateLimits/read', { excludeResetCreditDetails: true });
      if (this.stopped) return;
      this.setLimits(limits);
      this.state.quotaConnection = { checkedAt: Date.now(), status: 'reachable', elapsedMs: Date.now() - started };
      if (Date.now() - this.usageAttemptAt > 300000) {
        this.usageAttemptAt = Date.now();
        // Token statistics must not keep a quota refresh or its button waiting.
        void this.single('usage', async () => {
        const identity = this.identity;
        const generation = this.connectionGeneration;
        try {
          const raw = await this.client.request('account/usage/read');
          if (identity !== this.identity || generation !== this.connectionGeneration || this.stopped) return;
          this.state.usage = { data: { summary: raw.summary ?? null, dailyUsageBuckets: raw.dailyUsageBuckets ?? null }, updatedAt: Date.now(), error: null };
        } catch (e) { if (identity === this.identity && generation === this.connectionGeneration && !this.stopped) this.state.usage.error = safeError(e); }
        });
      }
  }
  refreshAccount() { return this.single('account', async () => {
    try {
      try { await this.readAccountAndQuota(); }
      catch (original) {
        if (this.stopped || !isAuthenticationError(original) || Date.now() - this.lastAuthRecoveryAt < 60000) throw original;
        this.lastAuthRecoveryAt = Date.now();
        this.state.quotas.error = '正在恢复登录连接…'; this.emit('update');
        // First load credentials updated by another Codex process, avoiding needless token rotation.
        this.connectionGeneration++; this.accountAt = 0; this.usageAttemptAt = 0; this.client.close();
        try { await this.readAccountAndQuota(); }
        catch (reloaded) {
          if (this.stopped || !isAuthenticationError(reloaded)) throw reloaded;
          // Let Codex manage refresh and persistence; Pulse never reads token files.
          await this.readAccountAndQuota(true);
        }
      }
    } catch (e) {
      if (this.stopped) return;
      this.accountAt = 0; this.state.quotas.error = safeError(e); this.state.quotaConnection = { checkedAt: Date.now(), status: 'error', elapsedMs: null };
    }
  }); }
  refreshNetwork() { return this.single('network', async () => {
    // The native probe is authoritative; the environment route is only an auxiliary check.
    if (this.systemNetwork && Date.now() - this.systemNetwork.checkedAt < 65000 && this.state.network && Date.now() - this.state.network.checkedAt < 60000) return;
    try { this.state.network = await this.probe(this.state.account?.type); }
    catch { this.state.network = { checkedAt: Date.now(), status: 'network_error', elapsedMs: null, note: '网络探测不可用' }; }
  }); }
  start() {
    const loop = async (fn, delay) => { if (this.stopped) return; const started = Date.now(); await fn(); if (!this.stopped) { const timer = setTimeout(() => { this.timers.delete(timer); void loop(fn, delay); }, Math.max(1000, delay() - (Date.now() - started))); this.timers.add(timer); } };
    let failures = 0;
    void loop(() => this.refreshAccount(), () => this.state.quotas.error ? Math.min(300000, 30000 * 2 ** Math.min(++failures, 4)) : (failures = 0, 30000));
    void loop(() => this.refreshNetwork(), () => this.systemNetwork && Date.now() - this.systemNetwork.checkedAt < 65000 ? 60000 : this.state.network?.transportReachable ? 15000 : 30000);
  }
  close() { this.stopped = true; this.timers.forEach(clearTimeout); this.timers.clear(); this.client.close(); }
}
