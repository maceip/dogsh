#!/usr/bin/env node
// Package a macOS .app for local debug / CI (darwin only, host arch).
// Output: build/dogsh-darwin-<arch>/dogsh.app
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.error('package:mac is darwin-only (this host is ' + process.platform + ')');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const outDir = path.join(root, 'build');
const appPath = path.join(outDir, `dogsh-darwin-${arch}`, 'dogsh.app');

execFileSync(
  path.join(root, 'node_modules', '.bin', 'electron-packager'),
  [
    '.',
    'dogsh',
    '--platform=darwin',
    `--arch=${arch}`,
    `--out=${outDir}`,
    '--overwrite',
    '--no-asar',
    '--icon=assets/dogsh.icns',
    '--ignore=^/build($|/)',
    '--ignore=^/\\.',
  ],
  { cwd: root, stdio: 'inherit' }
);

if (!fs.existsSync(appPath)) {
  console.error('packager did not produce ' + appPath);
  process.exit(1);
}

try {
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
} catch {
  /* CI runners may lack xattr quirks */
}
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
} catch (e) {
  console.warn('codesign ad-hoc failed (ok for CI debug builds):', e.message || e);
}

console.log('packaged', appPath);
