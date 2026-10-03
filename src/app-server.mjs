import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { version } from './version.mjs';
export function codexBinary() {
  if (process.env.CODEX_PULSE_CODEX_BIN) return process.env.CODEX_PULSE_CODEX_BIN;
  for (const p of ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/Codex.app/Contents/Resources/codex']) if (existsSync(p)) return p;
  return 'codex';
}
export class AppServer extends EventEmitter {
  next = 0; pending = new Map(); child = null; ready = null;
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start();
    try { await this.ready; } catch (e) { this.close(); throw e; }
  }
  async start() {
    const child = spawn(codexBinary(), ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.on('data', () => {}); // Do not log credentials or account details.
    const fail = () => {
      if (this.child !== child) return;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 服务已断开')); }
      this.pending.clear(); this.child = null; this.ready = null;
      lines.close(); if (child.exitCode === null) child.kill();
    };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && msg.method) {
        child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Read-only monitor does not support server requests' } }) + '\n');
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; p.reject(e); } else p.resolve(msg.result);
      } else if (msg.method) this.emit('notification', msg);
    });
    await this.request('initialize', { clientInfo: { name: 'codex_pulse', title: 'Codex Pulse', version }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.stdin.destroyed) return reject(new Error('Codex 服务未连接'));
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 服务已关闭')); }
    this.pending.clear(); this.child?.stdin.end(); this.child?.kill(); this.child = null; this.ready = null;
  }
}
