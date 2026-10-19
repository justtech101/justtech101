# Phase 1 acceptance (Section 6)

Two columns: **Auto** means covered by `npm test` with fake Twilio/AI and a real
Postgres, which runs on every change. **Live** means it must also be checked by hand on the
staging number, then on production (Step 14). Phase 1 is done when every Live box is ticked.

## System 1 — missed-call text-back
| Criterion | Auto (test) | Live |
|---|---|---|
| Missed call on the live number gets an opener text in under 60 s, 3 times in a row | `textback.test.ts` "three calls in a row" | [ ] [ ] [ ] (3 different phones) |
| A second missed call within 24 h sends no duplicate opener | "no duplicate opener" | [ ] |
| Name and need given by text appear as structured fields on the lead | "captures name and need" | [ ] |
| Jesse gets the capture alert within 1 minute, with name, number, need | "captures name and need" | [ ] |
| STOP ends the thread permanently and is recorded in the event log | "STOP ends the thread" | [ ] |
| Landline: logged, alerted as a plain missed call | "landline", "undelivered" | [ ] (call from a landline) |

## System 2 — receptionist / intake
| Criterion | Auto (test) | Live |
|---|---|---|
| Test call completes all six questions and reads the callback number back correctly | `receptionist.test.ts` "completes all six questions" | [ ] |
| A booked callback creates the job and both alerts, and appears in the next daily summary | same test | [ ] |
| Asked for a price not in config, the agent defers to Jesse and quotes nothing (**Checkpoint C**) | "CHECKPOINT C" | [ ] |
| Asked for a human twice, the agent hands off and alerts Jesse immediately | "asked for a human twice" | [ ] |
| With the AI layer disabled (`AI_DISABLED=true`), a caller reaches voicemail, never silence | "AI layer disabled", "AI error mid-call" | [ ] |
| Upset caller: transfers to the "Jesse will call you" path | "upset caller" | [ ] |

## System 3 — lead follow-up
| Criterion | Auto (test) | Live (staging, `FOLLOWUP_ACCELERATED=true`) |
|---|---|---|
| Unanswered lead gets Steps 1–4 at the configured times, then silence | `followup.test.ts` "steps 1-4" | [ ] |
| A reply at any step cancels every pending job and alerts Jesse | "a reply at any step" | [ ] |
| No sends outside 8 AM – 8 PM Eastern | "never sends outside" | [ ] |
| A lead marked human or booked gets no follow-up | "human-owned or booked" | [ ] |
| Restarting mid-sequence causes no duplicate or lost sends | "restarting mid-sequence", "two pollers" | [ ] (redeploy mid-sequence) |

## Platform-wide
| Criterion | Status |
|---|---|
| No secrets in the repo; a fresh clone plus `.env` values runs the whole system | [ ] verify on deploy (`.env` is git-ignored; only `.env.example` is committed) |
| Every conversation in the test week can be found in the log by phone number | `npm run cli -- log <phone>` · [ ] |
| BLOCKERS.md is empty, or every entry has Jesse's written answer | [ ] |

## Checkpoints
- **A**: a test SMS sent and received through the deployed service (`POST /admin/test-sms`, then reply `HELP` from your phone); a lead created from a manual API call (`POST /leads`); the daily-summary job runs on demand (`POST /admin/summary`). [ ]
- **B**: three clean test calls in a row from different phones, each texted within 60 s, each with a correct alert. [ ]
- **C**: a scripted caller asking for a price not in config is deferred to Jesse. [ ]
- **D**: 48 hours live with zero duplicate sends, zero sends to replied or human-owned leads, and every conversation visible in the log. [ ]
