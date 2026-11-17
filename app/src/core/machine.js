// The session state machine. Pure logic: no headset, no page, no timers of its own.
// Time comes in with every event, so the same code runs in the app and in the tests.
//
// Events in:  primary (trigger), secondary (grip), move, grounding (B or Y),
//             tick, visibility, fault.
// Effects out: fade (scene in or out), stim (bilateral stimulation on or off),
//              save (write the record), end (leave VR).
//
// No state waits on an outside reply. Timed states move on by the clock alone.

import { normalizeConfig, effectiveSet, HARD } from './config.js';
import { SCRIPT } from './scripts.js';

export const S = Object.freeze({
  CHECK_CRISIS: 'checkin.crisis',
  CHECK_DISTRESS: 'checkin.distress',
  CHECK_UNREAL: 'checkin.unreal',
  CHECK_UNWELL: 'checkin.unwell',
  CRISIS: 'crisis-card',
  NOT_TODAY: 'not-today',
  MENU: 'menu',
  SCENE_IN: 'scene-in',
  BASE_CALM: 'baseline.calm',
  BREATHE: 'breathing.active',
  CP_INVITE: 'calm.invite',
  CP_SENSE: 'calm.sense',
  CP_CUE: 'calm.cue',
  ROUND: 'round.active',
  SET: 'set.active',
  SET_REST: 'set.rest',
  ROUND_CHECK: 'round.check',
  CP_ANNOY: 'calm.annoyance',
  CP_END: 'calm.end',
  BENCH_INTRO: 'bench.intro',
  TO_ROOM: 'to-room',
  GROUND: 'grounding.step',
  REORIENT: 'closure.reorient',
  CLOSE_DISTRESS: 'closure.distress',
  CLOSE_CALM: 'closure.calm',
  CONTACT: 'closure.contact',
  BODY: 'closure.body',
  ADVICE: 'closure.advice',
  REAL_OR_TEST: 'closure.real-or-test',
  DONE: 'closure.done',
  ENDED: 'ended',
});

/** States between check-in and closure: the exercise choice, the scene and the exercises. */
export const EXERCISE_STATES = new Set([
  S.MENU, S.SCENE_IN, S.BASE_CALM, S.BREATHE, S.CP_INVITE, S.CP_SENSE, S.CP_CUE, S.ROUND,
  S.SET, S.SET_REST, S.ROUND_CHECK, S.CP_ANNOY, S.CP_END, S.BENCH_INTRO,
]);
/** The only state in which bilateral stimulation runs. */
export const STIM_STATES = new Set([S.SET]);
export const CHECKIN_STATES = new Set([S.CHECK_CRISIS, S.CHECK_DISTRESS, S.CHECK_UNREAL, S.CHECK_UNWELL]);
/** Screens with nothing left to stop: the grounding button does nothing there. */
export const TERMINAL_SCREENS = new Set([S.CRISIS, S.NOT_TODAY, S.DONE, S.ENDED]);
const RATING_STATES = new Set([S.CHECK_DISTRESS, S.BASE_CALM, S.CLOSE_DISTRESS, S.CLOSE_CALM]);
const READ_STATES = new Set([S.CRISIS, S.NOT_TODAY, S.GROUND, S.REORIENT, S.CONTACT, S.ADVICE, S.DONE, S.CP_INVITE, S.CP_CUE, S.CP_ANNOY, S.CP_END, S.BENCH_INTRO]);
/** Exercise screens that wait for the user: they close themselves at the session cap. */
const WAITING_STATES = new Set([S.MENU, S.BASE_CALM, S.ROUND_CHECK, S.CP_INVITE, S.CP_CUE, S.CP_ANNOY, S.CP_END, S.BENCH_INTRO]);

