// One test (or more) for every stop rule in the design spec, plus an exhaustive
// check that no trigger, from any state, can lead back into an exercise.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, S, EXERCISE_STATES, STIM_STATES, CHECKIN_STATES, TERMINAL_SCREENS, GROUNDING_STEPS, REORIENT_STEPS } from '../src/core/machine.js';
import { HARD, effectiveSet, normalizeConfig } from '../src/core/config.js';
import { SCRIPT } from '../src/core/scripts.js';

const T0 = Date.parse('2026-11-14T15:00:00Z');

/** Drives a session the way the app would, with a fake clock. */
class Driver {
  constructor(opts = {}) {
    this.t = opts.now || T0;
    this.s = createSession({ config: opts.config || {}, now: this.t, profile: opts.profile || 'testing', setsLocked: opts.setsLocked });
    this.visited = [this.s.state];
    this.effects = [];
  }
  send(type, extra = {}) {
    this.s.dispatch({ type, now: this.t, ...extra });
    this.effects.push(...this.s.drainEffects());
    if (this.visited[this.visited.length - 1] !== this.s.state) this.visited.push(this.s.state);
  }
  /** Let time pass, ticking every 100 ms as the app's frame loop would. */
  wait(ms) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + 100);
      this.send('tick');
    }
  }
  /** Wait out the hold on a check-in question, as a user reading it would. */
  ready() { while (this.s.screen(this.t).locked) this.wait(100); }
  yes() { this.ready(); this.send('primary'); }
  no() { this.ready(); this.send('secondary'); }
  rate(v) {
    this.ready();
    this.send('move', { dir: 1 }); // from "nothing chosen" to 5
    const cur = () => this.s.screen(this.t).value;
    while (cur() < v) this.send('move', { dir: 1 });
    while (cur() > v) this.send('move', { dir: -1 });
    this.send('primary');
  }
  choose(i) {
    this.send('move', { dir: 1 }); // selects the first option
    for (let k = 0; k < i; k++) this.send('move', { dir: 1 });
    this.send('primary');
  }
  /** Wait out the minimum reading time, then continue. */
  next() { this.wait(this.s.config.minDwellMs + 100); this.send('primary'); }
  get state() { return this.s.state; }
  get rec() { return this.s.record; }

  /** Check-in answered so that the exercise choice comes up. */
  clearCheckin(distress = 3) {
    this.no();
    this.rate(distress);
    this.no();
    this.no();
  }
  /** Choose an exercise by name on the choice screen. */
  pick(key) {
    const i = this.s.menu.indexOf(key);
    assert.ok(i >= 0, key + ' is not offered');
    this.choose(i);
  }
  /** Clear check-in, pick an exercise, and answer the baseline calm rating. */
  start(key = 'calm-place', distress = 3) {
    this.clearCheckin(distress);
    this.pick(key);
    if (key !== 'grounding') this.wait(this.s.config.sceneFadeInMs + 100);
    this.rate(5);
  }
  /** Wait until the current timed step has ended. */
  through(state) { let n = 0; while (this.state === state && ++n < 5000) this.wait(100); }
  roundDone() { this.through(S.ROUND); }
  setDone() { this.through(S.SET_REST); this.through(S.SET); }
  /** Calm place, up to the first cue-word round (or the first set, when sets are on). */
  toRound() {
    this.start('calm-place');
    assert.equal(this.state, S.CP_INVITE);
    this.next();
    this.through(S.CP_SENSE);
    assert.equal(this.state, S.CP_CUE);
    this.next();
    assert.ok(this.state === S.ROUND || this.state === S.SET);
  }
  toRoundCheck() {
    this.toRound();
    this.roundDone();
    this.setDone();
    assert.equal(this.state, S.ROUND_CHECK);
  }
  /** A full breathing exercise, answered "same", up to the first closing step. */
  toReorient(distress = 3) {
    this.start('breathing', distress);
    this.through(S.BREATHE);
    this.choose(1);
    this.wait(this.s.config.toRoomFadeMs + 100);
    assert.equal(this.state, S.REORIENT);
  }
  /** Answer everything in the calmest way until the session ends. */
  finish({ closingDistress = 1, real = true } = {}) {
    let guard = 0;
    while (this.state !== S.ENDED) {
      if (++guard > 3000) throw new Error('session did not end; stuck in ' + this.state);
      const sc = this.s.screen(this.t);
      if (sc.kind === 'timed') this.wait(1000);
      else if (sc.kind === 'rating') this.rate(this.state === S.CLOSE_DISTRESS || this.state === S.CHECK_DISTRESS ? closingDistress : 6);
      else if (sc.kind === 'choice') this.choose(1);
      else if (this.state === S.REAL_OR_TEST) { if (real) this.yes(); else this.no(); }
      else if (sc.kind === 'yesno') this.no();
      else this.next();
    }
  }
}

const enteredExerciseAfter = (d, index) => d.visited.slice(index).some((s) => EXERCISE_STATES.has(s));
const triggers = (d) => d.rec.flags.map((f) => f.trigger);
const stims = (d) => d.effects.filter((e) => e.type === 'stim');
const stimIsOff = (d) => { const x = stims(d); return d.s.stimulus() === null && (x.length === 0 || x[x.length - 1].on === false); };

/* ---------------------------------------------------------------- check-in hold */

test('a check-in question ignores both answers until it has been up for 2 seconds', () => {
  const d = new Driver();
  assert.equal(d.s.config.checkinHoldMs, 2000);
  d.send('secondary');
  d.send('primary');
  assert.equal(d.state, S.CHECK_CRISIS, 'answers in the first instant are ignored');
  d.wait(1900);
  d.send('primary');
  d.send('secondary');
  assert.equal(d.state, S.CHECK_CRISIS, 'still ignored at 1.9 s');
  assert.deepEqual(d.rec.checkin, {}, 'nothing was recorded from the ignored presses');
  assert.equal(d.rec.flags.length, 0);
  d.wait(100);
  d.send('secondary');
  assert.equal(d.state, S.CHECK_DISTRESS, 'accepted at 2.0 s');
});

test('an early "yes" to the crisis question is ignored, and a later one still works', () => {
  const d = new Driver();
  d.wait(500);
  d.send('primary');
  assert.equal(d.state, S.CHECK_CRISIS);
  d.wait(1500);
  d.send('primary');
  assert.equal(d.state, S.CRISIS);
});

test('every check-in question has its own hold, so none can be clicked through', () => {
  const d = new Driver();
  d.wait(2000); d.send('secondary');
  assert.equal(d.state, S.CHECK_DISTRESS);
  d.send('move', { dir: 1 }); // choosing a number is allowed during the hold
  d.send('primary');
  assert.equal(d.state, S.CHECK_DISTRESS, 'confirming the rating is held');
  assert.equal(d.s.screen(d.t).value, 5, 'the chosen number is kept');
  d.wait(2000); d.send('primary');
  assert.equal(d.state, S.CHECK_UNREAL);
  d.send('secondary');
  assert.equal(d.state, S.CHECK_UNREAL, 'third question is held');
  d.wait(2000); d.send('secondary');
  assert.equal(d.state, S.CHECK_UNWELL);
  d.send('secondary'); d.send('primary');
  assert.equal(d.state, S.CHECK_UNWELL, 'fourth question is held');
  d.wait(2000); d.send('secondary');
  assert.equal(d.state, S.MENU);
  const checkin = d.rec.steps.filter((x) => CHECKIN_STATES.has(x.state));
  assert.equal(checkin.length, 4);
  for (const x of checkin) assert.ok(x.ms >= 2000, `${x.state} was up for ${x.ms} ms`);
});

