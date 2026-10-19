# BLOCKERS

Things only Jesse can supply. Phase 1 is not done until every entry has Jesse's
written answer next to it (Section 6, platform-wide). Write the answer under
**Answer:** and the date.

Everything that does *not* depend on these is built and covered by automated
tests (`npm test`). Each blocker lists exactly which step it holds up.

---

### B1. Twilio account, funding, and approval to buy two numbers — *Step 5 / Block B*
Needed: a funded Twilio account, and a go-ahead to buy one local Augusta (706)
number for **staging** and one for **production**. Also needed for US texting:
A2P 10DLC registration (brand + campaign) for each number. Without it, carriers
filter or block texts from the numbers.
Blocks: Checkpoint A's live SMS test, all of Blocks B–D on real phones.
**Answer:**

### B2. Business facts for `config/business.json` — *Step 4*
Until these are confirmed they stay `null`, and the systems say "Let me have
Jesse confirm that":
- [ ] **Hours** (per weekday). Used for the after-hours opener line.
- [ ] **Callback windows** (days + start/end). Used for "Jesse can call you back [window]". If none is set, the systems say "as soon as possible".
- [ ] **Service list**: names + one plain-language note each. The note is the "useful fact" in follow-up step 2.
- [ ] **Any prices the systems may quote** (per service). Unconfirmed = `null`. Never `0`.
- [ ] **Booking link** (if any).
- [ ] **Same-day service**: true/false. Until it's true, nothing promises same-day.
- [ ] **Turnaround times** the systems may state (if any).
- [ ] **Remote service**: offered, yes or no?
- [ ] Confirm the **service area** wording: currently "Augusta and the CSRA".
- [ ] Confirm the **opener** wording on a real phone, and tune it after live tests (it's in `src/prompts/textback.md`).
**Answer:**

### B3. Claude API key and hosting account — *Block A*
Needed: an Anthropic API key, and a Render (blueprint in `render.yaml`) or
Railway account with a hosted Postgres (Neon / Supabase / Render Postgres).
Enter them **only** in the hosting dashboard's environment settings. Never paste
them into chat or commit them to the repo.
**Answer:**

### B4. Jesse's mobile number — *Step 3*
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
- **Job poll interval is 60s, not 5 min.** The 2-minute summary and the 15-minute callback reminder need it. The cost is negligible.
- **Follow-up timing is measured from when the thread went quiet.** That's the anchor: step 1 at +2h, step 2 at +1 day, step 3 at +3 days, step 4 at +7 days. A step that lands in quiet hours waits for 8:00 AM.
- **Partial calls.** If a caller hangs up partway through the receptionist intake, Jesse gets the partial summary and no text-back is sent. If the caller gave no details at all, the missed-call text-back fires.
- **Missed-call alert.** Jesse gets a one-line alert the moment a text-back goes out ("Jesse knows about it the same minute"). Turn it off with `textback.alert_on_missed_call: false`.
- **Call screening.** When calls ring Jesse first, Jesse presses 1 to accept. That stops a carrier voicemail from "answering" and swallowing the missed-call text-back.
