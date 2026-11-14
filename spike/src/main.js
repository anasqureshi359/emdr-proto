import * as THREE from 'three';

const VERSION = 'quest-spike 0.1';
const LS_RESULTS = 'questSpike.results';
const LS_CRUMB = 'questSpike.crumb';
const $ = (id) => document.getElementById(id);
const round = (x, d = 1) => { const k = 10 ** d; return Math.round(x * k) / k; };
const iso = () => new Date().toISOString();
const errText = (e) => String((e && e.message) || e);

const HINT_YN = 'Trigger = YES        Grip = NO';
const HINT_YNR = 'Trigger = YES     Grip = NO     A or X = again';
const HINT_NEXT = 'Trigger = continue';

let results = null;
let running = false;
let aborted = false;
let runSeq = 0;

/* ------------------------------------------------------------------ storage helpers */

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

function freshResults() {
  return { version: VERSION, createdAt: iso(), env: {}, storage: {}, run: null, tests: {}, exportTried: {}, log: [] };
}

function save() {
  lsSet(LS_RESULTS, JSON.stringify(results));
  renderResults();
}

function log(msg) {
  results.log.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
  if (results.log.length > 150) results.log.shift();
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open('questSpike', 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
}
function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbSet(db, key, val) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function checkStorage() {
  const s = { indexedDB: 'indexedDB' in window };
  s.localStorage = lsSet('questSpike.t', '1');
  lsDel('questSpike.t');
  try {
    const db = await idbOpen();
    const now = Date.now();
    let first = await idbGet(db, 'firstWrite');
    if (!first) {
      first = { at: now, ua: navigator.userAgent };
      await idbSet(db, 'firstWrite', first);
    }
    const visits = ((await idbGet(db, 'visits')) || 0) + 1;
    await idbSet(db, 'visits', visits);
    s.firstWriteAt = new Date(first.at).toISOString();
    s.ageDays = round((now - first.at) / 864e5, 2);
    s.visits = visits;
    s.browserChangedSinceFirstWrite = first.ua !== navigator.userAgent;
    s.browserAtFirstWrite = first.ua;
    db.close();
  } catch (e) {
    s.indexedDBError = errText(e);
  }
  if (navigator.storage) {
    try {
      const est = await navigator.storage.estimate();
      s.quotaMB = est.quota ? Math.round(est.quota / 1048576) : null;
      s.usageMB = est.usage ? round(est.usage / 1048576, 2) : 0;
    } catch (e) { /* ignore */ }
    try { s.persisted = await navigator.storage.persisted(); } catch (e) { /* ignore */ }
  }
  s.serviceWorkerSupported = 'serviceWorker' in navigator;
  let standalone = false;
  try { standalone = window.matchMedia('(display-mode: standalone)').matches; } catch (e) { /* ignore */ }
  s.installedAsApp = standalone;
  return s;
}

/* ------------------------------------------------------------------ environment report */

async function detectEnv() {
  const e = {};
  e.checkedAt = iso();
  e.userAgent = navigator.userAgent;
  e.secureContext = !!window.isSecureContext;
  let framed = false;
  try { framed = window.self !== window.top; } catch (err) { framed = true; }
  e.insideFrame = framed;
  e.xrApi = !!navigator.xr;
  e.xrAllowedByPolicy = null;
  try {
    const fp = document.featurePolicy || document.permissionsPolicy;
    if (fp && fp.allowsFeature) e.xrAllowedByPolicy = fp.allowsFeature('xr-spatial-tracking');
  } catch (err) { /* ignore */ }
  e.immersiveAr = false;
  e.immersiveVr = false;
  if (e.xrApi) {
    try { e.immersiveAr = await navigator.xr.isSessionSupported('immersive-ar'); } catch (err) { e.immersiveArError = errText(err); }
    try { e.immersiveVr = await navigator.xr.isSessionSupported('immersive-vr'); } catch (err) { e.immersiveVrError = errText(err); }
  }
  e.deviceMemoryGB = navigator.deviceMemory || null;
  e.cores = navigator.hardwareConcurrency || null;
  e.screen = `${screen.width}x${screen.height} @${window.devicePixelRatio || 1}`;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    e.webgl2 = !!gl;
    if (gl) {
      e.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      e.maxCubeMapSize = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      e.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const ext = gl.getSupportedExtensions() || [];
      e.compressedTextures = {
        astc: ext.includes('WEBGL_compressed_texture_astc'),
        etc2: ext.includes('WEBGL_compressed_texture_etc'),
        s3tc: ext.includes('WEBGL_compressed_texture_s3tc'),
        bptc: ext.includes('EXT_texture_compression_bptc'),
      };
      e.multiview = ext.includes('OCULUS_multiview') || ext.includes('OVR_multiview2');
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch (err) {
    e.webglError = errText(err);
  }
  e.clipboardWrite = !!(navigator.clipboard && navigator.clipboard.writeText);
  e.webShare = !!navigator.share;
  e.audioApi = !!(window.AudioContext || window.webkitAudioContext);
  return e;
}

/* ------------------------------------------------------------------ audio */

let audio = null;
function initAudio() {
  try {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audio = new AC();
    }
    if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  } catch (e) {
    log('audio init failed: ' + errText(e));
  }
}

function tone(pan, delay, dur = 0.35, freq = 392) {
  if (!audio) return;
  const when = audio.currentTime + delay;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(0.25, when + 0.03);
  g.gain.setTargetAtTime(0, when + dur - 0.1, 0.05);
  let last = g;
  o.connect(g);
  if (audio.createStereoPanner) {
    const p = audio.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    last = p;
  }
  last.connect(audio.destination);
  o.start(when);
  o.stop(when + dur + 0.3);
}

/* ------------------------------------------------------------------ graphics */

let renderer = null;
let scene, camera, world, dome, domeMat, floor, floorMat, panelCanvas, panelCtx, panelTex, skyTex;
let panoTex = null;
const gripMarkers = [];
const env = { opacity: 1 };
const fade = { active: false, from: 1, to: 1, t0: 0, dur: 1000, resolve: null };
const live = { dts: [], lastPanel: 0, buttons: { left: [], right: [] }, awaySince: 0, awayStates: [] };
const frameFns = new Set();
const sources = { left: null, right: null };
const prevButtons = {};
let panel = { kicker: '', title: '', body: [], hint: '' };
const look = { yaw: 0, pitch: 0 };

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(w, h); } catch (e) { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function makeSkyCanvas() {
  const c = makeCanvas(16, 512);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#16203a');
  grad.addColorStop(0.38, '#4a5078');
  grad.addColorStop(0.49, '#d49a76');
  grad.addColorStop(0.505, '#5a5560');
  grad.addColorStop(0.56, '#23262e');
  grad.addColorStop(1, '#101216');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 512);
  return c;
}

