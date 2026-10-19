# freeflow-core

**FreeFlow AI, Phase 1: your own systems.** Three systems on one shared platform:
one repo, one deployment, one phone number, one lead store, one AI layer, one alert path.
It runs on **Google Voice (co-pilot: the AI drafts, you send)** or **Twilio (fully
automated)**. See "Two channels" below.

| System | Live behaviour | Code |
|---|---|---|
| 1. Missed-call text-back | Texts an unanswered caller within seconds, holds a short chat, captures name + need, alerts Jesse, then steps aside | `src/flows/textback.ts` |
| 2. AI receptionist / intake | Answers calls (and new texts) with a **fixed** 6-question script, reads the callback number back, then books a callback or sends Jesse a written summary | `src/flows/intake.ts`, `src/flows/receptionist.ts`, `src/routes/voice.ts` |
| 3. Lead follow-up | Up to 4 timed, capped follow-ups for leads who go quiet. Any reply stops them instantly and hands the thread to Jesse | `src/flows/followup.ts` |

Plan documents: **[BLOCKERS.md](BLOCKERS.md)** (what's waiting on Jesse) ·
**[ACCEPTANCE.md](ACCEPTANCE.md)** (Section 6 checklist) · **[RUNBOOK.md](RUNBOOK.md)** (pause, reset, logs).

## Rules the code enforces (not just the prompts)
- **Facts live only in `config/business.json`.** Prompts get those facts as data. A
  deterministic guard (`src/core/guard.ts`) checks every AI-written message before it
  is sent. If a reply has a price, discount, same-day promise or turnaround that config
  doesn't back, the guard swaps in "Let me have Jesse confirm that and get right back to
  you" and logs a `guardrail` event. Unknown values stay `null`, never `0`.
- **The intake script is code, not model output.** The model interprets answers. It
  never writes the questions.
- **Every send goes through `sendToLead`** (`src/core/outbound.ts`). It enforces STOP,
  the global pause, and idempotency: the message row with its unique key is written
  *before* Twilio is called (or the draft is emailed), so a retry or a restart can never
  double-text or double-draft.
- **Everything is logged.** `messages` holds every SMS and voice-transcript line, and
  `events` holds every decision (missed_call, handoff, stop, guardrail, error, alert...).
- **Humans can always break in.** Any text from Jesse's number pauses the thread
  (see RUNBOOK.md), and customer STOP / HUMAN is honoured right away.
- **Fail loud.** An AI error on a call drops to voicemail and alerts Jesse. An AI error
  on a text sends a polite holding reply and hands off. Callers never hear silence.
- **Secrets are env-only.** See `.env.example`. A real `.env` is git-ignored.

## Layout
```
src/
  routes/   voice.ts  sms.ts  webhooks.ts  leads.ts     Twilio webhooks + admin API
  routes/   actions.ts                                    one-tap links in owner emails (confirm, then act)
  core/     telephony.ts  ai.ts  store.ts  notify.ts  jobs.ts
            outbound.ts (the one send path: SMS, or a draft email in Google Voice mode)
            guard.ts  facts.ts  time.ts  config.ts  prompts.ts
            gmail.ts  voice-email.ts (Voice email parser)  copilot.ts (draft emails)  actions.ts (signed links)
  flows/    textback.ts  intake.ts  receptionist.ts  followup.ts
            inbound.ts (SMS router)  googlevoice.ts (Gmail poller)  owner.ts (Jesse's commands)
            summary.ts  controls.ts  audit.ts
  prompts/  textback.md  receptionist.md  followup.md   all wording, versioned in git
config/     business.json                                 the only place facts live
migrations/ 001_init.sql                                  leads, messages, jobs, events (+ calls, settings)
tests/      core / textback / receptionist / followup     acceptance tests, real Postgres
```

## Two channels: start on Google Voice, upgrade to Twilio
| | **Google Voice co-pilot** (`CHANNEL=google_voice`, start here) | **Twilio, fully automated** (`CHANNEL=twilio`) |
|---|---|---|
| Your number | Your existing Google Voice number | A Twilio number (port your current one in, or a new one) |
| Missed call / voicemail | Read from the Voice notification email. **A drafted reply is emailed to you within ~20–60 s** | Text goes out in seconds by itself |
| Texts to customers | **You send every one** from the Voice app: copy the draft, paste, send, tap "I sent it" | Sent automatically |
| AI phone receptionist | ✗ Calls go to Voice voicemail; the transcript feeds the text intake | ✓ Answers calls, runs the six-question intake |
| Follow-ups | Drafted at the right times (never 8 PM–8 AM) for you to send | Sent automatically |
| Alerts + daily summary | Email | SMS (+ summary email) |
| Cost | $0 beyond hosting + AI | Twilio number + per-text fees + A2P registration |

**Why does Google Voice mode draft instead of send?** Google Voice has no API, and its
[Acceptable Use Policy](https://support.google.com/voice/answer/9230450) bans sending messages
"through an automated process such as a script". Google can shut the account down, and that
would take your business number with it. So in this mode the code can't send texts at all:
there is no automated SMS path (`NoTelephony`). A person presses send every time. Everything
else is automated: capture, AI drafts, guardrails, follow-up timing, the log and the summary.
When you're ready for full automation, switch to `CHANNEL=twilio` with nothing to rebuild.

## Your next steps, in order (Google Voice)
1. **Google Voice settings** (voice.google.com → Settings): turn on **Messages → Forward
   messages to email**, **Calls → Get email alerts for missed calls**, and
   **Voicemail → Get voicemail via email**. Voicemail transcripts must be on.
2. **Google Cloud OAuth client** (one time, about 10 minutes): at console.cloud.google.com,
   create a project and enable the **Gmail API**. Then:
   - Under **OAuth consent screen**, choose External, add your Gmail address as a test
     user, then **Publish app → In production**. A token made while the app is still
     "Testing" expires after 7 days. Google will show an "unverified app" warning when you
     sign in. That's expected for an app only you use; click Advanced → continue.
   - Under **Credentials → Create OAuth client ID → Desktop app**, copy the client ID and
     secret into `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`.
3. **On your computer:** `npm run gmail -- auth` (it opens a browser and prints
   `GMAIL_REFRESH_TOKEN`). Then run **`npm run gmail -- inspect 20`**. It shows how your real
   Voice emails parse. Every line should read sms / missed_call / voicemail with the right
   number. If any don't, send me that email with the numbers blacked out.
4. **Answer BLOCKERS.md B2** (confirm services and prices, add hours and callback windows).
5. **Get an Anthropic API key, then run `npm run ai-check`.**
6. **Try it:** `CHANNEL=google_voice npm run simulate`. Drafts print as emails.
7. **Deploy** from `render.yaml` with `CHANNEL=google_voice`, then `npm run gmail -- test`.
   Have a friend call and text your Voice number, then work through ACCEPTANCE.md
   (Google Voice section).

## Run it locally
Needs Node 20+ and Postgres 14+.
```bash
cd freeflow-core
npm install
cp .env.example .env          # fill in values; secrets never get committed
npm run migrate               # creates the schema (npm run migrate -- --reset rebuilds from scratch)
npm run dev                   # http://localhost:3000/health
```
To receive Twilio webhooks locally, expose the port with a tunnel (e.g. `ngrok http 3000`).
Then set `PUBLIC_BASE_URL` to the tunnel URL.

### Tests
The tests use fake Twilio and fake AI clients against a real, throwaway Postgres database.
**Every run wipes that database**, so never point `TEST_DATABASE_URL` at real data.
```bash
createdb freeflow_test
TEST_DATABASE_URL=postgresql://localhost:5432/freeflow_test npm test
npm run typecheck
```

## Deploy (Render: `render.yaml`. Railway works the same way)
Google Voice mode needs only steps 1–3 below. Leave the Twilio variables empty and skip the
Twilio steps; the service polls Gmail every `GV_POLL_SECONDS`.

1. Create a hosted Postgres (Neon / Supabase / Render) and copy its URL.
2. Create the web service from `render.yaml`. Use one service per environment
   (staging first). Enter every `sync: false` value in the dashboard. Use a paid
   instance: a sleeping instance misses webhooks.
3. The service runs migrations on boot and starts the job poller (every 60s).
4. Run `npm run twilio -- configure <number>` (or `buy`) to set these on the **staging** number.
   `npm run twilio -- check` shows what the number currently points at. To set them by hand in the Twilio console:
   - **Voice → A call comes in:** `POST {PUBLIC_BASE_URL}/voice/incoming`
   - **Voice → Primary handler fails:** `POST {PUBLIC_BASE_URL}/voice/fallback`
   - **Voice → Call status changes:** `POST {PUBLIC_BASE_URL}/voice/status`
   - **Messaging → A message comes in:** `POST {PUBLIC_BASE_URL}/sms/incoming`

   SMS delivery callbacks (`/webhooks/sms-status`) are set on each send automatically.
5. Run Checkpoint A: `POST /admin/test-sms`, reply `HELP` from your phone,
   `POST /leads`, `POST /admin/summary`.
6. Work through ACCEPTANCE.md on staging. Production (Step 14) is a second service
   with the production number and `DEPLOY_ENV=production`. Staging alerts carry a
   `[staging]` prefix.

### Call routing
- `OWNER_FORWARD_NUMBER` set: calls ring Jesse first, with call screening (press 1 to
  accept). No answer means the receptionist takes the call.
- `OWNER_FORWARD_NUMBER` empty: the receptionist answers every call.
- A call that ends with no details captured triggers the missed-call text-back.
- A call that ends partway through intake sends Jesse a partial summary.

## Manual controls (no admin panel in Phase 1)
```
npm run cli -- pause <phone>     npm run cli -- reset <phone>     npm run cli -- log <phone>
npm run cli -- pause-all         npm run cli -- resume-all        npm run cli -- queue
npm run cli -- summary           npm run cli -- audit [hours]     npm run cli -- add-lead <phone> --consent "..."
```
Other tools: `npm run simulate` (terminal sandbox) · `npm run ai-check` (live model check) ·
`npm run gmail -- auth|inspect|test` (Google Voice mode) · `npm run twilio -- search|buy|configure|check`. CI (`.github/workflows/freeflow-core.yml`)
runs the typecheck, build and all tests on every push.
Jesse can do the same by texting the business number. See RUNBOOK.md.

## Changing what the systems say
- **A fact** (hours, prices, services, callback windows, follow-up timing, quiet hours):
  edit `config/business.json` and redeploy. Never put a fact in a prompt.
- **Wording / tone**: edit `src/prompts/*.md`. Sections are `## name`, and placeholders are
  `{{name}}`.
- **Model**: `AI_MODEL` (default `claude-opus-5-5`, low effort for fast turns, with
  server-side refusal fallback enabled).

## Phase 2 (client deployments)
A client needs a new `business.json`, a new number, a new deployment and, if
wanted, new prompt files. There's no rebuild. Anything client-specific that turns up
in `src/` (outside `src/prompts/`) is a defect.
