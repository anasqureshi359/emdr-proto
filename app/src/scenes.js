// The two environments. Both are backdrops for the user's own calm place.
//   room: a stylized quiet room, with its lighting painted into the textures.
//   lake: a lakeshore at dusk. The surroundings are painted here as a stand-in until a
//         licensed 360° photograph is added (see assets/README.md); the dock is modelled.
// Everything uses unlit materials, so the cost per frame stays low.

import * as THREE from 'three';

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function texOf(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Small repeatable random source, so the scenes look the same on every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Paints fixed lighting into a mesh's vertex colours: a key light plus ambient. */
function shade(geo, hex, light, ambient = 0.55) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const n = g.attributes.normal;
  const base = new THREE.Color(hex);
  const L = new THREE.Vector3(light[0], light[1], light[2]).normalize();
  const colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const d = Math.max(0, n.getX(i) * L.x + n.getY(i) * L.y + n.getZ(i) * L.z);
    const k = ambient + (1 - ambient) * d;
    colors[i * 3] = base.r * k;
    colors[i * 3 + 1] = base.g * k;
    colors[i * 3 + 2] = base.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const shadedMat = () => new THREE.MeshBasicMaterial({ vertexColors: true });

function shadedMesh(geo, hex, light, ambient) {
  return new THREE.Mesh(shade(geo, hex, light, ambient), shadedMat());
}

/* ------------------------------------------------------------------ quiet room */

const ROOM = { x: 2.8, zFar: -3.4, zBack: 2.4, h: 2.8 };

function wallCanvas(w, h, opts = {}) {
  const c = canvasOf(w, h);
  const g = c.getContext('2d');
  g.fillStyle = opts.base || '#d8ccbb';
  g.fillRect(0, 0, w, h);
  // light falls off toward the ceiling and into the corners
  let grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(60,45,35,0.30)');
  grad.addColorStop(0.18, 'rgba(60,45,35,0.06)');
  grad.addColorStop(0.8, 'rgba(60,45,35,0.04)');
  grad.addColorStop(1, 'rgba(50,36,28,0.26)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, `rgba(50,38,30,${opts.left === undefined ? 0.26 : opts.left})`);
  grad.addColorStop(0.12, 'rgba(50,38,30,0.03)');
  grad.addColorStop(0.88, 'rgba(50,38,30,0.03)');
  grad.addColorStop(1, `rgba(50,38,30,${opts.right === undefined ? 0.26 : opts.right})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  if (opts.glow) {
    // soft daylight spilling across the wall from the window side
    const [gx, gy, gr] = opts.glow;
    const rad = g.createRadialGradient(gx * w, gy * h, 0, gx * w, gy * h, gr * w);
    rad.addColorStop(0, 'rgba(255,238,205,0.42)');
    rad.addColorStop(1, 'rgba(255,238,205,0)');
    g.fillStyle = rad;
    g.fillRect(0, 0, w, h);
  }
  // faint plaster grain, so the wall is not a flat fill
  const r = rng(opts.seed || 7);
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = r() > 0.5 ? 'rgba(255,255,255,0.016)' : 'rgba(40,30,20,0.014)';
    g.fillRect(r() * w, r() * h, 3 + r() * 6, 3 + r() * 6);
  }
  return c;
}

function plankCanvas(w, h, opts) {
  const c = canvasOf(w, h);
  const g = c.getContext('2d');
  const r = rng(opts.seed || 3);
  const pw = opts.plank;
  for (let x = 0; x < w; x += pw) {
    const k = 0.86 + r() * 0.26;
    const [br, bg, bb] = opts.rgb;
    g.fillStyle = `rgb(${Math.round(br * k)},${Math.round(bg * k)},${Math.round(bb * k)})`;
    g.fillRect(x, 0, pw, h);
    // grain
    for (let i = 0; i < 26; i++) {
      g.fillStyle = r() > 0.5 ? 'rgba(255,240,220,0.05)' : 'rgba(30,18,10,0.07)';
      g.fillRect(x + r() * pw, r() * h, 1 + r() * 2, 40 + r() * 260);
    }
    // board ends
    let y = r() * 500;
    while (y < h) {
      g.fillStyle = 'rgba(25,15,8,0.45)';
      g.fillRect(x, y, pw, 2);
      y += 500 + r() * 700;
    }
    g.fillStyle = 'rgba(25,15,8,0.5)';
    g.fillRect(x, 0, 2, h);
  }
  return c;
}

function buildRoom() {
  const group = new THREE.Group();
  const W = ROOM.x * 2;
  const D = ROOM.zBack - ROOM.zFar;
  const zc = (ROOM.zBack + ROOM.zFar) / 2;
  const light = [-0.65, 0.7, 0.25]; // from the window on the left

  // floor: planks running away from the viewer, with the light pool painted in
  const fc = plankCanvas(2048, 2048, { plank: 52, rgb: [164, 122, 84], seed: 11 });
  const fg = fc.getContext('2d');
  let rad = fg.createRadialGradient(700, 760, 100, 900, 1000, 1500);
  rad.addColorStop(0, 'rgba(255,236,200,0.22)');
  rad.addColorStop(0.5, 'rgba(0,0,0,0)');
  rad.addColorStop(1, 'rgba(25,15,10,0.5)');
  fg.fillStyle = rad;
  fg.fillRect(0, 0, 2048, 2048);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: texOf(fc) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, zc);
  group.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: texOf(wallCanvas(512, 512, { base: '#cbbfae', seed: 21 })) }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, ROOM.h, zc);
  group.add(ceiling);

  const wall = (w, canvas, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, ROOM.h), new THREE.MeshBasicMaterial({ map: texOf(canvas) }));
    m.position.set(x, ROOM.h / 2, z);
    m.rotation.y = ry;
    group.add(m);
    return m;
  };
  wall(W, wallCanvas(1024, 512, { glow: [0.16, 0.42, 0.5], left: 0.1, seed: 31 }), 0, ROOM.zFar, 0); // far wall, lit from the left
  wall(W, wallCanvas(1024, 512, { base: '#cfc3b2', seed: 32 }), 0, ROOM.zBack, Math.PI);
  wall(D, wallCanvas(1024, 512, { base: '#c9bdac', seed: 33 }), ROOM.x, zc, -Math.PI / 2); // right wall, in shade
  wall(D, wallCanvas(1024, 512, { base: '#d2c6b5', seed: 34 }), -ROOM.x, zc, Math.PI / 2); // window wall

  // window: a bright pane with a painted frame
  const wc = canvasOf(512, 416);
  const wg = wc.getContext('2d');
  wg.fillStyle = '#efe6d8';
  wg.fillRect(0, 0, 512, 416);
  const sky = wg.createLinearGradient(0, 0, 0, 416);
  sky.addColorStop(0, '#dfeaf2');
  sky.addColorStop(0.6, '#f6f1e4');
  sky.addColorStop(1, '#fbf3e0');
  wg.fillStyle = sky;
  wg.fillRect(22, 22, 468, 372);
  wg.fillStyle = '#efe6d8';
  wg.fillRect(250, 22, 12, 372);
  wg.fillRect(22, 200, 468, 12);
  wg.strokeStyle = 'rgba(90,70,50,0.35)';
  wg.lineWidth = 3;
  wg.strokeRect(22, 22, 468, 372);
  wg.strokeRect(1, 1, 510, 414);
  const windowPane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.3), new THREE.MeshBasicMaterial({ map: texOf(wc) }));
  windowPane.position.set(-ROOM.x + 0.01, 1.55, -1.3);
  windowPane.rotation.y = Math.PI / 2;
  group.add(windowPane);

  // the window's light on the floor; it drifts very slowly
  const pc = canvasOf(256, 256);
  const pg = pc.getContext('2d');
  pg.filter = 'blur(10px)';
  pg.fillStyle = 'rgba(255,240,210,0.5)';
  pg.beginPath(); pg.moveTo(30, 40); pg.lineTo(118, 40); pg.lineTo(150, 216); pg.lineTo(62, 216); pg.closePath(); pg.fill();
  pg.beginPath(); pg.moveTo(132, 40); pg.lineTo(214, 40); pg.lineTo(246, 216); pg.lineTo(164, 216); pg.closePath(); pg.fill();
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.7), new THREE.MeshBasicMaterial({ map: texOf(pc), transparent: true, depthWrite: false }));
  patch.rotation.x = -Math.PI / 2;
  patch.rotation.z = Math.PI / 2;
  patch.position.set(-1.25, 0.004, -1.35);
  patch.renderOrder = 5;
  group.add(patch);

  // rug under the seat
  const rc = canvasOf(512, 512);
  const rg = rc.getContext('2d');
  rg.clearRect(0, 0, 512, 512);
  const rings = ['#7f8f8a', '#93a39c', '#b9c0b0', '#93a39c', '#7f8f8a', '#6f7f7b'];
  rings.forEach((col, i) => { rg.fillStyle = col; rg.beginPath(); rg.arc(256, 256, 250 - i * 40, 0, Math.PI * 2); rg.fill(); });
  const rs = rg.createRadialGradient(200, 200, 40, 256, 256, 256);
  rs.addColorStop(0, 'rgba(255,240,215,0.12)');
  rs.addColorStop(1, 'rgba(20,15,10,0.28)');
  rg.globalCompositeOperation = 'source-atop';
  rg.fillStyle = rs;
  rg.fillRect(0, 0, 512, 512);
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.15, 48), new THREE.MeshBasicMaterial({ map: texOf(rc), transparent: true, depthWrite: false }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.006, -0.35);
  rug.renderOrder = 6;
  group.add(rug);

  // skirting boards
  const skirt = (w, x, z, ry) => {
    const m = shadedMesh(new THREE.BoxGeometry(w, 0.1, 0.02), '#efe6d8', light, 0.6);
    m.position.set(x, 0.05, z);
    m.rotation.y = ry;
    group.add(m);
  };
  skirt(W, 0, ROOM.zFar + 0.01, 0);
  skirt(W, 0, ROOM.zBack - 0.01, 0);
  skirt(D, ROOM.x - 0.01, zc, Math.PI / 2);
  skirt(D, -ROOM.x + 0.01, zc, Math.PI / 2);

  // a low shelf on the right of the far wall; the wall at eye level stays clear for the light
  const shelf = shadedMesh(new THREE.BoxGeometry(1.7, 0.42, 0.38), '#8a6a4c', light, 0.5);
  shelf.position.set(1.55, 0.21, ROOM.zFar + 0.21);
  group.add(shelf);
  const bookCols = ['#6d7f8c', '#a9705a', '#c9b98f', '#58705f'];
  bookCols.forEach((col, i) => {
    const b = shadedMesh(new THREE.BoxGeometry(0.06, 0.2 + (i % 2) * 0.04, 0.16), col, light, 0.55);
    b.position.set(1.05 + i * 0.075, 0.42 + (0.2 + (i % 2) * 0.04) / 2, ROOM.zFar + 0.2);
    group.add(b);
  });
  const vase = shadedMesh(new THREE.CylinderGeometry(0.07, 0.05, 0.24, 20), '#d9d2c4', light, 0.55);
  vase.position.set(1.95, 0.54, ROOM.zFar + 0.2);
  group.add(vase);

  // a plant in the far left corner, below the light's path
  const pot = shadedMesh(new THREE.CylinderGeometry(0.17, 0.13, 0.32, 20), '#a8826a', light, 0.5);
  pot.position.set(-2.2, 0.16, ROOM.zFar + 0.5);
  group.add(pot);
  [[0, 0.62, 0, 0.3], [-0.14, 0.5, 0.1, 0.22], [0.15, 0.48, -0.06, 0.2], [0.02, 0.84, 0.04, 0.2]].forEach(([dx, y, dz, r]) => {
    const leaf = shadedMesh(new THREE.IcosahedronGeometry(r, 1), '#6f8f66', light, 0.45);
    leaf.position.set(-2.2 + dx, y, ROOM.zFar + 0.5 + dz);
    group.add(leaf);
  });

  return {
    group,
    update(t) { patch.position.x = -1.25 + Math.sin(t / 40) * 0.07; },
  };
}

/* ------------------------------------------------------------------ lakeshore at dusk */

function paintDusk(W, H) {
  const c = canvasOf(W, H);
  const g = c.getContext('2d');
  const hz = H / 2;
  const r = rng(90210);
  const sunX = 0.75 * W; // straight ahead of the seat

  const sky = g.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#0e1730');
  sky.addColorStop(0.45, '#27365f');
  sky.addColorStop(0.72, '#5c5482');
  sky.addColorStop(0.9, '#b5806f');
  sky.addColorStop(1, '#f0bd8c');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, hz);

  // the side away from the sun is cooler and darker
  for (const off of [-W, 0, W]) {
    const away = g.createLinearGradient(sunX - W / 2 + off, 0, sunX + off, 0);
    away.addColorStop(0, 'rgba(14,20,48,0.5)');
    away.addColorStop(0.55, 'rgba(14,20,48,0.12)');
    away.addColorStop(1, 'rgba(14,20,48,0)');
    g.fillStyle = away;
    g.fillRect(sunX - W / 2 + off, 0, W / 2, hz);
    const away2 = g.createLinearGradient(sunX + off, 0, sunX + W / 2 + off, 0);
    away2.addColorStop(0, 'rgba(14,20,48,0)');
    away2.addColorStop(0.45, 'rgba(14,20,48,0.12)');
    away2.addColorStop(1, 'rgba(14,20,48,0.5)');
    g.fillStyle = away2;
    g.fillRect(sunX + off, 0, W / 2, hz);
  }

  // afterglow where the sun went down
  const glow = g.createRadialGradient(sunX, hz, 0, sunX, hz, W * 0.2);
  glow.addColorStop(0, 'rgba(255,214,150,0.85)');
  glow.addColorStop(0.25, 'rgba(255,180,120,0.45)');
  glow.addColorStop(1, 'rgba(255,170,120,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, hz);

  // a few faint stars high on the dark side
  for (let i = 0; i < 90; i++) {
    const x = (sunX + W / 2 + (r() - 0.5) * W * 0.7 + W) % W;
    const y = r() * hz * 0.5;
    g.fillStyle = `rgba(255,255,255,${0.15 + r() * 0.45})`;
    g.fillRect(x, y, 1.6, 1.6);
  }

  // thin cloud bands near the horizon
  for (let i = 0; i < 26; i++) {
    const x = r() * W;
    const y = hz * (0.62 + r() * 0.32);
    const rx = 90 + r() * 260;
    const ry = 5 + r() * 12;
    const near = 1 - Math.min(1, Math.abs(((x - sunX + W * 1.5) % W) - W / 2) / (W / 2));
    const col = near > 0.6 ? '255,170,130' : near > 0.3 ? '190,130,140' : '95,95,135';
    for (const off of [-W, 0, W]) {
      g.save();
      g.translate(x + off, y);
      g.scale(1, ry / rx);
      const cg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      cg.addColorStop(0, `rgba(${col},${0.2 + r() * 0.2})`);
      cg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = cg;
      g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }

  // water: the sky mirrored, darker, before the far shore goes on top
  g.save();
  g.translate(0, H);
  g.scale(1, -1);
  g.drawImage(c, 0, 0, W, hz, 0, 0, W, hz);
  g.restore();
  const deep = g.createLinearGradient(0, hz, 0, H);
  deep.addColorStop(0, 'rgba(18,24,44,0.30)');
  deep.addColorStop(0.3, 'rgba(14,20,38,0.58)');
  deep.addColorStop(1, 'rgba(8,12,24,0.86)');
  g.fillStyle = deep;
  g.fillRect(0, hz, W, hz);

  // far shore: low hills and a treeline, the same all the way round
  const shore = (yBase, amp, colour, seed, jag) => {
    const q = rng(seed);
    const ph = [q() * 6.28, q() * 6.28, q() * 6.28];
    const n = [];
    for (let i = 0; i < 256; i++) n.push(q());
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(0, yBase + 3);
    for (let x = 0; x <= W; x += 2) {
      const a = (x / W) * Math.PI * 2;
      const hill = (Math.sin(a * 3 + ph[0]) * 0.5 + Math.sin(a * 7 + ph[1]) * 0.3 + Math.sin(a * 13 + ph[2]) * 0.2 + 1) / 2;
      const k = (x / W) * 255;
      const i0 = Math.floor(k) % 256;
      const tree = jag * (n[i0] * 0.6 + n[(Math.floor(k * 7) % 256)] * 0.4);
      g.lineTo(x, yBase - 3 - hill * amp - tree);
    }
    g.lineTo(W, yBase + 3);
    g.closePath();
    g.fill();
  };
  shore(hz, 30, '#4a4762', 501, 0); // distant hills, hazy
  shore(hz, 13, '#1a1f2b', 502, 7); // near treeline
  // its reflection, short and soft
  const refl = g.createLinearGradient(0, hz, 0, hz + 26);
  refl.addColorStop(0, 'rgba(18,22,32,0.9)');
  refl.addColorStop(1, 'rgba(18,22,32,0)');
  g.fillStyle = refl;
  g.fillRect(0, hz, W, 26);

  // the afterglow on the water: a broken column of light toward the viewer
  for (let i = 0; i < 520; i++) {
    const d = r();
    const y = hz + 4 + d * d * hz * 0.9;
    const spread = 14 + d * 150;
    const x = sunX + (r() - 0.5) * 2 * spread;
    const len = 6 + r() * (20 + d * 80);
    g.fillStyle = `rgba(255,205,150,${0.32 * (1 - d * 0.75)})`;
    g.fillRect(x - len / 2, y, len, 1 + d * 2.2);
  }
  // ripples everywhere else
  for (let i = 0; i < 2600; i++) {
    const d = r();
    const y = hz + 3 + d * d * hz;
    const len = 5 + r() * (14 + d * 90);
    g.fillStyle = r() > 0.5 ? `rgba(200,190,220,${0.05 + r() * 0.07})` : `rgba(6,10,22,${0.08 + r() * 0.1})`;
    g.fillRect(r() * W, y, len, 1 + d * 1.8);
  }
  return c;
}

function buildLake(opts = {}) {
  const group = new THREE.Group();
  const light = [0, 0.5, -1]; // low light from across the water

  const domeGeo = new THREE.SphereGeometry(40, 64, 32);
  domeGeo.scale(-1, 1, 1);
  const domeMat = new THREE.MeshBasicMaterial({ map: texOf(paintDusk(2048, 1024)), depthWrite: false });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -10;
  dome.position.y = 1.2; // horizon at seated eye height
  group.add(dome);

  // near water: slow-moving streaks over the painted reflection, fading out with distance
  const sc = canvasOf(512, 512);
  const sg = sc.getContext('2d');
  const r = rng(77);
  for (let i = 0; i < 420; i++) {
    sg.fillStyle = r() > 0.45 ? `rgba(215,190,190,${0.1 + r() * 0.22})` : `rgba(8,12,26,${0.12 + r() * 0.2})`;
    sg.fillRect(r() * 512, r() * 512, 20 + r() * 110, 1 + r() * 2.5);
  }
  const streaks = texOf(sc);
  streaks.wrapS = THREE.RepeatWrapping;
  streaks.wrapT = THREE.RepeatWrapping;
  streaks.repeat.set(7, 7);
  const mc = canvasOf(256, 256);
  const mg = mc.getContext('2d');
  const mask = mg.createRadialGradient(128, 128, 10, 128, 128, 128);
  mask.addColorStop(0, '#ffffff');
  mask.addColorStop(0.55, '#8a8a8a');
  mask.addColorStop(1, '#000000');
  mg.fillStyle = mask;
  mg.fillRect(0, 0, 256, 256);
  const water = new THREE.Mesh(new THREE.CircleGeometry(26, 48), new THREE.MeshBasicMaterial({ map: streaks, alphaMap: new THREE.CanvasTexture(mc), transparent: true, opacity: 0.55, depthWrite: false }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.55;
  water.renderOrder = 4;
  group.add(water);

  // the dock under the seat
  const dc = plankCanvas(1024, 512, { plank: 64, rgb: [112, 92, 78], seed: 5 });
  const dg = dc.getContext('2d');
  const dgr = dg.createLinearGradient(0, 0, 1024, 0); // brighter toward the far end, where the light is
  dgr.addColorStop(0, 'rgba(255,190,140,0.20)');
  dgr.addColorStop(0.5, 'rgba(0,0,0,0)');
  dgr.addColorStop(1, 'rgba(8,10,20,0.45)');
  dg.fillStyle = dgr;
  dg.fillRect(0, 0, 1024, 512);
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 2.3), new THREE.MeshBasicMaterial({ map: texOf(dc) }));
  deck.rotation.x = -Math.PI / 2;
  deck.rotation.z = Math.PI / 2; // planks run across the dock
  deck.position.set(0, 0, -1.3);
  group.add(deck);
  const frame = shadedMesh(new THREE.BoxGeometry(2.3, 0.14, 6.2), '#4a3d36', light, 0.5);
  frame.position.set(0, -0.072, -1.3);
  group.add(frame);
  for (const z of [-4.3, -1.5, 1.3]) {
    for (const x of [-1.2, 1.2]) {
      const post = shadedMesh(new THREE.CylinderGeometry(0.075, 0.075, 1.25, 14), '#3d332e', light, 0.5);
      post.position.set(x, -0.1, z);
      group.add(post);
      const cap = shadedMesh(new THREE.CylinderGeometry(0.085, 0.085, 0.03, 14), '#8a705c', light, 0.6);
      cap.position.set(x, 0.54, z);
      group.add(cap);
    }
  }

  // A licensed 360° photograph, when one has been added, replaces the painted surroundings.
  if (opts.photoUrl) {
    new THREE.TextureLoader().load(opts.photoUrl, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      domeMat.map = t;
      domeMat.needsUpdate = true;
      water.visible = false;
      if (opts.onPhoto) opts.onPhoto(true);
    }, undefined, () => { if (opts.onPhoto) opts.onPhoto(false); });
  }

  return {
    group,
    update(t) {
      streaks.offset.x = (t * 0.004) % 1;
      streaks.offset.y = (t * 0.0015) % 1;
    },
  };
}

export function buildScene(name, opts) {
  return name === 'lake' ? buildLake(opts) : buildRoom();
}

/** The soft warm light used for paced breathing and for bilateral sets. */
export function buildLight() {
  const c = canvasOf(256, 256);
  const g = c.getContext('2d');
  const rad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  rad.addColorStop(0, 'rgba(255,248,230,1)');
  rad.addColorStop(0.2, 'rgba(255,238,200,1)');
  rad.addColorStop(0.34, 'rgba(255,214,150,0.9)');
  rad.addColorStop(0.6, 'rgba(255,186,110,0.3)');
  rad.addColorStop(1, 'rgba(255,170,90,0)');
  g.fillStyle = rad;
  g.fillRect(0, 0, 256, 256);
  const mat = new THREE.SpriteMaterial({ map: texOf(c), transparent: true, depthWrite: false, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 50;
  sprite.visible = false;
  return sprite;
}
