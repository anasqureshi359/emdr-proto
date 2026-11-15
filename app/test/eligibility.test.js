// Tests for the rules that decide whether a session may start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, HARD } from '../src/core/config.js';
import { eligibility, activeProfile, needsAnswer, minutesSinceBreak } from '../src/core/eligibility.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime(); // local 3 pm, so "today" has room either side

let seq = 0;
function session(startedAgoMs, opts = {}) {
  const startedAt = NOW - startedAgoMs;
  return {
    id: 's' + ++seq,
    startedAt,
    endedAt: startedAt + (opts.minutes === undefined ? 8 : opts.minutes) * 60000,
    route: opts.route || 'full',
    flags: opts.flagged ? [{ at: startedAt, trigger: opts.trigger || 'grounding-button' }] : [],
    real: opts.real === undefined ? (opts.flagged ? true : null) : opts.real,
    completed: opts.completed === undefined ? true : opts.completed,
  };
}
const elig = (history, cfg = {}, now = NOW) => eligibility({ config: normalizeConfig(cfg), history, now });

test('no history: a session may start, in the testing profile', () => {
  const e = elig([]);
  assert.equal(e.canStart, true);
  assert.equal(e.profile, 'testing');
  assert.equal(e.setsLocked, false);
});

test('a real flagged session blocks the next one for 4 hours, in the testing profile too', () => {
  const s = session(1 * HOUR, { flagged: true, real: true });
  const e = elig([s]);
  assert.equal(e.canStart, false);
  assert.equal(e.reason, 'pause');
  assert.equal(e.until, s.endedAt + 4 * HOUR);
  assert.equal(elig([s], {}, s.endedAt + 4 * HOUR - 1000).canStart, false);
  assert.equal(elig([s], {}, s.endedAt + 4 * HOUR + 1000).canStart, true);
});

test('a flagged session marked "test" adds no pause', () => {
  assert.equal(elig([session(10 * 60000, { flagged: true, real: false })]).canStart, true);
});

test('the 4-hour pause cannot be configured away', () => {
  const cfg = normalizeConfig({ flaggedPauseHours: 0, final: { gapHours: 0 } });
  assert.equal(HARD.flaggedPauseHours, 4);
  const e = eligibility({ config: cfg, history: [session(1 * HOUR, { flagged: true, real: true })], now: NOW });
  assert.equal(e.reason, 'pause');
});

test('a flagged session with no real-or-test answer blocks until it is answered', () => {
  const s = session(5 * HOUR, { flagged: true, real: null });
  const e = elig([s]);
  assert.equal(e.canStart, false);
  assert.equal(e.reason, 'needs-answer');
  assert.equal(e.pendingAnswer, s.id);
});

test('a session that ended early after check-in needs an answer; one that ended in check-in does not', () => {
  assert.equal(needsAnswer(session(HOUR, { completed: false, real: null })), true);
  assert.equal(needsAnswer(session(HOUR, { completed: false, real: null, route: 'ended-in-check-in' })), false);
  assert.equal(elig([session(HOUR, { completed: false, real: null, route: 'ended-in-check-in' })]).canStart, true);
});

test('a crisis-card session needs an answer, then pauses for 4 hours if real', () => {
  const s = session(30 * 60000, { route: 'crisis-card', flagged: true, trigger: 'crisis', real: null, minutes: 0 });
  assert.equal(elig([s]).reason, 'needs-answer');
  s.real = true;
  assert.equal(elig([s]).reason, 'pause');
});

test('testing profile: no daily limit and no gap', () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push(session((10 - i) * 20 * 60000 + 16 * 60000, { minutes: 2 }));
  const e = elig(many);
  assert.equal(e.canStart, true);
});

test('testing profile: break reminder after 30 minutes of use, cleared by a 15-minute break', () => {
  const backToBack = [session(41 * 60000, { minutes: 10 }), session(30 * 60000, { minutes: 10 }), session(19 * 60000, { minutes: 10 }), session(8 * 60000, { minutes: 8 })];
  const e = elig(backToBack);
  assert.equal(e.canStart, true, 'a reminder, not a block');
  assert.ok(e.notices.some((n) => n.kind === 'break'));
  assert.ok(minutesSinceBreak(backToBack, NOW, 15) >= 30);
  const rested = elig(backToBack, {}, NOW + 16 * 60000);
  assert.ok(!rested.notices.some((n) => n.kind === 'break'));
});

test('final profile: one session a day', () => {
  const e = elig([session(6 * HOUR)], { profile: 'final' });
  assert.equal(e.canStart, false);
  assert.equal(e.reason, 'daily-cap');
  assert.equal(elig([session(6 * HOUR)], { profile: 'final' }, NOW + DAY).canStart, true);
});

test('final profile: the gap between sessions applies when two a day are allowed', () => {
  const cfg = { profile: 'final', final: { sessionsPerDay: 2, gapHours: 4 } };
  assert.equal(elig([session(2 * HOUR)], cfg).reason, 'gap');
  assert.equal(elig([session(5 * HOUR)], cfg).canStart, true);
});

test('"no session today" and crisis-card visits do not count toward the daily limit', () => {
  const e = elig([session(2 * HOUR, { route: 'not-today', minutes: 0 })], { profile: 'final' });
  assert.equal(e.canStart, true);
});

test('the testing profile ends 14 days after the pilot starts, unless renewed', () => {
  const cfg = normalizeConfig({ pilotStartedAt: NOW - 15 * DAY });
  assert.equal(activeProfile(cfg, NOW), 'final');
  assert.equal(activeProfile(normalizeConfig({ pilotStartedAt: NOW - 13 * DAY }), NOW), 'testing');
  assert.equal(activeProfile(normalizeConfig({ pilotStartedAt: NOW - 15 * DAY, testingRenewedAt: NOW - DAY }), NOW), 'testing');
  assert.equal(activeProfile(normalizeConfig({ pilotStartedAt: null }), NOW), 'testing', 'before the pilot there is no end date');
  assert.equal(elig([session(6 * HOUR)], { pilotStartedAt: NOW - 15 * DAY }).reason, 'daily-cap', 'final limits apply once it has ended');
});

test('two real flagged sessions in a row lock bilateral sets; a test stop does not count', () => {
  const two = [session(30 * HOUR, { flagged: true, real: true }), session(20 * HOUR, { flagged: true, real: true })];
  assert.equal(elig(two).setsLocked, true);
  const mixed = [session(30 * HOUR, { flagged: true, real: true }), session(20 * HOUR, { flagged: true, real: false })];
  assert.equal(elig(mixed).setsLocked, false);
  const broken = [session(40 * HOUR, { flagged: true, real: true }), session(30 * HOUR), session(20 * HOUR, { flagged: true, real: true })];
  assert.equal(elig(broken).setsLocked, false);
});

test('a settings review older than 30 days locks bilateral sets and says so', () => {
  const e = elig([], { reviewedOn: '2026-10-01' });
  assert.equal(e.setsLocked, true);
  assert.ok(e.notices.some((n) => n.kind === 'review'));
  assert.equal(elig([], { reviewedOn: '2026-11-13' }).setsLocked, false);
});

test('settings are forced inside their hard limits', () => {
  const c = normalizeConfig({ sessionMinutes: 60, distressBlock: 10, final: { sessionsPerDay: 5, gapHours: 0.5 } });
  assert.equal(c.sessionMinutes, 20);
  assert.equal(c.distressBlock, 8);
  assert.equal(c.final.sessionsPerDay, 2);
  assert.equal(c.final.gapHours, 2);
  assert.equal(normalizeConfig({ distressBlock: 1 }).distressBlock, 5);
});
