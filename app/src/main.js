// Page wiring: start and run a session (in the headset or as an
// on-screen preview), keep the log, and enforce the start rules.

import { createSession, S } from './core/machine.js';
import { normalizeConfig } from './core/config.js';
import { eligibility, needsAnswer } from './core/eligibility.js';
import { createStore } from './store.js';
import { createXrView } from './xr.js';
import { PANEL_W, PANEL_H, drawScreen } from './panel.js';
import { createAudio } from './audio.js';

const VERSION = 'stabilization-app 0.3';
const LAKE_PHOTO = 'assets/lakeshore.jpg'; // optional: a licensed 360° photo replaces the painted lakeshore
const EXERCISE_NAMES = { 'breathing': 'paced breathing', 'calm-place': 'calm place', 'grounding': 'grounding', 'bench': 'engine test' };
const $ = (id) => document.getElementById(id);
const errText = (e) => String((e && e.message) || e);
const clone = (x) => JSON.parse(JSON.stringify(x));

let store = null;
let history = [];
let settings = { scene: 'room', cueWord: 'calm', renderScale: 1, sceneSound: true };
let config = normalizeConfig(settings);
let onboarded = false;
let run = null;
let lastPreview = null;
let view = null;
let previewTimer = null;
let backupTimer = null;
const problems = [];
const audio = createAudio({ onProblem: (text) => problem(text) });

function problem(text) {
  problems.push(new Date().toISOString().slice(11, 19) + ' ' + text);
  if (problems.length > 30) problems.shift();
  const el = $('problems');
  if (el) { el.hidden = false; el.textContent = 'Problems seen on this page: ' + problems.join(' | '); }
}

/* ------------------------------------------------------------------ running a session */

const clockNow = () => (run && run.clock ? run.clock() : Date.now());

function send(type, extra) {
  if (!run) return;
  try {
    run.machine.dispatch({ type, now: clockNow(), ...(extra || {}) });
  } catch (e) {
    emergency(e);
    return;
  }
  afterDispatch(type !== 'tick');
}

function afterDispatch(force) {
  if (!run) return;
  const m = run.machine;
  for (const e of m.drainEffects()) {
    if (e.type === 'fade') {
      run.fade(e.to, e.ms);
      // scene sound follows the scene: on as it fades in, off at once as it fades out
      audio.setAmbient(e.to > 0 && config.sceneSound ? (m.record.scene || config.scene) : null);
    } else if (e.type === 'stim') {
      if (e.on) stimStart(); else stimStop();
    } else if (e.type === 'save') persist();
    else if (e.type === 'end') { run.leave(); return; }
  }
  if (!run) return;
  if (m.state !== run.lastState) {
    run.lastState = m.state;
    run.lastChangeAt = performance.now();
    snapshot();
    force = true;
  }
  redraw(force);
}

/* ------------------------------------------------------------------ light, tone and pulse */

const turnAt = (s, k) => s.t0 + (k + 0.5) * (s.passMs / 2); // turn k: even = right, odd = left

function stimStart() {
  if (!run) return;
  const s = run.machine.stimulus();
  if (!s) return;
  const now = clockNow();
  const key = run.machine.record.rounds.length;
  if (run.stim.key !== key) run.stim = { key, nextTone: 0, nextPulse: 0, tones: 0, toneLateMax: 0, pulses: 0, frameGapMax: 0, startedWall: performance.now() };
  // After a pause the timeline has moved: pick up at the next turn still ahead.
  let k = 0;
  while (k < s.passes * 2 && turnAt(s, k) <= now) k++;
  run.stim.nextTone = Math.max(run.stim.nextTone, k);
  run.stim.nextPulse = Math.max(run.stim.nextPulse, k);
  audio.stimOn();
}

function stimStop() {
  audio.stimOff(); // first, before anything else
  if (!run) return;
  run.setVisual({ kind: 'none' });
  const rounds = run.machine.record.rounds;
  const r = rounds[rounds.length - 1];
  const st = run.stim;
  if (r && r.set && st.key === rounds.length) {
    r.set.sync = {
      tones: st.tones,
      toneLateMaxMs: Math.round(st.toneLateMax),
      pulses: st.pulses,
      frameGapMaxMs: Math.round(st.frameGapMax),
      outputDelayMs: Math.round(audio.latencyMs()),
      sound: audio.running,
    };
  }
}

