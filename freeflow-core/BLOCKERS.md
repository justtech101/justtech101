# BLOCKERS

Things only Jesse can supply. Phase 1 is not done until every entry has Jesse's
written answer next to it (Section 6, platform-wide). Write the answer under
**Answer:** and the date.

Everything that does *not* depend on these is built and covered by automated
tests (`npm test`). Each blocker lists exactly which step it holds up.

---

### B0. Google Voice mode setup (start here) — *replaces Twilio for now*
- [ ] Google Voice settings: forward messages to email, missed-call email alerts, and voicemail by email with transcripts on (README step 1).
- [ ] Google Cloud project with the Gmail API, an OAuth consent screen set to **In production**, and a Desktop OAuth client (README step 2).
- [ ] `npm run gmail -- auth` → put `GMAIL_REFRESH_TOKEN` in the hosting dashboard.
- [ ] **`npm run gmail -- inspect 20` output.** I couldn't see your real Google Voice emails, so the parser is built from the commonly seen formats. Paste the output (numbers redacted). Fix anything that says `unknown` or reads the wrong number before going live.
- [ ] Is **(803) 380-6153** your Google Voice number? Set it as `GOOGLE_VOICE_NUMBER`.
- [ ] Confirm you're OK with co-pilot mode: Google Voice's policy forbids automated texting, so in this mode **you send every text** (the system drafts them). Full automation needs Twilio (B1).
**Answer:**

### B1. Twilio (later, for full automation) — *only when switching to CHANNEL=twilio*
Needed: a funded Twilio account and numbers, plus A2P 10DLC registration (brand +
campaign) for texting. Without that registration, carriers filter or block texts. `npm run twilio --
search|buy|configure` handles the rest. If you want customers to keep calling
(803) 380-6153, port it from Google Voice to Twilio (1–4 weeks). Not needed for Google
Voice mode.
**Answer:**

### B2. Business facts for `config/business.json` — *Step 4*
**Filled in from backonlinefast.com (Oct 2026). Please confirm or correct:**
- [ ] The **8 services** and their one-line notes, copied from "What I fix". The notes are what follow-up step 2 shares.
- [ ] **Published prices**: Phone SIM unlock **$49.99**, cable & internet bill review **$50 flat**. These are the only prices any system may quote. Every other service's price is `null`, so it gets "Let me have Jesse confirm that".
- [ ] **Policies** the systems may repeat: free quote before any work, the price comes before work and you can say no, software is usually fixed remotely while you watch.
- [ ] **Service area**: "Augusta, GA and the CSRA in person; remote help anywhere" (remote = yes).
- [ ] **Business name in texts**: the plan's opener says "JustTech". The website brand is "Back Online Fast by Justtech LLC". Which should callers see? (`business_name` / `parent_brand`)

**Still unknown, so it stays `null` and the systems defer:**
- [ ] **Hours** (per weekday). Used for the after-hours opener line. The site doesn't list any.
- [ ] **Callback windows** (days + start/end). Used for "Jesse can call you back [window]". Without them, the systems say "as soon as possible".
- [ ] **Same-day service**: true/false. Until it's true, nothing promises same-day.
- [ ] **Turnaround times** the systems may state (if any).
- [ ] **Booking link** (if any). The site's ticket form opens an email draft, so there's no link yet.
- [ ] Confirm the **opener** wording on a real phone, and tune it after live tests (`src/prompts/textback.md`).

**Your current number:** the site lists **(803) 380-6153** for call or text. Options for
production: (a) port that number into Twilio so it becomes the business number
(customers keep the number they know), or (b) keep it as `OWNER_FORWARD_NUMBER` and
publish a new 706 number. Porting takes 1–4 weeks, so if you choose (a), start it early.
**Answer:**

### B3. Claude API key and hosting account — *Block A*
Needed: an Anthropic API key, and a Render (blueprint in `render.yaml`) or
Railway account with a hosted Postgres (Neon / Supabase / Render Postgres).
Enter them **only** in the hosting dashboard's environment settings. Never paste
them into chat or commit them to the repo.
**Answer:**

### B4. Jesse's mobile number — *Step 3 (Twilio mode only)*
In Google Voice mode, alerts and drafts go to your email (`OWNER_ALERT_EMAIL`). Turn on
Gmail notifications on your phone so drafts arrive within seconds.

This number receives every alert. Texting the business number from it breaks
into any thread (see RUNBOOK.md). Also decide whether inbound calls should ring
this mobile first (`OWNER_FORWARD_NUMBER`), with the receptionist as backup,
or whether the receptionist answers every call.
**Answer:**

### B5. Summary email (optional) — *Step 12*
The daily 8:00 AM summary always goes out by SMS. For the email copy: which
address, and which SMTP sender to use (e.g. Google Workspace app password,
Postmark, or SendGrid SMTP)?
**Answer:**

### B6. Go / no-go on the production number — *Step 14*
After the staging acceptance run (ACCEPTANCE.md), Jesse decides whether the
production number gets pointed at the service.
**Answer:**

---

## Decisions made without Jesse (flag if you disagree)
- **Google Voice mode drafts, never sends.** This follows Google Voice's acceptable-use policy (no automated messaging). The unofficial email-reply trick that could auto-text was ruled out on purpose: it breaks the policy and risks your number.
- **Voicemails with a transcript** skip the generic "sorry we missed your call" and get a reply that answers what they said ("Hey, this is Jesse at JustTech — got your voicemail. …").
- **First start ignores old emails.** When Google Voice mode first runs, it skips notifications older than that moment, so nobody from last week gets texted.
- **Job poll interval is 60s, not 5 min.** The 2-minute summary and the 15-minute callback reminder need it. The cost is negligible.
- **Follow-up timing is measured from when the thread went quiet.** That's the anchor: step 1 at +2h, step 2 at +1 day, step 3 at +3 days, step 4 at +7 days. A step that lands in quiet hours waits for 8:00 AM.
- **Partial calls.** If a caller hangs up partway through the receptionist intake, Jesse gets the partial summary and no text-back is sent. If the caller gave no details at all, the missed-call text-back fires.
- **Missed-call alert.** Jesse gets a one-line alert the moment a text-back goes out ("Jesse knows about it the same minute"). Turn it off with `textback.alert_on_missed_call: false`.
- **Call screening.** When calls ring Jesse first, Jesse presses 1 to accept. That stops a carrier voicemail from "answering" and swallowing the missed-call text-back.