function makeFloorCanvas() {
  const n = 512;
  const c = makeCanvas(n, n);
  const g = c.getContext('2d');
  g.fillStyle = '#2b313b';
  g.fillRect(0, 0, n, n);
  g.strokeStyle = '#8492a6';
  g.lineWidth = 3;
  for (let i = 0; i <= 12; i++) {
    const p = (i / 12) * n;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, n); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(n, p); g.stroke();
  }
  // fade the edge out so the floor has no hard rim
  g.globalCompositeOperation = 'destination-in';
  const rad = g.createRadialGradient(n / 2, n / 2, n * 0.36, n / 2, n / 2, n * 0.5);
  rad.addColorStop(0, 'rgba(0,0,0,1)');
  rad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rad;
  g.fillRect(0, 0, n, n);
  return c;
}

function randomCode() {
  const chars = 'ACEFHJKLMNPRTUVWXY3479';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* A test chart: grid lines every 15 degrees and three rows of letters whose
   height is a fixed angle (1, 0.5 and 0.25 degrees), repeated around the horizon. */
function buildPano(w) {
  const h = w / 2;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#16203a');
  grad.addColorStop(0.4, '#454b72');
  grad.addColorStop(0.5, '#c79274');
  grad.addColorStop(0.51, '#3b3d47');
  grad.addColorStop(1, '#121418');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = Math.max(1, w / 4096);
  for (let lon = 0; lon < 360; lon += 15) {
    const x = (lon / 360) * w;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = (0.5 - lat / 180) * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  const pxPerDeg = h / 180;
  const rows = [
    { name: 'LARGE', deg: 1.0, lat: 31 },
    { name: 'MEDIUM', deg: 0.5, lat: 27 },
    { name: 'SMALL', deg: 0.25, lat: 24.5 },
  ];
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let lon = 15; lon < 360; lon += 30) {
    const x = (lon / 360) * w;
    for (const r of rows) {
      g.font = `bold ${r.deg * pxPerDeg}px sans-serif`;
      g.fillText(`${r.name} ${randomCode()}`, x, (0.5 - r.lat / 180) * h);
    }
    g.font = `bold ${2.2 * pxPerDeg}px sans-serif`;
    g.fillText(`${w} x ${h}`, x, (0.5 - 37 / 180) * h);
  }
  return c;
}

function wrapLines(g, text, maxWidth) {
  const words = String(text).split(' ');
  const out = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (g.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out;
}

function currentFps() {
  if (live.dts.length < 10) return null;
  const sum = live.dts.reduce((a, b) => a + b, 0);
  return Math.round(1000 / (sum / live.dts.length));
}

function drawPanel() {
  if (!panelCtx) return;
  const g = panelCtx;
  const W = 1024;
  const H = 640;
  g.fillStyle = '#0f1216';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#3d4654';
  g.lineWidth = 6;
  g.strokeRect(3, 3, W - 6, H - 6);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#93a8bd';
  g.font = '600 28px system-ui, sans-serif';
  g.fillText(panel.kicker || '', 44, 62);
  const fps = currentFps();
  if (fps) {
    g.textAlign = 'right';
    g.fillText(fps + ' fps', W - 44, 62);
    g.textAlign = 'left';
  }
  g.fillStyle = '#ffffff';
  g.font = '600 50px system-ui, sans-serif';
  let y = 136;
  for (const line of wrapLines(g, panel.title || '', W - 88)) {
    g.fillText(line, 44, y);
    y += 60;
  }
  y += 14;
  g.fillStyle = '#e4e8ee';
  g.font = '36px system-ui, sans-serif';
  for (const para of panel.body || []) {
    for (const line of wrapLines(g, para, W - 88)) {
      g.fillText(line, 44, y);
      y += 48;
    }
    y += 12;
  }
  if (panel.hint) {
    g.fillStyle = '#1c2530';
    g.fillRect(6, H - 92, W - 12, 86);
    g.fillStyle = '#ffd08a';
    g.font = '600 32px system-ui, sans-serif';
    g.fillText(panel.hint, 44, H - 38);
  }
  panelTex.needsUpdate = true;
  const mirror = $('simPanelText');
  if (mirror && results && results.run && results.run.mode === 'sim') {
    const text = [panel.kicker, panel.title].concat(panel.body || []).concat(panel.hint ? [panel.hint.replace(/\s{2,}/g, '  |  ')] : []).filter(Boolean).join('\n');
    if (mirror.textContent !== text) mirror.textContent = text;
  }
}

function initGraphics() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.xr.enabled = true;
  $('simCanvasHost').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  camera.position.set(0, 1.2, 0);
  camera.rotation.order = 'YXZ';
  world = new THREE.Group();
  scene.add(world);

  skyTex = new THREE.CanvasTexture(makeSkyCanvas());
  skyTex.colorSpace = THREE.SRGBColorSpace;
  const domeGeo = new THREE.SphereGeometry(30, 64, 32);
  domeGeo.scale(-1, 1, 1);
  domeMat = new THREE.MeshBasicMaterial({ map: skyTex, depthWrite: false });
  dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -10;
  dome.position.y = 1.2;
  world.add(dome);

  const floorTex = new THREE.CanvasTexture(makeFloorCanvas());
  floorTex.colorSpace = THREE.SRGBColorSpace;
  const floorGeo = new THREE.CircleGeometry(6, 48);
  floorGeo.rotateX(-Math.PI / 2);
  floorMat = new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false });
  floor = new THREE.Mesh(floorGeo, floorMat);
  floor.renderOrder = -5;
  world.add(floor);

  panelCanvas = document.createElement('canvas');
  panelCanvas.width = 1024;
  panelCanvas.height = 640;
  panelCtx = panelCanvas.getContext('2d');
  panelTex = new THREE.CanvasTexture(panelCanvas);
  panelTex.colorSpace = THREE.SRGBColorSpace;
  panelTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const panelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.8125), new THREE.MeshBasicMaterial({ map: panelTex }));
  panelMesh.position.set(0, 1.15, -1.5);
  world.add(panelMesh);

  for (let i = 0; i < 2; i++) {
    const grip = renderer.xr.getControllerGrip(i);
    const marker = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.025, 0.11, 12),
      new THREE.MeshBasicMaterial({ color: 0x8fa3b8 }),
    );
    marker.rotation.x = Math.PI / 2;
    gripMarkers.push(marker);
    grip.add(marker);
    grip.visible = false;
    scene.add(grip);
  }
  drawPanel();
}