/** Runs every frame: moves the light, schedules the tone ahead of time, fires the pulse. */
function stimFrame(dt) {
  if (!run) return;
  const now = clockNow();
  run.setVisual(run.machine.visual(now));
  const s = run.machine.stimulus();
  if (!s) return;
  const st = run.stim;
  const speed = run.speed || 1;
  const total = s.passes * 2;
  if (dt > 0 && now >= s.t0) st.frameGapMax = Math.max(st.frameGapMax, dt);
  // The tone is scheduled up to 220 ms ahead, because sound leaves the headset late.
  while (st.nextTone < total && turnAt(s, st.nextTone) - now < 220 * speed) {
    const k = st.nextTone++;
    const inMs = (turnAt(s, k) - now) / speed;
    if (inMs < -40 || !s.channels.tone) continue;
    const late = audio.chime(Math.max(0, inMs), k % 2 === 0 ? 1 : -1);
    if (late !== null) { st.tones += 1; st.toneLateMax = Math.max(st.toneLateMax, late); }
  }
  // A pulse cannot be scheduled ahead, so it fires on the frame its turn falls in.
  while (st.nextPulse < total && turnAt(s, st.nextPulse) <= now) {
    const k = st.nextPulse++;
    if (s.channels.pulse && now - turnAt(s, k) < 60 * speed && run.pulse && run.pulse(k % 2 === 0 ? 1 : -1, 0.2, 60)) st.pulses += 1;
  }
}

function redraw(force) {
  if (!run) return;
  const t = performance.now();
  if (!force && t - run.lastDrawAt < 120) return;
  run.lastDrawAt = t;
  const sc = run.machine.screen(clockNow());
  const corner = run.mode === 'preview' ? 'preview' : (run.fps.value ? Math.round(run.fps.value / 5) * 5 + ' fps' : '');
  const key = JSON.stringify([sc.state, sc.title, sc.body, sc.kind, sc.hint, sc.value, sc.selected, sc.paused, sc.canContinue, sc.locked, sc.layout, sc.progress == null ? null : Math.round(sc.progress * 30), corner]);
  if (key === run.lastDrawKey) return;
  run.lastDrawKey = key;
  if (run.mode === 'xr') {
    view.setScreen(sc, { corner });
  } else {
    drawScreen(run.previewCtx, sc, { corner });
    $('previewText').textContent = [sc.kicker, sc.title].concat(sc.body || []).concat(sc.options || []).concat(sc.hint ? [sc.hint.replace(/\s{2,}/g, '  |  ')] : []).filter(Boolean).join('\n');
  }
}

function onInput(kind, value) {
  if (!run) return;
  if (kind === 'grounding') { send('grounding'); return; } // never locked out, never delayed
  if (kind === 'primary' || kind === 'secondary') {
    if (performance.now() - run.lastChangeAt < 250) return; // ignore a bounce right after a screen change
    send(kind);
    return;
  }
  const sc = run.machine.screen(clockNow());
  if (kind === 'step') send('move', { dir: value });
  else if (kind === 'stickX' && sc.kind === 'rating') send('move', { dir: value });
  else if (kind === 'stickY' && sc.kind === 'choice') send('move', { dir: value });
}

function monitorFrameRate(dt) {
  const f = run.fps;
  if (!view.visible || run.machine.paused) {
    f.dts = [];
    f.sum = 0;
    f.since = performance.now();
    return;
  }
  if (!(dt > 0) || dt > 1000) return;
  f.frames += 1;
  f.timeMs += dt;
  if (f.reported == null && view.frameRate) f.reported = view.frameRate; // the Quest browser may not report a rate at the start
  f.dts.push(dt);
  f.sum += dt;
  while (f.dts.length > 1 && f.sum - f.dts[0] >= config.frameRateWindowMs) f.sum -= f.dts.shift();
  f.value = (1000 * f.dts.length) / f.sum;
  const settled = performance.now() - f.since >= config.frameRateWindowMs + 1500 && f.sum >= config.frameRateWindowMs * 0.95;
  if (settled && (f.lowest == null || f.value < f.lowest)) f.lowest = f.value;
  // Re-arms after 10 s, so a slow spell during check-in cannot hide a later one mid-exercise.
  if (settled && !f.off && f.value < f.floor && performance.now() - f.faultedAt > 10000) {
    f.faultedAt = performance.now();
    send('fault', { kind: 'frame-rate', detail: Math.round(f.value) + ' fps' });
  }
}

function onFrame(dt) {
  if (!run || run.mode !== 'xr') return;
  monitorFrameRate(dt);
  send('tick');
  stimFrame(dt);
}

function onVisibility(state) {
  if (!run) return;
  if (state === 'visible') { run.fps.dts = []; run.fps.sum = 0; run.fps.since = performance.now(); }
  audio.setHidden(state !== 'visible'); // no sound while the user cannot see the session
  send('visibility', { state });
}