test('the grounding button works at once during the hold', () => {
  const d = new Driver();
  d.send('grounding');
  assert.equal(d.state, S.GROUND);
  assert.deepEqual(triggers(d), ['grounding-button']);
});

test('time spent paused does not count toward the hold', () => {
  const d = new Driver();
  d.wait(1000);
  d.send('visibility', { state: 'visible-blurred' });
  d.wait(5000);
  d.send('visibility', { state: 'visible' });
  d.send('secondary');
  assert.equal(d.state, S.CHECK_CRISIS, 'only 1 second of reading time has passed');
  d.wait(1000);
  d.send('secondary');
  assert.equal(d.state, S.CHECK_DISTRESS);
});

test('the hold starts again when check-in restarts after the headset was off', () => {
  const d = new Driver();
  d.no();
  d.wait(3000);
  d.send('visibility', { state: 'hidden' });
  d.wait(4000);
  d.send('visibility', { state: 'visible' });
  assert.equal(d.state, S.CHECK_CRISIS);
  d.send('secondary');
  assert.equal(d.state, S.CHECK_CRISIS, 'the restarted question is held');
  d.wait(2000);
  d.send('secondary');
  assert.equal(d.state, S.CHECK_DISTRESS);
});

test('a held question shows that it is held and when it opens', () => {
  const d = new Driver();
  let sc = d.s.screen(d.t);
  assert.equal(sc.locked, true);
  assert.equal(sc.canContinue, false);
  assert.equal(sc.hint, 'Read the question first');
  assert.ok(sc.progress >= 0 && sc.progress < 1);
  assert.equal(sc.showGroundingHint, true, 'the grounding hint stays on a held question');
  d.wait(1000);
  assert.ok(Math.abs(d.s.screen(d.t).progress - 0.5) < 0.06);
  d.wait(1000);
  sc = d.s.screen(d.t);
  assert.equal(sc.locked, false);
  assert.equal(sc.progress, null);
  assert.match(sc.hint, /Trigger = YES/);
  d.send('secondary');
  d.send('move', { dir: 1 });
  assert.doesNotMatch(d.s.screen(d.t).hint, /confirm/, 'no "confirm" hint while the rating is held');
  d.wait(2000);
  assert.match(d.s.screen(d.t).hint, /Trigger = confirm/);
});

test('questions after check-in are not held', () => {
  const d = new Driver();
  d.toRoundCheck();
  assert.equal(d.s.screen(d.t).locked, false);
  d.choose(0);
  assert.equal(d.state, S.ROUND);
});

/* ---------------------------------------------------------------- check-in routing */

test('a clear check-in runs the full session and saves an unflagged record', () => {
  const d = new Driver();
  d.clearCheckin(3);
  assert.equal(d.state, S.MENU);
  assert.deepEqual(d.effects, [], 'no scene loads before an exercise is chosen');
  d.pick('calm-place');
  assert.equal(d.state, S.SCENE_IN);
  assert.deepEqual(d.effects[0], { type: 'fade', to: 1, ms: d.s.config.sceneFadeInMs });
  d.finish();
  assert.equal(d.rec.route, 'full');
  assert.equal(d.rec.exercise, 'calm-place');
  assert.equal(d.rec.completed, true);
  assert.equal(d.rec.rounds.filter((r) => r.kind === 'cue').length, 3);
  assert.deepEqual(d.rec.flags, []);
  assert.equal(d.rec.real, null);
  assert.ok(d.effects.some((e) => e.type === 'save'));
  assert.equal(d.effects[d.effects.length - 1].type, 'end');
  assert.ok(!d.visited.includes(S.REAL_OR_TEST), 'an unflagged session is not asked real-or-test');
});

test('crisis "yes" shows the crisis card, saves at once, and offers no exercise', () => {
  const d = new Driver();
  d.yes();
  assert.equal(d.state, S.CRISIS);
  assert.ok(d.effects.some((e) => e.type === 'save'), 'saved as soon as the card shows');
  const sc = d.s.screen(d.t);
  assert.ok(sc.body.some((l) => l.includes('988')));
  assert.ok(sc.body.some((l) => l.includes('911')));
  assert.equal(sc.title, 'Take the headset off now');
  d.finish();
  assert.equal(d.rec.route, 'crisis-card');
  assert.deepEqual(triggers(d), ['crisis']);
  assert.ok(!enteredExerciseAfter(d, 0));
  assert.ok(!d.visited.includes(S.GROUND));
});

test('check-in distress at the threshold blocks the scene and runs grounding only', () => {
  const d = new Driver();
  d.no(); d.rate(7); d.no(); d.no();
  assert.equal(d.state, S.GROUND);
  assert.equal(d.rec.route, 'grounding-only');
  assert.ok(!d.effects.some((e) => e.type === 'fade'), 'the scene never loads');
  d.finish({ closingDistress: 3 });
  assert.ok(!enteredExerciseAfter(d, 0));
  assert.equal(d.rec.completed, true);
});

test('check-in distress one below the threshold is allowed in', () => {
  const d = new Driver();
  d.no(); d.rate(6); d.no(); d.no();
  assert.equal(d.state, S.MENU);
});

test('feeling unreal at check-in blocks the scene and runs grounding only', () => {
  const d = new Driver();
  d.no(); d.rate(2); d.yes(); d.no();
  assert.equal(d.state, S.GROUND);
  assert.equal(d.rec.route, 'grounding-only');
  d.finish();
  assert.ok(!enteredExerciseAfter(d, 0));
});

test('tired, unwell or intoxicated ends with "no session today"', () => {
  const d = new Driver();
  d.no(); d.rate(2); d.no(); d.yes();
  assert.equal(d.state, S.NOT_TODAY);
  d.finish();
  assert.equal(d.rec.route, 'not-today');
  assert.ok(!enteredExerciseAfter(d, 0));
  assert.deepEqual(d.rec.flags, []);
});

test('unwell plus high distress still ends the session, and points to grounding without the headset', () => {
  const d = new Driver();
  d.no(); d.rate(9); d.no(); d.yes();
  assert.equal(d.state, S.NOT_TODAY);
  assert.ok(d.s.screen(d.t).body.some((l) => l.includes('grounding steps without the headset')));
});

/* ---------------------------------------------------------------- grounding button */

test('grounding button mid-round: scene fades out, grounding script runs, then closure', () => {
  const d = new Driver();
  d.toRound();
  d.wait(3000);
  const mark = d.visited.length;
  d.send('grounding');
  assert.equal(d.state, S.TO_ROOM);
  assert.deepEqual(d.effects[d.effects.length - 1], { type: 'fade', to: 0, ms: d.s.config.toRoomFadeMs });
  d.wait(d.s.config.toRoomFadeMs + 100);
  assert.equal(d.state, S.GROUND);
  d.finish();
  assert.ok(!enteredExerciseAfter(d, mark));
  assert.deepEqual(d.rec.stop.trigger, 'grounding-button');
  assert.ok(triggers(d).includes('grounding-button'));
  assert.ok(d.visited.includes(S.REAL_OR_TEST), 'testing profile asks real or test');
  assert.equal(d.visited.filter((s) => s === S.GROUND).length >= 1, true);
});

test('grounding button during check-in goes straight to grounding in the real room', () => {
  for (const reach of [(d) => {}, (d) => d.no(), (d) => { d.no(); d.rate(2); }, (d) => { d.no(); d.rate(2); d.no(); }]) {
    const d = new Driver();
    reach(d);
    assert.ok(CHECKIN_STATES.has(d.state));
    d.send('grounding');
    assert.equal(d.state, S.GROUND);
    assert.equal(d.rec.route, 'grounding-only');
    d.finish();
    assert.ok(!enteredExerciseAfter(d, 0));
    assert.ok(triggers(d).includes('grounding-button'));
  }
});