function applyOpacity() {
  domeMat.opacity = env.opacity;
  domeMat.transparent = env.opacity < 1;
  floorMat.opacity = env.opacity;
  const shown = env.opacity > 0.001;
  dome.visible = shown;
  floor.visible = shown;
  // stand-in controller shapes are only needed while the real ones are hidden
  for (const m of gripMarkers) m.visible = env.opacity > 0.5;
}

function fadeTo(target, dur) {
  return new Promise((resolve) => {
    fade.active = true;
    fade.from = env.opacity;
    fade.to = target;
    fade.t0 = performance.now();
    fade.dur = dur;
    fade.resolve = resolve;
  });
}

function setDomeTexture(tex) {
  if (panoTex && panoTex !== tex) panoTex.dispose();
  panoTex = tex;
  domeMat.map = tex || skyTex;
  domeMat.needsUpdate = true;
}

function summarize(dts) {
  if (!dts.length) return { frames: 0 };
  const sorted = dts.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
  return {
    frames: dts.length,
    fps: round(1000 / mean, 1),
    medianMs: round(median, 2),
    worstMs: round(sorted[sorted.length - 1], 1),
    slowFrames: dts.filter((d) => d > median * 1.6).length,
  };
}

function measure(ms) {
  return new Promise((resolve) => {
    const dts = [];
    const t0 = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      frameFns.delete(fn);
      resolve(summarize(dts));
    };
    const fn = (dt) => {
      dts.push(dt);
      if (performance.now() - t0 >= ms) finish();
    };
    frameFns.add(fn);
    setTimeout(finish, ms + 1500);
  });
}

/* ------------------------------------------------------------------ input */

let waiter = null;
function waitInput(kinds) {
  if (aborted) return Promise.reject(new Error('session ended'));
  return new Promise((resolve, reject) => {
    waiter = { kinds, resolve, reject, at: performance.now() };
  });
}
function input(kind, data) {
  if (!waiter || !waiter.kinds.includes(kind)) return;
  if (performance.now() - waiter.at < 350) return;
  const w = waiter;
  waiter = null;
  w.resolve({ kind, data });
}
function abortWaiter() {
  if (!waiter) return;
  const w = waiter;
  waiter = null;
  w.reject(new Error('session ended'));
}

function onButton(hand, index) {
  if (waiter && waiter.kinds.includes('button')) input('button', { hand, index });
  else if (index >= 3) input('repeat');
}

function pollButtons(session) {
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const hand = src.handedness || 'none';
    sources[hand] = src;
    const now = [];
    for (let i = 0; i < gp.buttons.length; i++) now.push(!!gp.buttons[i].pressed);
    const prev = prevButtons[hand] || [];
    for (let i = 2; i < now.length; i++) {
      if (now[i] && !prev[i]) onButton(hand, i);
    }
    prevButtons[hand] = now;
    const down = [];
    now.forEach((p, i) => { if (p) down.push(i); });
    live.buttons[hand] = down;
    if (results.run && !results.run.controllers[hand]) {
      results.run.controllers[hand] = {
        profiles: Array.from(src.profiles || []),
        buttonCount: gp.buttons.length,
        axesCount: gp.axes.length,
        mapping: gp.mapping || '',
        hapticActuators: gp.hapticActuators ? gp.hapticActuators.length : 0,
        vibrationActuator: !!gp.vibrationActuator,
      };
    }
  }
}

function onVisibility(state) {
  if (!results.run) return;
  results.run.visibility.push({ at: iso(), state });
  if (state !== 'visible') {
    if (!live.awaySince) { live.awaySince = performance.now(); live.awayStates = []; }
    live.awayStates.push(state);
  } else if (live.awaySince) {
    const awayMs = Math.round(performance.now() - live.awaySince);
    const states = live.awayStates.slice();
    live.awaySince = 0;
    input('visibility-return', { awayMs, states });
  }
}

function pulse(hand, intensity, ms) {
  const src = sources[hand];
  const gp = src && src.gamepad;
  if (!gp) return Promise.resolve('no controller');
  try {
    const act = gp.hapticActuators && gp.hapticActuators[0];
    if (act && act.pulse) {
      return act.pulse(intensity, ms).then((ok) => (ok ? 'pulse ok' : 'pulse returned false'), (e) => 'error: ' + errText(e));
    }
    if (gp.vibrationActuator && gp.vibrationActuator.playEffect) {
      return gp.vibrationActuator
        .playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity })
        .then(() => 'rumble ok', (e) => 'error: ' + errText(e));
    }
    return Promise.resolve('no actuator');
  } catch (e) {
    return Promise.resolve('error: ' + errText(e));
  }
}

/* ------------------------------------------------------------------ the checks */

function makeCtx(mode, session, myRun) {
  const alive = () => !aborted && runSeq === myRun;
  const guard = () => { if (!alive()) throw new Error('session ended'); };
  return {
    mode,
    session,
    alive,
    blendMode: session ? session.environmentBlendMode || 'unknown' : 'simulated',
    say(kicker, title, body, hint) {
      if (!alive()) return;
      panel = { kicker, title, body: body || [], hint: hint || '' };
      drawPanel();
    },
    sleep(ms) {
      return new Promise((resolve, reject) => {
        setTimeout(() => (alive() ? resolve() : reject(new Error('session ended'))), ms);
      });
    },
    measure,
    pulse,
    fadeTo(target, dur) { guard(); return fadeTo(target, dur); },
    async wait(kinds) { guard(); return waitInput(kinds); },
    async choice(kinds) { guard(); return (await waitInput(kinds)).kind; },
    async yesNo() { guard(); return (await waitInput(['yes', 'no'])).kind === 'yes'; },
  };
}

async function stepIntro(ctx) {
  ctx.say('Headset spike', 'Stay seated', [
    'Six short checks, about five minutes.',
    'Answer with the controllers. A or X repeats a check.',
    'To stop early, press the Meta button and quit.',
  ], 'Trigger = YES / continue        Grip = NO');
  await ctx.choice(['yes']);
}

