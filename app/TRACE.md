# Stop rules and the tests that cover them

Unit tests are in `test/machine.test.js` and `test/eligibility.test.js` (`npm test`). The emulated-headset checks drive the built page through an emulated Quest 3 passthrough session with emulated controllers; they are run by hand during development and are not part of `npm test`.

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

Each rule was also checked by breaking it on purpose: eighteen deliberate changes to the logic (for example, "upsetting no longer stops", "pause shortened to 1 hour" or "no hold on the grip answer") each made at least one test fail.

Not covered yet, because they need the headset or later build steps: grounding exit timing on the device, ceilings on bilateral settings, channel sync, frame rate with the real scenes, offline use and comfort runs.

The emulator renders too slowly for the frame-rate monitor, so the emulated tests set a page flag (`__SHELL_TEST_NO_FRAME_RATE_FAULT`) that switches the monitor off. The page shows a warning whenever that flag is set, and one emulated test runs with the monitor on.
