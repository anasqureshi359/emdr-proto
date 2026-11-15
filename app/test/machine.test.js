// One test (or more) for every stop rule in the design spec, plus an exhaustive
// check that no trigger, from any state, can lead back into an exercise.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, S, EXERCISE_STATES, CHECKIN_STATES, TERMINAL_SCREENS, GROUNDING_STEPS, REORIENT_STEPS } from '../src/core/machine.js';

const T0 = Date.parse('2026-11-14T15:00:00Z');

/** Drives a session the way the app would, with a fake clock. */
class Driver {
  constructor(opts = {}) {
    this.t = opts.now || T0;
    this.s = createSession({ config: opts.config || {}, now: this.t, profile: opts.profile || 'testing' });
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
  yes() { this.send('primary'); }
  no() { this.send('secondary'); }
  rate(v) {
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

  /** Check-in answered so that the full session starts. */
  clearCheckin(distress = 3) {
    this.no();
    this.rate(distress);
    this.no();
    this.no();
  }
  toRound() {
    this.clearCheckin();
    this.wait(this.s.config.sceneFadeInMs + 100);
    this.rate(5);
    assert.equal(this.state, S.ROUND);
  }
  toRoundCheck() {
    this.toRound();
    this.wait(this.s.config.roundSeconds * 1000 + 100);
    assert.equal(this.state, S.ROUND_CHECK);
  }
  /** Answer everything in the calmest way until the session ends. */
  finish({ closingDistress = 1, real = true } = {}) {
    let guard = 0;
    while (this.state !== S.ENDED) {
      if (++guard > 500) throw new Error('session did not end; stuck in ' + this.state);
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

/* ---------------------------------------------------------------- check-in routing */

test('a clear check-in runs the full session and saves an unflagged record', () => {
  const d = new Driver();
  d.clearCheckin(3);
  assert.equal(d.state, S.SCENE_IN);
  assert.deepEqual(d.effects[0], { type: 'fade', to: 1, ms: d.s.config.sceneFadeInMs });
  d.finish();
  assert.equal(d.rec.route, 'full');
  assert.equal(d.rec.completed, true);
  assert.equal(d.rec.rounds.length, 3);
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
  assert.equal(d.state, S.SCENE_IN);
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
  d.toRoundCheck();
  d.choose(0); d.wait(21000); d.choose(0); d.wait(21000); d.choose(0); // three calm rounds
  d.wait(1200);
  assert.equal(d.state, S.REORIENT);
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
  d.wait(d.s.config.roundSeconds * 1000 + 100);
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
  d.clearCheckin(baseline);
  d.wait(1600); d.rate(5);
  for (let i = 0; i < 3; i++) { d.wait(20100); d.choose(1); }
  d.wait(1200);
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
  // 5-minute cap with 150 s kept for closure leaves 150 s for rounds of 60 s each.
  const d = new Driver({ config: { sessionMinutes: 5, rounds: 6, roundSeconds: 60 } });
  d.clearCheckin(); d.wait(1600); d.rate(5);
  d.wait(60100); d.choose(1);
  d.wait(60100); d.choose(1);
  assert.equal(d.state, S.ROUND, 'third round starts before the deadline');
  d.wait(60100);
  assert.equal(d.state, S.TO_ROOM, 'no check and no fourth round after the deadline');
  assert.equal(d.rec.rounds.length, 3);
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
  assert.ok(p > 0.2 && p < 0.3, 'the round resumes at 5 of 20 seconds, got ' + p);
  d.wait(15100);
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
  const d = new Driver();
  let guard = 0;
  const seen = new Set();
  const check = () => {
    const sc = d.s.screen(d.t);
    if (sc.state === S.ENDED) return;
    seen.add(sc.state);
    const hasProgress = typeof sc.progress === 'number';
    assert.ok(hasProgress || sc.hint.length > 0, `screen ${sc.state} has neither progress nor a hint`);
  };
  d.clearCheckin(); check();
  while (d.state !== S.ENDED && ++guard < 400) {
    check();
    const sc = d.s.screen(d.t);
    if (sc.kind === 'timed') d.wait(500);
    else if (sc.kind === 'rating') d.rate(8); // high closing distress, to visit the contact screen too
    else if (sc.kind === 'choice') d.choose(1);
    else if (sc.kind === 'yesno') d.yes(); // "yes" to the body check, "real" to real-or-test
    else { check(); d.wait(1000); check(); d.next(); }
  }
  for (const s of [S.SCENE_IN, S.ROUND, S.ROUND_CHECK, S.TO_ROOM, S.REORIENT, S.CONTACT, S.GROUND, S.BODY, S.ADVICE, S.REAL_OR_TEST, S.DONE]) {
    assert.ok(seen.has(s), 'walk did not visit ' + s);
  }
});

/* ---------------------------------------------------------------- exhaustive sweep */

// Reach every state of a session, fire every trigger there, and check the rule the
// spec's test table asks for: each ends in grounding or closure, none reaches an exercise.
function reachAll() {
  const paths = [];
  const add = (name, fn) => paths.push({ name, fn });
  add(S.CHECK_CRISIS, () => {});
  add(S.CHECK_DISTRESS, (d) => d.no());
  add(S.CHECK_UNREAL, (d) => { d.no(); d.rate(3); });
  add(S.CHECK_UNWELL, (d) => { d.no(); d.rate(3); d.no(); });
  add(S.SCENE_IN, (d) => d.clearCheckin());
  add(S.BASE_CALM, (d) => { d.clearCheckin(); d.wait(1600); });
  add(S.ROUND, (d) => d.toRound());
  add(S.ROUND_CHECK, (d) => d.toRoundCheck());
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
  for (const p of reachAll()) {
    const d = new Driver();
    p.fn(d);
    assert.equal(d.state, p.name);
  }
});

for (const [tname, fire] of Object.entries(TRIGGERS)) {
  test(`sweep: "${tname}" from every state ends the session without re-entering an exercise`, () => {
    for (const p of reachAll()) {
      const d = new Driver();
      p.fn(d);
      const wasExercise = EXERCISE_STATES.has(d.state);
      const wasCheckin = CHECKIN_STATES.has(d.state);
      fire(d);
      const mark = d.visited.length - 1;
      // From an exercise state the trigger must leave the exercise at once.
      if (wasExercise) assert.ok(!EXERCISE_STATES.has(d.state), `${tname} from ${p.name}: still in ${d.state}`);
      d.finish();
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
    for (let k = 1; k < round; k++) { d.choose(0); d.wait(20100); }
    const mark = d.visited.length;
    d.choose(3);
    d.finish();
    assert.ok(!enteredExerciseAfter(d, mark), 'round ' + round);
    assert.equal(d.rec.rounds.length, round);
  }
});
