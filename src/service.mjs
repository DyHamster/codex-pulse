import { spawn } from 'node:child_process';
import { readFile, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { descriptor, origin, runtime, prepareRuntime } from './config.mjs';
export async function existingService() {
  try {
    const data = JSON.parse(await readFile(descriptor, 'utf8'));
    if (data.origin !== origin || !/^[a-f0-9]{64}$/.test(data.token)) return null;
    const res = await fetch(`${origin}/api/status`, { headers: { Authorization: `Bearer ${data.token}` }, signal: AbortSignal.timeout(1500) });
    if (!res.ok || (await res.json()).service !== 'codex-pulse') return null;
    return data;
  } catch { return null; }
}
let starting;
export async function ensureService() {
  if (starting) return starting;
  starting = (async () => {
    await prepareRuntime(); const existing = await existingService(); if (existing) return existing;
    const log = await open(`${runtime}/service.log`, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    let spawnError; child.on('error', e => { spawnError = e; }); child.unref(); await log.close();
    for (let i = 0; i < 40; i++) { if (spawnError) throw spawnError; await delay(200); const found = await existingService(); if (found) return found; }
    throw new Error(`监控服务未启动，请检查端口占用或 ${runtime}/service.log`);
  })();
  try { return await starting; } finally { starting = null; }
}
export async function api(service, path, method = 'GET') {
  const res = await fetch(service.origin + path, { method, headers: { Authorization: `Bearer ${service.token}` }, signal: AbortSignal.timeout(5000) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`); return data;
}
