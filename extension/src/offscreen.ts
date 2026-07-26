// Offscreen document: WebSocket hub. One socket per connected content-script
// port (1:1 keeps the daemon protocol trivial — each tab is its own client).
// Immune to page CSP / mixed-content rules and to service-worker idling.
const DEFAULT_PORT = 47703;

chrome.runtime.onConnect.addListener((port) => {
  // Offscreen documents may ONLY use chrome.runtime APIs (no chrome.storage
  // — reading it here throws and kills the bridge for everyone). The content
  // script owns settings: the e2e port override rides in the port name
  // ("dogsh-tab" or "dogsh-tab#47713"), and the REMOTE daemon URL (Edge
  // Android against a laptop over the tailnet) arrives as the port's first
  // message ({type:'dogsh-config', url}) — consumed here, never forwarded.
  const m = /^dogsh-tab(?:#(\d+))?$/.exec(port.name);
  if (!m) return;
  const defaultUrl = `ws://127.0.0.1:${Number(m[1]) || DEFAULT_PORT}`;

  let ws: WebSocket | null = null;
  let daemonUrl: string | null = null;
  let closedByPort = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function openSocket(): void {
    ws = new WebSocket(daemonUrl || defaultUrl);
    ws.onopen = () => port.postMessage({ type: 'bridge-up' });
    ws.onmessage = (ev) => {
      try {
        port.postMessage(JSON.parse(ev.data));
      } catch {
        /* port gone mid-flight */
      }
    };
    ws.onclose = () => {
      if (closedByPort) return;
      try {
        port.postMessage({ type: 'bridge-down' });
      } catch {
        /* port gone */
      }
      // The daemon being gone is normal (app not installed yet, app quit,
      // app restarting). Keep knocking; when it comes back, bridge-up makes
      // the content script re-hello and re-claim without a page refresh.
      retryTimer = setTimeout(() => {
        if (!closedByPort) openSocket();
      }, 2000);
    };
    ws.onerror = () => ws?.close();
  }

  port.onMessage.addListener((msg) => {
    // First message is always the config (the content script guarantees
    // it); everything after flows to the daemon verbatim.
    if (msg && msg.type === 'dogsh-config') {
      if (ws) return; // reconnect chatter; the socket already exists
      daemonUrl = typeof msg.url === 'string' && msg.url ? msg.url : null;
      openSocket();
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });
  port.onDisconnect.addListener(() => {
    closedByPort = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (ws) ws.close();
  });
});
