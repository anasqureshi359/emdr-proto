// The headset view: an empty scene (sky, floor), a floating panel, the fade between
// scene and real room, and controller input. It holds no session logic: it reports
// input and frames, and draws whatever screen it is given.

import * as THREE from 'three';
import { PANEL_W, PANEL_H, drawScreen } from './panel.js';

const errText = (e) => String((e && e.message) || e);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function skyCanvas() {
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

function floorCanvas() {
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
  g.globalCompositeOperation = 'destination-in';
  const rad = g.createRadialGradient(n / 2, n / 2, n * 0.36, n / 2, n / 2, n * 0.5);
  rad.addColorStop(0, 'rgba(0,0,0,1)');
  rad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rad;
  g.fillRect(0, 0, n, n);
  return c;
}

/**
 * handlers: onInput(kind, value), onFrame(dtMs), onVisibility(state), onEnd(), onProblem(text)
 * kinds: 'primary', 'secondary', 'grounding', 'step' (+1 / -1 from A / X),
 *        'stickX' (+1 / -1), 'stickY' (+1 down / -1 up)
 */
export function createXrView(handlers) {
  let renderer = null;
  let scene, camera, world, dome, domeMat, floor, floorMat, panelTex, panelCtx;
  const gripMarkers = [];
  let session = null;
  let opacity = 0;
  const fade = { active: false, from: 0, to: 0, t0: 0, dur: 1 };
  const prev = {};
  const stick = { x: { dir: 0, next: 0 }, y: { dir: 0, next: 0 } };
  let lastT = 0;
  let lastFrameWall = 0;
  let dirty = true;
  let currentScreen = null;
  let currentExtra = {};

  function init() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.xr.enabled = true;
    renderer.domElement.style.display = 'none';
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
    world = new THREE.Group();
    scene.add(world);

    const skyTex = new THREE.CanvasTexture(skyCanvas());
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const domeGeo = new THREE.SphereGeometry(30, 48, 24);
    domeGeo.scale(-1, 1, 1);
    domeMat = new THREE.MeshBasicMaterial({ map: skyTex, depthWrite: false, transparent: true });
    dome = new THREE.Mesh(domeGeo, domeMat);
    dome.renderOrder = -10;
    dome.position.y = 1.2;
    world.add(dome);

    const floorTex = new THREE.CanvasTexture(floorCanvas());
    floorTex.colorSpace = THREE.SRGBColorSpace;
    const floorGeo = new THREE.CircleGeometry(6, 48);
    floorGeo.rotateX(-Math.PI / 2);
    floorMat = new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false });
    floor = new THREE.Mesh(floorGeo, floorMat);
    floor.renderOrder = -5;
    world.add(floor);

    const pc = makeCanvas(PANEL_W, PANEL_H);
    panelCtx = pc.getContext('2d');
    panelTex = new THREE.CanvasTexture(pc);
    panelTex.colorSpace = THREE.SRGBColorSpace;
    panelTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4 * PANEL_H / PANEL_W), new THREE.MeshBasicMaterial({ map: panelTex }));
    panel.position.set(0, 1.15, -1.6);
    world.add(panel);

    for (let i = 0; i < 2; i++) {
      const grip = renderer.xr.getControllerGrip(i);
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.11, 12), new THREE.MeshBasicMaterial({ color: 0x8fa3b8 }));
      marker.rotation.x = Math.PI / 2;
      gripMarkers.push(marker);
      grip.add(marker);
      grip.visible = false;
      scene.add(grip);
    }
    applyOpacity();
  }

  function applyOpacity() {
    domeMat.opacity = opacity;
    domeMat.transparent = opacity < 1;
    floorMat.opacity = opacity;
    const shown = opacity > 0.001;
    dome.visible = shown;
    floor.visible = shown;
    // stand-in controller shapes are only needed while the real ones are hidden
    for (const m of gripMarkers) m.visible = opacity > 0.5;
  }

  function fadeTo(to, ms) {
    fade.active = true;
    fade.from = opacity;
    fade.to = to;
    fade.t0 = performance.now();
    fade.dur = Math.max(1, ms);
  }

  function setScreen(sc, extra) {
    currentScreen = sc;
    currentExtra = extra || {};
    dirty = true;
  }

  function stickAxis(axis, value, now, kind) {
    const dir = value > 0.6 ? 1 : value < -0.6 ? -1 : 0;
    if (dir === 0) { axis.dir = 0; return; }
    if (dir !== axis.dir) {
      axis.dir = dir;
      axis.next = now + 420;
      handlers.onInput(kind, dir);
    } else if (now >= axis.next) {
      axis.next = now + 220;
      handlers.onInput(kind, dir);
    }
  }

  function pollInput(now) {
    let sx = 0;
    let sy = 0;
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const hand = src.handedness || 'none';
      const was = prev[hand] || [];
      const cur = [];
      for (let i = 0; i < gp.buttons.length; i++) cur.push(!!gp.buttons[i].pressed);
      if (cur[5] && !was[5]) handlers.onInput('grounding');
      if (cur[4] && !was[4]) handlers.onInput('step', hand === 'left' ? -1 : 1);
      prev[hand] = cur;
      const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
      const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
      if (Math.abs(ax) > Math.abs(sx)) sx = ax;
      if (Math.abs(ay) > Math.abs(sy)) sy = ay;
    }
    stickAxis(stick.x, sx, now, 'stickX');
    stickAxis(stick.y, sy, now, 'stickY');
  }

  function onFrame(time) {
    const dt = lastT ? time - lastT : 0;
    lastT = time;
    lastFrameWall = performance.now();
    try {
      if (session && session.visibilityState === 'visible') pollInput(performance.now());
      if (fade.active) {
        const k = Math.min(1, (performance.now() - fade.t0) / fade.dur);
        opacity = fade.from + (fade.to - fade.from) * k;
        applyOpacity();
        if (k >= 1) fade.active = false;
      }
      handlers.onFrame(dt);
      if (dirty && currentScreen) {
        drawScreen(panelCtx, currentScreen, currentExtra);
        panelTex.needsUpdate = true;
        dirty = false;
      }
    } catch (e) {
      handlers.onProblem('frame error: ' + errText(e));
    }
    renderer.render(scene, camera);
  }

  async function begin(xrSession) {
    init();
    session = xrSession;
    let refType = 'local-floor';
    try { await session.requestReferenceSpace('local-floor'); } catch (e) { refType = 'local'; }
    renderer.xr.setReferenceSpaceType(refType);
    world.position.y = refType === 'local' ? -1.2 : 0;
    await renderer.xr.setSession(session);
    opacity = 0; // check-in happens in the real-room view
    fade.active = false;
    applyOpacity();
    lastT = 0;
    lastFrameWall = performance.now();
    for (const k of Object.keys(prev)) delete prev[k];
    session.addEventListener('selectstart', () => handlers.onInput('primary'));
    session.addEventListener('squeezestart', () => handlers.onInput('secondary'));
    session.addEventListener('visibilitychange', () => handlers.onVisibility(session.visibilityState));
    session.addEventListener('end', () => {
      renderer.setAnimationLoop(null);
      session = null;
      handlers.onEnd();
    });
    renderer.setAnimationLoop(onFrame);
    return { refType, blendMode: session.environmentBlendMode || 'unknown', frameRate: session.frameRate || null };
  }

  function end() {
    if (session) session.end().catch(() => {});
  }

  return {
    begin,
    end,
    fadeTo,
    setScreen,
    get active() { return !!session; },
    get visible() { return !!session && session.visibilityState === 'visible'; },
    get frameRate() { return session && session.frameRate ? session.frameRate : null; },
    msSinceFrame() { return performance.now() - lastFrameWall; },
  };
}
