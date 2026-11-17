# emdr-proto

Prototype work for a WebXR app that runs in the Meta Quest browser. Each build is one self-contained page, served by GitHub Pages.

| Path | What it is |
| --- | --- |
| `index.html` | Landing page with links to the builds |
| `app/` | The app (build steps 3 to 5) |
| `spike/` | Headset spike (build step 2) |

## The app (`app/`)

Build steps 3 to 5: the safety shell, two scenes, three exercises and the bilateral engine.

- After check-in the user chooses paced breathing, calm place or grounding. Calm place uses the cue word only: bilateral sets inside it are locked (`sets.enabled` is false) until the therapist's walkthrough.
- An engine test runs up to three slow sets of light and tone on their own, with every stop rule active. It exists in the testing profile only.
- `src/core/` holds the session logic as pure code: `machine.js` (the session state machine), `eligibility.js` (the pause, caps and lock rules), `config.js` (defaults, hard limits and the ceilings on sets) and `scripts.js` (every word shown in the headset).
- `src/xr.js` is the headset view, `src/scenes.js` builds the two scenes, `src/audio.js` makes the tone and the scene sound, `src/panel.js` draws each screen, `src/store.js` keeps the log in IndexedDB on the device, and `src/main.js` wires the page.
- `test/` has 87 automated tests, at least one for every stop rule, plus a sweep that fires each trigger from every state.
- `TRACE.md` maps each rule to the tests that cover it.
- `tools/scripts-doc.mjs` prints the wording as a document for review.
- `assets/README.md` says how to replace the painted lakeshore with a licensed 360° photo.

```
cd app
npm install
npm test         # the session logic tests
npm run build    # writes app/index.html
```

The session log stays in the browser on the headset until it is downloaded from the page. Wording on every screen is a draft.

Version history:

- 0.3: scenes, paced breathing, calm place, grounding as an exercise, the bilateral engine (locked in calm place), settings for scene, cue word, render scale and scene sound.
- 0.2: each check-in question takes no answer for its first 2 seconds; each session records its measured frame rate.
- 0.1: the safety shell.

## Headset spike (`spike/`)

Seven technical checks with no exercise content: passthrough fade, panorama size, haptics, tone separation, stored data, button mapping and getting results off the headset. Version 0.2 no longer waits for the browser to confirm a haptic pulse, which stalled version 0.1 on the Quest 3.

```
cd spike
npm install
npm run build    # writes spike/index.html
```
