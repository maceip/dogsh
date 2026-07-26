#!/usr/bin/env node
// Stamp dogsh.icns into the local Electron.app so `electron .` / debug runs
// never show the stock Electron dock or Finder icon — even before ready.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const icns = path.join(root, 'assets', 'dogsh.icns');
const electronIcns = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Resources',
  'electron.icns'
);

if (!fs.existsSync(icns)) {
  console.warn('[dogsh] stamp-electron-icon: missing', icns);
  process.exit(0);
}
if (!fs.existsSync(electronIcns)) {
  console.warn('[dogsh] stamp-electron-icon: Electron.app not installed yet');
  process.exit(0);
}

fs.copyFileSync(icns, electronIcns);
console.log('[dogsh] stamped dogsh.icns → Electron.app (debug dock/Finder icon)');
