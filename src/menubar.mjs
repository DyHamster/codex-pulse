import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function openMenubar() {
  if (process.platform !== 'darwin') throw new Error('菜单栏应用仅支持 macOS');
  const path = join(homedir(), 'Applications', 'Codex Pulse.app');
  try { await access(path); } catch { throw new Error('请先在项目目录执行 npm run install:menubar'); }
  await promisify(execFile)('open', [path]);
  return { opened: true, path };
}

