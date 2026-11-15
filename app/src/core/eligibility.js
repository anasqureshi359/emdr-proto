// Pure rules for whether a session may start: the pause after a real stop,
// daily caps, the testing profile and the lock on bilateral sets.

import { HARD } from './config.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

/** Sessions that count as use of the app: they got past check-in. */
export const countsAsSession = (r) => r.route === 'full' || r.route === 'grounding-only';

/** A stop or flag that has not been marked "test". Unanswered counts as real. */
export const isRealFlag = (r) => (r.flags && r.flags.length > 0) && r.real !== false;

/** A flagged or ended-early session that still needs the "real or test?" answer. */
export function needsAnswer(r) {
  if (r.real !== null && r.real !== undefined) return false;
  if (r.flags && r.flags.length > 0) return true;
  return !r.completed && countsAsSession(r);
}

export function activeProfile(config, now) {
  if (config.profile === 'final') return 'final';
  const from = config.testingRenewedAt || config.pilotStartedAt;
  if (from && now > from + config.testing.lengthDays * DAY) return 'final';
  return 'testing';
}

const sameLocalDay = (a, b) => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

function startOfNextLocalDay(t) {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Minutes of headset use since the last break of at least `breakMinutes`. */
export function minutesSinceBreak(history, now, breakMinutes) {
  const sessions = history.filter(countsAsSession).slice().sort((a, b) => a.startedAt - b.startedAt);
  let total = 0;
  let cursor = now;
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    const end = s.endedAt || s.startedAt;
    if (cursor - end >= breakMinutes * 60000) break;
    total += Math.max(0, end - s.startedAt);
    cursor = s.startedAt;
  }
  return total / 60000;
}

export function eligibility({ config, history, now }) {
  const profile = activeProfile(config, now);
  const out = { canStart: true, reason: null, until: null, message: '', profile, notices: [], setsLocked: false, lockReason: null, pendingAnswer: null };
  const sessions = history.slice().sort((a, b) => a.startedAt - b.startedAt);

  // 1. An unanswered stop blocks everything until the user says whether it was real.
  const pending = sessions.filter(needsAnswer).pop();
  if (pending) {
    out.canStart = false;
    out.reason = 'needs-answer';
    out.pendingAnswer = pending.id;
    out.message = 'The last session stopped early or was flagged. Say whether that was real or a test before starting again.';
  }

  // 2. The pause after a real flagged session. Fixed in code, in every profile.
  const lastReal = sessions.filter((r) => isRealFlag(r) && !needsAnswer(r)).pop();
  if (out.canStart && lastReal) {
    const until = (lastReal.endedAt || lastReal.startedAt) + HARD.flaggedPauseHours * HOUR;
    if (now < until) {
      out.canStart = false;
      out.reason = 'pause';
      out.until = until;
      out.message = 'A session was flagged, so the next one waits 4 hours.';
    }
  }

  // 3. Daily caps apply in the final profile only.
  const counted = sessions.filter(countsAsSession);
  if (out.canStart && profile === 'final') {
    const today = counted.filter((r) => sameLocalDay(r.startedAt, now));
    const last = counted[counted.length - 1];
    if (today.length >= config.final.sessionsPerDay) {
      out.canStart = false;
      out.reason = 'daily-cap';
      out.until = startOfNextLocalDay(now);
      out.message = 'Today\'s session limit is reached.';
    } else if (last && now < (last.endedAt || last.startedAt) + config.final.gapHours * HOUR) {
      out.canStart = false;
      out.reason = 'gap';
      out.until = (last.endedAt || last.startedAt) + config.final.gapHours * HOUR;
      out.message = 'The gap between sessions has not passed yet.';
    }
  }

  // 4. Testing profile: no caps, but a break reminder after 30 minutes of use.
  if (profile === 'testing') {
    const used = minutesSinceBreak(history, now, config.testing.breakMinutes);
    if (used >= config.testing.breakAfterMinutes) {
      out.notices.push({ kind: 'break', message: `About ${Math.round(used)} minutes of headset use without a ${config.testing.breakMinutes}-minute break. Take one now.` });
    }
  }

  // 5. Lock on bilateral sets (none exist in this build; the state is tracked for later).
  const lastTwo = counted.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every(isRealFlag)) {
    out.setsLocked = true;
    out.lockReason = 'two flagged sessions in a row';
  }
  const reviewed = Date.parse(config.reviewedOn);
  if (!Number.isNaN(reviewed) && now - reviewed > config.reviewEveryDays * DAY) {
    out.setsLocked = true;
    out.lockReason = out.lockReason || 'settings review is overdue';
    out.notices.push({ kind: 'review', message: 'The therapist\'s review of the settings is overdue.' });
  }
  return out;
}
