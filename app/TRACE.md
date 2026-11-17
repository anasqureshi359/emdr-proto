# Stop rules and the tests that cover them

Unit tests are in `test/machine.test.js` and `test/eligibility.test.js` (`npm test`). The emulated-headset checks drive the built page through an emulated Quest 3 passthrough session with emulated controllers, and read back the drawn frame (colour, alpha, the light's position); they are run by hand during development and are not part of `npm test`.

| Rule | Unit tests | Emulated headset |
| --- | --- | --- |
| Crisis "yes" shows the crisis card and offers no exercise | crisis "yes" shows the crisis card, saves at once, and offers no exercise | Crisis card shown, saved at once, then the page asks real or test |
| Check-in distress at or above the threshold, or feeling unreal: grounding only | distress at the threshold blocks the scene; one below is allowed in; feeling unreal blocks the scene | |
| A check-in question takes no answer for its first 2 seconds | ignores both answers until 2 seconds; early "yes" to the crisis question; every question has its own hold; grounding button works at once during the hold; paused time does not count; hold restarts with check-in; held screen shows the hold; cannot be switched off or shortened | Buttons hammered through check-in: no question answered in under 2 s |
| Tired, unwell or intoxicated: no session today | tired, unwell or intoxicated ends with "no session today"; unwell plus high distress | |
| Grounding button, from any screen | mid-round; during check-in; during closure; no effect on terminal screens; sweep "grounding button" from every state | B mid-round fades to the real room and starts grounding |
| Grounding steps cannot be skipped | each grounding step stays up for the minimum reading time | |
| "Something upsetting came up" | stops the session and flags it; sweep at every round check | |
| "Worse" once ends bilateral sets; "worse" twice stops the session | "worse" once; "worse" a second time | |
| Closing distress at the threshold, or 2 points above baseline | at the threshold; 2 above baseline; 1 above is not flagged | |
| Positive body check | shows rest advice and flags the session | |
| Session time cap | running round finishes and no new step starts; left waiting past the cap; sweep "session cap reached" | |
| Frame rate under 72 fps, or an uncaught error | fault during a round; fault during check-in; sweeps "frame-rate fault" and "uncaught error" | Slow frames in check-in are recorded; slow frames in the scene lead to closure |
| Headset taken off | mid-round leads to closure; during check-in restarts check-in; sweep "headset off and on" | Hidden then visible mid-round leads to closure |
| System menu pauses the clock and input | system menu (blurred, not hidden) | Paused while the menu is up; same round resumes |
| Session closed from outside | saved as incomplete | Saved as ended early; page asks real or test |
| Browser closed or crashed mid-session | | Snapshot recovered on reload as an ended-early session |
| Real or test | asked for flagged sessions in the testing profile; final profile treats a flag as real | Both answers on the page, with and without the pause |
| 4-hour pause after a real flagged session | blocks for 4 hours in the testing profile too; "test" adds no pause; cannot be configured away; unanswered blocks until answered | Start disabled, banner shows the time |
| Two flagged sessions in a row, or review overdue: bilateral sets lock | two real flags in a row; review older than 30 days | |
| Daily limit and gap (final profile); none while testing | one session a day; the gap; testing has no limit; break reminder; profile ends 14 days after the pilot starts | |
| Hard limits on settings | settings are forced inside their hard limits | |
| No screen may stall or wait without progress | timed states move on by the clock alone; every waiting screen shows progress or a hint | Spike page completes with pulse confirmations that never arrive |
| The exercise is chosen in the real room; no scene loads before it | choice screen offers three exercises; a clear check-in shows the choice with no fade; grounding exercise loads no scene | Grounding exercise: the scene never fades in |
| Engine test only while testing, and never while sets are locked | choice screen: not offered in the final profile, when locked, or when switched off | |
| The lock: no bilateral set inside calm place unless sets are switched on and unlocked | sets off by default; the start-rule lock closes them; calm place with sets locked runs no set and never switches the engine on | Calm place: three cue rounds, no set |
| Ceilings: 1.0 passes a second, 12 passes, 4 sets, 30 degrees, 10 s rest | sweep of over 90,000 settings combinations through both checks; ceilings hold in a running session | Set 1 runs at 0.5 passes a second, 6 passes, 20 degrees |
| The rest between sets cannot be skipped | no button shortens the rest; sets at least 10 s apart | Rest shown before set 2 |
| Stimulation exists only inside a set | stimulation is off in every state except a running set; sweeps check it after every trigger and at the end of every session | |
| Grounding button during a set: light and tone off on the same press | grounding button during a set (four moments, lead-in included) | Light gone on the next frame; scene fades to alpha 0; scene sound off |
| System menu during a set pauses it; headset off ends it | system menu during a set; headset off, a fault, or the session closing during a set | Both, in one emulated set |
| Watchdogs: a set 20% over its length, or any timed step 5 s late | set watchdog (and just inside the margin); step watchdog | |
| "Worse" after a set ends sets for the session | next round uses the cue word | Emulated, with sets switched on by a test hook |
| Mild-annoyance step: once, cue word only, skipped after a "worse" | skipped after a "worse" and when switched off; never runs with a set even when one is unused | |
| Session cap with sets | the running set finishes and no new set starts | |
| Paced breathing: 4 s in, 6 s out, 2 minutes, one check | timing of every breath; light fullest at the end of the in-breath; engine never switched on | Light swells and shrinks at the centre; pause and headset-off |
| Calm place sequence | invite, four 10-second prompts, cue word, three rounds, annoyance step, close | Full session in the quiet room |
| Every word on screen comes from the scripts file | walk of every exercise compares each screen's text with the file | |

Each rule was also checked by breaking it on purpose: 44 deliberate changes to the logic (for example, "upsetting no longer stops", "pause shortened to 1 hour", "leaving a set does not switch stimulation off" or "speed ceiling raised to 2") each made at least one test fail.

Not covered yet, because they need the headset: the grounding exit timed during a set, light and tone sync measured by ear and eye, frame rate with each scene loaded and at each render scale, the fade on the real display, the pulse channel (off by default), offline use and comfort runs. The app logs frame rate, tone lateness and the longest frame gap for every set, so headset runs fill most of these in.

The emulator renders too slowly for the frame-rate monitor, so the emulated tests set a page flag (`__SHELL_TEST_NO_FRAME_RATE_FAULT`) that switches the monitor off. The page shows a warning whenever that flag is set, and one emulated test runs with the monitor on.

A second test flag (`__SHELL_TEST_SETS_ON`) lets the emulated tests switch sets on inside calm place for one page load. It stores nothing, and the page shows a warning while it is in force.