/** The logic itself failed. Get the user to the real room and out. */
function emergency(e) {
  problem('internal error: ' + errText(e));
  audio.allOff();
  const r = run;
  if (!r) return;
  try { r.setVisual({ kind: 'none' }); } catch (err) { /* ignore */ }
  try { r.machine.abort(clockNow(), 'internal error: ' + errText(e)); } catch (err) { /* nothing more to do */ }
  try { persist(); } catch (err) { /* ignore */ }
  try { r.fade(0, 500); } catch (err) { /* ignore */ }
  const sc = { state: 'error', kicker: 'Stopped', title: 'Something went wrong', body: ['Take the headset off.', 'The session has ended and what was recorded is saved.'], kind: 'read', hint: '', tone: 'warn', progress: null, showGroundingHint: false };
  try {
    if (r.mode === 'xr') view.setScreen(sc, {});
    else drawScreen(r.previewCtx, sc, {});
  } catch (err) { /* ignore */ }
  setTimeout(() => { if (run === r) r.leave(); }, 5000);
}

/**
 * Frame rate for the record. "average" covers every frame drawn while the session was
 * visible; "lowest" is the lowest 2-second average, the same figure the monitor judges.
 */
function frameRateSummary(r) {
  const f = r.fps;
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    reported: f.reported || null,
    average: f.timeMs > 0 ? r1((1000 * f.frames) / f.timeMs) : null,
    lowest: f.lowest == null ? null : r1(f.lowest),
    floor: r1(f.floor),
    measuredSeconds: Math.round(f.timeMs / 1000),
  };
}

function withDevice(rec) {
  rec.app = VERSION;
  if (run.info) rec.device = { ...run.info, frameRate: run.fps.reported || run.info.frameRate || null };
  rec.settings = { scene: config.scene, renderScale: config.renderScale, sceneSound: config.sceneSound, lakePhoto: !!pageEnv.lakePhoto, setsInCalmPlace: run.machine.setsInCalmPlace };
  if (run.mode === 'xr') rec.frameRate = frameRateSummary(run);
  return rec;
}

function persist() {
  if (!run) return;
  const rec = withDevice(clone(run.machine.record));
  if (run.mode === 'preview') { lastPreview = rec; return; }
  run.saved = true;
  const i = history.findIndex((r) => r.id === rec.id);
  if (i >= 0) history[i] = rec; else history.push(rec);
  store.saveSession(rec).then(() => store.del('current')).catch((e) => problem('save failed: ' + errText(e)));
}

function snapshot() {
  if (!run || run.mode !== 'xr' || run.saved) return;
  const rec = withDevice(clone(run.machine.record));
  store.set('current', rec).catch(() => {});
}

function finishRun() {
  const r = run;
  if (!r) return;
  if (r.machine.state !== S.ENDED) {
    try { r.machine.abort(clockNow(), r.mode === 'xr' ? 'headset session closed' : 'preview stopped'); } catch (e) { problem('abort failed: ' + errText(e)); }
  }
  audio.allOff();
  audio.setHidden(false);
  try { r.setVisual({ kind: 'none' }); } catch (e) { /* ignore */ }
  for (const e of r.machine.drainEffects()) {
    if (e.type === 'save') persist();
    else if (e.type === 'stim' && !e.on) stimStop();
  }
  if (r.mode === 'xr' && r.saved) persist(); // write the final details of a record already saved
  run = null;
  clearInterval(previewTimer);
  clearInterval(backupTimer);
  previewTimer = null;
  backupTimer = null;
  renderAll();
  try { $('logSection').scrollIntoView(); } catch (e) { /* ignore */ }
}

function newRun(mode, machine, extra) {
  return {
    mode,
    machine,
    clock: null,
    lastState: machine.state,
    lastChangeAt: performance.now() - 1000,
    lastDrawAt: 0,
    lastDrawKey: '',
    saved: false,
    info: null,
    fps: { dts: [], sum: 0, value: 0, since: performance.now(), faultedAt: -1e9, floor: config.frameRateFloor, off: false, frames: 0, timeMs: 0, lowest: null, reported: null },
    stallFaulted: false,
    stim: { key: -1, nextTone: 0, nextPulse: 0, tones: 0, toneLateMax: 0, pulses: 0, frameGapMax: 0 },
    setVisual: () => {},
    pulse: null,
    ...extra,
  };
}

