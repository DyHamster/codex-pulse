import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
test('MCP initialization, discovery, invalid tools and protocol errors', async t => {
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))]); t.after(() => proc.kill());
  let id = 0; const pending = new Map();
  createInterface({ input: proc.stdout }).on('line', line => { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); });
  const call = (method, params) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const init = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  const list = await call('tools/list'); assert.equal(list.result.tools.length, 3);
  assert.equal((await call('tools/call', { name: 'bad' })).error.code, -32602);
  assert.equal((await call('unknown')).error.code, -32601);
});