export const GROUNDING_STEPS = SCRIPT.grounding;
export const REORIENT_STEPS = SCRIPT.reorient;
export const CHECK_OPTIONS = SCRIPT.check.options;
export const EXERCISES = ['breathing', 'calm-place', 'grounding', 'bench'];
const CHECK_KEYS = ['calmer', 'same', 'worse', 'upsetting'];
const TRIGGER_WORDS = SCRIPT.triggers;
const H = SCRIPT.hints;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * setsLocked: the lock from the start rules (two flagged sessions in a row, or the
 * therapist's review overdue). It closes bilateral sets everywhere, the engine test included.
 */
export function createSession({ config, now, profile, setsLocked }) {
  const cfg = normalizeConfig(config);
  const prof = profile === 'final' ? 'final' : 'testing';
  const locked = setsLocked === true;
  const setCfg = effectiveSet(cfg.sets); // ceilings applied here, whatever the settings say
  const setCap = Math.min(setCfg.perSession, HARD.setsPerSessionMax);
  const setsInCalmPlace = cfg.sets.enabled === true && !locked;
  const benchOffered = prof === 'testing' && cfg.sets.bench === true && !locked;
  const menu = EXERCISES.filter((k) => k !== 'bench' || benchOffered);
  const cue = cfg.cueWord;
  const say = (text) => String(text).replace('{cue}', cue);

  const rec = {
    id: 's-' + now,
    version: 2,
    profile: prof,
    startedAt: now,
    endedAt: null,
    route: null,
    exercise: null,
    scene: null,
    checkin: {},
    baseline: {},
    closing: {},
    rounds: [],
    setsRun: 0,
    setsEnded: false,
    worseCount: 0,
    stop: null,
    flags: [],
    real: null,
    body: null,
    events: [],
    faults: [],
    steps: [],
    completed: false,
    endedEarly: null,
  };
  const st = { name: null, enteredAt: now, data: {} };
  let effects = [];
  let sceneVisible = false;
  let paused = null;
  let extraGroundingDone = false;
  let lastSetEndedAt = null;

  const fx = (e) => effects.push(e);
  const note = (t, type, detail) => rec.events.push(detail === undefined ? { at: t, type } : { at: t, type, detail });
  const flag = (t, trigger) => rec.flags.push({ at: t, trigger });
  const deadline = () => rec.startedAt + cfg.sessionMinutes * 60000 - cfg.closureReserveSeconds * 1000;
  const hardCap = () => rec.startedAt + cfg.sessionMinutes * 60000;
  const lastRound = () => rec.rounds[rec.rounds.length - 1];
  const mainRounds = () => rec.rounds.filter((r) => r.kind === 'cue' || r.kind === 'set').length;

  function enter(name, t, data) {
    if (st.name) rec.steps.push({ state: st.name, at: st.enteredAt, ms: Math.max(0, t - st.enteredAt) });
    if (st.name === S.SET) endSet(t); // every way out of a set switches the stimulation off
    st.name = name;
    st.enteredAt = t;
    st.data = data || {};
  }

  function endSet(t) {
    const r = lastRound();
    if (r && r.set) {
      r.set.ranMs = Math.round(clamp(t - st.enteredAt - st.data.leadMs, 0, st.data.expectedMs * 2));
      r.set.completed = r.set.ranMs >= st.data.expectedMs;
    }
    lastSetEndedAt = t;
    fx({ type: 'stim', on: false });
  }

  function startGrounding(t, then) {
    enter(S.GROUND, t, { i: 0, then });
  }

  /** Fade the scene away if it is showing, then go on to grounding or closure. */
  function toRoom(t, next) {
    if (sceneVisible) {
      sceneVisible = false;
      fx({ type: 'fade', to: 0, ms: cfg.toRoomFadeMs });
      enter(S.TO_ROOM, t, { next });
    } else if (next === 'ground') {
      startGrounding(t, 'closure');
    } else {
      enter(S.REORIENT, t, { i: 0 });
    }
  }

  /** A stop rule fired: flag the session, leave the scene, run the grounding script. */
  function groundingExit(t, trigger) {
    if (!rec.stop) rec.stop = { trigger, state: st.name, at: t };
    flag(t, trigger);
    note(t, 'stop', { trigger, state: st.name });
    toRoom(t, 'ground');
  }

  function startClosure(t, why) {
    note(t, 'closure', why);
    toRoom(t, 'closure');
  }

  function timeCap(t) {
    note(t, 'time-cap');
    startClosure(t, 'session time cap');
  }

  /* ---------------------------------------------------------------- exercises */

  function chooseExercise(t, key) {
    rec.exercise = key;
    note(t, 'exercise', key);
    if (key === 'grounding') {
      enter(S.BASE_CALM, t, { value: null }); // grounding happens in the real room: no scene loads
    } else {
      rec.scene = cfg.scene;
      sceneVisible = true;
      fx({ type: 'fade', to: 1, ms: cfg.sceneFadeInMs });
      enter(S.SCENE_IN, t);
    }
  }

  function startExercise(t) {
    if (t >= deadline()) { timeCap(t); return; } // check-in used up the session time
    if (rec.exercise === 'breathing') {
      const ms = cfg.breathing.minutes * 60000;
      rec.rounds.push({ n: 1, kind: 'breathing', startedAt: t, seconds: ms / 1000 });
      enter(S.BREATHE, t, { ms });
    } else if (rec.exercise === 'calm-place') {
      enter(S.CP_INVITE, t);
    } else if (rec.exercise === 'bench') {
      enter(S.BENCH_INTRO, t);
    } else {
      startGrounding(t, 'closure');
    }
  }

  function startCueRound(t, kind) {
    const n = kind === 'cue' ? mainRounds() + 1 : 1;
    rec.rounds.push({ n, kind, startedAt: t, seconds: cfg.roundSeconds });
    enter(S.ROUND, t, { n, kind });
  }

  const setsAllowedNow = () => !rec.setsEnded && rec.setsRun < setCap;

  /** Start a set, after the rest that must separate it from the one before. */
  function beginSet(t) {
    const wait = lastSetEndedAt === null ? 0 : lastSetEndedAt + setCfg.pauseMs - t;
    if (wait > 0) { enter(S.SET_REST, t, { ms: wait }); return; }
    const passMs = 1000 / setCfg.speed;
    const expectedMs = setCfg.passes * passMs;
    rec.setsRun += 1;
    const n = rec.exercise === 'bench' ? rec.setsRun : mainRounds() + 1;
    rec.rounds.push({
      n,
      kind: 'set',
      startedAt: t,
      seconds: expectedMs / 1000,
      set: { speed: setCfg.speed, passes: setCfg.passes, sweepDeg: setCfg.sweepDeg, channels: { ...setCfg.channels }, ranMs: 0, completed: false },
    });
    enter(S.SET, t, { n, leadMs: setCfg.leadMs, passMs, passes: setCfg.passes, expectedMs });
    fx({ type: 'stim', on: true });
  }

  /** Calm place: the next strengthening round, as a set or with the cue word alone. */
  function nextRound(t) {
    if (mainRounds() >= cfg.rounds) { afterRounds(t); return; }
    if (t >= deadline()) { timeCap(t); return; }
    if (setsInCalmPlace && setsAllowedNow()) beginSet(t);
    else startCueRound(t, 'cue');
  }

  function afterRounds(t) {
    // The mild-annoyance step runs once, with the cue word only, and never after a "worse".
    if (cfg.calmPlace.annoyanceStep && rec.worseCount === 0 && t < deadline()) enter(S.CP_ANNOY, t);
    else enter(S.CP_END, t);
  }

  /** Engine test: the next set, up to the session's cap. */
  function nextBenchSet(t) {
    if (!benchOffered || !setsAllowedNow()) { startClosure(t, 'exercise complete'); return; }
    if (t >= deadline()) { timeCap(t); return; }
    beginSet(t);
  }

  function afterCheck(t) {
    const r = lastRound();
    if (rec.exercise === 'bench') nextBenchSet(t);
    else if (rec.exercise === 'calm-place' && r.kind === 'annoyance') enter(S.CP_END, t);
    else if (rec.exercise === 'calm-place') nextRound(t);
    else startClosure(t, 'exercise complete');
  }

  function answerRound(t, idx) {
    const r = lastRound();
    r.answer = CHECK_KEYS[idx];
    r.answeredAfterMs = Math.max(0, t - st.enteredAt);
    if (idx === 3) {
      groundingExit(t, 'upsetting');
      return;
    }
    if (idx === 2) {
      rec.worseCount += 1;
      if (rec.worseCount >= 2) {
        groundingExit(t, 'worse-twice');
        return;
      }
      rec.setsEnded = true;
      note(t, 'worse-once', 'bilateral sets end for this session');
    }
    afterCheck(t);
  }

  /* ---------------------------------------------------------------- closure */

  function afterClosingRatings(t) {
    const d = rec.closing.distress;
    const base = rec.baseline.distress;
    const high = d >= cfg.distressBlock || (typeof base === 'number' && d >= base + cfg.flagRise);
    if (high) {
      flag(t, 'closing-distress');
      if (!extraGroundingDone) {
        extraGroundingDone = true;
        enter(S.CONTACT, t);
        return;
      }
    }
    enter(S.BODY, t);
  }

  function finishDone(t) {
    rec.completed = true;
    rec.endedAt = t;
    enter(S.DONE, t);
    fx({ type: 'save' });
  }

  function afterBody(t) {
    if (rec.flags.length > 0 && prof === 'testing') {
      enter(S.REAL_OR_TEST, t);
    } else {
      rec.real = rec.flags.length > 0 ? true : null;
      finishDone(t);
    }
  }

  function routeAfterCheckin(t) {
    const c = rec.checkin;
    if (c.distress >= cfg.distressBlock || c.unreal) {
      rec.route = 'grounding-only';
      note(t, 'checkin-block', { distress: c.distress, unreal: !!c.unreal });
      startGrounding(t, 'closure');
    } else {
      rec.route = 'full';
      enter(S.MENU, t, { selected: null });
    }
  }

  const dwellDone = (t) => t - st.enteredAt >= cfg.minDwellMs;
  // A check-in question takes no answer until it has been up long enough to read.
  // The grounding button is not an answer and is never held back.
  const holdDone = (t) => !CHECKIN_STATES.has(st.name) || t - st.enteredAt >= cfg.checkinHoldMs;

  function primary(t) {
    const d = st.data;
    if (READ_STATES.has(st.name) && !dwellDone(t)) return;
    if (!holdDone(t)) return;
    switch (st.name) {
      case S.CHECK_CRISIS:
        rec.checkin.crisis = true;
        rec.route = 'crisis-card';
        rec.stop = { trigger: 'crisis', state: st.name, at: t };
        flag(t, 'crisis');
        rec.endedAt = t;
        rec.completed = true; // the crisis card is this route's proper end
        enter(S.CRISIS, t);
        fx({ type: 'save' });
        break;
      case S.CHECK_DISTRESS:
        if (d.value == null) return;
        rec.checkin.distress = d.value;
        rec.baseline.distress = d.value;
        enter(S.CHECK_UNREAL, t);
        break;
      case S.CHECK_UNREAL:
        rec.checkin.unreal = true;
        enter(S.CHECK_UNWELL, t);
        break;
      case S.CHECK_UNWELL:
        rec.checkin.unwell = true;
        rec.route = 'not-today';
        rec.endedAt = t;
        rec.completed = true;
        enter(S.NOT_TODAY, t);
        fx({ type: 'save' });
        break;
      case S.CRISIS:
      case S.NOT_TODAY:
      case S.DONE:
        enter(S.ENDED, t);
        fx({ type: 'end' });
        break;
      case S.MENU:
        if (d.selected == null) return;
        chooseExercise(t, menu[d.selected]);
        break;
      case S.BASE_CALM:
        if (d.value == null) return;
        rec.baseline.calm = d.value;
        startExercise(t);
        break;
      case S.CP_INVITE:
        if (t >= deadline()) timeCap(t);
        else enter(S.CP_SENSE, t, { i: 0 });
        break;
      case S.CP_CUE:
        nextRound(t);
        break;
      case S.CP_ANNOY:
        if (t >= deadline()) timeCap(t);
        else startCueRound(t, 'annoyance');
        break;
      case S.CP_END:
        startClosure(t, 'exercise complete');
        break;
      case S.BENCH_INTRO:
        nextBenchSet(t);
        break;
      case S.ROUND_CHECK:
        if (d.selected == null) return;
        answerRound(t, d.selected);
        break;
      case S.GROUND:
        if (d.i + 1 < GROUNDING_STEPS.length) enter(S.GROUND, t, { i: d.i + 1, then: d.then });
        else if (d.then === 'body') enter(S.BODY, t);
        else enter(S.CLOSE_DISTRESS, t, { value: null });
        break;
      case S.REORIENT:
        if (d.i + 1 < REORIENT_STEPS.length) enter(S.REORIENT, t, { i: d.i + 1 });
        else enter(S.CLOSE_DISTRESS, t, { value: null });
        break;
      case S.CLOSE_DISTRESS:
        if (d.value == null) return;
        rec.closing.distress = d.value;
        enter(S.CLOSE_CALM, t, { value: null });
        break;
      case S.CLOSE_CALM:
        if (d.value == null) return;
        rec.closing.calm = d.value;
        afterClosingRatings(t);
        break;
      case S.CONTACT:
        startGrounding(t, 'body');
        break;
      case S.BODY:
        rec.body = { positive: true };
        flag(t, 'body-check');
        enter(S.ADVICE, t);
        break;
      case S.ADVICE:
        afterBody(t);
        break;
      case S.REAL_OR_TEST:
        rec.real = true;
        finishDone(t);
        break;
      default:
        break; // timed states ignore the trigger
    }
  }

  function secondary(t) {
    if (!holdDone(t)) return;
    switch (st.name) {
      case S.CHECK_CRISIS:
        rec.checkin.crisis = false;
        enter(S.CHECK_DISTRESS, t, { value: null });
        break;
      case S.CHECK_UNREAL:
        rec.checkin.unreal = false;
        enter(S.CHECK_UNWELL, t);
        break;
      case S.CHECK_UNWELL:
        rec.checkin.unwell = false;
        routeAfterCheckin(t);
        break;
      case S.BODY:
        rec.body = { positive: false };
        afterBody(t);
        break;
      case S.REAL_OR_TEST:
        rec.real = false;
        finishDone(t);
        break;
      default:
        break;
    }
  }

  function move(dir) {
    const d = st.data;
    const step = dir > 0 ? 1 : -1;
    if (RATING_STATES.has(st.name)) {
      d.value = d.value == null ? 5 : clamp(d.value + step, 0, 10);
    } else if (st.name === S.ROUND_CHECK || st.name === S.MENU) {
      const n = st.name === S.MENU ? menu.length : CHECK_OPTIONS.length;
      d.selected = d.selected == null ? (step > 0 ? 0 : n - 1) : clamp(d.selected + step, 0, n - 1);
    }
  }

  function groundingButton(t) {
    note(t, 'grounding-button', st.name);
    if (TERMINAL_SCREENS.has(st.name) || st.name === S.GROUND) return;
    if (st.name === S.TO_ROOM) {
      if (st.data.next !== 'ground') {
        st.data.next = 'ground';
        if (!rec.stop || String(rec.stop.trigger).indexOf('fault') === 0 || rec.stop.trigger === 'headset-off') rec.stop = { trigger: 'grounding-button', state: st.name, at: t };
        flag(t, 'grounding-button');
      }
      return;
    }
    if (CHECKIN_STATES.has(st.name)) {
      rec.route = 'grounding-only';
      groundingExit(t, 'grounding-button');
      return;
    }
    if (EXERCISE_STATES.has(st.name)) {
      groundingExit(t, 'grounding-button');
      return;
    }
    // Pressed during closure: run the grounding script again, then redo the closing ratings.
    if (!rec.stop) rec.stop = { trigger: 'grounding-button', state: st.name, at: t };
    flag(t, 'grounding-button');
    startGrounding(t, 'closure');
  }

  /** How long the current timed state is meant to last, or null if it waits for the user. */
  function timedLength() {
    const d = st.data;
    switch (st.name) {
      case S.SCENE_IN: return cfg.sceneFadeInMs;
      case S.BREATHE: return d.ms;
      case S.CP_SENSE: return cfg.calmPlace.senseSeconds * 1000;
      case S.ROUND: return cfg.roundSeconds * 1000;
      case S.SET: return d.leadMs + d.expectedMs;
      case S.SET_REST: return d.ms;
      case S.TO_ROOM: return cfg.toRoomFadeMs;
      default: return null;
    }
  }

  function tick(t) {
    const age = t - st.enteredAt;
    const len = timedLength();
    if (len === null) {
      // Left waiting at an exercise screen past the session cap: close the session.
      if (WAITING_STATES.has(st.name) && t >= hardCap()) timeCap(t);
      return;
    }
    if (age < len) return;
    const name = st.name;
    // Watchdogs. A set that ran 20% over its length, or any timed step that ran 5 seconds
    // over, means the clock stalled: record it, and take an exercise to closure.
    const overrun = name === S.SET ? age > st.data.leadMs + st.data.expectedMs * 1.2 : age > len + 5000;
    if (overrun) {
      fault(name === S.SET ? 'set-overrun' : 'step-overrun', Math.round(age - len) + ' ms late in ' + name, t);
      if (st.name !== name) return;
    }
    switch (name) {
      case S.SCENE_IN:
        enter(S.BASE_CALM, t, { value: null });
        break;
      case S.BREATHE:
      case S.ROUND:
      case S.SET:
        if (t >= deadline()) timeCap(t); // the running step finished; no new step starts
        else enter(S.ROUND_CHECK, t, { selected: null });
        break;
      case S.CP_SENSE:
        if (st.data.i + 1 < SCRIPT.calmPlace.sense.length) enter(S.CP_SENSE, t, { i: st.data.i + 1 });
        else enter(S.CP_CUE, t);
        break;
      case S.SET_REST:
        if (rec.exercise === 'bench') nextBenchSet(t);
        else nextRound(t);
        break;
      case S.TO_ROOM:
        if (st.data.next === 'ground') startGrounding(t, 'closure');
        else enter(S.REORIENT, t, { i: 0 });
        break;
      default:
        break;
    }
  }

  function visibility(state, t) {
    note(t, 'visibility', state);
    if (state !== 'visible') {
      if (!paused) {
        paused = { at: t, hidden: false };
        if (st.name === S.SET) fx({ type: 'stim', on: false }); // nothing plays while the user cannot see it
      }
      if (state === 'hidden') paused.hidden = true;
      return;
    }
    if (!paused) return;
    const was = paused;
    paused = null;
    st.enteredAt += Math.max(0, t - was.at); // the pause does not count against the current step
    if (!was.hidden) {
      // System menu only: carry on where we were.
      if (st.name === S.SET) fx({ type: 'stim', on: true });
      return;
    }
    if (CHECKIN_STATES.has(st.name)) {
      rec.checkin = {};
      rec.baseline = {};
      note(t, 'checkin-restarted', 'headset was off');
      enter(S.CHECK_CRISIS, t);
    } else if (EXERCISE_STATES.has(st.name)) {
      if (!rec.stop) rec.stop = { trigger: 'headset-off', state: st.name, at: t };
      startClosure(t, 'headset was off');
    }
  }

  function fault(kind, detail, t) {
    if (rec.faults.length < 20) rec.faults.push({ at: t, kind, detail: detail === undefined ? null : detail, state: st.name });
    if (EXERCISE_STATES.has(st.name)) {
      if (!rec.stop) rec.stop = { trigger: 'fault:' + kind, state: st.name, at: t };
      startClosure(t, 'fault: ' + kind);
    }
  }

  function dispatch(ev) {
    if (st.name === S.ENDED) return;
    const t = ev.now;
    if (ev.type === 'visibility') { visibility(ev.state, t); return; }
    if (ev.type === 'fault') { fault(ev.kind, ev.detail, t); return; }
    if (paused) return; // no input and no clock while the system menu is up or the headset is off
    if (ev.type === 'tick') tick(t);
    else if (ev.type === 'primary') primary(t);
    else if (ev.type === 'secondary') secondary(t);
    else if (ev.type === 'move') move(ev.dir);
    else if (ev.type === 'grounding') groundingButton(t);
  }

  /** The session was ended from outside (browser quit, headset session closed). */
  function abort(t, reason) {
    if (st.name === S.ENDED) return;
    if (!rec.completed && rec.route !== 'crisis-card') {
      rec.endedAt = t;
      rec.endedEarly = reason || 'ended from outside';
      if (!rec.route) rec.route = 'ended-in-check-in';
    }
    enter(S.ENDED, t);
    fx({ type: 'save' });
  }

  function contactLine() {
    const c = cfg.crisisCard;
    return `Your therapist: ${c.therapist}, ${c.phone}, ${c.hours}`;
  }

  /**
   * The bilateral set that is running now, for the code that makes the light, tone and
   * pulse. Null whenever stimulation must be off. Turn k (0, 1, 2…) falls at
   * t0 + (k + 0.5) * passMs / 2: even turns on the right, odd turns on the left.
   */
  function stimulus() {
    if (st.name !== S.SET || paused) return null;
    const d = st.data;
    return { t0: st.enteredAt + d.leadMs, leadMs: d.leadMs, passMs: d.passMs, passes: d.passes, expectedMs: d.expectedMs, sweepDeg: setCfg.sweepDeg, channels: setCfg.channels };
  }

  /** What moves in the scene right now: the breathing light or the bilateral light. */
  function visual(now) {
    if (paused) return { kind: 'none' };
    const age = Math.max(0, now - st.enteredAt);
    if (st.name === S.BREATHE) {
      const inMs = cfg.breathing.inSeconds * 1000;
      const outMs = cfg.breathing.outSeconds * 1000;
      const ph = age % (inMs + outMs);
      const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1));
      const level = ph < inMs ? ease(ph / inMs) : 1 - ease((ph - inMs) / outMs);
      const edge = Math.min(1, age / 1500, Math.max(0, st.data.ms - age) / 1500);
      return { kind: 'breath', level, phase: ph < inMs ? 'in' : 'out', alpha: edge };
    }
    if (st.name === S.SET) {
      const d = st.data;
      const run = clamp(age - d.leadMs, 0, d.expectedMs);
      const x = Math.sin((2 * Math.PI * run) / d.passMs); // starts at centre, glides right first
      const alpha = Math.min(1, age / 1200, Math.max(0, d.leadMs + d.expectedMs - age) / 400);
      return { kind: 'sweep', x, deg: setCfg.sweepDeg, alpha: setCfg.channels.light ? alpha : 0 };
    }
    return { kind: 'none' };
  }

  /** What to show right now. The app draws this; it holds no logic of its own. */
  function screen(now) {
    const d = st.data;
    const age = Math.max(0, (paused ? paused.at : now) - st.enteredAt);
    const base = {
      state: st.name,
      kicker: '',
      title: '',
      body: [],
      kind: 'read',
      hint: '',
      tone: 'normal',
      layout: 'normal',
      progress: null,
      canContinue: true,
      locked: false,
      sceneVisible,
      paused: !!paused,
      showGroundingHint: !TERMINAL_SCREENS.has(st.name) && st.name !== S.GROUND,
    };
    // Check-in questions: answers stay shut for the hold, with a bar that shows it running out.
    const held = CHECKIN_STATES.has(st.name) && age < cfg.checkinHoldMs;
    const hold = held ? { locked: true, canContinue: false, progress: age / cfg.checkinHoldMs } : {};
    const yesno = (o) => ({ ...base, kind: 'yesno', hint: held ? H.hold : H.yesno, yesLabel: 'YES', noLabel: 'NO', ...hold, ...o });
    const rating = (o) => ({ ...base, kind: 'rating', value: d.value == null ? null : d.value, hint: d.value == null ? H.ratingEmpty : (held ? H.ratingHeld : H.rating), ...hold, ...o });
    const read = (o) => {
      const ok = age >= cfg.minDwellMs;
      return { ...base, kind: 'read', canContinue: ok, progress: ok ? null : age / cfg.minDwellMs, hint: ok ? H.next : '', ...o };
    };
    const timed = (ms, o) => ({ ...base, kind: 'timed', progress: clamp(age / ms, 0, 1), ...o });
    const choice = (options, o) => ({ ...base, kind: 'choice', options, selected: d.selected == null ? null : d.selected, hint: d.selected == null ? H.choiceEmpty : H.choice, ...o });
    const leave = age >= cfg.minDwellMs ? H.leave : '';
    const cp = SCRIPT.calmPlace;
    const cl = SCRIPT.closing;
    const roundKicker = () => {
      const r = lastRound();
      if (rec.exercise === 'bench') return `${SCRIPT.bench.kicker} · set ${r ? r.n : 1} of ${setCap}`;
      if (rec.exercise === 'breathing') return SCRIPT.breathing.kicker;
      if (r && r.kind === 'annoyance') return cp.annoyance.kicker;
      return `${cp.kicker} · round ${r ? r.n : 1} of ${cfg.rounds}`;
    };

    switch (st.name) {
      case S.CHECK_CRISIS:
        return yesno({ kicker: 'Check-in · 1 of 4', title: SCRIPT.checkin.crisis });
      case S.CHECK_DISTRESS:
        return rating({ kicker: 'Check-in · 2 of 4', title: SCRIPT.checkin.distress, low: SCRIPT.scales.distress[0], high: SCRIPT.scales.distress[1] });
      case S.CHECK_UNREAL:
        return yesno({ kicker: 'Check-in · 3 of 4', title: SCRIPT.checkin.unreal });
      case S.CHECK_UNWELL:
        return yesno({ kicker: 'Check-in · 4 of 4', title: SCRIPT.checkin.unwell });
      case S.CRISIS:
        return read({
          kind: 'card',
          tone: 'crisis',
          kicker: SCRIPT.crisisCard.kicker,
          title: SCRIPT.crisisCard.title,
          body: [contactLine(), SCRIPT.crisisCard.lifeline, SCRIPT.crisisCard.emergency],
          hint: leave,
        });
      case S.NOT_TODAY: {
        const body = [SCRIPT.notToday.body];
        if (rec.checkin.distress >= cfg.distressBlock || rec.checkin.unreal) body.push(SCRIPT.notToday.highDistress);
        body.push(SCRIPT.notToday.off);
        return read({ kicker: 'Check-in', title: SCRIPT.notToday.title, body, hint: leave });
      }
      case S.MENU:
        return choice(menu.map((k) => SCRIPT.menu.options[k]), { kicker: SCRIPT.menu.kicker, title: SCRIPT.menu.title });
      case S.SCENE_IN:
        return timed(cfg.sceneFadeInMs, { kicker: SCRIPT.sceneIn.kicker, title: SCRIPT.sceneIn.title, body: [SCRIPT.sceneIn.body] });
      case S.BASE_CALM:
        return rating({ kicker: SCRIPT.baselineCalm.kicker, title: SCRIPT.baselineCalm.title, low: SCRIPT.scales.calm[0], high: SCRIPT.scales.calm[1] });
      case S.BREATHE: {
        const v = visual(paused ? paused.at : now);
        return timed(d.ms, { layout: 'low', kicker: SCRIPT.breathing.kicker, title: v.phase === 'out' ? SCRIPT.breathing.out : SCRIPT.breathing.in, body: [SCRIPT.breathing.body] });
      }
      case S.CP_INVITE:
        return read({ kicker: cp.kicker, title: cp.invite.title, body: cp.invite.body });
      case S.CP_SENSE:
        return timed(cfg.calmPlace.senseSeconds * 1000, { kicker: `${cp.kicker} · ${d.i + 1} of ${cp.sense.length}`, title: cp.sense[d.i], body: [cp.senseBody] });
      case S.CP_CUE:
        return read({ kicker: cp.kicker, title: say(cp.cue.title), body: [cp.cue.body] });
      case S.ROUND:
        if (d.kind === 'annoyance') return timed(cfg.roundSeconds * 1000, { kicker: cp.annoyance.kicker, title: say(cp.annoyanceRound.title), body: [cp.annoyanceRound.body] });
        return timed(cfg.roundSeconds * 1000, { kicker: roundKicker(), title: say(cp.round.title), body: [cp.round.body] });
      case S.SET: {
        const text = rec.exercise === 'bench' ? SCRIPT.bench.set : cp.set;
        return timed(d.leadMs + d.expectedMs, { layout: 'low', kicker: roundKicker(), title: text.title, body: text.body.map(say) });
      }
      case S.SET_REST:
        return timed(d.ms, { kicker: roundKicker(), title: SCRIPT.rest.title, body: [SCRIPT.rest.body] });
      case S.ROUND_CHECK:
        return choice(CHECK_OPTIONS, { kicker: roundKicker(), title: SCRIPT.check.title });
      case S.CP_ANNOY:
        return read({ kicker: cp.annoyance.kicker, title: cp.annoyance.title, body: cp.annoyance.body });
      case S.CP_END:
        return read({ kicker: cp.kicker, title: say(cp.end.title), body: cp.end.body });
      case S.BENCH_INTRO:
        return read({ kicker: SCRIPT.bench.kicker, title: SCRIPT.bench.intro.title, body: SCRIPT.bench.intro.body });
      case S.TO_ROOM:
        return timed(cfg.toRoomFadeMs, { kicker: SCRIPT.toRoom.kicker, title: SCRIPT.toRoom.title, body: [SCRIPT.toRoom.body] });
      case S.GROUND:
        return read({ kicker: `Grounding · ${d.i + 1} of ${GROUNDING_STEPS.length}`, title: GROUNDING_STEPS[d.i][0], body: [GROUNDING_STEPS[d.i][1]] });
      case S.REORIENT:
        return read({ kicker: `${cl.kicker} · ${d.i + 1} of ${REORIENT_STEPS.length}`, title: REORIENT_STEPS[d.i][0], body: [REORIENT_STEPS[d.i][1]] });
      case S.CLOSE_DISTRESS:
        return rating({ kicker: cl.kicker, title: cl.distress, low: SCRIPT.scales.distress[0], high: SCRIPT.scales.distress[1] });
      case S.CLOSE_CALM:
        return rating({ kicker: cl.kicker, title: cl.calm, low: SCRIPT.scales.calm[0], high: SCRIPT.scales.calm[1] });
      case S.CONTACT:
        return read({ tone: 'warn', kicker: cl.kicker, title: cl.contact.title, body: [contactLine(), cl.contact.next] });
      case S.BODY:
        return yesno({ kicker: cl.kicker, title: cl.body.title, body: [cl.body.body] });
      case S.ADVICE:
        return read({ tone: 'warn', kicker: cl.kicker, title: cl.advice.title, body: cl.advice.body });
      case S.REAL_OR_TEST: {
        const triggers = Array.from(new Set(rec.flags.map((f) => TRIGGER_WORDS[f.trigger] || f.trigger))).join(', ');
        return yesno({
          kicker: cl.kicker,
          title: cl.realOrTest.title,
          body: [cl.realOrTest.flagged.replace('{triggers}', triggers), cl.realOrTest.pause],
          yesLabel: 'REAL',
          noLabel: 'TEST',
          hint: 'Trigger = REAL        Grip = TEST',
        });
      }
      case S.DONE: {
        const flagged = rec.flags.length > 0;
        const body = [];
        if (flagged && rec.real !== false) body.push(cl.done.flagged, contactLine());
        else if (flagged) body.push(cl.done.test);
        else body.push(cl.done.clean);
        body.push(cl.done.off);
        return read({ kicker: cl.done.kicker, title: cl.done.title, body, hint: leave });
      }
      default:
        return { ...base, kind: 'read', title: 'Session ended', canContinue: false };
    }
  }

  enter(S.CHECK_CRISIS, now);

  return {
    dispatch,
    abort,
    screen,
    visual,
    stimulus,
    get state() { return st.name; },
    get record() { return rec; },
    get paused() { return !!paused; },
    get sceneVisible() { return sceneVisible; },
    get menu() { return menu.slice(); },
    get setsInCalmPlace() { return setsInCalmPlace; },
    drainEffects() { const e = effects; effects = []; return e; },
    config: cfg,
  };
}
