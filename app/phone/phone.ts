// Phone face: a full-page remote face of the daemon, served by the daemon
// itself. Protocol-wise it is a 'tab' face like any browser overlay — durable
// faceKey, raw {visible,focused} signals, owner-state rendering — plus the
// v8 remote rules on the daemon side: its socket arrives from beyond
// loopback, so it authenticates with the shared token and its engagement can
// outrank an idle-focused laptop window (picking up the phone IS the
// handoff).
//
// SCRIPT-KIND FILE (no import/export): loaded via a bare <script> tag after
// xterm's UMD bundles and /config.js. Types come from the ambient
// declarations in ../types/ and ../shared/config.d.ts.
(async () => {
  const C = DOGSH_CONFIG;

  const $ = (id: string): HTMLElement => document.getElementById(id)!;
  const statusEl = $('status');
  const veil = $('veil');
  const gate = $('gate');

  // -------------------------------------------------------------------
  // Identity + secret. faceKey makes THIS PHONE one durable face across
  // visits and reconnects (same ledger row, same ownership). The token
  // arrives once via the URL fragment (#t=..., never sent to the server,
  // never logged) or the gate form, then lives in localStorage.
  // -------------------------------------------------------------------
  const faceKey =
    localStorage.getItem('dogsh.faceKey') ||
    (() => {
      const k = `phone-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('dogsh.faceKey', k);
      return k;
    })();
  let token = localStorage.getItem('dogsh.token') || '';
  const frag = /[#&]t=([^&]+)/.exec(location.hash);
  if (frag) {
    token = decodeURIComponent(frag[1]);
    localStorage.setItem('dogsh.token', token);
    history.replaceState(null, '', location.pathname); // secret out of the URL
  }

  // Load the Nerd Font before the terminal measures cell metrics (same as
  // the native face; p10k prompts use private-use glyphs).
  try {
    await Promise.all([
      new FontFace('MesloLGS NF', "url(/fonts/MesloLGS-NF-Regular.ttf)").load(),
      new FontFace('MesloLGS NF', "url(/fonts/MesloLGS-NF-Bold.ttf)", { weight: 'bold' }).load(),
    ]).then((fonts) => fonts.forEach((f) => document.fonts.add(f)));
  } catch {
    /* fall back to the stack's monospace */
  }

  const term = new Terminal({
    cols: C.cols,
    rows: C.rows,
    scrollback: C.scrollback,
    // Phone screens are dense; slightly smaller cells buy usable columns.
    fontSize: Math.max(10, C.fontSize - 2),
    lineHeight: C.lineHeight,
    fontFamily: C.fontFamily,
    theme: C.theme,
    cursorBlink: true,
    allowProposedApi: true,
    ...C.termBehavior,
  });
  term.open($('term'));
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  function fittedDims(): { cols: number; rows: number } | null {
    try {
      const d = fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
      return { cols: Math.max(20, Math.min(500, d.cols)), rows: Math.max(5, Math.min(200, d.rows)) };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Socket. Same origin the page came from: ws on http, wss on https.
  // Hot-potato may replace this with host-fenced.redirectUrl.
  let ws: WebSocket | null = null;
  let myId: number | null = null;
  let sessionId: number | null = null;
  let owned = false;
  let lastGen = -1;
  let retryTimer: number | undefined;
  let daemonWsUrl =
    (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;

  function post(msg: DogshClientMsg): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function connect(): void {
    // No token? Try anyway: a loopback daemon doesn't demand one, and a
    // remote daemon answers 4401 — which is what opens the gate. The
    // daemon is the authority on whether a secret is needed, not the face.
    ws = new WebSocket(daemonWsUrl);
    statusEl.style.background = '#6e7681';
    ws.onopen = () => {
      const dims = fittedDims();
      post({
        type: 'hello',
        surface: 'tab',
        proto: C.protocolVersion,
        href: location.href,
        faceKey,
        token: token || undefined,
        sig: currentSig(),
        caps: { cols: dims ? dims.cols : term.cols, rows: dims ? dims.rows : term.rows, canResize: true },
      });
    };
    ws.onmessage = (ev) => {
      let msg: DogshDaemonMsg;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      onDaemonMessage(msg);
    };
    ws.onclose = (ev) => {
      myId = null;
      statusEl.style.background = '#6e7681';
      setOwned(false);
      if (ev.code === 4401) {
        // The daemon refused the secret (or the lack of one). Ask the human.
        localStorage.removeItem('dogsh.token');
        showGate(token ? 'token rejected — check DOGSH_TOKEN on the laptop' : '');
        token = '';
        return;
      }
      retryTimer = window.setTimeout(connect, 2000);
    };
    ws.onerror = () => ws?.close();
  }

  function showGate(err: string): void {
    gate.dataset.on = '1';
    $('gate-err').textContent = err;
  }
  $('go').addEventListener('click', () => {
    const val = ($('token') as HTMLInputElement).value.trim();
    if (!val) return;
    token = val;
    localStorage.setItem('dogsh.token', token);
    delete gate.dataset.on;
    if (retryTimer) clearTimeout(retryTimer);
    connect();
  });

  function freshGen(msg: { gen?: number }): boolean {
    if (typeof msg.gen !== 'number') return true;
    if (msg.gen < lastGen) return false;
    lastGen = msg.gen;
    return true;
  }

  // -------------------------------------------------------------------
  // Owner-state rendering: the veil (and the wake lock) — never a report.
  // -------------------------------------------------------------------
  let wakeLock: { release(): Promise<void> } | null = null;
  async function syncWakeLock(): Promise<void> {
    // Keep the screen alive only while this face OWNS the terminal and is
    // visible; secure-context only (wss), and best-effort everywhere.
    const want = owned && document.visibilityState === 'visible';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        type WL = { request(t: string): Promise<{ release(): Promise<void> }> };
        wakeLock = await (navigator as unknown as { wakeLock: WL }).wakeLock.request('screen');
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      wakeLock = null;
    }
  }

  function setOwned(next: boolean): void {
    owned = next;
    if (next) delete veil.dataset.on;
    else veil.dataset.on = '1';
    statusEl.style.background = next ? '#d29922' : myId != null ? '#3fb950' : '#6e7681';
    void syncWakeLock();
  }

  function renderTabs(list: DogshSessionListMsg): void {
    const tabs = $('tabs');
    tabs.textContent = '';
    for (const s of list.sessions) {
      const el = document.createElement('div');
      el.className = 'tab';
      if (s.id === list.active) el.dataset.active = '1';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = s.title || `shell ${s.id}`;
      el.appendChild(label);
      el.addEventListener('click', () => post({ type: 'session-switch', sessionId: s.id }));
      tabs.appendChild(el);
    }
  }

  function applyGrid(cols?: number, rows?: number): void {
    if (!cols || !rows) return;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  }

  function onDaemonMessage(msg: DogshDaemonMsg): void {
    switch (msg.type) {
      case 'hello-ack':
        myId = msg.clientId;
        sessionId = msg.sessionId;
        if (typeof msg.gen === 'number') lastGen = msg.gen;
        statusEl.style.background = '#3fb950';
        {
          const role =
            msg.leaseRole === 'sole' || msg.leaseRole === 'mute' || msg.leaseRole === 'monitor'
              ? msg.leaseRole
              : msg.owner === myId
                ? 'sole'
                : 'monitor';
          setOwned(role === 'sole' || role === 'monitor');
          // Phone/network face: monitor still shows; sole takes input via ownedInput
          (window as unknown as { __dogshSole?: boolean }).__dogshSole = role === 'sole';
        }
        break;
      case 'session-list':
        sessionId = msg.active;
        renderTabs(msg);
        break;
      case 'owner-state':
        if (!freshGen(msg)) break;
        {
          const role =
            msg.leaseRole === 'sole' || msg.leaseRole === 'mute' || msg.leaseRole === 'monitor'
              ? msg.leaseRole
              : msg.owner === myId
                ? 'sole'
                : 'monitor';
          setOwned(role === 'sole' || role === 'monitor');
          (window as unknown as { __dogshSole?: boolean }).__dogshSole = role === 'sole';
        }
        break;
      case 'host-fenced':
        myId = null;
        lastGen = -1;
        setOwned(false);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        if (typeof msg.redirectUrl === 'string' && msg.redirectUrl) {
          daemonWsUrl = msg.redirectUrl;
        }
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, 200);
        break;
      case 'snapshot':
        if (msg.sessionId != null) sessionId = msg.sessionId;
        applyGrid(msg.cols, msg.rows);
        term.reset();
        term.write(msg.data);
        break;
      case 'grid':
        applyGrid(msg.cols, msg.rows);
        break;
      case 'data':
        term.write(msg.data);
        break;
      case 'clear':
        term.clear();
        break;
      case 'session-exit':
        if (msg.sessionId == null || msg.sessionId === sessionId) {
          term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
        }
        break;
      case 'stale':
        $('title').textContent = 'dogsh — face outdated, pull to refresh';
        $('title').style.color = '#e3b341';
        break;
    }
  }

  // -------------------------------------------------------------------
  // Input. Ctrl is a sticky one-shot modifier (soft keyboards have no
  // ctrl): arm it, the next typed letter becomes its control byte.
  // -------------------------------------------------------------------
  let ctrlArmed = false;
  const ctrlBtn = $('k-ctrl');
  function sendInput(data: string): void {
    if (!(window as unknown as { __dogshSole?: boolean }).__dogshSole) return;
    if (ctrlArmed && data.length === 1) {
      const c = data.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) data = String.fromCharCode(c - 96);
      ctrlArmed = false;
      delete ctrlBtn.dataset.armed;
    }
    post({ type: 'input', sessionId, data });
  }
  term.onData(sendInput);

  const KEYS: Array<[string, string]> = [
    ['k-esc', '\x1b'],
    ['k-tab', '\t'],
    ['k-up', '\x1b[A'],
    ['k-down', '\x1b[B'],
    ['k-left', '\x1b[D'],
    ['k-right', '\x1b[C'],
  ];
  for (const [id, seq] of KEYS) {
    $(id).addEventListener('click', () => {
      sendInput(seq);
      term.focus();
    });
  }
  ctrlBtn.addEventListener('click', () => {
    ctrlArmed = !ctrlArmed;
    if (ctrlArmed) ctrlBtn.dataset.armed = '1';
    else delete ctrlBtn.dataset.armed;
    term.focus();
  });

  // -------------------------------------------------------------------
  // Signals: event-backed raw levels, the same contract every face keeps.
  // Picking the phone up = unlock/foreground -> visibilitychange fires ->
  // a LIVE engaged report -> the arbiter's v8 rule does the rest.
  // -------------------------------------------------------------------
  function currentSig(): { visible: boolean; focused: boolean } {
    return {
      visible: document.visibilityState === 'visible',
      // Mobile browsers keep hasFocus() true whenever the page is the
      // foreground tab; on desktop it distinguishes window focus too.
      focused: document.hasFocus(),
    };
  }
  function reportSignal(): void {
    post({ type: 'signal', ...currentSig() });
    void syncWakeLock();
  }
  document.addEventListener('visibilitychange', reportSignal);
  window.addEventListener('focus', reportSignal);
  window.addEventListener('blur', reportSignal);
  window.addEventListener('pageshow', reportSignal);

  // Summoning: a tap on the veil is a real user gesture — one live engaged
  // report, exactly like tapping into a browser tab. (Input mints too, so
  // just typing summons as well.)
  veil.addEventListener('click', () => {
    reportSignal();
    term.focus();
  });

  // -------------------------------------------------------------------
  // Grid: rotations and the soft keyboard resize the visual viewport; pin
  // the layout to it, refit, and report caps (recorded always, applied by
  // the daemon only while this face owns).
  // -------------------------------------------------------------------
  let lastCaps = '';
  function refit(): void {
    const vv = window.visualViewport;
    if (vv) document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    const dims = fittedDims();
    if (!dims) return;
    if (owned) {
      // Owner drives the session grid; the daemon broadcasts it back and
      // every other face follows.
      const key = `${dims.cols}x${dims.rows}`;
      if (key !== lastCaps) {
        lastCaps = key;
        post({ type: 'caps', caps: { cols: dims.cols, rows: dims.rows, canResize: true } });
      }
    } else {
      // Not the owner: render the session's grid as-is (snapshots/grid
      // messages size the terminal); nothing to report.
    }
  }
  let refitTimer: number | undefined;
  const refitSoon = (): void => {
    if (refitTimer) clearTimeout(refitTimer);
    refitTimer = window.setTimeout(refit, 120);
  };
  window.visualViewport?.addEventListener('resize', refitSoon);
  window.addEventListener('resize', refitSoon);
  window.addEventListener('orientationchange', refitSoon);
  refit();

  connect();
})();