test('grounding button during closure runs the grounding script again, then the closing ratings', () => {
  const d = new Driver();
  d.toReorient();
  d.send('grounding');
  assert.equal(d.state, S.GROUND);
  for (let i = 0; i < GROUNDING_STEPS.length; i++) d.next();
  assert.equal(d.state, S.CLOSE_DISTRESS);
  d.finish();
  assert.ok(triggers(d).includes('grounding-button'));
});

test('grounding button does nothing on the crisis card, "no session today" and the final screen', () => {
  const a = new Driver(); a.yes(); a.send('grounding'); assert.equal(a.state, S.CRISIS);
  const b = new Driver(); b.no(); b.rate(1); b.no(); b.yes(); b.send('grounding'); assert.equal(b.state, S.NOT_TODAY);
  assert.deepEqual(b.rec.flags, []);
});

test('each grounding step stays up for the minimum reading time', () => {
  const d = new Driver();
  d.send('grounding');
  assert.equal(d.state, S.GROUND);
  assert.equal(d.s.screen(d.t).kicker, 'Grounding · 1 of 5');
  for (let i = 0; i < 10; i++) d.yes(); // hammering the trigger must not skip ahead
  assert.equal(d.s.screen(d.t).kicker, 'Grounding · 1 of 5');
  assert.equal(d.s.screen(d.t).canContinue, false);
  d.wait(d.s.config.minDwellMs + 100);
  assert.equal(d.s.screen(d.t).canContinue, true);
  d.yes();
  assert.equal(d.s.screen(d.t).kicker, 'Grounding · 2 of 5');
});

/* ---------------------------------------------------------------- check answers */

test('"something upsetting came up" stops the session and flags it', () => {
  const d = new Driver();
  d.toRoundCheck();
  const mark = d.visited.length;
  d.choose(3);
  assert.equal(d.state, S.TO_ROOM);
  d.finish();
  assert.ok(!enteredExerciseAfter(d, mark));
  assert.equal(d.rec.stop.trigger, 'upsetting');
  assert.deepEqual(triggers(d), ['upsetting']);
  assert.equal(d.rec.rounds.length, 1);
});

test('"worse" once ends bilateral sets for the session but lets it continue', () => {
  const d = new Driver();
  d.toRoundCheck();
  d.choose(2);
  assert.equal(d.state, S.ROUND);
  assert.equal(d.rec.setsEnded, true);
  assert.deepEqual(d.rec.flags, []);
  assert.equal(d.rec.rounds.length, 2);
});

test('"worse" a second time stops the session and flags it', () => {
  const d = new Driver();
  d.toRoundCheck();
  d.choose(2);
  d.roundDone();
  const mark = d.visited.length;
  d.choose(2);
  assert.equal(d.state, S.TO_ROOM);
  d.finish();
  assert.ok(!enteredExerciseAfter(d, mark));
  assert.equal(d.rec.stop.trigger, 'worse-twice');
  assert.deepEqual(triggers(d), ['worse-twice']);
});

test('a rating or a choice cannot be confirmed before something is chosen', () => {
  const d = new Driver();
  d.no();
  assert.equal(d.state, S.CHECK_DISTRESS);
  d.yes(); d.yes();
  assert.equal(d.state, S.CHECK_DISTRESS, 'trigger alone does not confirm an empty rating');
  const e = new Driver();
  e.toRoundCheck();
  e.yes(); e.yes();
  assert.equal(e.state, S.ROUND_CHECK, 'trigger alone does not confirm an empty choice');
});

/* ---------------------------------------------------------------- closure rules */

function runToClosingRatings(baseline) {
  const d = new Driver();
  d.toReorient(baseline);
  for (let i = 0; i < REORIENT_STEPS.length; i++) d.next();
  assert.equal(d.state, S.CLOSE_DISTRESS);
  return d;
}

test('closing distress at the threshold: therapist contact, a second grounding round, flagged', () => {
  const d = runToClosingRatings(3);
  d.rate(7); d.rate(4);
  assert.equal(d.state, S.CONTACT);
  assert.ok(d.s.screen(d.t).body[0].includes('Your therapist'));
  d.next();
  assert.equal(d.state, S.GROUND);
  for (let i = 0; i < GROUNDING_STEPS.length; i++) d.next();
  assert.equal(d.state, S.BODY);
  d.finish();
  assert.deepEqual(triggers(d), ['closing-distress']);
});

test('closing distress 2 points above baseline is flagged even below the threshold', () => {
  const d = runToClosingRatings(2);
  d.rate(4); d.rate(5);
  assert.equal(d.state, S.CONTACT);
  d.finish();
  assert.deepEqual(triggers(d), ['closing-distress']);
});

test('closing distress 1 point above baseline is not flagged', () => {
  const d = runToClosingRatings(2);
  d.rate(3); d.rate(5);
  assert.equal(d.state, S.BODY);
  d.finish();
  assert.deepEqual(d.rec.flags, []);
});

test('a positive body check shows rest advice and flags the session', () => {
  const d = runToClosingRatings(2);
  d.rate(1); d.rate(6);
  assert.equal(d.state, S.BODY);
  d.yes();
  assert.equal(d.state, S.ADVICE);
  assert.ok(d.s.screen(d.t).body[0].includes('Rest before driving'));
  d.finish();
  assert.deepEqual(triggers(d), ['body-check']);
  assert.equal(d.rec.body.positive, true);
});

test('real-or-test: asked for flagged sessions in the testing profile; both answers are recorded', () => {
  const a = new Driver(); a.send('grounding'); a.finish({ real: true });
  assert.equal(a.rec.real, true);
  const b = new Driver(); b.send('grounding'); b.finish({ real: false });
  assert.equal(b.rec.real, false);
});

test('final profile never asks real-or-test: a flagged session is real', () => {
  const d = new Driver({ profile: 'final' });
  d.send('grounding');
  d.finish();
  assert.ok(!d.visited.includes(S.REAL_OR_TEST));
  assert.equal(d.rec.real, true);
});

/* ---------------------------------------------------------------- time cap */

test('session time cap: the running round finishes, no new step starts, closure follows', () => {
  // A 5-minute cap with 150 s kept for closure leaves 150 s for everything before it.
  const d = new Driver({ config: { sessionMinutes: 5, rounds: 6, roundSeconds: 60 } });
  const deadline = T0 + 150000;
  d.toRound();
  let checks = 0;
  while (d.state === S.ROUND) {
    const startedBeforeDeadline = d.t < deadline;
    assert.ok(startedBeforeDeadline, 'a round started after the deadline');
    d.roundDone();
    if (d.state !== S.ROUND_CHECK) break;
    checks += 1;
    d.choose(1);
  }
  assert.equal(d.state, S.TO_ROOM, 'the round that crossed the deadline ends without a check or a new round');
  assert.ok(d.t >= deadline && d.t < deadline + 60000);
  assert.equal(d.rec.rounds.length, checks + 1);
  assert.ok(d.rec.rounds.length < 6);
  assert.equal(d.rec.rounds[d.rec.rounds.length - 1].answer, undefined);
  assert.ok(d.rec.events.some((e) => e.type === 'time-cap'));
  d.finish();
  assert.deepEqual(d.rec.flags, []);
});

test('left waiting at a question past the session cap: the session closes itself', () => {
  const d = new Driver({ config: { sessionMinutes: 5 } });
  d.toRoundCheck();
  d.wait(6 * 60000);
  assert.ok([S.TO_ROOM, S.REORIENT].includes(d.state));
  assert.ok(d.rec.events.some((e) => e.type === 'time-cap'));
});

/* ---------------------------------------------------------------- faults and visibility */

