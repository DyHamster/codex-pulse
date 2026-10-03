import { mkdir, writeFile, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { descriptor, origin } from '../src/config.mjs';
import { version } from '../src/version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'build/Codex Pulse.app');
const resources = join(app, 'Contents/Resources');
const executable = join(app, 'Contents/MacOS/CodexPulse');
const minimumMacOS = '13.0';
const machine = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
const targetArch = new Map([
  ['arm64', 'arm64'],
  ['x86_64', 'x86_64'],
]).get(machine);

if (!targetArch) {
  throw new Error(`Unsupported macOS architecture: ${machine}`);
}

const swiftTarget = `${targetArch}-apple-macosx${minimumMacOS}`;

await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
await mkdir(resources, { recursive: true });
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.codex.pulse.menubar</string><key>CFBundleName</key><string>Codex Pulse</string><key>CFBundleExecutable</key><string>CodexPulse</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`;
await writeFile(join(app, 'Contents/Info.plist'), plist);
await writeFile(join(resources, 'config.json'), JSON.stringify({ node: process.execPath, descriptor, origin }));
for (const dir of ['src', 'public']) await cp(join(root, dir), join(resources, 'monitor', dir), { recursive: true });

execFileSync(
  'swiftc',
  [
    '-swift-version', '5',
    '-target', swiftTarget,
    '-module-cache-path', join(root, 'build/module-cache'),
    join(root, 'native/Pulse.swift'),
    '-o', executable,
    '-framework', 'AppKit',
    '-framework', 'CFNetwork',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: minimumMacOS },
  },
);

const vtool = execFileSync('xcrun', ['--find', 'vtool'], { encoding: 'utf8' }).trim();
const buildInfo = execFileSync(vtool, ['-show-build', executable], { encoding: 'utf8' });
const compiledMinimum = buildInfo.match(/^\s*minos\s+([0-9.]+)\s*$/m)?.[1];
if (compiledMinimum !== minimumMacOS) {
  throw new Error(
    `Unexpected Mach-O minimum macOS version: ${compiledMinimum ?? 'missing'}; expected ${minimumMacOS}`,
  );
}

execFileSync(executable, ['--self-test'], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
console.log(`Built ${targetArch} app for macOS ${minimumMacOS}+: ${app}`);
