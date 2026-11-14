# emdr-proto

Prototype work for a WebXR app that runs in the Meta Quest browser.

## Headset spike

`index.html` is a single self-contained test page. It runs seven technical checks on the headset and contains no exercise content:

1. Fading from an opaque scene to passthrough inside one session
2. The largest panorama texture the browser will load
3. Controller haptics
4. Left and right tone separation
5. Whether stored data survives browser updates
6. Controller button mapping and the system menu
7. Getting a results file off the headset

Open the page over https in the Quest browser, press Start, and answer with the controllers. Results stay in the browser until you copy them out. "Preview on this screen" walks through the same checks on a phone or desktop.

## Rebuilding

The source is in `spike/`. The build bundles three.js into the page and writes `index.html` at the repo root.

```
cd spike
npm install
npm run build
```
