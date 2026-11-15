// Limits and defaults for the safety shell. Values follow the design spec.
// HARD limits are fixed in code: no setting can go past them.

export const HARD = Object.freeze({
  sessionMinutesMax: 20,
  finalSessionsPerDayMax: 2,
  finalGapHoursMin: 2,
  distressBlockMax: 8,
  distressBlockMin: 5,
  flaggedPauseHours: 4, // cannot be switched off or shortened
  checkinHoldMsMin: 2000, // a check-in question cannot take an answer sooner than this
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
  rounds: 3, // placeholder rounds in this build: there are no exercises yet
  roundSeconds: 20,
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
  return c;
}
