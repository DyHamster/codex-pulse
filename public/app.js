const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('pulse-token');
if (location.hash) { sessionStorage.setItem('pulse-token', token); history.replaceState(null, '', '/'); }
const headers = { Authorization: `Bearer ${token || ''}` };
let state, lastProbe, historyPoints = [], notified = new Set(), notificationEnabled = false;
const labels = { reachable: '服务可达', slow: '响应较慢', auth_required: '可达 · 需要鉴权', access_denied: '可达 · 访问受限', rate_limited: '可达 · 请求限流', server_error: '服务端异常', dns_error: 'DNS 解析失败', proxy_error: '代理错误', connect_error: '连接失败', tls_error: 'TLS 错误', timeout: '连接超时', network_error: '探测失败' };
const fmt = n => n == null ? '—' : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const duration = mins => mins == null ? '未知窗口' : mins % 1440 === 0 ? `${mins / 1440} 天窗口` : mins % 60 === 0 ? `${mins / 60} 小时窗口` : `${mins} 分钟窗口`;
const countdown = at => { if (!at) return '重置时间未知'; const sec = Math.ceil(at - Date.now() / 1000); if (sec <= 0) return '等待额度更新'; const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); const d = Math.floor(h / 24); return `${d ? `${d} 天 ` : ''}${h % 24 ? `${h % 24} 小时 ` : ''}${m} 分钟后重置`; };
function element(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function render(s) {
  state = s;
  $('account').textContent = s.account ? `${(s.account.plan || s.account.type).toUpperCase()}  ·  ${s.account.email || '本机 Codex CLI 账号'}` : '未获取账号 · 请确认 Codex CLI 已登录';
  $('updated').textContent = s.quotas.updatedAt ? `额度更新于 ${new Date(s.quotas.updatedAt).toLocaleTimeString('zh-CN')}${s.quotas.stale ? ' · 已过期' : ''}` : '等待首次额度采集';
  $('notice').textContent = s.quotas.error || '';
  const cards = [];
  for (const bucket of s.quotas.data) for (const w of bucket.windows) {
    const card = element('article', `card quota-card${w.remainingPercent !== null && w.remainingPercent <= 20 ? ' low' : ''}${s.quotas.stale ? ' stale' : ''}`);
    const label = element('div', 'label'); label.append(element('span', '', duration(w.minutes)), element('span', '', bucket.name));
    const number = element('div', 'quota-number'); number.append(element('strong', '', w.remainingPercent == null ? '—' : String(w.remainingPercent)), element('span', '', '%'), element('small', '', s.quotas.stale ? '上次可用额度 · 已过期' : '剩余可用额度'));
    const track = element('div', 'track'); const fill = element('div', 'fill'); fill.style.width = `${w.remainingPercent ?? 0}%`; track.append(fill);
    const footer = element('div', 'quota-footer'); const reset = element('span', 'countdown', countdown(w.resetsAt)); reset.dataset.reset = w.resetsAt || ''; footer.append(reset, element('span', '', w.usedPercent == null ? '已用未知' : `已使用 ${w.usedPercent}%`));
    card.append(label, number, track, footer); cards.push(card);
    const threshold = w.remainingPercent <= 10 ? 10 : w.remainingPercent <= 20 ? 20 : null;
    if (w.remainingPercent !== null && threshold && !s.quotas.stale) notify(`${bucket.id}/${w.key}/${w.resetsAt}/${threshold}`, 'Codex 额度提醒', `${duration(w.minutes)}剩余 ${w.remainingPercent}%`);
  }
  $('quotas').replaceChildren(...(cards.length ? cards : [element('article', 'card placeholder', s.quotas.error ? '额度暂不可用，恢复后自动更新' : '等待额度数据…')]));
  const n = s.network;
  if (n) {
    $('network-badge').textContent = (labels[n.status] || n.status) + (n.stale ? ' · 已过期' : ''); $('latency').textContent = n.elapsedMs ?? '—';
    $('network-detail').replaceChildren(...[['额度接口', s.quotaConnection?.status === 'reachable' ? `最近成功 · ${s.quotaConnection.elapsedMs} ms` : '暂不可用'], ['HTTP', n.httpStatus || '无响应'], ['代理', n.proxy === 'environment' ? '环境代理' : '未检测到环境代理'], ['DNS', n.dnsMs == null ? '—' : `${n.dnsMs} ms`], ['最近检测', new Date(n.checkedAt).toLocaleTimeString('zh-CN')]].map(([k, v]) => { const row = element('div', '', `${k}  `); row.append(element('b', '', String(v))); return row; }));
    $('network-note').textContent = `${n.target || ''} · ${n.note || ''}`;
    if (lastProbe !== n.checkedAt) { lastProbe = n.checkedAt; historyPoints.push(n); historyPoints = historyPoints.slice(-40); }
    const max = Math.max(500, ...historyPoints.map(p => p.elapsedMs || 0));
    $('spark').replaceChildren(...historyPoints.map(p => { const bar = element('i', p.transportReachable ? '' : 'failed'); bar.style.height = `${Math.max(12, (p.elapsedMs || 0) / max * 100)}%`; bar.title = `${labels[p.status]} · ${p.elapsedMs ?? '—'} ms`; return bar; }));
    if (historyPoints.length >= 3 && historyPoints.slice(-3).every(p => !p.transportReachable)) notify('network-down', 'Codex 网络提醒', '连续三次探测未收到 HTTP 响应，请检查网络。');
    if (n.transportReachable && notified.has('network-down')) { notify(`recovered-${n.checkedAt}`, 'Codex 网络恢复', '探测已重新收到 HTTP 响应。'); notified.delete('network-down'); }
  }
  const u = s.usage.data; const days = [...(u?.dailyUsageBuckets || [])].sort((a, b) => a.startDate.localeCompare(b.startDate)); const day = days.at(-1);
  $('daily').textContent = fmt(day?.tokens); $('daily-date').textContent = day?.startDate || '暂无统计'; $('lifetime').textContent = fmt(u?.summary?.lifetimeTokens);
  $('usage-note').textContent = s.usage.error || `${s.usage.stale ? '数据未更新。' : ''}统计存在延迟；最近统计日按服务端日期展示，已用 Token 不等于剩余额度。`;
}
function notify(key, title, body) { if (!notificationEnabled || Notification.permission !== 'granted' || notified.has(key)) return; notified.add(key); new Notification(title, { body }); }
$('notify').onclick = async () => { if (!('Notification' in window)) { $('notice').textContent = '当前浏览器不支持通知'; return; } notificationEnabled = await Notification.requestPermission() === 'granted'; $('notify').textContent = notificationEnabled ? '提醒已开启' : '通知未授权'; };
$('refresh').onclick = async () => {
  $('refresh').disabled = true;
  try { const r = await fetch('/api/refresh', { method: 'POST', headers }); const result = await r.json(); if (!r.ok) throw new Error(result.error); $('notice').textContent = '正在刷新…'; } catch (e) { $('notice').textContent = e.message; }
  finally { setTimeout(() => { $('refresh').disabled = false; }, 10000); }
};
async function connect() {
  if (!token) { $('connection').textContent = '需要访问链接'; $('notice').textContent = '请通过插件“打开监控面板”获取含访问密钥的链接。'; return; }
  try {
    const response = await fetch('/api/events', { headers }); if (!response.ok) { if (response.status === 401) { $('connection').textContent = '链接已失效'; $('notice').textContent = '请重新通过插件获取面板链接。'; return; } throw new Error('连接失败'); }
    $('connection').textContent = '● 实时连接'; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let end; while ((end = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (event.startsWith('data: ')) render(JSON.parse(event.slice(6))); } }
  } catch {}
  $('connection').textContent = '连接中断 · 正在重连'; if (state) { state.quotas.stale = true; state.usage.stale = true; if (state.network) state.network.stale = true; render(state); }
  setTimeout(connect, 3000);
}
setInterval(() => document.querySelectorAll('.countdown').forEach(el => { el.textContent = countdown(Number(el.dataset.reset)); }), 1000);
void connect();