async function startXr() {
  if (run) return;
  const e = eligibility({ config, history, now: Date.now() });
  if (!e.canStart || !onboarded) return;
  audio.unlock(); // inside the button press, so the browser allows sound
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['local-floor'] });
  } catch (err) {
    $('startNote').textContent = 'Could not start: ' + errText(err);
    return;
  }
  try {
    if (!view) view = createXrView({ onInput, onFrame, onVisibility, onEnd: finishRun, onProblem: problem });
    const info = await view.begin(session, { scene: config.scene, renderScale: config.renderScale, lakePhotoUrl: pageEnv.lakePhoto ? LAKE_PHOTO : null });
    const machine = createSession({ config, now: Date.now(), profile: e.profile, setsLocked: e.setsLocked });
    run = newRun('xr', machine, { fade: (to, ms) => view.fadeTo(to, ms), leave: () => view.end(), setVisual: (v) => view.setVisual(v), pulse: (side, strength, ms) => view.pulse(side, strength, ms) });
    run.info = { ...info, renderScale: config.renderScale };
    if (info.frameRate) { run.fps.reported = info.frameRate; run.fps.floor = Math.min(config.frameRateFloor, info.frameRate * 0.9 - 1); }
    if (window.__SHELL_TEST_NO_FRAME_RATE_FAULT) {
      // Only the emulator tests set this: software rendering runs at a few frames a second.
      run.fps.off = true;
      problem('frame-rate monitor switched off by a test hook');
    }
    snapshot();
    redraw(true);
    renderAll();
    // Backup clock: keeps the session moving, and notices, if headset frames stop arriving.
    backupTimer = setInterval(() => {
      if (!run || run.mode !== 'xr') return;
      const stalled = view.msSinceFrame();
      if (stalled > 500) send('tick');
      if (run && !run.fps.off && view.visible && !run.machine.paused && stalled > 2000 && !run.stallFaulted) {
        run.stallFaulted = true;
        send('fault', { kind: 'frames-stopped', detail: Math.round(stalled) + ' ms without a frame' });
      }
    }, 250);
    $('startNote').textContent = '';
  } catch (err) {
    problem('session setup failed: ' + errText(err));
    $('startNote').textContent = 'Could not set up the session: ' + errText(err);
    run = null;
    try { await session.end(); } catch (e2) { /* ignore */ }
  }
}

function previewFade(to, ms) {
  const el = $('previewScene');
  const speed = run && run.speed ? run.speed : 1;
  el.style.transitionDuration = Math.max(50, ms / speed) + 'ms';
  el.style.opacity = String(to);
}

function previewVisual(v) {
  const el = $('previewLight');
  if (!v || v.kind === 'none') { el.style.opacity = '0'; return; }
  el.style.opacity = String(Math.min(1, v.alpha));
  if (v.kind === 'sweep') {
    const half = ($('previewLightRow').clientWidth || 600) / 2 - 40;
    el.style.transform = `translateX(${(v.x * (v.deg / 30) * half).toFixed(1)}px) scale(1)`;
  } else {
    el.style.transform = `translateX(0px) scale(${(0.6 + 0.9 * v.level).toFixed(3)})`;
  }
}