test('frame-rate fault during a round: fade to the real room, closure, recorded as a fault', () => {
  const d = new Driver();
  d.toRound();
  const mark = d.visited.length;
  d.send('fault', { kind: 'frame-rate', detail: '48 fps' });
  assert.equal(d.state, S.TO_ROOM);
  assert.deepEqual(d.effects[d.effects.length - 1], { type: 'fade', to: 0, ms: d.s.config.toRoomFadeMs });
  d.wait(1100);
  assert.equal(d.state, S.REORIENT);
  d.finish();
  assert.ok(!enteredExerciseAfter(d, mark));
  assert.equal(d.rec.faults[0].kind, 'frame-rate');
  assert.equal(d.rec.stop.trigger, 'fault:frame-rate');
  assert.deepEqual(d.rec.flags, [], 'a fault is recorded, not flagged');
});

test('a fault during check-in is recorded and check-in carries on', () => {
  const d = new Driver();
  d.send('fault', { kind: 'error', detail: 'x' });
  assert.equal(d.state, S.CHECK_CRISIS);
  assert.equal(d.rec.faults.length, 1);
});

test('headset taken off mid-round: paused, then closure on return', () => {
  const d = new Driver();
  d.toRound();
  const mark = d.visited.length;
  d.send('visibility', { state: 'visible-blurred' });
  d.send('visibility', { state: 'hidden' });
  d.wait(50000);
  assert.equal(d.state, S.ROUND, 'nothing moves while the headset is off');
  d.send('visibility', { state: 'visible' });
  assert.equal(d.state, S.TO_ROOM);
  d.finish();
  assert.ok(!enteredExerciseAfter(d, mark));
  assert.equal(d.rec.stop.trigger, 'headset-off');
  assert.deepEqual(d.rec.flags, [], 'recorded, not flagged');
});

test('headset taken off during check-in: check-in starts again', () => {
  const d = new Driver();
  d.no(); d.rate(2);
  d.send('visibility', { state: 'hidden' });
  d.wait(5000);
  d.send('visibility', { state: 'visible' });
  assert.equal(d.state, S.CHECK_CRISIS);
  assert.deepEqual(d.rec.checkin, {});
});

test('system menu (blurred, not hidden): the clock and input pause, then the same step resumes', () => {
  const d = new Driver();
  d.toRound();
  d.wait(5000);
  d.send('visibility', { state: 'visible-blurred' });
  d.wait(60000);
  d.send('grounding');
  d.yes();
  assert.equal(d.state, S.ROUND, 'no input and no clock while the menu is up');
  d.send('visibility', { state: 'visible' });
  assert.equal(d.state, S.ROUND);
  const p = d.s.screen(d.t).progress;
  const len = d.s.config.roundSeconds * 1000;
  assert.ok(Math.abs(p - 5000 / len) < 0.02, 'the round resumes 5 seconds in, got ' + p);
  d.wait(len - 5000 - 200);
  assert.equal(d.state, S.ROUND, 'the pause did not shorten the round');
  d.wait(300);
  assert.equal(d.state, S.ROUND_CHECK);
});

test('session ended from outside mid-round: saved as incomplete', () => {
  const d = new Driver();
  d.toRound();
  d.s.abort(d.t + 1000, 'headset session closed');
  d.effects.push(...d.s.drainEffects());
  assert.equal(d.state, S.ENDED);
  assert.equal(d.rec.completed, false);
  assert.equal(d.rec.endedEarly, 'headset session closed');
  assert.equal(d.rec.real, null);
  assert.ok(d.effects.some((e) => e.type === 'save'));
});

/* ---------------------------------------------------------------- nothing can stall */

test('timed states move on by the clock alone, with no outside reply', () => {
  const d = new Driver();
  d.clearCheckin();
  d.pick('breathing');
  assert.equal(d.state, S.SCENE_IN);
  d.wait(d.s.config.sceneFadeInMs + 100); // only ticks arrive: no "fade finished" message exists
  assert.equal(d.state, S.BASE_CALM);
  d.rate(5);
  d.send('grounding');
  assert.equal(d.state, S.TO_ROOM);
  d.wait(d.s.config.toRoomFadeMs + 100);
  assert.equal(d.state, S.GROUND);
});

test('every screen that waits shows progress or tells the user what to press', () => {
  const seen = new Set();
  for (const key of ['calm-place', 'breathing', 'grounding', 'bench', 'calm-place-with-sets']) {
    const d = new Driver(key === 'calm-place-with-sets' ? { config: { sets: { enabled: true } } } : {});
    let guard = 0;
    const check = () => {
      const sc = d.s.screen(d.t);
      if (sc.state === S.ENDED) return;
      seen.add(sc.state);
      const hasProgress = typeof sc.progress === 'number';
      assert.ok(hasProgress || sc.hint.length > 0, `screen ${sc.state} has neither progress nor a hint`);
      assert.ok(sc.title.length > 0, `screen ${sc.state} has no title`);
    };
    d.clearCheckin(); check();
    d.pick(key.replace('-with-sets', ''));
    while (d.state !== S.ENDED && ++guard < 3000) {
      check();
      const sc = d.s.screen(d.t);
      if (sc.kind === 'timed') d.wait(500);
      else if (sc.kind === 'rating') d.rate(8); // high closing distress, to visit the contact screen too
      else if (sc.kind === 'choice') d.choose(1);
      else if (sc.kind === 'yesno') d.yes(); // "yes" to the body check, "real" to real-or-test
      else { check(); d.wait(1000); check(); d.next(); }
    }
    assert.equal(d.state, S.ENDED);
  }
  for (const s of Object.values(S)) {
    if (s === S.ENDED || s === S.CRISIS || s === S.NOT_TODAY || CHECKIN_STATES.has(s)) continue;
    assert.ok(seen.has(s), 'walk did not visit ' + s);
  }
});

/* ---------------------------------------------------------------- exhaustive sweep */

