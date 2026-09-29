import { ensureService, existingService, api } from './service.mjs';
try {
  const command = process.argv[2] || 'start';
  if (command === 'start') { const s = await ensureService(); console.log(`Codex Pulse 已启动\n${s.origin}/#${s.token}`); }
  else if (command === 'status') { const s = await ensureService(); console.log(JSON.stringify(await api(s, '/api/status'), null, 2)); }
  else if (command === 'stop') { const s = await existingService(); if (s) await api(s, '/api/stop', 'POST'); console.log('Codex Pulse 已停止'); }
  else throw new Error('用法：node src/cli.mjs start|status|stop');
} catch (e) { console.error(e.message); process.exitCode = 1; }