function startPreview() {
  if (run) return;
  audio.unlock();
  const e = eligibility({ config, history, now: Date.now() });
  const speed = $('fast').checked ? 10 : 1;
  const base = Date.now();
  const p0 = performance.now();
  const clock = () => base + (performance.now() - p0) * speed;
  const machine = createSession({ config, now: clock(), profile: e.profile, setsLocked: e.setsLocked });
  const canvas = $('previewPanel');
  $('previewScene').className = config.scene;
  canvas.width = PANEL_W;
  canvas.height = PANEL_H;
  $('previewWrap').hidden = false;
  $('previewScene').style.transitionDuration = '0ms';
  $('previewScene').style.opacity = '0';
  run = newRun('preview', machine, { fade: previewFade, leave: finishRun, speed, previewCtx: canvas.getContext('2d'), setVisual: previewVisual });
  run.clock = clock;
  redraw(true);
  renderAll();
  previewTimer = setInterval(() => send('tick'), 100);
  // The light and the tone run on their own, faster loop, as they do on headset frames.
  const mine = run;
  let lastLoop = performance.now();
  const loop = () => {
    if (run !== mine) return;
    const t = performance.now();
    stimFrame((t - lastLoop) * speed);
    lastLoop = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try { $('previewWrap').scrollIntoView(); } catch (err) { /* ignore */ }
}

/* ------------------------------------------------------------------ page rendering */

const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const routeText = (r) => (r.route === 'full' && r.exercise ? 'Session: ' + (EXERCISE_NAMES[r.exercise] || r.exercise) : (ROUTES[r.route] || r.route || 'no route'));
const ROUTES = { 'full': 'Full session, ended before an exercise', 'grounding-only': 'Grounding only', 'crisis-card': 'Crisis card', 'not-today': 'Not today', 'ended-in-check-in': 'Left during check-in' };
const TRIGGERS = { 'grounding-button': 'grounding button', 'upsetting': 'something upsetting', 'worse-twice': 'worse twice', 'closing-distress': 'high closing distress', 'body-check': 'body check', 'crisis': 'crisis card', 'headset-off': 'headset off' };
const trig = (t) => TRIGGERS[t] || String(t).replace('fault:', 'fault: ');

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function describeFlags(r) {
  const set = Array.from(new Set((r.flags || []).map((f) => trig(f.trigger))));
  return set.join(', ');
}

function renderBanner(e) {
  const box = $('banner');
  box.textContent = '';
  box.hidden = true;
  const add = (node) => { box.appendChild(node); box.hidden = false; };
  if (e.reason === 'needs-answer') {
    const r = history.find((x) => x.id === e.pendingAnswer);
    const what = r && r.flags && r.flags.length ? 'was flagged (' + describeFlags(r) + ')' : 'ended before closure';
    add(el('p', `The session at ${r ? fmtTime(r.startedAt) : 'an earlier time'} ${what}. Was that real, or a test of the app?`, 'strong'));
    add(el('p', 'A real stop pauses the app for 4 hours. A test does not.'));
    const row = el('div', null, 'row');
    const real = el('button', 'It was real');
    const testBtn = el('button', 'It was a test');
    real.addEventListener('click', () => answerPending(e.pendingAnswer, true));
    testBtn.addEventListener('click', () => answerPending(e.pendingAnswer, false));
    row.appendChild(real);
    row.appendChild(testBtn);
    add(row);
  } else if (e.reason === 'pause') {
    add(el('p', `Next session after ${fmtClock(e.until)}. ${e.message}`, 'strong'));
  } else if (e.reason) {
    add(el('p', `${e.message}${e.until ? ' Next session after ' + fmtTime(e.until) + '.' : ''}`, 'strong'));
  }
  for (const n of e.notices) add(el('p', n.message));
}

async function answerPending(id, real) {
  const r = history.find((x) => x.id === id);
  if (!r) return;
  r.real = real;
  r.answeredOnPage = true;
  try { await store.saveSession(r); } catch (err) { problem('save failed: ' + errText(err)); }
  renderAll();
}

function renderStatus(e) {
  const xr = pageEnv.immersiveAr;
  const start = $('btnStart');
  start.disabled = !!run || !onboarded || !e.canStart || !xr;
  $('btnPreview').disabled = !!run;
  let note = '';
  if (!onboarded) note = 'Finish the first-time questions below before starting.';
  else if (!pageEnv.checked) note = 'Checking this browser…';
  else if (!xr) note = pageEnv.note;
  else if (run) note = run.mode === 'xr' ? 'A session is running in the headset.' : 'A preview is running below.';
  else if (e.canStart) note = 'You can start a session.';
  $('envNote').textContent = note;
  const parts = [`Profile: ${e.profile === 'testing' ? 'testing (no daily limit)' : 'final limits'}`, `Session length: ${config.sessionMinutes} minutes`];
  parts.push(e.setsLocked ? `Bilateral sets: locked (${e.lockReason})` : (config.sets.enabled ? 'Bilateral sets: on in calm place' : 'Bilateral sets: locked in calm place until the therapist walkthrough'));
  parts.push(store && store.persistent ? 'Log: saved on this device' : 'Log: not saved (this browser refused storage)');
  $('statusLine').textContent = parts.join(' · ');
}

function renderLog() {
  const body = $('logRows');
  body.textContent = '';
  const rows = history.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
  $('logEmpty').hidden = rows.length > 0;
  $('logTable').hidden = rows.length === 0;
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', fmtTime(r.startedAt)));
    const mins = r.endedAt ? Math.max(0, (r.endedAt - r.startedAt) / 60000) : 0;
    tr.appendChild(el('td', mins >= 1 ? mins.toFixed(1) + ' min' : Math.round(mins * 60) + ' s'));
    tr.appendChild(el('td', routeText(r)));
    const d0 = r.baseline && r.baseline.distress;
    const d1 = r.closing && r.closing.distress;
    tr.appendChild(el('td', (d0 === undefined ? '–' : d0) + ' → ' + (d1 === undefined ? '–' : d1)));
    const c0 = r.baseline && r.baseline.calm;
    const c1 = r.closing && r.closing.calm;
    tr.appendChild(el('td', (c0 === undefined ? '–' : c0) + ' → ' + (c1 === undefined ? '–' : c1)));
    const flags = describeFlags(r);
    const notes = [];
    if (flags) notes.push('Flagged: ' + flags + (r.real === false ? ' (test)' : r.real === true ? ' (real)' : ' (unanswered)'));
    if (r.stop && !flags) notes.push('Stopped: ' + trig(r.stop.trigger));
    if (r.setsRun) notes.push(r.setsRun + (r.setsRun === 1 ? ' set' : ' sets'));
    if (r.faults && r.faults.length) notes.push('Faults: ' + r.faults.map((f) => f.kind).join(', '));
    if (!r.completed) notes.push('Ended early' + (r.endedEarly ? ': ' + r.endedEarly : ''));
    tr.appendChild(el('td', notes.join('. ') || 'Nothing flagged'));
    body.appendChild(tr);
  }
  const prev = $('previewResult');
  if (lastPreview) {
    prev.hidden = false;
    const flags = describeFlags(lastPreview);
    prev.textContent = `Last preview (not saved to the log): ${routeText(lastPreview)}; ${flags ? 'flagged: ' + flags : 'nothing flagged'}; ${lastPreview.completed ? 'completed' : 'stopped early'}.`;
  } else {
    prev.hidden = true;
  }
}

