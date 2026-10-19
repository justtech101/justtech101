# Runbook (one page)

Three things you might need in a hurry: **pause everything**, **reset a lead**,
and **read the logs**. Each one works from your phone (text the business number
from your alert mobile), from the CLI, or from the admin API.

## From your phone: text the business number
| Text | What happens |
|---|---|
| `PAUSE ALL` | Every automated text stops right away: openers, AI replies, follow-ups. Calls still go to voicemail or the receptionist, and you still get every alert. |
| `RESUME ALL` | Automation back on. |
| `PAUSE` or `PAUSE 706-555-1234` | That lead is yours. Automation stops on the thread and its follow-ups are cancelled. With no number, it applies to the lead from your latest alert. |
| `RESET 706-555-1234` | Lead goes back to "new" and gets a fresh follow-up sequence. This is the only way a lead gets a second sequence. |
| `SAY 706-555-1234 On my way!` | Texts the lead from the business number, as you. Automation stays off on that thread. |
| `QUEUE` | Today's scheduled sends and reminders. |
| `HELP` | The command list. |
| *anything else* | Pauses the lead from your latest alert. You can always break in. |

Customers can text **STOP**, which is permanent: no system will ever text that number
again. **HUMAN** hands the thread straight to you.

## From a terminal (in `freeflow-core/`, with the production `.env`)
```
npm run cli -- pause-all            # pause everything
npm run cli -- resume-all
npm run cli -- pause 7065551234     # one lead
npm run cli -- reset 7065551234
npm run cli -- log 7065551234       # every message + event for a number
npm run cli -- queue                # today's scheduled jobs
npm run cli -- summary              # send the daily summary now
```

## Admin API (header `Authorization: Bearer $ADMIN_API_KEY`)
`POST /admin/pause-all` · `POST /admin/resume-all` · `POST /leads/{phone}/pause` ·
`POST /leads/{phone}/reset` · `GET /leads/{phone}` (full log) · `GET /admin/queue` ·
`POST /admin/summary` · `GET /health`

## Reading the logs
`npm run cli -- log <phone>` prints one timeline per number:
- `<<` they texted us, `>>` we texted them (with delivery status), `--` notes
- `** event`: missed_call, handoff, stop, guardrail (the AI tried to say something config doesn't back, and it was blocked), error, alert (every text sent to you), booked, closed, paused, reset

If something looks wrong, search the events for `error`. Every failure is logged,
and anything you need to act on also comes to you as a text.

## When something breaks
- **The service is down.** The Twilio number's "Primary handler fails" URL points
  at `/voice/fallback`, so callers still hear the voicemail prompt. Texts that arrive while it's down
  show up in the Twilio console logs.
- **The AI is failing.** Calls drop to voicemail and texts hand off to you, with an
  alert each time. To force this on purpose, set `AI_DISABLED=true`.
- **A "may or may not have gone out" alert.** The service restarted mid-send. It will
  not resend, so check the customer's thread and text them yourself if needed.
