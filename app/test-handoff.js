// Protocol test: pretend to be a tab face, claim focus, verify the daemon
// hands off (snapshot first, then a fly-in reveal carrying the native rect).
// Run with: node test-handoff.js   (while the app is running)
const WebSocket = require('ws');
const CONFIG = require('./shared/config.js');

const ws = new WebSocket(`ws://127.0.0.1:${CONFIG.port}`);
let gotSnapshot = false;

const timeout = setTimeout(() => {
  console.error('[test] FAIL: no reveal within 10s');
  process.exit(1);
}, 10000);

ws.on('open', () => {
  ws.send(
    JSON.stringify({ type: 'hello', surface: 'tab', href: 'test://fake', proto: CONFIG.protocolVersion })
  );
  setTimeout(() => ws.send(JSON.stringify({ type: 'focus' })), 300);
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'snapshot') {
    gotSnapshot = true;
    console.log(`[test] snapshot received (${msg.data.length} bytes, ${msg.cols}x${msg.rows})`);
  } else if (msg.type === 'reveal') {
    if (!gotSnapshot) {
      console.error('[test] FAIL: reveal arrived before snapshot');
      process.exit(1);
    }
    // native->tab reveals fly in from the native window's screen rect.
    const okRect =
      msg.mode === 'fly' &&
      msg.from &&
      Number.isFinite(msg.from.x) &&
      msg.from.width > 100 &&
      msg.from.height > 100;
    if (okRect) {
      console.log(
        `[test] PASS phase 1: native->tab handoff — reveal mode=fly from rect ${JSON.stringify(msg.from)}`
      );
      phase2();
    } else {
      console.error(`[test] FAIL: bad reveal payload: ${JSON.stringify(msg)}`);
      process.exit(1);
    }
  } else if (msg.type === 'hide') {
    console.log(`[test] PASS phase 2a: tab1 got hide mode=${msg.mode} when tab2 claimed focus`);
    tab1Hidden = true;
    maybeDone();
  }
});

// Phase 2: a second tab claims focus -> expect settle-reveal there and an
// instant hide here (the "it never moved" tab->tab path).
let tab1Hidden = false;
let tab2Revealed = false;

function maybeDone() {
  if (tab1Hidden && tab2Revealed) {
    console.log('[test] PASS: all phases');
    clearTimeout(timeout);
    process.exit(0);
  }
}

function phase2() {
  const ws2 = new WebSocket(`ws://127.0.0.1:${CONFIG.port}`);
  ws2.on('open', () => {
    ws2.send(
      JSON.stringify({ type: 'hello', surface: 'tab', href: 'test://fake2', proto: CONFIG.protocolVersion })
    );
    setTimeout(() => ws2.send(JSON.stringify({ type: 'focus' })), 200);
  });
  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'reveal') {
      if (msg.mode === 'instant') {
        console.log('[test] PASS phase 2b: tab2 got reveal');
        tab2Revealed = true;
        maybeDone();
      } else {
        console.error(`[test] FAIL: tab2 expected instant reveal, got ${JSON.stringify(msg)}`);
        process.exit(1);
      }
    }
  });
}

ws.on('error', (e) => {
  console.error('[test] FAIL: cannot connect — is the app running?', e.message);
  process.exit(1);
});
