// Dev extension server for Edge on Android (Canary).
//
// Edge's developer options can point "Extension local server config" at a
// custom webstore base; "Extension install by id" then fetches the crx from
// it instead of edge.microsoft.com — which is how we iterate on the phone
// without the pick-a-file dance every build:
//
//   node build.js && node pack.js && node serve.js
//   phone: Developer options > Extension local server config > http://<laptop>:47723
//          Developer options > Extension install by id       > <extension id>
//
// The server is deliberately promiscuous about paths: the exact request
// shape Edge uses against a local base is undocumented, so ANY GET that
// mentions the extension id (or asks for *.crx) gets the crx, any request
// for an update manifest gets Omaha XML, and EVERY request is logged loudly
// so the real protocol teaches us. LAN-only dev tool: no auth, no TLS.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.DOGSH_EXT_PORT || 47723);
const BUILD = path.join(__dirname, 'build');
const CRX = path.join(BUILD, 'dogsh.crx');
const PEM = path.join(BUILD, 'dogsh.pem');
const MANIFEST = path.join(__dirname, 'dist', 'manifest.json');

if (!fs.existsSync(CRX) || !fs.existsSync(PEM)) {
  console.error('build/dogsh.crx or build/dogsh.pem missing — run `node build.js && node pack.js` first');
  process.exit(1);
}

// Extension id = first 16 bytes of sha256(spki pubkey), digits mapped a-p.
function extensionId() {
  const key = crypto.createPrivateKey(fs.readFileSync(PEM, 'utf8'));
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(spki).digest();
  return [...hash.slice(0, 16)].map((b) => 'abcdefghijklmnop'[b >> 4] + 'abcdefghijklmnop'[b & 15]).join('');
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function lanIp() {
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs || []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, ip: a.address }))
  );
  const en0 = all.find((a) => a.name === 'en0');
  return (en0 || all[0] || {}).ip || '127.0.0.1';
}

const ID = extensionId();
// Last time the crx was actually fetched — deploy-phone.js polls /stat to
// CONFIRM a redeploy landed instead of trusting blind adb taps.
let lastCrxFetch = 0;
let lastCrxVersion = null;

function sendCrx(req, res) {
  lastCrxFetch = Date.now();
  lastCrxVersion = version();
  // The webstore protocol's `response=redirect` asks for a 302 to the crx.
  const wantsRedirect = /response=redirect/.test(req.url);
  if (wantsRedirect && !req.url.includes('/dogsh.crx')) {
    res.writeHead(302, { location: '/dogsh.crx' });
    res.end();
    return;
  }
  // Re-read every time: pack.js may have just rewritten it.
  const buf = fs.readFileSync(CRX);
  res.writeHead(200, {
    'content-type': 'application/x-chrome-extension',
    'content-length': buf.length,
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendOmaha(res) {
  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${ID}'>
    <updatecheck codebase='http://${lanIp()}:${PORT}/dogsh.crx' version='${version()}' />
  </app>
</gupdate>`;
  res.writeHead(200, { 'content-type': 'application/xml', 'cache-control': 'no-cache' });
  res.end(xml);
}

const server = http.createServer((req, res) => {
  console.log(`[ext-serve] ${new Date().toISOString()} ${req.method} ${req.url}`);
  const url = req.url || '/';
  if (url.startsWith('/stat')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ lastCrxFetch, lastCrxVersion, version: version(), id: ID }));
    return;
  }
  if (url.includes(ID) || url.includes('.crx') || /\bcrx\b/.test(url)) return sendCrx(req, res);
  if (url.includes('update') || url.includes('.xml')) return sendOmaha(res);
  // Root: a human-readable status page (handy to sanity-check from the phone).
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(
    `dogsh extension dev server\n\nid:      ${ID}\nversion: ${version()}\ncrx:     http://${lanIp()}:${PORT}/dogsh.crx\nomaha:   http://${lanIp()}:${PORT}/updates.xml\n`
  );
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ext-serve] http://${lanIp()}:${PORT}  (id ${ID}, version ${version()})`);
  console.log('[ext-serve] phone: Developer options > Extension local server config >');
  console.log(`[ext-serve]   http://${lanIp()}:${PORT}`);
  console.log(`[ext-serve] then: Extension install by id > ${ID}`);
});
