// Limits and defaults for the app. Values follow the design spec.
// HARD limits are fixed in code: no setting can go past them.

export const HARD = Object.freeze({
  sessionMinutesMax: 20,
  finalSessionsPerDayMax: 2,
  finalGapHoursMin: 2,
  distressBlockMax: 8,
  distressBlockMin: 5,
  flaggedPauseHours: 4, // cannot be switched off or shortened
  checkinHoldMsMin: 2000, // a check-in question cannot take an answer sooner than this
  // Ceilings on bilateral sets. The engine applies these itself, whatever the settings say.
  setSpeedMax: 1.0, // passes per second; one pass is a full left-right-left movement
  setPassesMax: 12,
  setsPerSessionMax: 4,
  sweepDegMax: 30, // each side of centre
  setPauseMsMin: 10000, // rest between sets; cannot be skipped
});

/** The range the therapist may set, inside the ceilings above. */
export const SET_RANGE = Object.freeze({
  speed: [0.3, 0.8],
  passes: [4, 12],
  perSession: [1, 4],
  sweepDeg: [10, 25],
});

export const DEFAULTS = Object.freeze({
  profile: 'testing', // 'testing' while the prototype is tested, 'final' afterwards
  sessionMinutes: 10,
  closureReserveSeconds: 150, // time kept back for closure inside the session cap
  distressBlock: 7, // check-in distress at or above this blocks the virtual scene
  flagRise: 2, // closing distress this far above baseline flags the session
  reviewEveryDays: 30,
  reviewedOn: '2026-11-13',
  pilotStartedAt: null, // ms; the testing profile ends 14 days after this unless renewed
  testingRenewedAt: null,
  final: { sessionsPerDay: 1, gapHours: 4 },
  testing: { breakAfterMinutes: 30, breakMinutes: 15, lengthDays: 14 },
  scene: 'room', // 'room' (stylized quiet room) or 'lake' (lakeshore at dusk)
  cueWord: 'calm', // placeholder until the cue word from therapy is entered
  breathing: { inSeconds: 4, outSeconds: 6, minutes: 2 },
  calmPlace: { senseSeconds: 10, annoyanceStep: true },
  rounds: 3, // strengthening rounds in calm place
  roundSeconds: 30, // one cue-word round: about three slow breaths
  sets: {
    enabled: false, // the lock: sets inside calm place stay off until the therapist's walkthrough
    bench: true, // engine test, offered in the testing profile only
    speed: 0.5,
    passes: 6,
    perSession: 3,
    sweepDeg: 20,
    pauseMs: 10000,
    leadMs: 3000, // the light appears and holds still before it starts to move
    channels: { light: true, tone: true, pulse: false },
  },
  renderScale: 1,
  sceneSound: true,
  minDwellMs: 2500, // shortest time a reading step stays up before "continue" works
  checkinHoldMs: 2000, // each check-in question ignores answers for this long, so it cannot be clicked through
  sceneFadeInMs: 1500,
  toRoomFadeMs: 1000,
  frameRateFloor: 71, // "under 72 fps", with 1 fps of tolerance for jitter
  frameRateWindowMs: 2000,
  crisisCard: {
    therapist: 'Sample Therapist (placeholder)',
    phone: '000-000-0000 (placeholder)',
    hours: 'Sample hours (placeholder)',
  },
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Returns a config with every adjustable value forced inside its hard limit. */
export function normalizeConfig(input = {}) {
  const c = { ...DEFAULTS, ...input };
  c.final = { ...DEFAULTS.final, ...(input.final || {}) };
  c.testing = { ...DEFAULTS.testing, ...(input.testing || {}) };
  c.crisisCard = { ...DEFAULTS.crisisCard, ...(input.crisisCard || {}) };
  c.profile = c.profile === 'final' ? 'final' : 'testing';
  c.sessionMinutes = clamp(Number(c.sessionMinutes) || DEFAULTS.sessionMinutes, 5, HARD.sessionMinutesMax);
  c.distressBlock = clamp(Math.round(Number(c.distressBlock) || DEFAULTS.distressBlock), HARD.distressBlockMin, HARD.distressBlockMax);
  c.final.sessionsPerDay = clamp(Math.round(Number(c.final.sessionsPerDay) || 1), 1, HARD.finalSessionsPerDayMax);
  c.final.gapHours = clamp(Number(c.final.gapHours) || DEFAULTS.final.gapHours, HARD.finalGapHoursMin, 12);
  c.rounds = clamp(Math.round(Number(c.rounds) || DEFAULTS.rounds), 1, 6);
  c.roundSeconds = clamp(Number(c.roundSeconds) || DEFAULTS.roundSeconds, 5, 120);
  c.checkinHoldMs = clamp(Number(c.checkinHoldMs) || DEFAULTS.checkinHoldMs, HARD.checkinHoldMsMin, 5000);
  c.scene = c.scene === 'lake' ? 'lake' : 'room';
  c.cueWord = cleanCueWord(c.cueWord);
  c.breathing = { ...DEFAULTS.breathing, ...(input.breathing || {}) };
  c.breathing.inSeconds = clamp(Number(c.breathing.inSeconds) || 4, 3, 6);
  c.breathing.outSeconds = clamp(Number(c.breathing.outSeconds) || 6, 4, 8);
  c.breathing.minutes = clamp(Number(c.breathing.minutes) || 2, 1, 3);
  c.calmPlace = { ...DEFAULTS.calmPlace, ...(input.calmPlace || {}) };
  c.calmPlace.senseSeconds = clamp(Number(c.calmPlace.senseSeconds) || 10, 5, 20);
  c.calmPlace.annoyanceStep = c.calmPlace.annoyanceStep !== false;
  c.sets = normalizeSets(input.sets);
  c.renderScale = clamp(Number(c.renderScale) || 1, 1, 1.5);
  c.sceneSound = c.sceneSound !== false;
  return c;
}

/** Letters, spaces, hyphens and apostrophes only, 24 characters at most. */
export function cleanCueWord(word) {
  const w = String(word === undefined || word === null ? '' : word).replace(/[^\p{L}\p{M} '\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  return w || DEFAULTS.cueWord;
}

const num = (x, fallback) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : fallback);

/** Set settings forced into the therapist's range. */
export function normalizeSets(input) {
  const d = DEFAULTS.sets;
  const s = { ...d, ...(input || {}) };
  const ch = { ...d.channels, ...((input && input.channels) || {}) };
  const channels = { light: ch.light === true, tone: ch.tone === true, pulse: ch.pulse === true };
  if (!channels.light && !channels.tone && !channels.pulse) channels.light = true; // at least one channel
  return {
    enabled: s.enabled === true,
    bench: s.bench !== false,
    speed: clamp(num(s.speed, d.speed), SET_RANGE.speed[0], SET_RANGE.speed[1]),
    passes: clamp(Math.round(num(s.passes, d.passes)), SET_RANGE.passes[0], SET_RANGE.passes[1]),
    perSession: clamp(Math.round(num(s.perSession, d.perSession)), SET_RANGE.perSession[0], SET_RANGE.perSession[1]),
    sweepDeg: clamp(num(s.sweepDeg, d.sweepDeg), SET_RANGE.sweepDeg[0], SET_RANGE.sweepDeg[1]),
    pauseMs: Math.max(HARD.setPauseMsMin, num(s.pauseMs, d.pauseMs)),
    leadMs: clamp(num(s.leadMs, d.leadMs), 2000, 6000),
    channels,
  };
}

/**
 * What the engine actually runs. It trusts nothing it is given: whatever arrives,
 * the result is inside the fixed ceilings. This is a second, separate check from
 * normalizeSets, so a mistake in the settings code cannot reach the user.
 */
export function effectiveSet(sets) {
  const d = DEFAULTS.sets;
  const s = sets || {};
  const pos = (x, fallback) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : fallback);
  const ch = s.channels || {};
  const channels = { light: ch.light === true, tone: ch.tone === true, pulse: ch.pulse === true };
  if (!channels.light && !channels.tone && !channels.pulse) channels.light = true;
  return {
    speed: Math.min(HARD.setSpeedMax, Math.max(0.1, pos(s.speed, d.speed))),
    passes: Math.min(HARD.setPassesMax, Math.max(1, Math.round(pos(s.passes, d.passes)))),
    perSession: Math.min(HARD.setsPerSessionMax, Math.max(1, Math.round(pos(s.perSession, d.perSession)))),
    sweepDeg: Math.min(HARD.sweepDegMax, Math.max(1, pos(s.sweepDeg, d.sweepDeg))),
    pauseMs: Math.max(HARD.setPauseMsMin, pos(s.pauseMs, d.pauseMs)),
    leadMs: Math.min(6000, Math.max(1000, pos(s.leadMs, d.leadMs))),
    channels,
  };
}
