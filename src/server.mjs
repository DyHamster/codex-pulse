import http from 'node:http';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Monitor } from './monitor.mjs';
import { port, origin, descriptor, prepareRuntime } from './config.mjs';
export async function startServer({ monitor = new Monitor(), listenPort = port, token = randomBytes(32).toString('hex'), persist = true } = {}) {
  const clients = new Set(); let lastRefresh = 0; let closing = false;
  const expectedOrigin = `http://127.0.0.1:${listenPort}`;
  const assets = new Map(await Promise.all(['index.html', 'style.css', 'app.js'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  const auth = req => { const value = (req.headers.authorization || '').replace(/^Bearer /, ''); return value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token)); };
  const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (req.headers.host !== `127.0.0.1:${listenPort}` || (req.headers.origin && req.headers.origin !== expectedOrigin)) return json(res, 403, { error: 'Forbidden origin' });
      const path = new URL(req.url, expectedOrigin).pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { service: 'codex-pulse', version: '0.1.0' });
      const asset = path === '/' ? 'index.html' : path.slice(1);
      if (req.method === 'GET' && assets.has(asset)) { res.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'); return res.end(assets.get(asset)); }
      if (!auth(req)) return json(res, 401, { error: 'Authentication required' });
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, monitor.snapshot());
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        clients.add(res); res.write(`data: ${JSON.stringify(monitor.snapshot())}\n\n`);
        req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST' && path === '/api/refresh') {
        if (Date.now() - lastRefresh < 10000) return json(res, 429, { error: '请等待 10 秒后再刷新' });
        lastRefresh = Date.now(); void monitor.refreshAccount(); void monitor.refreshNetwork(); return json(res, 202, { accepted: true });
      }
      if (req.method === 'POST' && path === '/api/stop') { json(res, 200, { stopped: true }); setImmediate(() => close()); return; }
      json(res, 404, { error: 'Not found' });
    } catch { if (!res.headersSent) json(res, 500, { error: 'Internal error' }); else res.end(); }
  });
  const publish = () => { const event = `data: ${JSON.stringify(monitor.snapshot())}\n\n`; for (const res of clients) { if (res.writableLength > 1024 * 1024) { res.destroy(); clients.delete(res); } else res.write(event); } };
  monitor.on('update', publish);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  if (persist) {
    try { await prepareRuntime(); await writeFile(descriptor + '.tmp', JSON.stringify({ token, origin, pid: process.pid }), { mode: 0o600 }); await rename(descriptor + '.tmp', descriptor); }
    catch (e) { server.close(); throw e; }
  }
  const heartbeat = setInterval(publish, 15000); heartbeat.unref(); monitor.start();
  async function close() {
    if (closing) return; closing = true; clearInterval(heartbeat); monitor.close(); monitor.off('update', publish);
    for (const res of clients) res.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (persist) { try { const data = JSON.parse(await readFile(descriptor, 'utf8')); if (data.token === token) await unlink(descriptor); } catch {} }
  }
  return { server, close, token, url: `${expectedOrigin}/#${token}` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const service = await startServer();
  process.on('SIGTERM', () => void service.close()); process.on('SIGINT', () => void service.close());
}
