// The headset view: the chosen scene, a floating panel, the moving light, the fade between
// scene and real room, and controller input. It holds no session logic: it reports input
// and frames, and draws whatever it is given.

import * as THREE from 'three';
import { PANEL_W, PANEL_H, drawScreen } from './panel.js';
import { buildScene, buildLight } from './scenes.js';

const errText = (e) => String((e && e.message) || e);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Where the panel sits. During breathing and bilateral sets it drops below the light.
const POSE = {
  normal: { y: 1.15, z: -1.6, rx: 0, s: 1 },
  low: { y: 0.64, z: -1.4, rx: -0.4, s: 0.8 },
};
const LIGHT_DISTANCE = 2; // metres

/**
 * handlers: onInput(kind, value), onFrame(dtMs), onVisibility(state), onEnd(), onProblem(text)
 * kinds: 'primary', 'secondary', 'grounding', 'step' (+1 / -1 from A / X),
 *        'stickX' (+1 / -1), 'stickY' (+1 down / -1 up)
 */
export function createXrView(handlers) {
  let renderer = null;
  let scene, camera, rig, world, veil, veilMat, panel, panelTex, panelCtx, light;
  const gripMarkers = [];
  const scenes = {};
  let active = null;
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
  let pose = { ...POSE.normal };
  let poseTarget = POSE.normal;
  let eyeY = 1.2;
  let lightWasOn = false;
  let visual = { kind: 'none' };
  let sceneOpts = {};
  const camPos = new THREE.Vector3();

  function init() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.xr.enabled = true;
    renderer.domElement.style.display = 'none';
    renderer.domElement.id = 'xrCanvas';
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, 1, 0.05, 120);
    rig = new THREE.Group(); // lowered as a whole when the headset has no floor-level tracking
    scene.add(rig);
    world = new THREE.Group();
    rig.add(world);

    light = buildLight();
    world.add(light);

    // The veil fades the whole scene to the real room. It is drawn after the scene and
    // multiplies both colour and alpha by the scene's opacity, so at 0 only passthrough
    // is left. The panel and the controller shapes are drawn after it and are not faded.
    veilMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.SrcAlphaFactor,
    });
    veil = new THREE.Mesh(new THREE.SphereGeometry(60, 16, 12), veilMat);
    veil.renderOrder = 900;
    veil.frustumCulled = false;
    scene.add(veil);

    const pc = makeCanvas(PANEL_W, PANEL_H);
    panelCtx = pc.getContext('2d');
    panelTex = new THREE.CanvasTexture(pc);
    panelTex.colorSpace = THREE.SRGBColorSpace;
    panelTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    panel = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4 * PANEL_H / PANEL_W), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthTest: false, depthWrite: false }));
    panel.renderOrder = 950;
    rig.add(panel);
    applyPose();

    for (let i = 0; i < 2; i++) {
      const grip = renderer.xr.getControllerGrip(i);
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.11, 12), new THREE.MeshBasicMaterial({ color: 0x8fa3b8, transparent: true, depthTest: false }));
      marker.rotation.x = Math.PI / 2;
      marker.renderOrder = 960;
      gripMarkers.push(marker);
      grip.add(marker);
      grip.visible = false;
      scene.add(grip);
    }
    applyOpacity();
  }

  function useScene(name) {
    const key = name === 'lake' ? 'lake' : 'room';
    if (!scenes[key]) {
      scenes[key] = buildScene(key, sceneOpts);
      scenes[key].group.visible = false;
      world.add(scenes[key].group);
    }
    for (const k of Object.keys(scenes)) scenes[k].group.visible = k === key;
    active = scenes[key];
  }

  function applyPose() {
    panel.position.set(0, pose.y, pose.z);
    panel.rotation.x = pose.rx;
    panel.scale.setScalar(pose.s);
  }

  function applyOpacity() {
    const shown = opacity > 0.001;
    world.visible = shown;
    veil.visible = shown && opacity < 0.999;
    veilMat.opacity = opacity;
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
    poseTarget = sc && sc.layout === 'low' ? POSE.low : POSE.normal;
    dirty = true;
  }

  /** v: { kind: 'none' } | { kind: 'breath', level, alpha } | { kind: 'sweep', x, deg, alpha } */
  function setVisual(v) {
    visual = v || { kind: 'none' };
  }

  function updateLight() {
    const on = visual.kind !== 'none' && visual.alpha > 0.002 && opacity > 0.001;
    if (on && !lightWasOn) {
      // eye level, measured once when the light appears, so it does not follow the head
      eyeY = Math.min(1.5, Math.max(0.9, (camPos.y - rig.position.y) || 1.2));
    }
    lightWasOn = on;
    light.visible = on;
    if (!on) return;
    light.material.opacity = Math.min(1, visual.alpha);
    if (visual.kind === 'sweep') {
      const a = (visual.x * visual.deg * Math.PI) / 180;
      light.position.set(LIGHT_DISTANCE * Math.sin(a), eyeY, -LIGHT_DISTANCE * Math.cos(a));
      light.scale.setScalar(0.5);
    } else {
      light.position.set(0, eyeY, -LIGHT_DISTANCE);
      light.scale.setScalar(0.3 + 0.6 * visual.level);
    }
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

  /** A short, gentle pulse in one controller. The browser's reply is never waited for. */
  function pulse(side, strength, ms) {
    if (!session) return false;
    const want = side > 0 ? 'right' : 'left';
    for (const src of session.inputSources) {
      if (src.handedness !== want || !src.gamepad) continue;
      const act = src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
      if (!act || !act.pulse) return false;
      try { const p = act.pulse(strength, ms); if (p && p.catch) p.catch(() => {}); } catch (e) { return false; }
      return true;
    }
    return false;
  }

  function onFrame(time) {
    const dt = lastT ? time - lastT : 0;
    lastT = time;
    const nowWall = performance.now();
    lastFrameWall = nowWall;
    try {
      if (session && session.visibilityState === 'visible') pollInput(nowWall);
      if (fade.active) {
        const k = Math.min(1, (nowWall - fade.t0) / fade.dur);
        opacity = fade.from + (fade.to - fade.from) * k;
        applyOpacity();
        if (k >= 1) fade.active = false;
      }
      handlers.onFrame(dt);
      try { camPos.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld); } catch (e) { /* keep the last value */ }
      updateLight();
      if (active && opacity > 0.001) active.update(nowWall / 1000);
      // ease the panel toward its place
      const k = Math.min(1, dt > 0 ? dt / 220 : 1);
      pose.y += (poseTarget.y - pose.y) * k;
      pose.z += (poseTarget.z - pose.z) * k;
      pose.rx += (poseTarget.rx - pose.rx) * k;
      pose.s += (poseTarget.s - pose.s) * k;
      applyPose();
      if (dirty && currentScreen) {
        drawScreen(panelCtx, currentScreen, currentExtra);
        panelTex.needsUpdate = true;
        dirty = false;
      }
    } catch (e) {
      handlers.onProblem('frame error: ' + errText(e));
    }
    renderer.render(scene, camera);
    if (window.__SHELL_TEST_PROBE) {
      // Emulator tests read one pixel high in the left eye to check the fade's colour and alpha.
      try {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        gl.readPixels(Math.floor(gl.drawingBufferWidth * 0.06), Math.floor(gl.drawingBufferHeight * 0.8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        window.__SHELL_TEST_PROBE({ rgba: Array.from(px), opacity, light: light.visible ? { x: light.position.x, y: light.position.y, z: light.position.z, scale: light.scale.x, alpha: light.material.opacity } : null, panel: { y: pose.y, rx: pose.rx } });
      } catch (e) { /* ignore */ }
    }
  }

  /** opts: { scene: 'room' | 'lake', renderScale, lakePhotoUrl, onPhoto } */
  async function begin(xrSession, opts = {}) {
    init();
    session = xrSession;
    sceneOpts = { photoUrl: opts.lakePhotoUrl || null, onPhoto: opts.onPhoto };
    try { renderer.xr.setFramebufferScaleFactor(Math.min(1.5, Math.max(1, Number(opts.renderScale) || 1))); } catch (e) { /* keep the default */ }
    let refType = 'local-floor';
    try { await session.requestReferenceSpace('local-floor'); } catch (e) { refType = 'local'; }
    renderer.xr.setReferenceSpaceType(refType);
    rig.position.y = refType === 'local' ? -1.2 : 0;
    await renderer.xr.setSession(session);
    useScene(opts.scene);
    opacity = 0; // check-in happens in the real-room view
    fade.active = false;
    visual = { kind: 'none' };
    pose = { ...POSE.normal };
    poseTarget = POSE.normal;
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
    let size = null;
    try { const bl = session.renderState.baseLayer; size = bl ? [bl.framebufferWidth, bl.framebufferHeight] : null; } catch (e) { /* ignore */ }
    return { refType, blendMode: session.environmentBlendMode || 'unknown', frameRate: session.frameRate || null, framebuffer: size };
  }

  function end() {
    if (session) session.end().catch(() => {});
  }

  return {
    begin,
    end,
    fadeTo,
    setScreen,
    setVisual,
    pulse,
    get active() { return !!session; },
    get visible() { return !!session && session.visibilityState === 'visible'; },
    get frameRate() { return session && session.frameRate ? session.frameRate : null; },
    msSinceFrame() { return performance.now() - lastFrameWall; },
  };
}
