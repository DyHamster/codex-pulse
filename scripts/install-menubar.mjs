import { cp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'build', 'Codex Pulse.app');
const applications = join(homedir(), 'Applications');
const destination = join(applications, 'Codex Pulse.app');

execFileSync(process.execPath, [join(root, 'scripts', 'build-menubar.mjs')], {
  stdio: 'inherit',
});

await mkdir(applications, { recursive: true });
try {
  execFileSync('pkill', ['-x', 'CodexPulse'], { stdio: 'ignore' });
} catch (error) {
  if (error.status !== 1) throw error;
}
await cp(source, destination, { recursive: true, force: true });
execFileSync('open', [destination]);
console.log(`Installed and opened: ${destination}`);