function renderOnboarding() {
  $('onboarding').hidden = onboarded;
}

function renderSettings(e) {
  const busy = !!run;
  for (const id of ['setScene', 'setCue', 'setScale', 'setSound']) $(id).disabled = busy;
  if (document.activeElement !== $('setCue')) $('setCue').value = config.cueWord;
  $('setScene').value = config.scene;
  $('setScale').value = String(config.renderScale);
  $('setSound').checked = config.sceneSound;
  $('lakeNote').textContent = config.scene === 'lake' ? (pageEnv.lakePhoto ? 'Lakeshore: using the 360° photo in assets/lakeshore.jpg.' : 'Lakeshore: painted stand-in. Add a licensed 360° photo as assets/lakeshore.jpg to replace it.') : '';
  $('setsNote').textContent = e.setsLocked
    ? `Bilateral sets and the engine test are locked: ${e.lockReason}.`
    : `Bilateral sets: ${config.sets.speed} passes a second, ${config.sets.passes} passes, up to ${config.sets.perSession} sets, light and tone. ${config.sets.enabled ? 'On in calm place.' : 'Locked in calm place; the engine test is available while testing.'}`;
}

async function saveSettings() {
  if (run) return;
  settings = { scene: $('setScene').value, cueWord: $('setCue').value, renderScale: Number($('setScale').value), sceneSound: $('setSound').checked };
  config = normalizeConfig(settings);
  settings = { scene: config.scene, cueWord: config.cueWord, renderScale: config.renderScale, sceneSound: config.sceneSound };
  try { await store.set('settings', settings); $('setNote').textContent = 'Saved.'; } catch (e) { problem('save failed: ' + errText(e)); }
  renderAll();
}

function renderAll() {
  const e = eligibility({ config, history, now: Date.now() });
  renderBanner(e);
  renderStatus(e);
  renderSettings(e);
  renderLog();
  renderOnboarding();
}

/* ------------------------------------------------------------------ exports */

function download(name, text, type) {
  try {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('exportNote').textContent = 'Saved as ' + name + '. Check the Downloads list.';
  } catch (e) {
    $('exportNote').textContent = 'Download was refused: ' + errText(e);
  }
}