async function stepFade(ctx) {
  const K = '1 of 6 · Passthrough fade';
  const t = { blendMode: ctx.blendMode };
  results.tests.fade = t;
  if (ctx.mode === 'immersive-vr' || ctx.blendMode === 'opaque') {
    t.skipped = 'this session cannot show the real room (blend mode ' + ctx.blendMode + ')';
    save();
    return;
  }
  ctx.say(K, 'Is your real room hidden?', ['You should see a dusk sky and a floor grid, and nothing of your room.'], HINT_YN);
  t.roomHiddenAtStart = await ctx.yesNo();
  ctx.say(K, 'Fading to your room', ['Watch the sky and floor fade away.'], '');
  const m = ctx.measure(1300);
  const t0 = performance.now();
  await ctx.fadeTo(0, 1000);
  t.fadeOutMs = Math.round(performance.now() - t0);
  t.framesDuringFade = await m;
  ctx.say(K, 'Can you see your real room?', ['It should be clear and in colour, with only this panel in front of it.'], HINT_YN);
  t.roomVisibleAfterFade = await ctx.yesNo();
  ctx.say(K, 'Fading back', ['The sky and floor return.'], '');
  await ctx.fadeTo(1, 1000);
  ctx.say(K, 'Is the room hidden again?', ['The sky and floor should fully cover it.'], HINT_YN);
  t.sceneRestored = await ctx.yesNo();
  t.pass = !!(t.roomHiddenAtStart && t.roomVisibleAfterFade && t.sceneRestored);
  save();
}

async function stepButtons(ctx) {
  const K = '2 of 6 · Buttons';
  const t = { presses: [] };
  results.tests.buttons = t;
  const asks = [
    { label: 'B', hand: 'right', expect: 5, where: 'right controller, upper round button' },
    { label: 'A', hand: 'right', expect: 4, where: 'right controller, lower round button' },
    { label: 'Y', hand: 'left', expect: 5, where: 'left controller, upper round button' },
    { label: 'X', hand: 'left', expect: 4, where: 'left controller, lower round button' },
  ];
  for (const a of asks) {
    ctx.say(K, 'Press ' + a.label, ['That is the ' + a.where + '.'], 'Trigger = skip');
    const r = await ctx.wait(['button', 'yes']);
    if (r.kind === 'yes') {
      t.presses.push({ asked: a.label, skipped: true });
    } else {
      t.presses.push({
        asked: a.label,
        hand: r.data.hand,
        index: r.data.index,
        asExpected: r.data.hand === a.hand && r.data.index === a.expect,
      });
    }
    save();
  }
  ctx.say(K, 'Press the Meta button', [
    'It is the flat button on the right controller. The system menu should open.',
    'Press it again to close the menu and come back.',
  ], 'Trigger = skip');
  const r = await ctx.wait(['visibility-return', 'yes']);
  t.systemMenu = r.kind === 'yes' ? { skipped: true } : { detected: true, awayMs: r.data.awayMs, states: r.data.states };
  const done = t.presses.filter((p) => !p.skipped);
  t.pass = done.length === 4 && done.every((p) => p.asExpected) && !!t.systemMenu.detected;
  save();
}

async function stepHaptics(ctx) {
  const K = '3 of 6 · Haptics';
  const t = { levels: [] };
  results.tests.haptics = t;
  if (!(sources.left && sources.left.gamepad) && !(sources.right && sources.right.gamepad)) {
    t.skipped = 'no controllers found';
    save();
    return;
  }
  for (const level of [0.2, 0.5, 1.0]) {
    const pct = Math.round(level * 100);
    let answer;
    let api;
    do {
      ctx.say(K, pct + '% strength', ['One pulse in the left hand, then one in the right.'], '');
      await ctx.sleep(900);
      const a = ctx.pulse('left', level, 60);
      await ctx.sleep(700);
      const b = ctx.pulse('right', level, 60);
      await ctx.sleep(500);
      api = [await a, await b];
      ctx.say(K, 'Felt it in both hands?', ['That was the ' + pct + '% pulse.'], HINT_YNR);
      answer = await ctx.choice(['yes', 'no', 'repeat']);
    } while (answer === 'repeat');
    t.levels.push({ intensity: level, feltInBothHands: answer === 'yes', api });
    save();
  }
  let answer;
  do {
    ctx.say(K, 'Alternating pulses', ['Six pulses, one a second, swapping hands each time.'], '');
    await ctx.sleep(900);
    const start = performance.now();
    let worst = 0;
    for (let i = 0; i < 6; i++) {
      const due = start + i * 1000;
      const waitMs = due - performance.now();
      if (waitMs > 0) await ctx.sleep(waitMs);
      worst = Math.max(worst, Math.abs(performance.now() - due));
      ctx.pulse(i % 2 === 0 ? 'left' : 'right', 0.5, 50);
    }
    t.timerJitterMs = round(worst, 1);
    await ctx.sleep(600);
    ctx.say(K, 'Evenly spaced?', ['Each pulse should have been in one hand only, at a steady beat.'], HINT_YNR);
    answer = await ctx.choice(['yes', 'no', 'repeat']);
  } while (answer === 'repeat');
  t.alternatingEven = answer === 'yes';
  const felt = t.levels.filter((l) => l.feltInBothHands).map((l) => l.intensity);
  t.weakestFelt = felt.length ? Math.min(...felt) : null;
  t.pass = t.weakestFelt !== null && t.weakestFelt <= 0.5 && t.alternatingEven;
  save();
}

async function stepAudio(ctx) {
  const K = '4 of 6 · Left and right tones';
  const t = {};
  results.tests.audio = t;
  if (!audio) {
    t.skipped = 'no audio support';
    save();
    return;
  }
  if (audio.state === 'suspended') {
    try { await audio.resume(); } catch (e) { /* ignore */ }
  }
  t.state = audio.state;
  t.sampleRate = audio.sampleRate;
  t.baseLatencyMs = audio.baseLatency ? round(audio.baseLatency * 1000, 1) : null;
  t.outputLatencyMs = audio.outputLatency ? round(audio.outputLatency * 1000, 1) : null;
  t.stereoPanner = !!audio.createStereoPanner;
  const ask = async (title, play, waitMs, question) => {
    let answer;
    do {
      ctx.say(K, title, ['Listen.'], '');
      await ctx.sleep(500);
      play();
      await ctx.sleep(waitMs);
      ctx.say(K, question, [], HINT_YNR);
      answer = await ctx.choice(['yes', 'no', 'repeat']);
    } while (answer === 'repeat');
    return answer === 'yes';
  };
  t.leftHeardOnLeft = await ask('Two tones on the left', () => { tone(-1, 0.1); tone(-1, 0.8); }, 1700, 'Did they come mainly from the LEFT?');
  save();
  t.rightHeardOnRight = await ask('Two tones on the right', () => { tone(1, 0.1); tone(1, 0.8); }, 1700, 'Did they come mainly from the RIGHT?');
  save();
  t.alternatingClear = await ask('Six tones, swapping sides', () => {
    for (let i = 0; i < 6; i++) tone(i % 2 === 0 ? -1 : 1, 0.1 + i * 0.7);
  }, 4800, 'Easy to tell which side each tone was on?');
  t.pass = !!(t.leftHeardOnLeft && t.rightHeardOnRight && t.alternatingClear);
  save();
}