// Reach every state of a session, fire every trigger there, and check the rule the
// spec's test table asks for: each ends in grounding or closure, none reaches an exercise.
function reachAll() {
  const paths = [];
  const add = (name, fn, opts) => paths.push({ name, fn, opts });
  add(S.CHECK_CRISIS, () => {});
  add(S.CHECK_DISTRESS, (d) => d.no());
  add(S.CHECK_UNREAL, (d) => { d.no(); d.rate(3); });
  add(S.CHECK_UNWELL, (d) => { d.no(); d.rate(3); d.no(); });
  add(S.MENU, (d) => d.clearCheckin());
  add(S.SCENE_IN, (d) => { d.clearCheckin(); d.pick('calm-place'); });
  add(S.BASE_CALM, (d) => { d.clearCheckin(); d.pick('calm-place'); d.wait(1600); });
  add(S.BASE_CALM, (d) => { d.clearCheckin(); d.pick('grounding'); });
  add(S.BREATHE, (d) => { d.start('breathing'); d.wait(30000); });
  add(S.CP_INVITE, (d) => d.start('calm-place'));
  add(S.CP_SENSE, (d) => { d.start('calm-place'); d.next(); d.wait(15000); });
  add(S.CP_CUE, (d) => { d.start('calm-place'); d.next(); d.through(S.CP_SENSE); });
  add(S.ROUND, (d) => d.toRound());
  add(S.ROUND_CHECK, (d) => d.toRoundCheck());
  add(S.CP_ANNOY, (d) => { d.toRoundCheck(); d.choose(0); d.roundDone(); d.choose(0); d.roundDone(); d.choose(0); });
  add(S.ROUND, (d) => { d.toRoundCheck(); d.choose(0); d.roundDone(); d.choose(0); d.roundDone(); d.choose(0); d.next(); });
  add(S.CP_END, (d) => { d.toRoundCheck(); d.choose(0); d.roundDone(); d.choose(0); d.roundDone(); d.choose(0); d.next(); d.roundDone(); d.choose(0); });
  add(S.BENCH_INTRO, (d) => d.start('bench'));
  add(S.SET, (d) => { d.start('bench'); d.next(); d.wait(1000); }); // while the light is still appearing
  add(S.SET, (d) => { d.start('bench'); d.next(); d.wait(8000); }); // mid-sweep
  add(S.ROUND_CHECK, (d) => { d.start('bench'); d.next(); d.setDone(); });
  add(S.SET_REST, (d) => { d.start('bench'); d.next(); d.setDone(); d.choose(0); });
  add(S.SET, (d) => { d.toRound(); d.wait(6000); }, { config: { sets: { enabled: true } } }); // a set inside calm place
  add(S.SET_REST, (d) => { d.toRoundCheck(); d.choose(1); }, { config: { sets: { enabled: true } } });
  add(S.TO_ROOM, (d) => { d.toRound(); d.send('fault', { kind: 'frame-rate' }); });
  add(S.GROUND, (d) => { d.toRound(); d.send('grounding'); d.wait(1100); });
  add(S.REORIENT, (d) => { d.toRound(); d.send('fault', { kind: 'frame-rate' }); d.wait(1100); });
  add(S.CLOSE_DISTRESS, (d) => { d.send('grounding'); for (let i = 0; i < 5; i++) d.next(); });
  add(S.CLOSE_CALM, (d) => { d.send('grounding'); for (let i = 0; i < 5; i++) d.next(); d.rate(2); });
  add(S.CONTACT, (d) => { d.send('grounding'); for (let i = 0; i < 5; i++) d.next(); d.rate(9); d.rate(2); });
  add(S.BODY, (d) => { d.send('grounding'); for (let i = 0; i < 5; i++) d.next(); d.rate(2); d.rate(5); });
  add(S.ADVICE, (d) => { d.send('grounding'); for (let i = 0; i < 5; i++) d.next(); d.rate(2); d.rate(5); d.yes(); });
  add(S.REAL_OR_TEST, (d) => { d.send('grounding'); for (let i = 0; i < 5; i++) d.next(); d.rate(2); d.rate(5); d.no(); });
  add(S.DONE, (d) => { d.send('grounding'); for (let i = 0; i < 5; i++) d.next(); d.rate(2); d.rate(5); d.no(); d.yes(); });
  add(S.CRISIS, (d) => d.yes());
  add(S.NOT_TODAY, (d) => { d.no(); d.rate(3); d.no(); d.yes(); });
  return paths;
}

const TRIGGERS = {
  'grounding button': (d) => d.send('grounding'),
  'frame-rate fault': (d) => d.send('fault', { kind: 'frame-rate' }),
  'uncaught error': (d) => d.send('fault', { kind: 'error' }),
  'headset off and on': (d) => { d.send('visibility', { state: 'hidden' }); d.wait(3000); d.send('visibility', { state: 'visible' }); },
  'session cap reached': (d) => { d.wait(21 * 60000); },
};

test('every state is reachable by the sweep', () => {
  const reached = new Set();
  for (const p of reachAll()) {
    const d = new Driver(p.opts);
    p.fn(d);
    assert.equal(d.state, p.name);
    reached.add(p.name);
  }
  for (const s of Object.values(S)) if (s !== S.ENDED) assert.ok(reached.has(s), 'the sweep has no path to ' + s);
});

test('stimulation is off in every state except a running set', () => {
  for (const p of reachAll()) {
    const d = new Driver(p.opts);
    p.fn(d);
    if (STIM_STATES.has(d.state)) {
      assert.ok(d.s.stimulus() !== null, 'a set is running in ' + p.name);
      assert.equal(stims(d).pop().on, true);
    } else {
      assert.ok(stimIsOff(d), 'stimulation is on in ' + p.name);
      assert.notEqual(d.s.visual(d.t).kind, 'sweep');
    }
  }
});

for (const [tname, fire] of Object.entries(TRIGGERS)) {
  test(`sweep: "${tname}" from every state ends the session without re-entering an exercise`, () => {
    for (const p of reachAll()) {
      const d = new Driver(p.opts);
      p.fn(d);
      const wasExercise = EXERCISE_STATES.has(d.state);
      const wasCheckin = CHECKIN_STATES.has(d.state);
      fire(d);
      const mark = d.visited.length - 1;
      // From an exercise state the trigger must leave the exercise at once, with stimulation off.
      if (wasExercise) {
        assert.ok(!EXERCISE_STATES.has(d.state), `${tname} from ${p.name}: still in ${d.state}`);
        assert.ok(stimIsOff(d), `${tname} from ${p.name}: stimulation still on`);
      }
      d.finish();
      assert.ok(stimIsOff(d), `${tname} from ${p.name}: stimulation on at the end`);
      assert.equal(d.state, S.ENDED, `${tname} from ${p.name}: did not end`);
      if (wasExercise || !wasCheckin) {
        // Once a trigger has fired during or after the exercise, no exercise state may follow.
        const later = d.visited.slice(mark);
        assert.ok(!later.some((s, i) => i > 0 && EXERCISE_STATES.has(s)), `${tname} from ${p.name}: re-entered an exercise (${later.join(' > ')})`);
      }
      if (tname === 'grounding button' && !TERMINAL_SCREENS.has(p.name)) {
        assert.ok(d.visited.includes(S.GROUND), `grounding button from ${p.name}: grounding script never ran`);
        assert.ok(triggers(d).includes('grounding-button') || p.name === S.GROUND, `grounding button from ${p.name}: not flagged`);
      }
    }
  });
}

test('sweep: "something upsetting" at any round check stops the session', () => {
  for (let round = 1; round <= 3; round++) {
    const d = new Driver();
    d.toRoundCheck();
    for (let k = 1; k < round; k++) { d.choose(0); d.roundDone(); }
    const mark = d.visited.length;
    d.choose(3);
    d.finish();
    assert.ok(!enteredExerciseAfter(d, mark), 'round ' + round);
    assert.equal(d.rec.rounds.length, round);
  }
});

/* ---------------------------------------------------------------- exercise choice */

test('the choice screen offers three exercises, plus the engine test while testing', () => {
  assert.deepEqual(new Driver().s.menu, ['breathing', 'calm-place', 'grounding', 'bench']);
  assert.deepEqual(new Driver({ profile: 'final' }).s.menu, ['breathing', 'calm-place', 'grounding'], 'no engine test outside the testing profile');
  assert.deepEqual(new Driver({ setsLocked: true }).s.menu, ['breathing', 'calm-place', 'grounding'], 'no engine test while sets are locked');
  assert.deepEqual(new Driver({ config: { sets: { bench: false } } }).s.menu, ['breathing', 'calm-place', 'grounding']);
  const d = new Driver();
  d.clearCheckin();
  const sc = d.s.screen(d.t);
  assert.equal(sc.kind, 'choice');
  assert.equal(sc.options.length, 4);
  assert.equal(sc.sceneVisible, false, 'the choice is made in the real room');
  d.yes(); d.yes();
  assert.equal(d.state, S.MENU, 'nothing starts until an exercise is chosen');
});

test('grounding exercise: no scene loads, the five steps run, and nothing is flagged', () => {
  const d = new Driver();
  d.start('grounding');
  assert.equal(d.state, S.GROUND);
  assert.ok(!d.effects.some((e) => e.type === 'fade'), 'the real room stays in view throughout');
  for (let i = 0; i < GROUNDING_STEPS.length; i++) d.next();
  assert.equal(d.state, S.CLOSE_DISTRESS);
  d.finish();
  assert.equal(d.rec.exercise, 'grounding');
  assert.equal(d.rec.scene, null);
  assert.equal(d.rec.route, 'full');
  assert.deepEqual(d.rec.flags, []);
  assert.equal(d.rec.completed, true);
});

