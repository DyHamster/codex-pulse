import { createInterface } from 'node:readline';
import { ensureService, api } from './service.mjs';
const definitions = [
  ['get_status', '读取 Codex 账号剩余额度、已用 Token 与网络探测快照。额度是百分比，不是剩余 Token 数。'],
  ['diagnose_network', '请求一次额度与网络刷新，立即返回缓存和刷新状态；探测不调用模型。'],
  ['get_dashboard_url', '获取本地实时监控面板链接，链接含本机访问密钥，仅向当前用户展示。']
].map(([name, description]) => ({ name, description, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));
const send = data => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
async function handle(msg) {
  if (msg.id === undefined) return;
  const reply = result => send({ id: msg.id, result });
  if (msg.method === 'initialize') return reply({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'codex-pulse', version: '0.1.0' } });
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: definitions });
  if (msg.method !== 'tools/call') return send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  const name = msg.params?.name;
  if (!definitions.some(t => t.name === name)) return send({ id: msg.id, error: { code: -32602, message: 'Unknown tool' } });
  if (msg.params?.arguments && Object.keys(msg.params.arguments).length) return send({ id: msg.id, error: { code: -32602, message: 'This tool accepts no arguments' } });
  try {
    const s = await ensureService(); let data;
    if (name === 'get_dashboard_url') data = { url: `${s.origin}/#${s.token}` };
    else {
      let refresh = null;
      if (name === 'diagnose_network') { try { refresh = await api(s, '/api/refresh', 'POST'); } catch (e) { refresh = { error: e.message }; } }
      data = await api(s, '/api/status'); if (refresh) data.refresh = refresh;
    }
    reply({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
  } catch (e) { reply({ isError: true, content: [{ type: 'text', text: e.message }] }); }
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { try { const msg = JSON.parse(line); void handle(msg).catch(() => send({ id: msg.id ?? null, error: { code: -32603, message: 'Internal error' } })); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); } });
