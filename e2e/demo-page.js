// Tiny static server for manual demo testing: a guaranteed content-script
// -injectable page (extensions can't run on chrome:// or the Web Store).
// Run: node demo-page.js   then open http://127.0.0.1:47790
const http = require('http');

const PORT = 47790;

function page(title, hue) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    body{margin:0;font:16px/1.6 -apple-system,sans-serif;background:hsl(${hue},30%,12%);color:#dde;}
    main{max-width:640px;margin:60px auto;padding:0 24px;}
    h1{font-size:40px} p{opacity:.7} a{color:#8bf}
  </style></head><body><main><h1>${title}</h1>
  <p>An ordinary web page. The terminal is not part of this page — it follows you here.</p>
  <p>Other tab: <a href="/a">Page A</a> · <a href="/b">Page B</a></p>
  ${'<p>Scroll filler.</p>'.repeat(30)}</main></body></html>`;
}

http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url.startsWith('/b') ? page('Page B', 260) : page('Page A', 210));
  })
  .listen(PORT, () => console.log(`demo pages at http://127.0.0.1:${PORT}/a and /b`));