/* ---------------------------------------------------------------- paced breathing */

test('paced breathing: 2 minutes of 4 seconds in and 6 out, one check, then closure', () => {
  const d = new Driver();
  d.start('breathing');
  assert.equal(d.state, S.BREATHE);
  const t0 = d.t;
  const titles = [];
  let breaths = 0;
  let prevPhase = null;
  while (d.state === S.BREATHE) {
    const v = d.s.visual(d.t);
    assert.equal(v.kind, 'breath');
    assert.ok(v.level >= 0 && v.level <= 1);
    const within = (d.t - t0) % 10000;
    assert.equal(v.phase, within < 4000 ? 'in' : 'out', 'at ' + within + ' ms into a breath');
    if (v.phase === 'in' && prevPhase !== 'in') breaths += 1;
    prevPhase = v.phase;
    const sc = d.s.screen(d.t);
    assert.equal(sc.title, v.phase === 'in' ? 'Breathe in' : 'Breathe out');
    assert.equal(sc.layout, 'low', 'the panel sits below the light');
    if (titles[titles.length - 1] !== sc.title) titles.push(sc.title);
    d.wait(100);
  }
  assert.equal(d.t - t0, 120000);
  assert.equal(breaths, 12);
  assert.equal(titles.length, 24);
  assert.equal(d.state, S.ROUND_CHECK);
  d.choose(0);
  assert.equal(d.state, S.TO_ROOM);
  d.finish();
  assert.equal(d.rec.rounds.length, 1);
  assert.equal(d.rec.rounds[0].kind, 'breathing');
  assert.equal(d.rec.rounds[0].answer, 'calmer');
  assert.equal(stims(d).length, 0, 'breathing never touches the bilateral engine');
  assert.deepEqual(d.rec.flags, []);
});

test('the breathing light is fullest at the end of the in-breath and empty at the end of the out-breath', () => {
  const d = new Driver();
  d.start('breathing');
  const t0 = d.t;
  const level = (ms) => d.s.visual(t0 + ms).level;
  assert.ok(level(0) < 0.01);
  assert.ok(level(2000) > 0.45 && level(2000) < 0.55);
  assert.ok(level(4000) > 0.99);
  assert.ok(level(7000) > 0.45 && level(7000) < 0.55);
  assert.ok(level(9990) < 0.01);
  assert.ok(level(14000) > 0.99, 'the second breath repeats the first');
});

/* ---------------------------------------------------------------- calm place */

test('calm place with sets locked: invite, four sense prompts, cue word, three cue rounds, annoyance step, close', () => {
  const d = new Driver({ config: { cueWord: 'harbour' } });
  d.start('calm-place');
  assert.equal(d.state, S.CP_INVITE);
  d.next();
  const prompts = [];
  const t0 = d.t;
  while (d.state === S.CP_SENSE) { const sc = d.s.screen(d.t); if (prompts[prompts.length - 1] !== sc.title) prompts.push(sc.title); d.wait(100); }
  assert.deepEqual(prompts, SCRIPT.calmPlace.sense);
  assert.equal(d.t - t0, 40000, 'sense prompts take 40 seconds');
  assert.equal(d.state, S.CP_CUE);
  assert.match(d.s.screen(d.t).title, /"harbour"/);
  d.next();
  for (let n = 1; n <= 3; n++) {
    assert.equal(d.state, S.ROUND, 'round ' + n + ' uses the cue word, not a set');
    assert.match(d.s.screen(d.t).title, /"harbour"/);
    assert.match(d.s.screen(d.t).kicker, new RegExp('round ' + n + ' of 3'));
    d.roundDone();
    assert.equal(d.state, S.ROUND_CHECK);
    d.choose(1);
  }
  assert.equal(d.state, S.CP_ANNOY);
  d.next();
  assert.equal(d.state, S.ROUND);
  assert.equal(d.rec.rounds[d.rec.rounds.length - 1].kind, 'annoyance');
  d.roundDone();
  assert.equal(d.state, S.ROUND_CHECK);
  d.choose(0);
  assert.equal(d.state, S.CP_END);
  d.next();
  assert.equal(d.state, S.TO_ROOM);
  d.finish();
  assert.ok(!d.visited.includes(S.SET), 'no set ran');
  assert.equal(stims(d).length, 0, 'the bilateral engine was never switched on');
  assert.equal(d.rec.setsRun, 0);
  assert.deepEqual(d.rec.rounds.map((r) => r.kind), ['cue', 'cue', 'cue', 'annoyance']);
  assert.deepEqual(d.rec.flags, []);
});

test('the annoyance step is skipped after a "worse", and can be switched off', () => {
  const d = new Driver();
  d.toRoundCheck();
  d.choose(2); d.roundDone(); d.choose(1); d.roundDone(); d.choose(1);
  assert.equal(d.state, S.CP_END, 'no annoyance step after a "worse"');
  assert.ok(!d.visited.includes(S.CP_ANNOY));
  const e = new Driver({ config: { calmPlace: { annoyanceStep: false } } });
  e.toRoundCheck();
  e.choose(1); e.roundDone(); e.choose(1); e.roundDone(); e.choose(1);
  assert.equal(e.state, S.CP_END);
});

test('the annoyance step never runs with a bilateral set, even when sets are on', () => {
  // Four sets allowed and three rounds: one set is still unused when the annoyance step comes.
  const d = new Driver({ config: { sets: { enabled: true, perSession: 4 } } });
  d.toRoundCheck();
  d.choose(1); d.setDone(); d.choose(1); d.setDone(); d.choose(1);
  assert.equal(d.state, S.CP_ANNOY);
  const before = d.rec.setsRun;
  d.next();
  assert.equal(d.state, S.ROUND, 'cue word only');
  assert.ok(stimIsOff(d));
  d.roundDone(); d.choose(1);
  assert.equal(d.rec.setsRun, before);
  assert.equal(d.state, S.CP_END);
});

test('the cue word is cleaned before it is shown', () => {
  assert.equal(normalizeConfig({ cueWord: '  still   water  ' }).cueWord, 'still water');
  assert.equal(normalizeConfig({ cueWord: '<img src=x>' }).cueWord, 'img srcx');
  assert.equal(normalizeConfig({ cueWord: '' }).cueWord, 'calm');
  assert.equal(normalizeConfig({ cueWord: 12345 }).cueWord, 'calm');
  assert.equal(normalizeConfig({ cueWord: 'x'.repeat(80) }).cueWord.length, 24);
  assert.equal(normalizeConfig({ cueWord: 'sérénité' }).cueWord, 'sérénité');
});

/* ---------------------------------------------------------------- bilateral sets */

test('the lock: sets inside calm place are off by default, and the start-rule lock closes them too', () => {
  assert.equal(new Driver().s.setsInCalmPlace, false);
  assert.equal(new Driver({ config: { sets: { enabled: true } } }).s.setsInCalmPlace, true);
  const d = new Driver({ config: { sets: { enabled: true } }, setsLocked: true });
  assert.equal(d.s.setsInCalmPlace, false);
  d.toRound();
  assert.equal(d.state, S.ROUND, 'locked: the round uses the cue word');
  d.finish();
  assert.equal(d.rec.setsRun, 0);
  assert.equal(stims(d).length, 0);
});

