// Static file service for the daemon's HTTP side. One job: serve the PHONE
// FACE (a PWA-ish page) from the same port the WebSocket lives on, so a
// phone on the tailnet needs exactly one URL and zero install steps.
//
// WHITELIST, not a file server: every servable path is enumerated here and
// resolved at startup. No directory walking, no path arithmetic on request
// strings — a request either names one of these entries or gets a 404.
// (The daemon may be reachable from beyond loopback; this is the only HTTP
// surface it exposes, and it must stay boring.)
import fs from 'fs';
import path from 'path';

const APP_ROOT = path.join(__dirname, '..');

interface Entry {
  file: string;
  mime: string;
}

const FILES: Record<string, Entry> = {
  '/': { file: 'phone/index.html', mime: 'text/html; charset=utf-8' },
  '/phone.js': { file: 'phone/phone.js', mime: 'text/javascript; charset=utf-8' },
  '/config.js': { file: 'shared/config.js', mime: 'text/javascript; charset=utf-8' },
  '/vendor/xterm.js': {
    file: 'node_modules/@xterm/xterm/lib/xterm.js',
    mime: 'text/javascript; charset=utf-8',
  },
  '/vendor/xterm.css': {
    file: 'node_modules/@xterm/xterm/css/xterm.css',
    mime: 'text/css; charset=utf-8',
  },
  '/vendor/addon-fit.js': {
    file: 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
    mime: 'text/javascript; charset=utf-8',
  },
  '/fonts/MesloLGS-NF-Regular.ttf': {
    file: 'shared/fonts/MesloLGS-NF-Regular.ttf',
    mime: 'font/ttf',
  },
  '/fonts/MesloLGS-NF-Bold.ttf': { file: 'shared/fonts/MesloLGS-NF-Bold.ttf', mime: 'font/ttf' },
  '/manifest.webmanifest': {
    file: 'phone/manifest.webmanifest',
    mime: 'application/manifest+json',
  },
  '/icon.png': { file: 'assets/dogsh_icon_1024.png', mime: 'image/png' },
};

import type { IncomingMessage, ServerResponse } from 'http';

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  // Strip query/fragment; the phone face passes ?token= style params that
  // the file lookup must not see.
  const pathname = (req.url || '/').split('?')[0].split('#')[0];
  const entry = FILES[pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const abs = path.join(APP_ROOT, entry.file);
  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': entry.mime,
      'content-length': buf.length,
      // The face is tiny and the daemon is on the same LAN; freshness beats
      // cache staleness debugging on a phone (where devtools are painful).
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}
