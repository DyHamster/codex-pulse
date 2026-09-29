import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
export const port = Number(process.env.CODEX_PULSE_PORT || 43127);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CODEX_PULSE_PORT');
export const origin = `http://127.0.0.1:${port}`;
export const runtime = join(tmpdir(), `codex-pulse-${process.getuid?.() ?? 'local'}-${port}`);
export const descriptor = join(runtime, 'service.json');
export async function prepareRuntime() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const stat = await lstat(runtime);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Unsafe runtime directory');
}