test('calm place with sets on: three sets at the defaults, a check after each, at least 10 seconds apart', () => {
  const d = new Driver({ config: { sets: { enabled: true } } });
  d.toRound();
  const ends = [];
  for (let n = 1; n <= 3; n++) {
    d.through(S.SET_REST);
    assert.equal(d.state, S.SET, 'round ' + n + ' is a set');
    const started = d.t;
    assert.deepEqual(stims(d).pop(), { type: 'stim', on: true });
    assert.equal(d.s.screen(d.t).layout, 'low');
    d.through(S.SET);
    assert.equal(d.t - started, 3000 + 12000, 'a set is 3 s of lead-in and 12 s of movement');
    assert.deepEqual(stims(d).pop(), { type: 'stim', on: false });
    assert.equal(d.state, S.ROUND_CHECK);
    if (ends.length) assert.ok(started + 3000 - ends[ends.length - 1] >= 10000, 'movement resumed ' + (started + 3000 - ends[ends.length - 1]) + ' ms after the last set');
    ends.push(d.t);
    d.choose(1);
  }
  assert.equal(d.state, S.CP_ANNOY);
  d.finish();
  const sets = d.rec.rounds.filter((r) => r.kind === 'set');
  assert.equal(sets.length, 3);
  assert.equal(d.rec.setsRun, 3);
  for (const r of sets) {
    assert.deepEqual(r.set, { speed: 0.5, passes: 6, sweepDeg: 20, channels: { light: true, tone: true, pulse: false }, ranMs: 12000, completed: true });
  }
  assert.equal(sets.reduce((a, r) => a + r.set.ranMs, 0), 36000, '36 seconds of stimulation in the session');
});

test('the rest between sets cannot be skipped', () => {
  const d = new Driver();
  d.start('bench'); d.next(); d.setDone();
  const ended = d.t;
  d.choose(0);
  assert.equal(d.state, S.SET_REST);
  for (let i = 0; i < 20; i++) { d.send('primary'); d.send('secondary'); d.send('move', { dir: 1 }); d.wait(100); }
  assert.equal(d.state, S.SET_REST, 'no button shortens the rest');
  d.through(S.SET_REST);
  assert.equal(d.state, S.SET);
  assert.ok(d.t - ended >= 10000);
  // Answering slowly uses up the rest: the next set may then start at once.
  d.through(S.SET);
  d.wait(15000);
  d.choose(0);
  assert.equal(d.state, S.SET);
});

test('"worse" after a set ends sets for the session; the next round uses the cue word', () => {
  const d = new Driver({ config: { sets: { enabled: true } } });
  d.toRoundCheck();
  assert.equal(d.rec.setsRun, 1);
  d.choose(2);
  assert.equal(d.state, S.ROUND);
  assert.equal(d.rec.setsEnded, true);
  d.roundDone(); d.choose(1);
  assert.equal(d.state, S.ROUND);
  d.finish();
  assert.equal(d.rec.setsRun, 1);
  assert.deepEqual(d.rec.rounds.map((r) => r.kind), ['set', 'cue', 'cue']);
});

test('engine test: up to three sets with a check after each, and "worse" ends it', () => {
  const d = new Driver();
  d.start('bench');
  assert.equal(d.state, S.BENCH_INTRO);
  d.next();
  for (let n = 1; n <= 3; n++) {
    d.through(S.SET_REST);
    assert.equal(d.state, S.SET);
    assert.match(d.s.screen(d.t).kicker, new RegExp('set ' + n + ' of 3'));
    d.through(S.SET);
    d.choose(1);
  }
  assert.equal(d.state, S.TO_ROOM, 'closure after the last set');
  d.finish();
  assert.equal(d.rec.setsRun, 3);
  const e = new Driver();
  e.start('bench'); e.next(); e.setDone();
  e.choose(2);
  assert.equal(e.state, S.TO_ROOM, 'one "worse" ends the engine test');
  e.finish();
  assert.equal(e.rec.setsRun, 1);
  assert.deepEqual(e.rec.flags, []);
});

test('ceilings: no settings combination runs faster than 1.0 passes a second, longer than 12 passes or more than 4 sets', () => {
  const values = [undefined, null, -1, 0, 0.01, 0.3, 0.5, 0.8, 1, 1.01, 2, 12, 13, 100, 1e9, Infinity, NaN, '5', 'fast', {}];
  let combos = 0;
  for (const speed of values) for (const passes of values) for (const perSession of values) for (const sweepDeg of [undefined, 5, 20, 31, 400, NaN]) {
    const raw = { enabled: true, speed, passes, perSession, sweepDeg, pauseMs: 0, leadMs: 0, channels: { light: false, tone: false, pulse: false } };
    for (const e of [effectiveSet(raw), effectiveSet(normalizeConfig({ sets: raw }).sets)]) {
      combos += 1;
      assert.ok(e.speed > 0 && e.speed <= HARD.setSpeedMax, 'speed ' + e.speed);
      assert.ok(Number.isInteger(e.passes) && e.passes >= 1 && e.passes <= HARD.setPassesMax, 'passes ' + e.passes);
      assert.ok(Number.isInteger(e.perSession) && e.perSession >= 1 && e.perSession <= HARD.setsPerSessionMax, 'sets ' + e.perSession);
      assert.ok(e.sweepDeg > 0 && e.sweepDeg <= HARD.sweepDegMax, 'sweep ' + e.sweepDeg);
      assert.ok(e.pauseMs >= HARD.setPauseMsMin, 'pause ' + e.pauseMs);
      assert.ok(e.leadMs >= 1000);
      assert.ok(e.channels.light || e.channels.tone || e.channels.pulse, 'at least one channel');
    }
  }
  assert.ok(combos > 90000);
  assert.deepEqual([HARD.setSpeedMax, HARD.setPassesMax, HARD.setsPerSessionMax, HARD.sweepDegMax, HARD.setPauseMsMin], [1.0, 12, 4, 30, 10000]);
});

test('ceilings hold in a running session, whatever the settings ask for', () => {
  for (const sets of [{ speed: 50, passes: 500, perSession: 50, sweepDeg: 90, pauseMs: 1 }, { speed: 0.8, passes: 12, perSession: 4 }, { speed: -3, passes: 0, perSession: 0 }]) {
    const d = new Driver({ config: { sessionMinutes: 20, rounds: 6, sets: { enabled: true, ...sets } } });
    d.toRound();
    let lastEnd = null;
    let guard = 0;
    while (d.state !== S.CP_ANNOY && d.state !== S.CP_END && ++guard < 50) {
      d.through(S.SET_REST);
      if (d.state === S.SET) {
        const st = d.s.stimulus();
        assert.ok(1000 / st.passMs <= 1.0 && st.passes <= 12 && st.sweepDeg <= 30);
        if (lastEnd !== null) assert.ok(st.t0 - lastEnd >= 10000);
        d.through(S.SET);
        lastEnd = d.t;
      } else {
        d.roundDone();
      }
      d.choose(1);
    }
    assert.ok(d.rec.setsRun <= 4, 'sets run: ' + d.rec.setsRun);
    assert.equal(d.rec.rounds.filter((r) => r.kind === 'set' || r.kind === 'cue').length, 6, 'rounds past the set cap use the cue word');
    for (const r of d.rec.rounds.filter((x) => x.kind === 'set')) {
      assert.ok(r.set.speed <= 0.8 && r.set.passes <= 12 && r.set.sweepDeg <= 25, JSON.stringify(r.set));
    }
  }
});

