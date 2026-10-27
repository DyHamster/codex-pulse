const $ = id => document.getElementById(id);
let token = location.hash.slice(1);
try {
  token ||= sessionStorage.getItem('pulse-token');
  if (location.hash) sessionStorage.setItem('pulse-token', token);
} catch { /* Private browsing can disable session storage. */ }
if (location.hash) history.replaceState(null, '', '/');
const headers = { Authorization: `Bearer ${token || ''}` };
let state, lastProbe, lastProbeSource, historyPoints = [], notified = new Set(), notificationEnabled = false;
let live = false, refreshing = false, actionNotice = '', accountKey;
const labels = { reachable: '收到响应', slow: '响应较慢', auth_required: '收到响应 · 需要鉴权', access_denied: '收到响应 · 访问受限', rate_limited: '收到响应 · 限流', server_error: '服务端异常', dns_error: 'DNS 解析失败', proxy_error: '代理错误', connect_error: '连接失败', tls_error: 'TLS 错误', timeout: '连接超时', network_error: '探测失败' };
const fmt = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '—';
const full = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN').format(n) : '未知';
const duration = mins => mins === 10080 ? '每周额度' : mins == null ? '未知周期' : mins % 1440 === 0 ? `${mins / 1440} 天额度` : mins % 60 === 0 ? `${mins / 60} 小时额度` : `${mins} 分钟额度`;
const dateTime = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';
const countdown = at => {
  if (!Number.isFinite(at) || at <= 0) return '重置时间未知';
  const minutes = Math.ceil((at * 1000 - Date.now()) / 60000);
  if (minutes <= 0) return '等待服务端更新';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return `${days ? `${days} 天 ` : ''}${hours ? `${hours} 小时 ` : ''}${mins ? `${mins} 分钟` : ''}后重置`;
};
function element(tag, cls, text) {
  const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el;
}
function controls() {
  $('refresh').disabled = !token || !live || !state || refreshing;
  $('refresh').textContent = refreshing ? '正在刷新…' : '刷新状态';
  $('refresh').setAttribute('aria-busy', String(refreshing));
  $('notice').textContent = actionNotice || state?.quotas.error || (!live && state ? '连接中断，当前显示上次数据，正在自动重连。' : '');
}
function connection(text, tone) { $('connection').textContent = text; $('connection').dataset.tone = tone; controls(); }
function render(s) {
  state = s;
  const key = `${s.account?.email}/${s.account?.plan}`;
  if (accountKey !== undefined && key !== accountKey) { historyPoints = []; lastProbe = null; notified.clear(); }
  accountKey = key;
  $('version').textContent = `Codex Pulse ${s.version || ''}`.trim();
  $('account').textContent = s.account ? `${String(s.account.plan || s.account.type).toUpperCase()} · ${s.account.email || '本机 Codex CLI 账号'}` : '账号尚未获取';
  $('updated').textContent = s.quotas.updatedAt ? `更新于 ${dateTime(s.quotas.updatedAt)}${s.quotas.stale ? ' · 数据已过期' : ''}` : '等待首次采集';
  const cards = [];
  for (const bucket of s.quotas.data) for (const w of bucket.windows) {
    const known = Number.isFinite(w.remainingPercent), low = known && w.remainingPercent <= 20;
    const card = element('article', `card quota-card${low ? ' low' : ''}${s.quotas.stale ? ' stale' : ''}`);
    const label = element('div', 'label'); label.append(element('span', '', duration(w.minutes)), element('span', '', bucket.name || bucket.id));
    const number = element('div', 'quota-number');
    number.append(element('strong', '', known ? String(w.remainingPercent) : '—'), element('span', '', '%'), element('small', '', s.quotas.stale ? '上次数据 · 已过期' : known ? '剩余可用额度' : '暂不可用'));
    const track = element('div', 'track'); const fill = element('div', 'fill'); fill.style.width = `${known ? Math.max(0, Math.min(100, w.remainingPercent)) : 0}%`; track.append(fill);
    track.setAttribute('role', 'meter'); track.setAttribute('aria-label', `${duration(w.minutes)}剩余`);
    track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    if (known) track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, w.remainingPercent))));
    else track.setAttribute('aria-valuetext', '暂不可用');
    const footer = element('div', 'quota-footer'); const reset = element('span', 'countdown', countdown(w.resetsAt));
    reset.dataset.reset = w.resetsAt ?? ''; footer.append(reset, element('span', '', Number.isFinite(w.usedPercent) ? `已使用 ${w.usedPercent}%` : '已用未知'));
    card.append(label, number, track, footer, element('span', 'reset-at', `重置于 ${dateTime(w.resetsAt == null ? null : w.resetsAt * 1000)}（本地时间）`)); cards.push(card);
    const threshold = known && w.remainingPercent <= 10 ? 10 : low ? 20 : null;
    if (threshold && !s.quotas.stale) notify(`${bucket.id}/${w.key}/${w.resetsAt}/${threshold}`, 'Codex 额度提醒', `${duration(w.minutes)}剩余 ${w.remainingPercent}%`);
  }
  $('quotas').setAttribute('aria-busy', String(!cards.length && !s.quotas.error));
  $('quotas').replaceChildren(...(cards.length ? cards : [element('article', 'card placeholder', s.quotas.error ? '额度暂不可用，恢复后自动更新' : '正在读取额度…')]));
  const q = s.quotaConnection;
  const quotaHealthy = live && q?.status === 'reachable' && !s.quotas.stale;
  $('network-badge').textContent = quotaHealthy ? '额度接口正常' : s.quotas.error ? '额度查询异常' : '状态待更新';
  $('network-badge').dataset.tone = quotaHealthy ? 'good' : 'warning';
  $('latency').textContent = q?.status === 'reachable' ? q.elapsedMs ?? '—' : '—';
  $('quota-network-note').textContent = quotaHealthy ? '实际额度请求已成功，监控连接正常。查询耗时不代表模型生成速度。' : s.quotas.error || '暂未取得新的额度结果；请稍候或刷新。';
  const n = s.network;
  if (n) {
    const system = n.source === 'system';
    const route = system ? n.proxy === 'system' ? '系统代理（已确认）' : n.proxy === 'direct' ? '直连（无显式代理）' : n.proxyConfigured ? '系统代理已配置 · 路径待确认' : '代理路径未确认' : n.proxy === 'environment' ? '环境代理变量' : '未配置环境代理变量';
    const status = system && n.transportReachable && n.viaProxy === true ? '代理已连接' : system && n.transportReachable && n.viaProxy === false ? '直连可达' : labels[n.status] || n.status;
    $('probe-heading').textContent = system ? '系统网络探测 · 同菜单栏' : '环境代理探测 · 辅助';
    $('probe-status').textContent = status + (n.stale ? ' · 已过期' : '');
    const details = [['探测耗时', n.elapsedMs == null ? '未知' : `${n.elapsedMs} ms`], ['HTTP', n.httpStatus || '未收到响应'], ['连接方式', route], ['最近检测', dateTime(n.checkedAt)]];
    if (!system) details.push(['DNS', n.dnsMs == null ? '未知' : `${n.dnsMs} ms`]);
    $('network-detail').replaceChildren(...details.map(([key, value]) => { const row = element('div', '', key); row.append(element('b', '', String(value))); return row; }));
    $('network-note').textContent = `${n.target || ''} · ${system ? '直接使用菜单栏同一次系统网络探测，代理、HTTP 与耗时保持一致。' : '尚未收到菜单栏系统探测；当前仅显示环境代理诊断。请打开或更新 Pulse 菜单栏。'} HTTP 响应不保证模型请求可用；不排除 VPN/TUN 或不同路由。`;
    const environment = s.environmentNetwork;
    $('environment-probe').hidden = !system || !environment;
    if (system && environment) {
      $('environment-status').textContent = (labels[environment.status] || environment.status) + (environment.stale ? ' · 已过期' : '');
      $('environment-detail').textContent = `HTTP ${environment.httpStatus || '未收到响应'} · ${environment.elapsedMs ?? '—'} ms · ${environment.proxy === 'environment' ? '已配置环境代理变量' : '未配置环境代理变量（不代表系统代理未开启）'}。此探测不读取系统代理，只用于辅助排查，不作为系统网络结论。`;
    }
    if (lastProbeSource !== n.source) { historyPoints = []; lastProbe = null; lastProbeSource = n.source; }
    if (lastProbe !== n.checkedAt) { lastProbe = n.checkedAt; historyPoints.push(n); historyPoints = historyPoints.slice(-40); }
    const max = Math.max(500, ...historyPoints.map(p => p.elapsedMs || 0));
    $('spark').replaceChildren(...historyPoints.map(p => { const bar = element('i', p.transportReachable ? '' : 'failed'); bar.style.height = `${Math.max(8, (p.elapsedMs || 0) / max * 100)}%`; bar.title = `${labels[p.status]} · ${p.elapsedMs ?? '—'} ms`; return bar; }));
    if (!quotaHealthy && !n.stale && historyPoints.length >= 3 && historyPoints.slice(-3).every(p => !p.transportReachable)) notify('network-down', 'Codex 网络探测提醒', `${system ? '系统网络' : '环境代理'}探测连续三次未收到响应，请检查网络或代理。`);
    if ((quotaHealthy || n.transportReachable) && notified.has('network-down')) { notify(`recovered-${n.checkedAt}`, 'Codex 连接恢复', '额度接口或网络探测已重新收到响应。'); notified.delete('network-down'); }
  }
  const u = s.usage.data;
  const days = [...(u?.dailyUsageBuckets || [])].filter(d => typeof d.startDate === 'string').sort((a, b) => a.startDate.localeCompare(b.startDate));
  const day = days.at(-1), recent = days.slice(-14);
  $('daily').textContent = fmt(day?.tokens); $('daily').title = full(day?.tokens);
  $('daily-date').textContent = day?.startDate || '暂无统计'; $('lifetime').textContent = fmt(u?.summary?.lifetimeTokens); $('lifetime').title = full(u?.summary?.lifetimeTokens);
  $('usage-badge').textContent = s.usage.stale ? '数据待更新' : '账号统计';
  $('usage-note').textContent = s.usage.error || `${s.usage.stale ? '当前显示上次统计。' : ''}统计存在延迟；按服务端统计日展示，已用 Token 不等于剩余额度。`;
  $('usage-range').textContent = recent.length ? `${recent[0].startDate.slice(5)} — ${recent.at(-1).startDate.slice(5)}` : '暂无数据';
  const peak = Math.max(1, ...recent.map(d => Number.isFinite(d.tokens) ? d.tokens : 0));
  $('usage-chart').replaceChildren(...recent.map(d => { const bar = element('i'); bar.style.height = `${Number.isFinite(d.tokens) ? Math.max(2, d.tokens / peak * 100) : 2}%`; bar.title = `${d.startDate} · ${full(d.tokens)} Token`; bar.setAttribute('aria-label', bar.title); return bar; }));
  controls();
}
function notify(key, title, body) {
  if (!notificationEnabled || !('Notification' in window) || Notification.permission !== 'granted' || notified.has(key)) return;
  try { new Notification(title, { body }); notified.add(key); } catch { /* Notifications may be restricted by the browser. */ }
}
$('notify').onclick = async () => {
  if (notificationEnabled) { notificationEnabled = false; $('notify').textContent = '开启提醒'; return; }
  if (!('Notification' in window)) { actionNotice = '当前浏览器不支持通知'; controls(); return; }
  try { notificationEnabled = await Notification.requestPermission() === 'granted'; } catch { notificationEnabled = false; }
  $('notify').textContent = notificationEnabled ? '关闭提醒' : '通知未授权';
  if (notificationEnabled && state) render(state);
};
$('refresh').onclick = async () => {
  if (refreshing || !live || !token) return;
  refreshing = true; actionNotice = '正在查询最新额度…'; controls();
  try {
    const response = await fetch('/api/refresh', { method: 'POST', headers, signal: AbortSignal.timeout(90000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '刷新失败');
    actionNotice = ''; if (result.snapshot) render(result.snapshot);
  } catch (error) { actionNotice = error.name === 'TimeoutError' ? '查询超时，后台恢复仍在继续；请稍候。' : error.message; }
  finally { refreshing = false; controls(); }
};
async function connect() {
  if (!token) { connection('需要访问链接', 'warning'); actionNotice = '请从菜单栏点击“查看详情”，获取有效的本机访问链接。'; controls(); return; }
  try {
    const response = await fetch('/api/events', { headers });
    if (response.status === 401) { live = false; connection('链接已失效', 'warning'); actionNotice = '后台已重新启动，请从菜单栏重新打开“查看详情”。'; controls(); return; }
    if (!response.ok) throw new Error('连接失败');
    live = true; connection('实时同步', 'good');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error('快照过大');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (event.startsWith('data: ')) render(JSON.parse(event.slice(6)));
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  } catch { /* Recover the live stream without discarding the last snapshot. */ }
  live = false; connection('正在重新连接', 'warning');
  if (state) { state.quotas.stale = true; state.usage.stale = true; if (state.network) state.network.stale = true; render(state); }
  setTimeout(connect, 3000);
}
setInterval(() => {
  document.querySelectorAll('.countdown').forEach(el => { el.textContent = countdown(Number(el.dataset.reset)); });
  if (live && state && !state.quotas.stale && Date.now() - state.quotas.updatedAt > 120000) { state.quotas.stale = true; render(state); }
  if (state?.network?.source === 'system' && !state.network.stale && Date.now() - state.network.checkedAt > 65000) { state.network.stale = true; render(state); }
}, 1000);
void connect();
