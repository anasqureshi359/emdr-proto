// Page wiring for the safety shell: start and run a session (in the headset or as an
// on-screen preview), keep the log, and enforce the start rules.

import { createSession, S } from './core/machine.js';
import { normalizeConfig } from './core/config.js';
import { eligibility, needsAnswer } from './core/eligibility.js';
import { createStore } from './store.js';
import { createXrView } from './xr.js';
import { PANEL_W, PANEL_H, drawScreen } from './panel.js';

const VERSION = 'safety-shell 0.1';
const $ = (id) => document.getElementById(id);
const errText = (e) => String((e && e.message) || e);
const clone = (x) => JSON.parse(JSON.stringify(x));

let store = null;
let history = [];
let config = normalizeConfig({});
let onboarded = false;
let run = null;
let lastPreview = null;
let view = null;
let previewTimer = null;
let backupTimer = null;
const problems = [];

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
    if (e.type === 'fade') run.fade(e.to, e.ms);
    else if (e.type === 'save') persist();
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

function redraw(force) {
  if (!run) return;
  const t = performance.now();
  if (!force && t - run.lastDrawAt < 120) return;
  run.lastDrawAt = t;
  const sc = run.machine.screen(clockNow());
  const corner = run.mode === 'preview' ? 'preview' : (run.fps.value ? Math.round(run.fps.value / 5) * 5 + ' fps' : '');
  const key = JSON.stringify([sc.state, sc.title, sc.body, sc.kind, sc.hint, sc.value, sc.selected, sc.paused, sc.canContinue, sc.progress == null ? null : Math.round(sc.progress * 30), corner]);
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
  f.dts.push(dt);
  f.sum += dt;
  while (f.dts.length > 1 && f.sum - f.dts[0] >= config.frameRateWindowMs) f.sum -= f.dts.shift();
  f.value = (1000 * f.dts.length) / f.sum;
  const settled = performance.now() - f.since >= config.frameRateWindowMs + 1500 && f.sum >= config.frameRateWindowMs * 0.95;
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
}

function onVisibility(state) {
  if (!run) return;
  if (state === 'visible') { run.fps.dts = []; run.fps.sum = 0; run.fps.since = performance.now(); }
  send('visibility', { state });
}

/** The logic itself failed. Get the user to the real room and out. */
function emergency(e) {
  problem('internal error: ' + errText(e));
  const r = run;
  if (!r) return;
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

function persist() {
  if (!run) return;
  const rec = clone(run.machine.record);
  rec.app = VERSION;
  if (run.info) rec.device = run.info;
  if (run.mode === 'preview') { lastPreview = rec; return; }
  run.saved = true;
  const i = history.findIndex((r) => r.id === rec.id);
  if (i >= 0) history[i] = rec; else history.push(rec);
  store.saveSession(rec).then(() => store.del('current')).catch((e) => problem('save failed: ' + errText(e)));
}

function snapshot() {
  if (!run || run.mode !== 'xr' || run.saved) return;
  const rec = clone(run.machine.record);
  rec.app = VERSION;
  store.set('current', rec).catch(() => {});
}

function finishRun() {
  const r = run;
  if (!r) return;
  if (r.machine.state !== S.ENDED) {
    try { r.machine.abort(clockNow(), r.mode === 'xr' ? 'headset session closed' : 'preview stopped'); } catch (e) { problem('abort failed: ' + errText(e)); }
  }
  for (const e of r.machine.drainEffects()) if (e.type === 'save') persist();
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
    fps: { dts: [], sum: 0, value: 0, since: performance.now(), faultedAt: -1e9, floor: config.frameRateFloor, off: false },
    stallFaulted: false,
    ...extra,
  };
}

