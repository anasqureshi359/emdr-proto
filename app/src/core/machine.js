// The session state machine. Pure logic: no headset, no page, no timers of its own.
// Time comes in with every event, so the same code runs in the app and in the tests.
//
// Events in:  primary (trigger), secondary (grip), move, grounding (B or Y),
//             tick, visibility, fault.
// Effects out: fade (scene in or out), save (write the record), end (leave VR).
//
// No state waits on an outside reply. Timed states move on by the clock alone.

import { normalizeConfig } from './config.js';

export const S = Object.freeze({
  CHECK_CRISIS: 'checkin.crisis',
  CHECK_DISTRESS: 'checkin.distress',
  CHECK_UNREAL: 'checkin.unreal',
  CHECK_UNWELL: 'checkin.unwell',
  CRISIS: 'crisis-card',
  NOT_TODAY: 'not-today',
  SCENE_IN: 'scene-in',
  BASE_CALM: 'baseline.calm',
  ROUND: 'round.active',
  ROUND_CHECK: 'round.check',
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

/** States in which the virtual scene and the (future) exercises run. */
export const EXERCISE_STATES = new Set([S.SCENE_IN, S.BASE_CALM, S.ROUND, S.ROUND_CHECK]);
export const CHECKIN_STATES = new Set([S.CHECK_CRISIS, S.CHECK_DISTRESS, S.CHECK_UNREAL, S.CHECK_UNWELL]);
/** Screens with nothing left to stop: the grounding button does nothing there. */
export const TERMINAL_SCREENS = new Set([S.CRISIS, S.NOT_TODAY, S.DONE, S.ENDED]);
const RATING_STATES = new Set([S.CHECK_DISTRESS, S.BASE_CALM, S.CLOSE_DISTRESS, S.CLOSE_CALM]);
const READ_STATES = new Set([S.CRISIS, S.NOT_TODAY, S.GROUND, S.REORIENT, S.CONTACT, S.ADVICE, S.DONE]);

export const GROUNDING_STEPS = [
  ['Look around the real room', 'Name three things you can see.'],
  ['Listen', 'Name two things you can hear.'],
  ['Feel', 'Press your feet into the floor and your hands onto your thighs.'],
  ['Breathe', 'Breathe out slowly three times.'],
  ['Here and now', 'Say today\'s date and where you are.'],
];
export const REORIENT_STEPS = [
  ['Back in the room', 'Name three things you can see in the room.'],
  ['Feet on the floor', 'Feel your feet on the floor.'],
  ['Stretch', 'Stretch your arms and shoulders.'],
];
export const CHECK_OPTIONS = ['Calmer', 'Same', 'Worse', 'Something upsetting came up'];
const CHECK_KEYS = ['calmer', 'same', 'worse', 'upsetting'];
const TRIGGER_WORDS = {
  'grounding-button': 'the grounding button',
  'upsetting': 'something upsetting came up',
  'worse-twice': 'worse twice',
  'closing-distress': 'high closing distress',
  'body-check': 'the body check',
  'crisis': 'the crisis card',
};

const HINT_YESNO = 'Trigger = YES        Grip = NO';
const HINT_CONTINUE = 'Trigger = continue';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function createSession({ config, now, profile }) {
  const cfg = normalizeConfig(config);
  const prof = profile === 'final' ? 'final' : 'testing';
  const rec = {
    id: 's-' + now,
    version: 1,
    profile: prof,
    startedAt: now,
    endedAt: null,
    route: null,
    checkin: {},
    baseline: {},
    closing: {},
    rounds: [],
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

  const fx = (e) => effects.push(e);
  const note = (t, type, detail) => rec.events.push(detail === undefined ? { at: t, type } : { at: t, type, detail });
  const flag = (t, trigger) => rec.flags.push({ at: t, trigger });
  const deadline = () => rec.startedAt + cfg.sessionMinutes * 60000 - cfg.closureReserveSeconds * 1000;
  const hardCap = () => rec.startedAt + cfg.sessionMinutes * 60000;

  function enter(name, t, data) {
    if (st.name) rec.steps.push({ state: st.name, at: st.enteredAt, ms: Math.max(0, t - st.enteredAt) });
    st.name = name;
    st.enteredAt = t;
    st.data = data || {};
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

  function startRound(t, n) {
    rec.rounds.push({ n, startedAt: t, seconds: cfg.roundSeconds });
    enter(S.ROUND, t, { n });
  }

  function nextRound(t) {
    if (rec.rounds.length >= cfg.rounds) {
      startClosure(t, 'rounds complete');
    } else if (t >= deadline()) {
      note(t, 'time-cap');
      startClosure(t, 'session time cap');
    } else {
      startRound(t, rec.rounds.length + 1);
    }
  }

  function answerRound(t, idx) {
    const r = rec.rounds[rec.rounds.length - 1];
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
    nextRound(t);
  }

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
      sceneVisible = true;
      fx({ type: 'fade', to: 1, ms: cfg.sceneFadeInMs });
      enter(S.SCENE_IN, t);
    }
  }

  const dwellDone = (t) => t - st.enteredAt >= cfg.minDwellMs;

  function primary(t) {
    const d = st.data;
    if (READ_STATES.has(st.name) && !dwellDone(t)) return;
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
      case S.BASE_CALM:
        if (d.value == null) return;
        rec.baseline.calm = d.value;
        nextRound(t); // starts round 1, unless check-in already used up the session time
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
    } else if (st.name === S.ROUND_CHECK) {
      const n = CHECK_OPTIONS.length;
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

  function tick(t) {
    const age = t - st.enteredAt;
    if (st.name === S.SCENE_IN && age >= cfg.sceneFadeInMs) {
      enter(S.BASE_CALM, t, { value: null });
    } else if (st.name === S.ROUND && age >= cfg.roundSeconds * 1000) {
      if (t >= deadline()) {
        note(t, 'time-cap');
        startClosure(t, 'session time cap');
      } else {
        enter(S.ROUND_CHECK, t, { selected: null });
      }
    } else if (st.name === S.TO_ROOM && age >= cfg.toRoomFadeMs) {
      if (st.data.next === 'ground') startGrounding(t, 'closure');
      else enter(S.REORIENT, t, { i: 0 });
    } else if ((st.name === S.BASE_CALM || st.name === S.ROUND_CHECK) && t >= hardCap()) {
      // Left waiting at a question past the session cap: close the session.
      note(t, 'time-cap');
      startClosure(t, 'session time cap');
    }
  }

  function visibility(state, t) {
    note(t, 'visibility', state);
    if (state !== 'visible') {
      if (!paused) paused = { at: t, hidden: false };
      if (state === 'hidden') paused.hidden = true;
      return;
    }
    if (!paused) return;
    const was = paused;
    paused = null;
    st.enteredAt += Math.max(0, t - was.at); // the pause does not count against the current step
    if (!was.hidden) return; // system menu only: carry on where we were
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
      progress: null,
      canContinue: true,
      sceneVisible,
      paused: !!paused,
      showGroundingHint: !TERMINAL_SCREENS.has(st.name) && st.name !== S.GROUND,
    };
    const yesno = (o) => ({ ...base, kind: 'yesno', hint: HINT_YESNO, yesLabel: 'YES', noLabel: 'NO', ...o });
    const rating = (o) => ({ ...base, kind: 'rating', value: d.value == null ? null : d.value, hint: d.value == null ? 'Thumbstick left or right, or A / X, to choose' : 'Thumbstick or A / X = change        Trigger = confirm', ...o });
    const read = (o) => {
      const ok = age >= cfg.minDwellMs;
      return { ...base, kind: 'read', canContinue: ok, progress: ok ? null : age / cfg.minDwellMs, hint: ok ? HINT_CONTINUE : '', ...o };
    };
    const timed = (ms, o) => ({ ...base, kind: 'timed', progress: clamp(age / ms, 0, 1), ...o });

    switch (st.name) {
      case S.CHECK_CRISIS:
        return yesno({ kicker: 'Check-in · 1 of 4', title: 'Are you in crisis, or having thoughts of harming yourself?' });
      case S.CHECK_DISTRESS:
        return rating({ kicker: 'Check-in · 2 of 4', title: 'How distressed are you right now?', low: 'none', high: 'the most' });
      case S.CHECK_UNREAL:
        return yesno({ kicker: 'Check-in · 3 of 4', title: 'Do you feel unreal, spaced out or disconnected?' });
      case S.CHECK_UNWELL:
        return yesno({ kicker: 'Check-in · 4 of 4', title: 'Are you tired or unwell, or have you had alcohol or drugs today?' });
      case S.CRISIS:
        return read({
          kind: 'card',
          tone: 'crisis',
          kicker: 'This session has ended',
          title: 'Take the headset off now',
          body: [contactLine(), '988 Suicide and Crisis Lifeline: call or text 988 (US)', 'Emergency: call 911'],
          hint: age >= cfg.minDwellMs ? 'Trigger = leave' : '',
        });
      case S.NOT_TODAY: {
        const body = ['Headsets are best avoided when you are tired, unwell, or have had alcohol or drugs.'];
        if (rec.checkin.distress >= cfg.distressBlock || rec.checkin.unreal) body.push('Do your grounding steps without the headset.');
        body.push('Take the headset off.');
        return read({ kicker: 'Check-in', title: 'No session today', body, hint: age >= cfg.minDwellMs ? 'Trigger = leave' : '' });
      }
      case S.SCENE_IN:
        return timed(cfg.sceneFadeInMs, { kicker: 'Starting', title: 'Loading the scene', body: ['The room around you fades out.'] });
      case S.BASE_CALM:
        return rating({ kicker: 'Before we start', title: 'How calm do you feel right now?', low: 'not at all', high: 'completely' });
      case S.ROUND:
        return timed(cfg.roundSeconds * 1000, {
          kicker: `Round ${d.n} of ${cfg.rounds}`,
          title: 'Empty round',
          body: ['There is no exercise in this build.', 'Sit quietly until the bar fills.'],
        });
      case S.ROUND_CHECK:
        return {
          ...base,
          kind: 'choice',
          kicker: `Round ${rec.rounds.length} of ${cfg.rounds}`,
          title: 'How is it now?',
          options: CHECK_OPTIONS,
          selected: d.selected == null ? null : d.selected,
          hint: d.selected == null ? 'Thumbstick up or down, or A / X, to choose' : 'Thumbstick or A / X = move        Trigger = confirm',
        };
      case S.TO_ROOM:
        return timed(cfg.toRoomFadeMs, { kicker: 'Leaving the scene', title: 'Back to your room', body: ['The scene is fading out.'] });
      case S.GROUND:
        return read({ kicker: `Grounding · ${d.i + 1} of ${GROUNDING_STEPS.length}`, title: GROUNDING_STEPS[d.i][0], body: [GROUNDING_STEPS[d.i][1]] });
      case S.REORIENT:
        return read({ kicker: `Closing · ${d.i + 1} of ${REORIENT_STEPS.length}`, title: REORIENT_STEPS[d.i][0], body: [REORIENT_STEPS[d.i][1]] });
      case S.CLOSE_DISTRESS:
        return rating({ kicker: 'Closing', title: 'How distressed are you now?', low: 'none', high: 'the most' });
      case S.CLOSE_CALM:
        return rating({ kicker: 'Closing', title: 'How calm do you feel now?', low: 'not at all', high: 'completely' });
      case S.CONTACT:
        return read({ tone: 'warn', kicker: 'Closing', title: 'Your distress is high', body: [contactLine(), 'Next: one more round of grounding.'] });
      case S.BODY:
        return yesno({ kicker: 'Closing', title: 'Body check', body: ['Dizzy, nauseous, eye strain, or feeling unreal?'] });
      case S.ADVICE:
        return read({ tone: 'warn', kicker: 'Closing', title: 'Rest first', body: ['Rest before driving or doing anything demanding.', 'Leave the headset off until the symptoms have gone.'] });
      case S.REAL_OR_TEST: {
        const triggers = Array.from(new Set(rec.flags.map((f) => TRIGGER_WORDS[f.trigger] || f.trigger))).join(', ');
        return yesno({
          kicker: 'Closing',
          title: 'Was that real, or a test of the app?',
          body: [`This session was flagged: ${triggers}.`, 'A real stop pauses the app for 4 hours. A test does not.'],
          yesLabel: 'REAL',
          noLabel: 'TEST',
          hint: 'Trigger = REAL        Grip = TEST',
        });
      }
      case S.DONE: {
        const flagged = rec.flags.length > 0;
        const body = [];
        if (flagged && rec.real !== false) body.push('This session was flagged for your therapist.', contactLine());
        else if (flagged) body.push('Flagged, and marked as a test.');
        else body.push('Nothing was flagged.');
        body.push('Take the headset off.');
        return read({ kicker: 'Finished', title: 'Session saved', body, hint: age >= cfg.minDwellMs ? 'Trigger = leave' : '' });
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
    get state() { return st.name; },
    get record() { return rec; },
    get paused() { return !!paused; },
    get sceneVisible() { return sceneVisible; },
    drainEffects() { const e = effects; effects = []; return e; },
    config: cfg,
  };
}