function csv() {
  const cols = ['id', 'started', 'minutes', 'profile', 'route', 'checkin_distress', 'checkin_unreal', 'baseline_calm', 'closing_distress', 'closing_calm', 'rounds', 'round_answers', 'sets_ended', 'stop', 'flags', 'real_or_test', 'body_check_positive', 'faults', 'completed', 'ended_early', 'fps_average', 'fps_lowest', 'exercise', 'scene', 'sets_run', 'set_seconds', 'tone_late_max_ms', 'frame_gap_max_ms', 'render_scale'];
  const q = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(',')];
  for (const r of history) {
    lines.push([
      r.id, new Date(r.startedAt).toISOString(), r.endedAt ? ((r.endedAt - r.startedAt) / 60000).toFixed(2) : '', r.profile, r.route,
      r.checkin && r.checkin.distress, r.checkin && r.checkin.unreal, r.baseline && r.baseline.calm, r.closing && r.closing.distress, r.closing && r.closing.calm,
      (r.rounds || []).length, (r.rounds || []).map((x) => x.answer || '').join(' '), r.setsEnded, r.stop && r.stop.trigger,
      (r.flags || []).map((f) => f.trigger).join(' '), r.real === true ? 'real' : r.real === false ? 'test' : '', r.body && r.body.positive,
      (r.faults || []).map((f) => f.kind).join(' '), r.completed, r.endedEarly,
      r.frameRate && r.frameRate.average, r.frameRate && r.frameRate.lowest,
      r.exercise, r.scene, r.setsRun,
      (r.rounds || []).filter((x) => x.set).map((x) => (x.set.ranMs / 1000).toFixed(1)).join(' '),
      (r.rounds || []).filter((x) => x.set && x.set.sync).reduce((a, x) => Math.max(a, x.set.sync.toneLateMaxMs), 0) || '',
      (r.rounds || []).filter((x) => x.set && x.set.sync).reduce((a, x) => Math.max(a, x.set.sync.frameGapMaxMs), 0) || '',
      r.settings && r.settings.renderScale,
    ].map(q).join(','));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ boot */

const pageEnv = { checked: false, immersiveAr: false, note: '', lakePhoto: false };

async function checkEnv() {
  let framed = false;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  if (!window.isSecureContext) pageEnv.note = 'The headset session needs this page on https.';
  else if (!navigator.xr) pageEnv.note = 'This browser has no WebXR. Open this page in the Quest browser, or use the preview here.';
  else {
    try { pageEnv.immersiveAr = await Promise.race([navigator.xr.isSessionSupported('immersive-ar'), new Promise((r) => setTimeout(() => r(false), 3000))]); } catch (e) { pageEnv.immersiveAr = false; }
    if (!pageEnv.immersiveAr) pageEnv.note = framed ? 'This page is inside a frame that blocks VR. Open it at its own address.' : 'This browser does not offer passthrough sessions. Use the preview here.';
  }
  pageEnv.checked = true;
  // Is there a 360° photo for the lakeshore? Never waited on for more than 3 seconds.
  try {
    const res = await Promise.race([fetch(LAKE_PHOTO, { method: 'HEAD' }), new Promise((r) => setTimeout(() => r(null), 3000))]);
    pageEnv.lakePhoto = !!(res && res.ok && /image/.test(res.headers.get('content-type') || ''));
  } catch (e) { pageEnv.lakePhoto = false; }
}

function wire() {
  $('btnStart').addEventListener('click', startXr);
  $('btnPreview').addEventListener('click', startPreview);
  $('btnStopPreview').addEventListener('click', () => { if (run && run.mode === 'preview') finishRun(); });

  document.querySelectorAll('[data-in]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!run || run.mode !== 'preview') return;
      const k = b.getAttribute('data-in');
      if (k === 'primary' || k === 'secondary' || k === 'grounding') onInput(k);
      else if (k === 'up') send('move', { dir: -1 });
      else if (k === 'down') send('move', { dir: 1 });
      else if (k === 'menu') { onVisibility('visible-blurred'); setTimeout(() => onVisibility('visible'), 3000); }
      else if (k === 'off') { onVisibility('visible-blurred'); onVisibility('hidden'); setTimeout(() => onVisibility('visible'), 3000); }
      else if (k === 'fault') send('fault', { kind: 'frame-rate', detail: 'simulated' });
    });
  });
  window.addEventListener('keydown', (ev) => {
    if (!run || run.mode !== 'preview') return;
    const k = ev.key;
    if (k === 'Enter' || k === ' ') { ev.preventDefault(); onInput('primary'); }
    else if (k === 'n' || k === 'Backspace') onInput('secondary');
    else if (k === 'ArrowRight' || k === 'ArrowDown') { ev.preventDefault(); send('move', { dir: 1 }); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { ev.preventDefault(); send('move', { dir: -1 }); }
    else if (k === 'b' || k === 'y') onInput('grounding');
  });

  // first-time questions
  const ob = { seizure: null, cleared: null };
  const refreshOb = () => {
    $('obCleared').hidden = ob.seizure !== true;
    $('obBlocked').hidden = !(ob.seizure === true && ob.cleared === false);
    const okMedical = ob.seizure === false || (ob.seizure === true && ob.cleared === true);
    $('obAcks').hidden = !okMedical;
    const all = ['ack1', 'ack2', 'ack3'].every((id) => $(id).checked);
    $('btnOnboard').disabled = !(okMedical && all);
  };
  const pick = (group, value, yesId, noId) => {
    ob[group] = value;
    $(yesId).classList.toggle('on', value === true);
    $(noId).classList.toggle('on', value === false);
    refreshOb();
  };
  $('obSeizureYes').addEventListener('click', () => pick('seizure', true, 'obSeizureYes', 'obSeizureNo'));
  $('obSeizureNo').addEventListener('click', () => pick('seizure', false, 'obSeizureYes', 'obSeizureNo'));
  $('obClearedYes').addEventListener('click', () => pick('cleared', true, 'obClearedYes', 'obClearedNo'));
  $('obClearedNo').addEventListener('click', () => pick('cleared', false, 'obClearedYes', 'obClearedNo'));
  ['ack1', 'ack2', 'ack3'].forEach((id) => $(id).addEventListener('change', refreshOb));
  $('btnOnboard').addEventListener('click', async () => {
    onboarded = true;
    // Only the fact that the questions were passed is kept, not the answers.
    try { await store.set('onboarded', { at: Date.now() }); } catch (e) { problem('save failed: ' + errText(e)); }
    renderAll();
  });

  $('versionText').textContent = VERSION;
  for (const id of ['setScene', 'setScale', 'setSound']) $(id).addEventListener('change', saveSettings);
  $('setCue').addEventListener('change', saveSettings);
  $('setCue').addEventListener('input', () => { $('setNote').textContent = ''; });
  $('btnJson').addEventListener('click', () => download('session-log.json', JSON.stringify({ app: VERSION, exportedAt: new Date().toISOString(), config: { profile: config.profile, sessionMinutes: config.sessionMinutes, distressBlock: config.distressBlock, flagRise: config.flagRise, scene: config.scene, renderScale: config.renderScale, sets: config.sets, breathing: config.breathing, rounds: config.rounds, roundSeconds: config.roundSeconds }, sessions: history }, null, 1), 'application/json'));
  $('btnCsv').addEventListener('click', () => download('session-log.csv', csv(), 'text/csv'));
  $('btnClear').addEventListener('click', () => { $('clearConfirm').hidden = false; });
  $('btnClearNo').addEventListener('click', () => { $('clearConfirm').hidden = true; });
  $('btnClearYes').addEventListener('click', async () => {
    if (run) return;
    await store.clearSessions();
    history = [];
    $('clearConfirm').hidden = true;
    $('exportNote').textContent = 'The log is cleared.';
    renderAll();
  });
}

