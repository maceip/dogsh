const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const dist = path.join(__dirname, 'dist');
fs.mkdirSync(dist, { recursive: true });

// TypeScript sources: esbuild strips types natively (no tsc emit step in the
// bundle path — `npm run typecheck` runs tsc --noEmit for the type errors).
// Output names must stay content.js / sw.js / offscreen.js: the manifest and
// offscreen.html reference them by name.
const options = {
  entryPoints: [
    path.join(__dirname, 'src', 'content.ts'),
    path.join(__dirname, 'src', 'sw.ts'),
    path.join(__dirname, 'src', 'offscreen.ts'),
  ],
  bundle: true,
  outdir: dist,
  format: 'iife',
  target: 'chrome116',
  loader: { '.css': 'text' },
  logLevel: 'info',
};

function copyStatic() {
  const staticDir = path.join(__dirname, 'static');
  for (const f of fs.readdirSync(staticDir)) {
    fs.copyFileSync(path.join(staticDir, f), path.join(dist, f));
  }
  const fontsSrc = path.join(__dirname, '..', 'app', 'shared', 'fonts');
  const fontsDst = path.join(dist, 'fonts');
  fs.mkdirSync(fontsDst, { recursive: true });
  for (const f of fs.readdirSync(fontsSrc)) {
    fs.copyFileSync(path.join(fontsSrc, f), path.join(fontsDst, f));
  }
}

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    copyStatic();
    await ctx.watch();
    console.log('watching…  (static/ copied once; re-run for manifest changes)');
  } else {
    await esbuild.build(options);
    copyStatic();
    console.log('built extension into dist/ — load that folder via chrome://extensions');
  }
})();