async function stepPano(ctx) {
  const K = '5 of 6 · Panorama size';
  const t = { maxTextureSize: renderer.capabilities.maxTextureSize, sizes: [] };
  results.tests.panorama = t;
  if (env.opacity < 1) await ctx.fadeTo(1, 300);
  for (const w of [2048, 4096, 8192]) {
    const h = w / 2;
    if (w > t.maxTextureSize) {
      t.sizes.push({ width: w, height: h, skipped: 'above this GPU\'s texture limit' });
      continue;
    }
    if (w === 8192) {
      ctx.say(K, 'Largest size next', [
        '8192 x 4096 may freeze for a few seconds or crash the browser.',
        'If it crashes, reload the page. Results so far are saved.',
      ], 'Trigger = try it        Grip = skip');
      if (!(await ctx.yesNo())) {
        t.sizes.push({ width: w, height: h, skipped: 'skipped by user' });
        save();
        continue;
      }
    }
    ctx.say(K, 'Building ' + w + ' x ' + h, ['The picture may freeze for a moment.'], '');
    await ctx.sleep(500);
    lsSet(LS_CRUMB, JSON.stringify({ step: 'panorama', width: w, at: iso() }));
    const rec = { width: w, height: h };
    try {
      const t0 = performance.now();
      const canvas = buildPano(w);
      const t1 = performance.now();
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      const gl = renderer.getContext();
      let guard = 0;
      while (gl.getError() !== gl.NO_ERROR && guard++ < 10) { /* clear old errors */ }
      renderer.initTexture(tex);
      const glErr = gl.getError();
      const t2 = performance.now();
      rec.buildMs = Math.round(t1 - t0);
      rec.uploadMs = Math.round(t2 - t1);
      rec.glError = glErr === gl.NO_ERROR ? null : glErr;
      setDomeTexture(tex);
      canvas.width = 0;
      canvas.height = 0;
    } catch (e) {
      rec.error = errText(e);
    }
    lsDel(LS_CRUMB);
    if (!rec.error) {
      await ctx.sleep(400);
      rec.frames = await ctx.measure(2500);
      ctx.say(K, w + ' x ' + h, ['Look above this panel at the rows of letters.', 'Can you read the SMALL row?'], HINT_YN);
      if (await ctx.yesNo()) {
        rec.smallestReadable = 'small';
      } else {
        ctx.say(K, w + ' x ' + h, ['Can you read the MEDIUM row?'], HINT_YN);
        rec.smallestReadable = (await ctx.yesNo()) ? 'medium' : 'large or none';
      }
    }
    t.sizes.push(rec);
    save();
  }
  setDomeTexture(null);
  const ok = t.sizes.filter((s) => !s.error && !s.skipped && !s.glError);
  t.largestLoaded = ok.length ? ok[ok.length - 1].width : null;
  save();
}

async function stepPerf(ctx) {
  const K = '6 of 6 · Frame rate';
  const t = {};
  results.tests.frameRate = t;
  ctx.say(K, 'Measuring', ['Look around slowly for three seconds.'], '');
  t.measured = await ctx.measure(3000);
  const s = ctx.session;
  if (s) {
    t.sessionFrameRate = s.frameRate || null;
    t.supportedFrameRates = s.supportedFrameRates ? Array.from(s.supportedFrameRates) : null;
    if (s.updateTargetFrameRate && t.supportedFrameRates && t.supportedFrameRates.includes(90) && s.frameRate !== 90) {
      try {
        await s.updateTargetFrameRate(90);
        t.requested90 = 'accepted';
        await ctx.sleep(800);
        t.measuredAt90 = await ctx.measure(3000);
      } catch (e) {
        t.requested90 = 'error: ' + errText(e);
      }
    }
    try { t.foveation = renderer.xr.getFoveation(); } catch (e) { /* ignore */ }
    try {
      const layer = renderer.xr.getBaseLayer();
      if (layer) {
        t.layerType = layer.constructor ? layer.constructor.name : '';
        t.framebuffer = (layer.framebufferWidth || layer.textureWidth || 0) + ' x ' + (layer.framebufferHeight || layer.textureHeight || 0);
      }
    } catch (e) { /* ignore */ }
  }
  save();
}

async function stepDone(ctx) {
  const lines = verdicts(results).filter((v) => v.inHeadset).map((v) => v.name + ': ' + v.status);
  ctx.say('Finished', 'All checks done', [lines.join('   ·   '), 'Leave VR, then read and send the results from the page.'], 'Trigger = leave VR');
  await ctx.choice(['yes']);
}

async function runWizard(ctx) {
  await stepIntro(ctx);
  await stepFade(ctx);
  await stepButtons(ctx);
  await stepHaptics(ctx);
  await stepAudio(ctx);
  await stepPano(ctx);
  await stepPerf(ctx);
  results.run.completed = true;
  save();
  await stepDone(ctx);
}

/* ------------------------------------------------------------------ session control */

let lastT = 0;
function onFrame(time) {
  const dt = lastT ? time - lastT : 0;
  lastT = time;
  if (dt > 0 && dt < 1000) {
    for (const fn of Array.from(frameFns)) fn(dt);
    live.dts.push(dt);
    if (live.dts.length > 90) live.dts.shift();
  }
  const session = renderer.xr.getSession();
  if (session) {
    try { pollButtons(session); } catch (e) { log('input error: ' + errText(e)); }
  } else {
    camera.rotation.y = look.yaw;
    camera.rotation.x = look.pitch;
  }
  if (fade.active) {
    const k = Math.min(1, (performance.now() - fade.t0) / fade.dur);
    env.opacity = fade.from + (fade.to - fade.from) * k;
    applyOpacity();
    if (k >= 1) {
      fade.active = false;
      const r = fade.resolve;
      fade.resolve = null;
      if (r) r();
    }
  }
  if (time - live.lastPanel > 500) {
    live.lastPanel = time;
    drawPanel();
  }
  renderer.render(scene, camera);
}