async function boot() {
  window.addEventListener('error', (ev) => problem('page error: ' + (ev.message || 'unknown')));
  window.addEventListener('unhandledrejection', (ev) => problem('unhandled: ' + errText(ev.reason)));
  wire();
  store = await createStore();
  try {
    // A session that was running when the browser closed or crashed left a snapshot behind.
    const cur = await store.get('current');
    if (cur && cur.id) {
      cur.completed = false;
      cur.endedEarly = cur.endedEarly || 'browser closed or crashed';
      const last = cur.steps && cur.steps.length ? cur.steps[cur.steps.length - 1] : null;
      cur.endedAt = cur.endedAt || (last ? last.at + last.ms : cur.startedAt);
      if (!cur.route) cur.route = 'ended-in-check-in';
      await store.saveSession(cur);
      await store.del('current');
    }
    history = await store.sessions();
    onboarded = !!(await store.get('onboarded'));
    const saved = await store.get('settings');
    if (saved && typeof saved === 'object') {
      // Only these four are read back. Limits and the lock on sets are not stored here.
      settings = { scene: saved.scene, cueWord: saved.cueWord, renderScale: saved.renderScale, sceneSound: saved.sceneSound };
      config = normalizeConfig(settings);
    }
  } catch (e) {
    problem('could not read saved data: ' + errText(e));
  }
  renderAll();
  await checkEnv();
  renderAll();
  store.requestPersistence().then((r) => { $('storageNote').textContent = 'Keep-this-data request: ' + r + '.'; });
  setInterval(() => { if (!run) renderAll(); }, 30000); // keeps "next session after…" current
  window.__shell = {
    state: () => (run ? run.machine.state : null),
    screen: () => (run ? run.machine.screen(clockNow()) : null),
    record: () => (run ? run.machine.record : null),
    history: () => history,
    running: () => !!run,
    problems: () => problems.slice(),
    eligibility: () => eligibility({ config, history, now: Date.now() }),
    visual: () => (run ? run.machine.visual(clockNow()) : null),
    stimulus: () => (run ? run.machine.stimulus() : null),
    stim: () => (run ? { ...run.stim } : null),
    config: () => config,
    audio: () => ({ running: audio.running, ambient: audio.ambient, latencyMs: audio.latencyMs() }),
  };
  // Emulator tests may switch sets on inside calm place for one page load. Nothing is stored,
  // and the page says so for as long as it is in force.
  if (window.__SHELL_TEST_SETS_ON) {
    window.__shell.setsOn = () => { config = normalizeConfig({ ...settings, sets: { enabled: true } }); problem('bilateral sets switched on in calm place by a test hook'); renderAll(); };
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
