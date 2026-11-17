// Prints every word the app shows in the headset, as markdown, for the therapist to review.
// Run with: node tools/scripts-doc.mjs
import { SCRIPT as S } from '../src/core/scripts.js';

const cue = (t) => String(t).replace(/\{cue\}/g, '[cue word]').replace(/\{triggers\}/g, '[what was flagged]');
const out = [];
const h = (t) => out.push('', '## ' + t, '');
const table = (head, rows) => { out.push('| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'); for (const r of rows) out.push('| ' + r.map((c) => cue(Array.isArray(c) ? c.join(' / ') : c)).join(' | ') + ' |'); out.push(''); };
const cp = S.calmPlace;
const cl = S.closing;

h('Check-in');
out.push('Shown in the real-room view. Each question takes no answer for its first 2 seconds.', '');
table(['Screen', 'Text', 'Answers'], [
  ['1 of 4', S.checkin.crisis, 'Yes: crisis card. No: next question'],
  ['2 of 4', S.checkin.distress, `0 (${S.scales.distress[0]}) to 10 (${S.scales.distress[1]}). At 7 or above: grounding only`],
  ['3 of 4', S.checkin.unreal, 'Yes: grounding only. No: next question'],
  ['4 of 4', S.checkin.unwell, 'Yes: no session today. No: the exercise choice'],
]);
table(['Screen', 'Heading', 'Text'], [
  ['Crisis card', `${S.crisisCard.kicker}: ${S.crisisCard.title}`, ['Your therapist: [name, phone, hours]', S.crisisCard.lifeline, S.crisisCard.emergency]],
  ['No session today', S.notToday.title, [S.notToday.body, `${S.notToday.highDistress} (only if distress was high or the user felt unreal)`, S.notToday.off]],
]);

h('Exercise choice');
table(['Heading', 'Options'], [[S.menu.title, Object.values(S.menu.options)]]);
table(['Screen', 'Heading', 'Text'], [
  ['Scene loads', S.sceneIn.title, S.sceneIn.body],
  ['Baseline rating', S.baselineCalm.title, `0 (${S.scales.calm[0]}) to 10 (${S.scales.calm[1]})`],
]);

h('Paced breathing');
out.push('Two minutes. A light swells for 4 seconds and shrinks for 6, and the heading changes with it.', '');
table(['Heading', 'Text'], [[`${S.breathing.in} / ${S.breathing.out}`, S.breathing.body]]);

h('Calm place');
table(['Step', 'Heading', 'Text', 'How it moves on'], [
  ['Invite', cp.invite.title, cp.invite.body, 'Trigger'],
  ...cp.sense.map((q, i) => [`Sense prompt ${i + 1} of 4`, q, cp.senseBody, 'By itself after 10 seconds']),
  ['Cue word', cp.cue.title, cp.cue.body, 'Trigger'],
  ['Round 1 to 3, cue word only', cp.round.title, cp.round.body, 'By itself after 30 seconds, then the check'],
  ['Round 1 to 3, with a bilateral set (locked)', cp.set.title, cp.set.body, 'By itself after the set, then the check'],
  ['Rest between sets', S.rest.title, S.rest.body, 'By itself; at least 10 seconds between sets'],
  ['Mild annoyance', cp.annoyance.title, cp.annoyance.body, 'Trigger'],
  ['Mild annoyance, cue word', cp.annoyanceRound.title, cp.annoyanceRound.body, 'By itself after 30 seconds, then the check'],
  ['Close', cp.end.title, cp.end.body, 'Trigger'],
]);
out.push('The mild-annoyance step runs once, after the last round, with the cue word only. It is skipped if any round was answered "worse".', '');

h('The check after each round or set');
table(['Heading', 'Answers'], [[S.check.title, S.check.options]]);
out.push('"Worse" once ends bilateral sets for the session. "Worse" twice, or "Something upsetting came up", stops the session and starts grounding.', '');

h('Engine test (testing profile only)');
table(['Step', 'Heading', 'Text'], [
  ['Intro', S.bench.intro.title, S.bench.intro.body],
  ['Set', S.bench.set.title, S.bench.set.body],
]);

h('Grounding');
out.push('Used as an exercise, by the grounding button, and whenever a stop rule fires. Always in the real-room view.', '');
table(['Step', 'Heading', 'Text'], S.grounding.map((g, i) => [`${i + 1} of ${S.grounding.length}`, g[0], g[1]]));

h('Closure');
table(['Step', 'Heading', 'Text'], [
  ['Leaving the scene', S.toRoom.title, S.toRoom.body],
  ...S.reorient.map((g, i) => [`Reorient ${i + 1} of ${S.reorient.length}`, g[0], g[1]]),
  ['Rating', cl.distress, `0 (${S.scales.distress[0]}) to 10 (${S.scales.distress[1]})`],
  ['Rating', cl.calm, `0 (${S.scales.calm[0]}) to 10 (${S.scales.calm[1]})`],
  ['High closing distress', cl.contact.title, ['Your therapist: [name, phone, hours]', cl.contact.next]],
  ['Body check', cl.body.title, `${cl.body.body} (Yes or No)`],
  ['After a yes to the body check', cl.advice.title, cl.advice.body],
  ['Flagged session, testing profile', cl.realOrTest.title, [cl.realOrTest.flagged, cl.realOrTest.pause, 'Answers: REAL or TEST']],
  ['End', cl.done.title, [`${cl.done.clean} / ${cl.done.flagged} / ${cl.done.test}`, cl.done.off]],
]);

h('Button hints shown at the foot of the panel');
table(['Hint'], Object.values(S.hints).map((x) => [x.replace(/\s{2,}/g, ' · ')]));

console.log(out.join('\n').trim());
