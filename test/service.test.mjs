import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('an occupied foreign port is reported without spawning another service or writing logs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-collision-test-'));
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'start'], {
    env: { ...process.env, CODEX_PULSE_PORT: String(port), CODEX_PULSE_STATE_DIR: dir }, timeout: 5000,
  }), e => e.code === 1 && /端口被其他程序占用/.test(e.stderr));
  await assert.rejects(access(join(dir, String(port), 'service.log')), { code: 'ENOENT' });
});
