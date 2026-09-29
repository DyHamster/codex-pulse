import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export function classifyNetwork(code, http, elapsed) {
  if (code) return ({ 5: 'proxy_error', 6: 'dns_error', 7: 'connect_error', 28: 'timeout', 35: 'tls_error', 60: 'tls_error' })[code] || 'network_error';
  if (http === 401) return 'auth_required';
  if (http === 403) return 'access_denied';
  if (http === 429) return 'rate_limited';
  if (http >= 500) return 'server_error';
  if (!http) return 'network_error';
  return elapsed > 1500 ? 'slow' : 'reachable';
}
export async function probeNetwork(mode = 'chatgpt') {
  const url = mode === 'apiKey' ? 'https://api.openai.com/v1/models' : 'https://chatgpt.com/';
  const args = ['--disable', '--silent', '--output', '/dev/null', '--connect-timeout', '4', '--max-time', '8', '--write-out', '%{json}', url];
  let result, code = 0;
  try { result = await run('curl', args, { timeout: 10000, maxBuffer: 128 * 1024 }); }
  catch (e) { result = e; code = typeof e.code === 'number' ? e.code : -1; }
  let metrics = {}; try { metrics = JSON.parse(result.stdout); } catch {}
  const http = metrics.http_code || metrics.response_code || 0;
  const ms = n => typeof n === 'number' ? Math.round(n * 1000) : null;
  const elapsedMs = ms(metrics.time_total);
  return { checkedAt: Date.now(), target: url, status: classifyNetwork(code, http, elapsedMs), httpStatus: http || null,
    elapsedMs, dnsMs: ms(metrics.time_namelookup), connectMs: ms(metrics.time_connect), tlsMs: ms(metrics.time_appconnect), firstByteMs: ms(metrics.time_starttransfer),
    proxy: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].some(k => process.env[k]) ? 'environment' : 'not_detected',
    routeVerified: false, transportReachable: http > 0,
    note: '轻量 HTTPS 探测；继承环境代理，未验证与 Codex 路径一致。HTTP 拒绝不等于断网；不代表模型生成速度。' };
}
