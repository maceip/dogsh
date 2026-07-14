// Offscreen document: WebSocket hub. One socket per connected content-script
// port (1:1 keeps the daemon protocol trivial — each tab is its own client).
// Immune to page CSP / mixed-content rules and to service-worker idling.
const DEFAULT_PORT = 47703;

chrome.runtime.onConnect.addListener((port) => {
  // Offscreen documents may ONLY use chrome.runtime APIs (no chrome.storage
  // — reading it here throws and kills the bridge for everyone). The content
  // script owns settings and encodes any port override into the port name:
  // "dogsh-tab" or "dogsh-tab#47713" (e2e isolation).
  const m = /^dogsh-tab(?:#(\d+))?$/.exec(port.name);
  if (!m) return;
  const daemonUrl = `ws://127.0.0.1:${Number(m[1]) || DEFAULT_PORT}`;

  let ws = null;
  let closedByPort = false;
  let retryTimer = null;

  function openSocket() {
    ws = new WebSocket(daemonUrl);
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
    ws.onerror = () => ws.close();
  }

  port.onMessage.addListener((msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });
  port.onDisconnect.addListener(() => {
    closedByPort = true;
    clearTimeout(retryTimer);
    if (ws) ws.close();
  });

  openSocket();
});