async function startXr() {
  if (run) return;
  const e = eligibility({ config, history, now: Date.now() });
  if (!e.canStart || !onboarded) return;
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['local-floor'] });
  } catch (err) {
    $('startNote').textContent = 'Could not start: ' + errText(err);
    return;
  }
  try {
    if (!view) view = createXrView({ onInput, onFrame, onVisibility, onEnd: finishRun, onProblem: problem });
    const info = await view.begin(session);
    const machine = createSession({ config, now: Date.now(), profile: e.profile });
    run = newRun('xr', machine, { fade: (to, ms) => view.fadeTo(to, ms), leave: () => view.end() });
    run.info = info;
    if (info.frameRate) run.fps.floor = Math.min(config.frameRateFloor, info.frameRate * 0.9 - 1);
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

function startPreview() {
  if (run) return;
  const e = eligibility({ config, history, now: Date.now() });
  const speed = $('fast').checked ? 10 : 1;
  const base = Date.now();
  const p0 = performance.now();
  const clock = () => base + (performance.now() - p0) * speed;
  const machine = createSession({ config, now: clock(), profile: e.profile });
  const canvas = $('previewPanel');
  canvas.width = PANEL_W;
  canvas.height = PANEL_H;
  $('previewWrap').hidden = false;
  $('previewScene').style.transitionDuration = '0ms';
  $('previewScene').style.opacity = '0';
  run = newRun('preview', machine, { fade: previewFade, leave: finishRun, speed, previewCtx: canvas.getContext('2d') });
  run.clock = clock;
  redraw(true);
  renderAll();
  previewTimer = setInterval(() => send('tick'), 100);
  try { $('previewWrap').scrollIntoView(); } catch (err) { /* ignore */ }
}

/* ------------------------------------------------------------------ page rendering */

const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ROUTES = { 'full': 'Full session', 'grounding-only': 'Grounding only', 'crisis-card': 'Crisis card', 'not-today': 'Not today', 'ended-in-check-in': 'Left during check-in' };
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
  parts.push(e.setsLocked ? `Bilateral sets: locked (${e.lockReason})` : 'Bilateral sets: not in this build');
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
    tr.appendChild(el('td', ROUTES[r.route] || r.route || ''));
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
    if (r.faults && r.faults.length) notes.push('Faults: ' + r.faults.map((f) => f.kind).join(', '));
    if (!r.completed) notes.push('Ended early' + (r.endedEarly ? ': ' + r.endedEarly : ''));
    tr.appendChild(el('td', notes.join('. ') || 'Nothing flagged'));
    body.appendChild(tr);
  }
  const prev = $('previewResult');
  if (lastPreview) {
    prev.hidden = false;
    const flags = describeFlags(lastPreview);
    prev.textContent = `Last preview (not saved to the log): ${ROUTES[lastPreview.route] || lastPreview.route || 'no route'}; ${flags ? 'flagged: ' + flags : 'nothing flagged'}; ${lastPreview.completed ? 'completed' : 'stopped early'}.`;
  } else {
    prev.hidden = true;
  }
}

function renderOnboarding() {
  $('onboarding').hidden = onboarded;
}

function renderAll() {
  const e = eligibility({ config, history, now: Date.now() });
  renderBanner(e);
  renderStatus(e);
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
  const cols = ['id', 'started', 'minutes', 'profile', 'route', 'checkin_distress', 'checkin_unreal', 'baseline_calm', 'closing_distress', 'closing_calm', 'rounds', 'round_answers', 'sets_ended', 'stop', 'flags', 'real_or_test', 'body_check_positive', 'faults', 'completed', 'ended_early'];
  const q = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(',')];
  for (const r of history) {
    lines.push([
      r.id, new Date(r.startedAt).toISOString(), r.endedAt ? ((r.endedAt - r.startedAt) / 60000).toFixed(2) : '', r.profile, r.route,
      r.checkin && r.checkin.distress, r.checkin && r.checkin.unreal, r.baseline && r.baseline.calm, r.closing && r.closing.distress, r.closing && r.closing.calm,
      (r.rounds || []).length, (r.rounds || []).map((x) => x.answer || '').join(' '), r.setsEnded, r.stop && r.stop.trigger,
      (r.flags || []).map((f) => f.trigger).join(' '), r.real === true ? 'real' : r.real === false ? 'test' : '', r.body && r.body.positive,
      (r.faults || []).map((f) => f.kind).join(' '), r.completed, r.endedEarly,
    ].map(q).join(','));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ boot */

const pageEnv = { checked: false, immersiveAr: false, note: '' };

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

  $('btnJson').addEventListener('click', () => download('session-log.json', JSON.stringify({ app: VERSION, exportedAt: new Date().toISOString(), config: { profile: config.profile, sessionMinutes: config.sessionMinutes, distressBlock: config.distressBlock, flagRise: config.flagRise }, sessions: history }, null, 1), 'application/json'));
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
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