function beginRun(mode, session, refSpace) {
  running = true;
  aborted = false;
  const myRun = ++runSeq;
  lastT = 0;
  live.dts = [];
  live.awaySince = 0;
  fade.active = false;
  fade.resolve = null;
  env.opacity = 1;
  applyOpacity();
  setDomeTexture(null);
  results.tests = {};
  results.run = {
    mode,
    startedAt: iso(),
    referenceSpace: refSpace,
    blendMode: session ? session.environmentBlendMode || 'unknown' : 'simulated',
    controllers: {},
    visibility: [],
    completed: false,
    endedCleanly: false,
  };
  log('run started: ' + mode);
  save();
  setStartNote('');
  const ctx = makeCtx(mode, session, myRun);
  renderer.setAnimationLoop(onFrame);
  runWizard(ctx)
    .then(() => { if (runSeq === myRun) endRun(session); })
    .catch((e) => {
      if (runSeq !== myRun) return;
      if (errText(e) !== 'session ended') {
        results.run.error = errText(e);
        log('checks stopped: ' + errText(e));
        ctx.say('Stopped', 'A check hit an error', [errText(e), 'Leaving in a few seconds. The results so far are saved.'], '');
        setTimeout(() => { if (runSeq === myRun && running) endRun(session); }, 5000);
      }
      save();
    });
}

function endRun(session) {
  if (session) {
    session.end().catch(() => {});
  } else {
    finishRun();
  }
}

function finishRun() {
  if (!running) return;
  running = false;
  aborted = true;
  abortWaiter();
  fade.active = false;
  fade.resolve = null;
  frameFns.clear();
  renderer.setAnimationLoop(null);
  sources.left = null;
  sources.right = null;
  if (results.run) {
    results.run.endedAt = iso();
    results.run.endedCleanly = true;
  }
  log('run ended');
  save();
  try { $('results').scrollIntoView(); } catch (e) { /* ignore */ }
}

function setStartNote(text) {
  $('startNote').textContent = text;
}

async function startXR(mode) {
  if (running) return;
  initAudio();
  let session;
  try {
    session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor'] });
  } catch (e) {
    setStartNote('Could not start: ' + errText(e));
    log('requestSession failed (' + mode + '): ' + errText(e));
    save();
    return;
  }
  try {
    initGraphics();
    let refType = 'local-floor';
    try { await session.requestReferenceSpace('local-floor'); } catch (e) { refType = 'local'; }
    renderer.xr.setReferenceSpaceType(refType);
    world.position.y = refType === 'local' ? -1.2 : 0;
    await renderer.xr.setSession(session);
    session.addEventListener('end', finishRun);
    session.addEventListener('selectstart', () => input('yes'));
    session.addEventListener('squeezestart', () => input('no'));
    session.addEventListener('visibilitychange', () => onVisibility(session.visibilityState));
    beginRun(mode, session, refType);
  } catch (e) {
    setStartNote('Could not set up the session: ' + errText(e));
    log('session setup failed: ' + errText(e));
    save();
    try { await session.end(); } catch (err) { /* ignore */ }
  }
}

