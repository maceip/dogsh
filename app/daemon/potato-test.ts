// Unit test: SessionMux export/import + host meta (no full daemon).
// Spawns real shells briefly — run under Electron-as-Node like smoke.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionMux } from './session-mux.js';
import { loadHostMeta } from './persist.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsh-potato-'));
process.env.DOGSH_STATE_DIR = dir;
process.env.DOGSH_SHELL_BACKEND = process.env.DOGSH_SHELL_BACKEND || 'guest';

function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL: ${name}${detail ? ' — ' + detail : ''}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}`);
}

const events: string[] = [];
const mux = new SessionMux({
  onSessionData: () => {},
  onSessionTitle: () => {},
  onSessionExit: () => {},
  onActiveChanged: () => events.push('active'),
  onFenced: () => events.push('fenced'),
});

mux.bootstrap({ smoke: true });
check('bootstrap has a session', mux.sessions.size >= 1);
check('not fenced at boot', !mux.fenced);
const gen0 = mux.hostGeneration;

const s = mux.activeSession()!;
s.write('echo __POTATO__\r');

setTimeout(() => {
  const bundle = mux.exportBundle();
  check('export has sessions', bundle.sessions.length >= 1);
  check('guest checkpoint present', Object.keys(bundle.guestCheckpoints).length >= 1);

  mux.fence('ws://127.0.0.1:49999');
  check('fenced', mux.fenced);
  check('fence event', events.includes('fenced'));
  check('no input while fenced', !mux.acceptsInput());

  const imp = mux.importBundle(bundle);
  check('import ok', imp.ok);
  check('generation advanced', mux.hostGeneration > gen0, `gen=${mux.hostGeneration}`);
  check('unfenced after import', !mux.fenced && mux.acceptsInput());
  check('guest kind', [...mux.sessions.values()].every((x) => x.kind === 'guest'));

  mux.saveDirtySessions();
  const meta = loadHostMeta();
  check('meta generation persisted', meta.hostGeneration === mux.hostGeneration);
  check('meta active persisted', meta.activeSessionId === mux.activeSessionId);

  console.log('POTATO PASS');
  for (const sess of [...mux.sessions.values()]) {
    try {
      sess.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}, 1500);