test('the light starts at the centre, glides right first, and turns twice in every pass', () => {
  const d = new Driver();
  d.start('bench'); d.next();
  const st = d.s.stimulus();
  assert.equal(st.passMs, 2000);
  assert.equal(st.passes, 6);
  assert.equal(st.t0, d.t + 3000, 'movement starts after the lead-in');
  const x = (ms) => d.s.visual(st.t0 + ms).x;
  assert.equal(d.s.visual(d.t + 1500).x, 0, 'still at the centre during the lead-in');
  assert.ok(Math.abs(x(0)) < 1e-9);
  assert.ok(Math.abs(x(500) - 1) < 1e-9, 'right-hand turn at a quarter of a pass');
  assert.ok(Math.abs(x(1500) + 1) < 1e-9, 'left-hand turn at three quarters');
  assert.ok(Math.abs(x(12000)) < 1e-6, 'back at the centre at the end');
  let turns = 0;
  let prev = x(0);
  let dir = 1;
  for (let ms = 10; ms <= 12000; ms += 10) {
    const cur = x(ms);
    assert.ok(cur >= -1 && cur <= 1);
    const nd = cur > prev ? 1 : cur < prev ? -1 : dir;
    if (nd !== dir) { turns += 1; dir = nd; }
    prev = cur;
  }
  assert.equal(turns, 12);
  // The fastest allowed movement: at the ceiling of 1 pass a second and 30 degrees, the peak is under 190 degrees a second.
  assert.ok(2 * Math.PI * HARD.setSpeedMax * HARD.sweepDegMax < 190);
});

test('grounding button during a set: stimulation is off in the same instant', () => {
  for (const at of [1000, 3050, 9000, 14900]) {
    const d = new Driver({ config: { sets: { enabled: true } } });
    d.toRound();
    assert.equal(d.state, S.SET);
    d.wait(at);
    assert.ok(d.s.stimulus() !== null);
    const before = d.effects.length;
    d.send('grounding');
    assert.equal(d.state, S.TO_ROOM);
    assert.equal(d.s.stimulus(), null);
    assert.equal(d.s.visual(d.t).kind, 'none');
    const fxNow = d.effects.slice(before);
    assert.ok(fxNow.some((e) => e.type === 'stim' && e.on === false), 'the stop is sent with the button press, not on a later tick');
    assert.ok(fxNow.some((e) => e.type === 'fade' && e.to === 0));
    const r = d.rec.rounds[d.rec.rounds.length - 1];
    assert.equal(r.set.completed, false);
    assert.equal(r.set.ranMs, Math.max(0, at - 3000));
    d.finish();
    assert.ok(stimIsOff(d));
    assert.equal(d.rec.setsRun, 1);
  }
});

test('system menu during a set: stimulation stops, and the set picks up where it left off', () => {
  const d = new Driver();
  d.start('bench'); d.next();
  d.wait(7000);
  const before = d.s.stimulus();
  d.send('visibility', { state: 'visible-blurred' });
  assert.deepEqual(stims(d).pop(), { type: 'stim', on: false });
  assert.equal(d.s.stimulus(), null);
  assert.equal(d.s.visual(d.t).kind, 'none');
  d.wait(20000);
  assert.equal(d.state, S.SET);
  d.send('visibility', { state: 'visible' });
  assert.deepEqual(stims(d).pop(), { type: 'stim', on: true });
  const after = d.s.stimulus();
  assert.equal(after.t0 - before.t0, 20000, 'the timeline moved by the length of the pause');
  d.wait(7900);
  assert.equal(d.state, S.SET);
  d.wait(200);
  assert.equal(d.state, S.ROUND_CHECK);
  assert.equal(d.rec.rounds[0].set.ranMs, 12000);
});

test('headset off, a fault, or the session closing during a set: stimulation off, then closure', () => {
  const cases = {
    'headset off': (d) => { d.send('visibility', { state: 'hidden' }); assert.ok(stimIsOff(d)); d.wait(4000); d.send('visibility', { state: 'visible' }); },
    'frame-rate fault': (d) => d.send('fault', { kind: 'frame-rate' }),
    'frames stopped': (d) => d.send('fault', { kind: 'frames-stopped' }),
  };
  for (const [name, fire] of Object.entries(cases)) {
    const d = new Driver();
    d.start('bench'); d.next(); d.wait(8000);
    fire(d);
    assert.equal(d.state, S.TO_ROOM, name);
    assert.ok(stimIsOff(d), name);
    d.finish();
    assert.deepEqual(d.rec.flags, [], name + ' is recorded, not flagged');
    assert.equal(d.rec.setsRun, 1);
  }
  const d = new Driver();
  d.start('bench'); d.next(); d.wait(8000);
  d.s.abort(d.t, 'headset session closed');
  d.effects.push(...d.s.drainEffects());
  assert.ok(stimIsOff(d));
  assert.equal(d.rec.rounds[0].set.completed, false);
});

test('watchdog: a set that runs 20% over its length ends in closure and is recorded as a fault', () => {
  const d = new Driver();
  d.start('bench'); d.next();
  d.wait(10000);
  d.t += 8000; // the clock stalled: no ticks for 8 seconds, so the set is now 3 s past its end
  d.send('tick');
  assert.equal(d.state, S.TO_ROOM);
  assert.ok(stimIsOff(d));
  assert.equal(d.rec.faults[0].kind, 'set-overrun');
  assert.equal(d.rec.stop.trigger, 'fault:set-overrun');
  // Just inside the margin, the set ends normally.
  const e = new Driver();
  e.start('bench'); e.next();
  e.wait(10000);
  e.t += 7000;
  e.send('tick');
  assert.equal(e.state, S.ROUND_CHECK);
  assert.equal(e.rec.faults.length, 0);
});

test('watchdog: any timed step that ends 5 seconds late is recorded, and an exercise goes to closure', () => {
  const d = new Driver();
  d.start('breathing');
  d.wait(60000);
  d.t += 66000;
  d.send('tick');
  assert.equal(d.state, S.TO_ROOM);
  assert.equal(d.rec.faults[0].kind, 'step-overrun');
  // The fade back to the room is not an exercise: it is recorded and simply carries on.
  d.t += 30000;
  d.send('tick');
  assert.equal(d.state, S.REORIENT);
  assert.equal(d.rec.faults.length, 2);
});

test('session time cap with sets: the running set finishes and no new set starts', () => {
  const d = new Driver({ config: { sessionMinutes: 5 } });
  d.start('bench');
  d.wait(150000 - (d.t - T0) - 5000); // 5 seconds before the deadline
  d.next();
  assert.equal(d.state, S.SET, 'a set may start just before the deadline');
  d.through(S.SET);
  assert.equal(d.state, S.TO_ROOM, 'it finishes, and closure follows without a check');
  assert.equal(d.rec.rounds[0].set.completed, true);
  assert.equal(d.rec.setsRun, 1);
  const e = new Driver({ config: { sessionMinutes: 5 } });
  e.start('bench');
  e.wait(150000 - (e.t - T0) + 100);
  e.next();
  assert.equal(e.state, S.TO_ROOM, 'no set starts after the deadline');
  assert.equal(e.rec.setsRun, 0);
});

test('every word on every screen comes from the scripts file', () => {
  const all = JSON.stringify(SCRIPT);
  const words = new Set();
  for (const key of ['calm-place', 'breathing', 'grounding', 'bench']) {
    const d = new Driver({ config: { sets: { enabled: true }, cueWord: 'calm' } });
    d.clearCheckin();
    d.pick(key);
    let guard = 0;
    while (d.state !== S.ENDED && ++guard < 3000) {
      const sc = d.s.screen(d.t);
      for (const text of [sc.title].concat(sc.body, sc.options || [])) words.add(text);
      if (sc.kind === 'timed') d.wait(500);
      else if (sc.kind === 'rating') d.rate(8);
      else if (sc.kind === 'choice') d.choose(1);
      else if (sc.kind === 'yesno') d.yes();
      else d.next();
    }
  }
  const stripped = all.replace(/\{cue\}/g, 'calm').replace(/\\"/g, '"');
  for (const text of words) {
    if (/^Your therapist: /.test(text) || /^This session was flagged: /.test(text)) continue; // built from settings or flags
    assert.ok(stripped.includes(JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"')), 'not in the scripts file: ' + text);
  }
  assert.ok(words.size > 40);
});
