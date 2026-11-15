# emdr-proto

Prototype work for a WebXR app that runs in the Meta Quest browser. Each build is one self-contained page, served by GitHub Pages.

| Path | What it is |
| --- | --- |
| `index.html` | Landing page with links to the builds |
| `app/` | Safety shell (build step 3) |
| `spike/` | Headset spike (build step 2) |

## Safety shell (`app/`)

Check-in, stop rules, the grounding exit, closure and the session log, in an empty scene. There are no exercises and no stimulation in this build. Three empty rounds stand in for the exercises so that every stop rule can be triggered.

- `src/core/` holds the session logic as pure code: `machine.js` (the session state machine), `eligibility.js` (the pause, caps and lock rules) and `config.js` (defaults and hard limits).
- `src/xr.js` is the headset view, `src/panel.js` draws each screen, `src/store.js` keeps the log in IndexedDB on the device, and `src/main.js` wires the page.
- `test/` has 55 automated tests, at least one for every stop rule, plus a sweep that fires each trigger from every state.
- `TRACE.md` maps each stop rule to the tests that cover it.

```
cd app
npm install
npm test         # the safety logic tests
npm run build    # writes app/index.html
```

The session log stays in the browser on the headset until it is downloaded from the page. Wording on every screen is a draft.

## Headset spike (`spike/`)

Seven technical checks with no exercise content: passthrough fade, panorama size, haptics, tone separation, stored data, button mapping and getting results off the headset. Version 0.2 no longer waits for the browser to confirm a haptic pulse, which stalled version 0.1 on the Quest 3.

```
cd spike
npm install
npm run build    # writes spike/index.html
```