function resizeSim() {
  if (!renderer || renderer.xr.isPresenting) return;
  const host = $('simCanvasHost');
  const w = Math.max(200, host.clientWidth);
  const h = Math.round((w * 9) / 16);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function startSim() {
  if (running) return;
  initAudio();
  try {
    initGraphics();
  } catch (e) {
    setStartNote('Could not start the preview: ' + errText(e));
    return;
  }
  $('simWrap').hidden = false;
  world.position.y = 0;
  look.yaw = 0;
  look.pitch = 0;
  resizeSim();
  // stand-in controllers so the preview can walk through the haptics check
  const fake = () => ({ gamepad: { hapticActuators: [{ pulse: () => Promise.resolve(true) }] } });
  sources.left = fake();
  sources.right = fake();
  beginRun('sim', null, 'none');
  try { $('simWrap').scrollIntoView(); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ results on the page */

function verdicts(r) {
  const t = r.tests || {};
  const v = [];
  const yn = (b) => (b ? 'yes' : 'no');

  if (!t.fade) v.push({ n: 1, name: 'Passthrough fade', status: 'not run', detail: '', inHeadset: true });
  else if (t.fade.skipped) v.push({ n: 1, name: 'Passthrough fade', status: 'skipped', detail: t.fade.skipped, inHeadset: true });
  else {
    v.push({
      n: 1,
      name: 'Passthrough fade',
      status: t.fade.pass ? 'pass' : 'fail',
      detail: `blend mode ${t.fade.blendMode}; room hidden at start: ${yn(t.fade.roomHiddenAtStart)}; room visible after fade: ${yn(t.fade.roomVisibleAfterFade)}; scene restored: ${yn(t.fade.sceneRestored)}`,
      inHeadset: true,
    });
  }

  if (!t.panorama) v.push({ n: 2, name: 'Panorama size', status: 'not run', detail: '', inHeadset: true });
  else {
    const parts = t.panorama.sizes.map((s) => {
      if (s.skipped) return `${s.width}: ${s.skipped}`;
      if (s.error) return `${s.width}: error (${s.error})`;
      return `${s.width}: ${s.frames ? s.frames.fps + ' fps' : 'no timing'}, reads ${s.smallestReadable || '?'}, upload ${s.uploadMs} ms${s.glError ? ', GL error ' + s.glError : ''}`;
    });
    if (t.panorama.crashedAt) parts.push(`crashed while loading ${t.panorama.crashedAt}`);
    v.push({
      n: 2,
      name: 'Panorama size',
      status: t.panorama.largestLoaded ? 'largest ' + t.panorama.largestLoaded : (t.panorama.crashedAt ? 'crashed' : 'not finished'),
      detail: `GPU limit ${t.panorama.maxTextureSize || (r.env && r.env.maxTextureSize) || '?'}; ` + parts.join('; '),
      inHeadset: true,
    });
  }

  if (!t.haptics) v.push({ n: 3, name: 'Haptics', status: 'not run', detail: '', inHeadset: true });
  else if (t.haptics.skipped) v.push({ n: 3, name: 'Haptics', status: 'skipped', detail: t.haptics.skipped, inHeadset: true });
  else if (t.haptics.alternatingEven === undefined) v.push({ n: 3, name: 'Haptics', status: 'not finished', detail: '', inHeadset: true });
  else {
    v.push({
      n: 3,
      name: 'Haptics',
      status: t.haptics.pass ? 'pass' : 'fail',
      detail: `weakest pulse felt: ${t.haptics.weakestFelt === null ? 'none' : Math.round(t.haptics.weakestFelt * 100) + '%'}; alternating even: ${yn(t.haptics.alternatingEven)}; timer jitter ${t.haptics.timerJitterMs} ms`,
      inHeadset: true,
    });
  }

  if (!t.audio) v.push({ n: 4, name: 'Left and right tones', status: 'not run', detail: '', inHeadset: true });
  else if (t.audio.skipped) v.push({ n: 4, name: 'Left and right tones', status: 'skipped', detail: t.audio.skipped, inHeadset: true });
  else if (t.audio.pass === undefined) v.push({ n: 4, name: 'Left and right tones', status: 'not finished', detail: '', inHeadset: true });
  else {
    v.push({
      n: 4,
      name: 'Left and right tones',
      status: t.audio.pass ? 'pass' : 'fail',
      detail: `left on left: ${yn(t.audio.leftHeardOnLeft)}; right on right: ${yn(t.audio.rightHeardOnRight)}; alternating clear: ${yn(t.audio.alternatingClear)}`,
      inHeadset: true,
    });
  }

  const s = r.storage || {};
  let sStatus = 'check again later';
  if (s.indexedDBError) sStatus = 'fail';
  else if (s.browserChangedSinceFirstWrite && s.ageDays > 0) sStatus = 'pass';
  v.push({
    n: 5,
    name: 'Stored data survives',
    status: sStatus,
    detail: s.indexedDBError
      ? 'IndexedDB error: ' + s.indexedDBError
      : `test record saved ${s.ageDays} days ago, seen on ${s.visits} visits; browser updated since then: ${yn(s.browserChangedSinceFirstWrite)}; marked persistent: ${yn(s.persisted)}; offline install needs the final host`,
    inHeadset: false,
  });

  if (!t.buttons) v.push({ n: 6, name: 'Buttons', status: 'not run', detail: '', inHeadset: true });
  else {
    const p = t.buttons.presses.map((x) => (x.skipped ? `${x.asked} skipped` : `${x.asked} = ${x.hand} button ${x.index}`)).join(', ');
    const menu = !t.buttons.systemMenu ? 'not reached' : t.buttons.systemMenu.detected ? `detected (${t.buttons.systemMenu.states.join(', ')}, away ${t.buttons.systemMenu.awayMs} ms)` : 'skipped';
    v.push({
      n: 6,
      name: 'Buttons',
      status: t.buttons.pass === undefined ? 'not finished' : t.buttons.pass ? 'pass' : 'check',
      detail: `${p}; system menu: ${menu}`,
      inHeadset: true,
    });
  }

  const ex = r.exportTried || {};
  const tried = Object.keys(ex);
  v.push({
    n: 7,
    name: 'Getting results off the headset',
    status: tried.length ? 'tried' : 'not tried',
    detail: tried.length ? tried.map((k) => `${k}: ${ex[k]}`).join('; ') : 'use the buttons below, then note which one worked for you',
    inHeadset: false,
  });

  if (t.frameRate && t.frameRate.measured) {
    const f = t.frameRate;
    v.push({
      n: '+',
      name: 'Frame rate',
      status: f.measured.fps + ' fps',
      detail: `session rate ${f.sessionFrameRate || '?'}; supported ${f.supportedFrameRates ? f.supportedFrameRates.join('/') : '?'}${f.measuredAt90 ? '; at 90 Hz request: ' + f.measuredAt90.fps + ' fps' : ''}; worst frame ${f.measured.worstMs} ms`,
      inHeadset: true,
    });
  }
  return v;
}

function shortSummary(r) {
  const bits = verdicts(r).map((v) => `${v.n}.${v.name}: ${v.status}`);
  const mode = r.run ? r.run.mode : 'no run yet';
  return `[${VERSION}] ${mode} | ` + bits.join(' | ');
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function renderResults() {
  const tbody = $('verdictRows');
  if (!tbody) return;
  tbody.textContent = '';
  for (const v of verdicts(results)) {
    const tr = el('tr');
    tr.appendChild(el('td', String(v.n)));
    tr.appendChild(el('td', v.name));
    const st = el('td');
    const cls = v.status === 'pass' ? 'ok' : v.status === 'fail' || v.status === 'crashed' ? 'bad' : 'muted';
    st.appendChild(el('span', v.status, 'pill ' + cls));
    tr.appendChild(st);
    tr.appendChild(el('td', v.detail));
    tbody.appendChild(tr);
  }
  const run = results.run;
  let runText = 'No in-headset run yet.';
  if (run) {
    const what = run.mode === 'sim' ? 'on-screen preview' : run.mode === 'immersive-ar' ? 'passthrough session' : 'VR-only session';
    runText = `Last run: ${what}, started ${run.startedAt.replace('T', ' ').slice(0, 16)} UTC, ${run.completed ? 'completed' : running ? 'in progress' : 'stopped before the end'}.`;
    if (run.error) runText += ' Stopped with an error: ' + run.error;
  }
  $('runLine').textContent = runText;
  $('summaryLine').textContent = shortSummary(results);
  $('json').value = JSON.stringify(results, null, 1);
}

function renderEnv() {
  const e = results.env;
  const yn = (b) => (b ? 'yes' : 'no');
  const rows = [
    ['Secure page (https)', yn(e.secureContext)],
    ['WebXR available', yn(e.xrApi)],
    ['Passthrough sessions (immersive-ar)', yn(e.immersiveAr)],
    ['VR sessions (immersive-vr)', yn(e.immersiveVr)],
    ['Page is inside a frame', yn(e.insideFrame)],
    ['Frame policy allows XR', e.xrAllowedByPolicy === null ? 'unknown' : yn(e.xrAllowedByPolicy)],
    ['GPU', e.gpu || 'unknown'],
    ['Largest texture', e.maxTextureSize ? e.maxTextureSize + ' px (cube map ' + e.maxCubeMapSize + ')' : 'unknown'],
    ['Compressed textures', e.compressedTextures ? Object.keys(e.compressedTextures).filter((k) => e.compressedTextures[k]).join(', ') || 'none' : 'unknown'],
    ['Multiview rendering', yn(e.multiview)],
    ['Memory reported', e.deviceMemoryGB ? e.deviceMemoryGB + ' GB' : 'not reported'],
    ['Copy to clipboard', yn(e.clipboardWrite)],
    ['Share sheet', yn(e.webShare)],
    ['Browser', e.userAgent],
  ];
  const tbody = $('envRows');
  tbody.textContent = '';
  for (const [k, val] of rows) {
    const tr = el('tr');
    tr.appendChild(el('th', k));
    tr.appendChild(el('td', String(val)));
    tbody.appendChild(tr);
  }
  const s = results.storage;
  let text;
  if (s.indexedDBError) {
    text = 'This browser refused to store the test record: ' + s.indexedDBError;
  } else {
    text = `A small test record was saved on this headset ${s.ageDays} days ago and has been found on ${s.visits} visit${s.visits === 1 ? '' : 's'}. `;
    text += s.browserChangedSinceFirstWrite
      ? 'The browser has been updated since, and the record survived.'
      : 'To finish this check, open this page again after the browser next updates.';
  }
  $('storageText').textContent = text;

  const ar = $('btnAR');
  const vr = $('btnVR');
  ar.disabled = !e.immersiveAr;
  vr.disabled = !e.immersiveVr;
  let note = '';
  if (!e.secureContext) note = 'VR cannot start because this page is not on https.';
  else if (!e.xrApi) note = 'This browser has no WebXR, so only the on-screen preview works here. Open this page in the Quest browser.';
  else if (e.xrAllowedByPolicy === false) note = 'This page is inside a frame that blocks VR. Open it at its own address.';
  else if (!e.immersiveAr && e.immersiveVr) note = 'Passthrough sessions are not offered here, so the fade check will be skipped.';
  else if (!e.immersiveAr && !e.immersiveVr) note = 'No headset session is offered here. Only the on-screen preview works.';
  $('envNote').textContent = note;
  // inside a preview frame the browser refuses downloads and the share sheet, so do not offer them there
  $('btnDownload').hidden = !!e.insideFrame;
  $('btnShare').hidden = !!e.insideFrame;
  if (e.insideFrame) $('exportNote').textContent = 'Download and Share appear when this page is opened at its own address.';
}

function recordExport(kind, outcome) {
  results.exportTried[kind] = outcome;
  save();
  $('exportNote').textContent = kind + ': ' + outcome;
}

function wireUi() {
  $('btnAR').addEventListener('click', () => startXR('immersive-ar'));
  $('btnVR').addEventListener('click', () => startXR('immersive-vr'));
  $('btnSim').addEventListener('click', startSim);
  $('btnStopSim').addEventListener('click', () => { if (running && !renderer.xr.isPresenting) finishRun(); });

  const simKeys = { yes: () => input('yes'), no: () => input('no') };
  document.querySelectorAll('[data-sim]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!running) return;
      const k = b.getAttribute('data-sim');
      if (simKeys[k]) simKeys[k]();
      else if (k === 'menu') { onVisibility('visible-blurred'); setTimeout(() => onVisibility('visible'), 1200); }
      else {
        const [hand, index] = k.split(':');
        onButton(hand, Number(index));
      }
    });
  });
  window.addEventListener('keydown', (ev) => {
    if (!running || (renderer && renderer.xr.isPresenting)) return;
    const k = ev.key.toLowerCase();
    if (k === 'enter' || k === ' ') { ev.preventDefault(); input('yes'); }
    else if (k === 'n' || k === 'backspace') input('no');
    else if (k === 'a') onButton('right', 4);
    else if (k === 'b') onButton('right', 5);
    else if (k === 'x') onButton('left', 4);
    else if (k === 'y') onButton('left', 5);
    else if (k === 'm') { onVisibility('visible-blurred'); setTimeout(() => onVisibility('visible'), 1200); }
  });

  const host = $('simCanvasHost');
  let drag = null;
  host.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, yaw: look.yaw, pitch: look.pitch }; });
  window.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    look.yaw = drag.yaw + (ev.clientX - drag.x) * 0.005;
    look.pitch = Math.max(-1.3, Math.min(1.3, drag.pitch + (ev.clientY - drag.y) * 0.005));
  });
  window.addEventListener('resize', resizeSim);

  $('btnCopy').addEventListener('click', () => {
    const text = JSON.stringify(results, null, 1);
    const fallback = () => {
      try {
        $('json').focus();
        $('json').select();
        const ok = document.execCommand('copy');
        recordExport('copy', ok ? 'worked (fallback method)' : 'refused');
      } catch (e) {
        recordExport('copy', 'refused: ' + errText(e));
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => recordExport('copy', 'worked'), fallback);
    } else {
      fallback();
    }
  });
  $('btnDownload').addEventListener('click', () => {
    try {
      const blob = new Blob([JSON.stringify(results, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'quest-spike-results.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      recordExport('download', 'started; check the Downloads list to confirm');
    } catch (e) {
      recordExport('download', 'refused: ' + errText(e));
    }
  });
  $('btnShare').addEventListener('click', () => {
    if (!navigator.share) {
      recordExport('share', 'not offered by this browser');
      return;
    }
    navigator.share({ title: 'Quest spike results', text: JSON.stringify(results) }).then(
      () => recordExport('share', 'worked'),
      (e) => recordExport('share', 'refused: ' + errText(e)),
    );
  });
  $('btnPersist').addEventListener('click', async () => {
    try {
      if (!navigator.storage || !navigator.storage.persist) {
        $('persistNote').textContent = 'This browser has no persistent-storage request.';
        return;
      }
      const granted = await navigator.storage.persist();
      results.storage.persistRequest = granted ? 'granted' : 'declined';
      results.storage.persisted = granted;
      $('persistNote').textContent = granted ? 'Granted: the browser will keep this data.' : 'Declined: the browser may clear this data when space is short.';
      save();
    } catch (e) {
      $('persistNote').textContent = 'Request failed: ' + errText(e);
    }
  });
  $('btnReset').addEventListener('click', () => {
    if (running) return;
    const keepEnv = results.env;
    const keepStorage = results.storage;
    results = freshResults();
    results.env = keepEnv;
    results.storage = keepStorage;
    save();
    $('exportNote').textContent = 'Saved results cleared.';
  });
}

async function boot() {
  results = freshResults();
  const saved = lsGet(LS_RESULTS);
  if (saved) {
    try {
      const old = JSON.parse(saved);
      if (old && old.version === VERSION) {
        results.run = old.run || null;
        results.tests = old.tests || {};
        results.exportTried = old.exportTried || {};
        results.log = old.log || [];
      }
    } catch (e) { /* ignore a corrupt save */ }
  }
  const crumbRaw = lsGet(LS_CRUMB);
  if (crumbRaw) {
    lsDel(LS_CRUMB);
    try {
      const crumb = JSON.parse(crumbRaw);
      results.tests.panorama = results.tests.panorama || { sizes: [] };
      results.tests.panorama.crashedAt = crumb.width;
      $('banner').hidden = false;
      $('banner').textContent = `The last run stopped while loading the ${crumb.width} x ${crumb.width / 2} panorama, most likely because the browser ran out of memory. That is a result: it is recorded below.`;
    } catch (e) { /* ignore */ }
  }
  if (results.run && !results.run.endedCleanly) log('previous run did not end cleanly');

  window.addEventListener('error', (ev) => { log('page error: ' + (ev.message || 'unknown')); });
  window.addEventListener('unhandledrejection', (ev) => { log('unhandled: ' + errText(ev.reason)); });

  wireUi();
  renderResults();
  try { results.env = await detectEnv(); } catch (e) { log('environment check failed: ' + errText(e)); }
  try { results.storage = await checkStorage(); } catch (e) { results.storage = { indexedDBError: errText(e) }; }
  renderEnv();
  save();
  window.__spike = { results: () => results, running: () => running, panel: () => panel };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
