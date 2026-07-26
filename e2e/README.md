# dogsh glass e2e

**One command. One session. Harness owns every browser.**

```bash
cd e2e && npm test
```

## What it does

1. Rebuilds `extension/dist` and packs `extension/build/dogsh.crx`
2. Starts the Android emulator if needed (`DOGSH_E2E_AVD`, default `codex_cosmo_api35`)
3. Opens **Edge Canary**, pushes the newest crx, force-installs when `DOGSH_DEMO_*` is set (otherwise requires a prior sideload of the packed id)
4. Opens **Google Chrome for Testing** (Playwright’s binary — never Google Chrome.app) with unpacked `extension/dist`
5. Opens packaged **dogsh**, runs `agent --yolo`, submits `what is trending on Twitter right now`
6. Switches to tab A (`x.com`) then tab B (`news.ycombinator.com`) and checks the overlay follows while the agent is active
7. Idles the laptop faces, then checks the phone overlay is **durable** (≥4s ownership, no flicker) with agent output still in the session

Headless protocol smoke (no glass): `node e2e/wire-probe.js` — separate from `npm test`.

## Rules for agents

- **Only** run `cd e2e && npm test` for glass e2e. Do not invent probes.
- Do **not** open Google Chrome.app, system Edge, or hand-drive the emulator.
- Do **not** stop at “N FAILURES” — fix product or harness until green or a real blocker.
- Phone PASS requires a human-visible durable overlay, not a one-tick grant. Artifact: `e2e/artifacts/phone-follow.png`.
- Quarantined (exit immediately): `phone-probe.js`, `phone-device-probe.js`, `phone-leg.js`, `record-follow-demo.js`.

## Env

| Var | Purpose |
|-----|---------|
| `DOGSH_E2E_AVD` | Emulator AVD name (default `codex_cosmo_api35`) |
| `DOGSH_E2E_GRACE_MS` | Hands-off delay before seizing the desk (default 5000) |
| `DOGSH_E2E_TAB_A` / `TAB_B` / `PHONE_URL` | Override sites |
| `DOGSH_DEMO_*` | When set, `deploy-phone.js` force-installs/updates the crx every run |

## Prereqs

- `cd app && npm run package` → `app/build/dogsh-darwin-arm64/dogsh.app`
- Playwright browsers installed (`npx playwright install chromium` in `e2e/`)
- Edge Canary on the emulator; packed extension sideloaded once (or `DOGSH_DEMO_*` for automated install)
- `agent` on PATH (suite prepends `~/.local/bin`)
