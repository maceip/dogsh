// Pack dist/ into a signed .crx for Edge on Android (Canary), whose
// developer options install extensions from a local crx ("Extension install
// by crx") — Android has no chrome://extensions "load unpacked".
//
//   node build.js && node pack.js   ->  build/dogsh.crx  (+ build/dogsh.pem)
//
// The .pem is the extension's signing identity: keep it, or every pack gets
// a new extension id (and Edge treats it as a different extension). It is
// gitignored; the crx is a build artifact.
const path = require('path');
const fs = require('fs');
const crx3 = require('crx3');

const dist = path.join(__dirname, 'dist');
const out = path.join(__dirname, 'build');
fs.mkdirSync(out, { recursive: true });

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/ missing or stale — run `node build.js` first');
  process.exit(1);
}

crx3([path.join(dist, 'manifest.json')], {
  keyPath: path.join(out, 'dogsh.pem'),
  crxPath: path.join(out, 'dogsh.crx'),
})
  .then(() => {
    console.log('packed build/dogsh.crx (key: build/dogsh.pem)');
    console.log('Edge Android Canary: Settings > About > tap build 5x > Developer options');
    console.log('  > "Extension install by crx" > pick dogsh.crx (e.g. from Downloads)');
  })
  .catch((e) => {
    console.error('pack failed:', e);
    process.exit(1);
  });
