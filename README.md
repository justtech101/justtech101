# JUSTTECH Application Manager

An open-source, local-first web app that finds job and grant opportunities,
scores them, drafts application material, tracks them through a review
pipeline, and uses Playwright to fill (never submit) application forms —
always with a human approving before anything goes out.

Full design doc: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Database schema: [`backend/migrations/001_init.sql`](backend/migrations/001_init.sql).

## 1. System architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full write-up
(component diagram, data flow, safety boundaries, deployment topology,
extensibility points). Summary:

- **FastAPI** backend (async, SQLAlchemy 2.0) exposes a REST API and runs an
  in-process **APScheduler** job that polls RSS/API ingestion sources.
- **React + Vite + TypeScript** frontend renders the 7-bucket dashboard.
- **PostgreSQL** (local via docker-compose, or hosted **Supabase**) is the
  single source of truth; `backend/migrations/001_init.sql` is portable to
  either.
- **Playwright** (Python) is isolated behind `backend/app/automation/`, with
  hard-coded stop rules for attestations, CAPTCHAs, and the final submit
  click. It can run on the same machine or on a separate, beefier **remote
  worker** (see `worker/README.md`) — important for the 8 GB RAM Surface
  Pro target.
- **n8n-compatible webhooks**: inbound (`POST /api/webhooks/n8n/opportunity`)
  and outbound (`N8N_OUTBOUND_WEBHOOK_URL`, fired when an opportunity scores
  ≥ 70). Sample workflows in `n8n/workflows/`.

## 2. Folder structure

```
justtech101/
├── README.md                     # this file
├── docker-compose.yml            # postgres + backend + frontend, local dev
├── .env.example                  # every env var, REQUIRED/OPTIONAL marked
├── docs/
│   └── ARCHITECTURE.md
├── backend/
│   ├── requirements.txt / requirements-dev.txt
│   ├── Dockerfile
│   ├── pytest.ini
│   ├── migrations/
│   │   └── 001_init.sql          # full Postgres/Supabase schema
│   ├── storage/                  # local disk: documents/, screenshots/
│   └── app/
│       ├── main.py               # FastAPI app, CORS, scheduler wiring
│       ├── config.py             # Settings (env vars), all documented
│       ├── database.py           # async SQLAlchemy engine/session
│       ├── security.py           # Fernet encryption for credentials
│       ├── models/                # SQLAlchemy ORM (profile, opportunity, application, ingestion)
│       ├── schemas/                # Pydantic request/response models
│       ├── routers/               # profiles, opportunities, applications, drafting,
│       │                          # automation, dashboard, webhooks, credentials, audit, ingestion_sources
│       ├── services/
│       │   ├── dedup.py           # exact-hash + fuzzy duplicate detection
│       │   ├── scoring.py         # rule-based 0-100 scorer
│       │   ├── extraction.py      # deadline/salary/docs/questions from raw text
│       │   ├── drafting.py        # resume/cover-letter/grant-narrative templates
│       │   ├── audit.py           # audit_log writer
│       │   ├── notifications.py   # outbound n8n webhook
│       │   └── ingestion/         # base.py, rss_ingestor.py, api_ingestor.py
│       │                          # (Grants.gov + RemoteOK), email_ingestor.py, runner.py
│       ├── automation/
│       │   ├── browser_manager.py  # Playwright wrapper, CAPTCHA detection, dry-run request blocking
│       │   ├── form_filler.py      # orchestration, STOP_FIELD_PATTERNS, pause/resume, screenshots
│       │   └── session_registry.py # holds a paused browser open between /fill and /resume-fill
│       └── tests/                 # pytest unit tests (scoring, dedup, extraction, form_filler, resume_fill, session_registry)
├── frontend/
│   ├── package.json / vite.config.ts / tsconfig.json
│   ├── Dockerfile
│   └── src/
│       ├── main.tsx / App.tsx
│       ├── api/client.ts          # typed fetch wrapper
│       ├── types/index.ts
│       ├── pages/Dashboard.tsx    # 7-bucket Kanban board
│       ├── pages/Profiles.tsx
│       └── components/OpportunityCard.tsx
├── n8n/workflows/                 # importable example n8n workflows
├── worker/README.md               # remote/split-topology worker notes
└── windows/                       # Windows desktop shortcut (icon + PowerShell launcher)
```

## 3. Database schema

Full DDL: [`backend/migrations/001_init.sql`](backend/migrations/001_init.sql). Tables:

| Table | Purpose |
|---|---|
| `applicant_profiles` | Multiple applicant identities, skills, work history, eligibility, preferences |
| `reusable_answers` | Human-verified short answers, keyed by a hash of the question text |
| `profile_documents` | Resumes/cover letters/transcripts, versioned |
| `ingestion_sources` | Configured RSS/API/email/n8n sources, enable/disable, last run status |
| `opportunities` | Jobs and grants (discriminated by `type`), extracted fields, `score`/`score_breakdown`, `content_hash` (unique, dedup) |
| `applications` | One profile applying to one opportunity; `dry_run`, `human_approved`, `submitted_at`; **unique `(opportunity_id, profile_id)`** for duplicate-application protection |
| `screenshots` | Every Playwright step, tied to an application |
| `credentials` | Fernet-encrypted site credentials (ciphertext only, ever) |
| `audit_log` | Every state-changing action: who/what/when |
| `webhook_log` | Raw inbound n8n payloads, for replay/debugging |

Row Level Security is enabled on `applicant_profiles`, `applications`, and
`credentials` with a `service_role`-only policy — a no-op for local
single-user dev (connect with the postgres/service-role connection string,
which bypasses RLS), but ready for a multi-user hosted Supabase deployment.

## 4. Setup instructions

### 4.1 Prerequisites (manual installs)

- Python 3.12+
- Node.js 20+
- Docker + Docker Compose (recommended path), **or** a local/hosted
  PostgreSQL 14+ instance (e.g. a free Supabase project)

### 4.2 Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env` and fill in, at minimum:

1. **`JUSTTECH_ENCRYPTION_KEY`** (REQUIRED before creating any credential):
   ```bash
   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```
2. **`N8N_WEBHOOK_SHARED_SECRET`** (REQUIRED to accept inbound webhooks):
   ```bash
   openssl rand -hex 32
   ```
3. If using hosted Supabase instead of local Postgres, set `DATABASE_URL`
   to your project's pooler connection string (see comments in
   `.env.example`).

All other variables have working defaults for local dev — see
`.env.example` for the full list with REQUIRED/OPTIONAL markers.

### 4.3 Start Postgres + apply the schema

**Option A — docker-compose (recommended for local dev):**

```bash
docker compose up -d postgres
# 001_init.sql runs automatically on first container start via
# /docker-entrypoint-initdb.d
```

**Option B — hosted Supabase:**

Open the Supabase SQL editor for your project and paste the contents of
`backend/migrations/001_init.sql`, then run it. (Safe to re-run — every
statement is idempotent.)

### 4.4 Run the backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
playwright install chromium                          # one-time browser download, REQUIRED for form-fill
uvicorn app.main:app --reload --port 8000
```

Verify: `curl http://localhost:8000/api/health` → `{"status": "ok"}`

Run the test suite:

```bash
pytest
```

### 4.5 Run the frontend

```bash
cd frontend
cp .env.example .env      # VITE_API_BASE_URL — defaults to http://localhost:8000
npm install
npm run dev
```

Open `http://localhost:5173`.

### 4.6 Or run everything with docker-compose

```bash
docker compose up --build
```

Backend on `:8000`, frontend on `:5173`, Postgres on `:5432`.

**Windows desktop shortcut**: on the Surface Pro / Windows client, see
[`windows/README.md`](windows/README.md) to create a "JUSTTECH Application
Manager" desktop icon that starts everything with `docker compose` and
opens the dashboard for you — no terminal needed after the one-time setup.

### 4.7 Configure your first ingestion sources

Via the API (or build a small admin UI on top of `/api/ingestion-sources` —
not built in Phase 1, see roadmap below):

```bash
# RemoteOK jobs (no API key needed)
curl -X POST http://localhost:8000/api/ingestion-sources \
  -H "Content-Type: application/json" \
  -d '{"name":"RemoteOK","source_type":"api","opportunity_type":"job","config":{"provider":"remoteok"}}'

# Grants.gov (no API key needed)
curl -X POST http://localhost:8000/api/ingestion-sources \
  -H "Content-Type: application/json" \
  -d '{"name":"Grants.gov","source_type":"api","opportunity_type":"grant","config":{"provider":"grants_gov","keyword":"technology"}}'

# Any RSS feed
curl -X POST http://localhost:8000/api/ingestion-sources \
  -H "Content-Type: application/json" \
  -d '{"name":"WeWorkRemotely","source_type":"rss","opportunity_type":"job","config":{"url":"https://weworkremotely.com/categories/remote-programming-jobs.rss"}}'
```

Sources run automatically every `INGESTION_INTERVAL_MINUTES` (default 60),
or trigger immediately:

```bash
curl -X POST http://localhost:8000/api/webhooks/ingestion/run-all \
  -H "X-Webhook-Secret: $N8N_WEBHOOK_SHARED_SECRET"
```

### 4.8 (Optional) Email alert ingestion

Set `JUSTTECH_ALERT_EMAIL_USERNAME` / `JUSTTECH_ALERT_EMAIL_APP_PASSWORD`
in `.env` (use an app password, not your real password — see comments in
`app/services/ingestion/email_ingestor.py`), then create a source with
`"source_type": "email"` and a config block as documented in that file.

### 4.9 Walk an opportunity through the review pipeline

```bash
# 1. Create a profile
curl -X POST http://localhost:8000/api/profiles -H "Content-Type: application/json" -d \
  '{"display_name":"Jane Doe","full_name":"Jane Doe","email":"jane@example.com",
    "skills":["python","fastapi"],"eligibility":{"work_authorization":"us_citizen"}}'

# 2. Once an opportunity exists (via ingestion or the webhook), create an application for it
curl -X POST http://localhost:8000/api/applications -H "Content-Type: application/json" -d \
  '{"opportunity_id":"<OPPORTUNITY_ID>","profile_id":"<PROFILE_ID>","dry_run":true}'

# 3. Generate a draft cover letter / resume / grant narrative (never invents facts --
#    anything missing from the profile comes back in `missing_fields` instead)
curl -X POST http://localhost:8000/api/applications/<APPLICATION_ID>/draft -H "Content-Type: application/json" -d \
  '{"doc_type":"cover_letter","persist":true}'

# 4. A human reviews and approves -- required before any browser automation can run
curl -X POST http://localhost:8000/api/applications/<APPLICATION_ID>/approve -H "Content-Type: application/json" -d \
  '{"approved_by":"jane"}'

# 5. Playwright fills the form (dry-run by default) -- pauses before attestations, passwords, and other
#    sensitive fields instead of guessing or auto-filling them
curl -X POST http://localhost:8000/api/applications/<APPLICATION_ID>/fill -H "Content-Type: application/json" -d \
  '{"field_map":[
     {"selector":"#email","label":"Email address","field_type":"fill","value_source":"profile.email"},
     {"selector":"#password","label":"Account Password","field_type":"fill","value_source":"n/a"}
   ]}'
# -> if the response is {"status":"awaiting_human_input","pending_fields":[{"selector":"#password",...}],...},
#    the browser is still open exactly there. A human supplies the live value in the next call --
#    it's used once and never stored:
curl -X POST http://localhost:8000/api/applications/<APPLICATION_ID>/resume-fill -H "Content-Type: application/json" -d \
  '{"human_inputs":[{"selector":"#password","value":"<typed live, this request only>"}]}'

# 6. Only a human clicks submit on the real site, then confirms it here (exact phrase required)
curl -X POST http://localhost:8000/api/applications/<APPLICATION_ID>/confirm-submitted -H "Content-Type: application/json" -d \
  '{"confirmed_by":"jane","confirmation_phrase":"I confirm I have manually submitted this application"}'
```

### 4.10 (Optional) n8n

Import `n8n/workflows/outbound-new-qualified-opportunity.json` and
`n8n/workflows/inbound-rss-to-justtech.json` into your n8n instance and
follow the manual-setup notes embedded in each workflow's node comments.

## 5. MVP development phases

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | Data model + migrations; profiles & reusable answers CRUD; RSS + public-API (Grants.gov, RemoteOK) + IMAP email ingestion; regex-based field extraction; hash + fuzzy dedup; rule-based 0-100 scoring; template-based drafting (resume/cover letter/grant narrative) with missing-field reporting; Playwright form-filling with dry-run, screenshots, STOP_FIELD_PATTERNS, CAPTCHA detection, human-approval gate, duplicate-application protection; encrypted credential storage; audit log; n8n inbound/outbound webhooks; 7-bucket dashboard UI | **Shipped in this repo** |
| **Phase 2** | Website scraper ingestors (Greenhouse/Lever/Workday job boards; common grant portals); LLM-backed `Drafter` implementation behind the existing `Drafter` protocol (still fact-grounded, still flags gaps instead of inventing); DOM-aware auto field-mapping for `form_filler.py` (currently requires an explicit `field_map`); document upload/versioning UI | Planned |
| **Phase 3** | Career-ops / GrantHunt / Browser Use / Stagehand integration behind the existing `Ingestor` and browser-driver interfaces; saved searches; per-profile notification rules in n8n | Planned |
| **Phase 4** | Multi-user auth via Supabase Auth + tightened RLS policies; remote worker queue (Celery/RQ) replacing the in-process APScheduler + direct endpoint call for browser automation | Planned |
| **Phase 5** | Analytics (response-rate tracking, score-calibration feedback loop), calendar integration for deadlines/follow-ups | Planned |

## 6. Safety behaviors (enforced in code, not just documented)

- `app/automation/form_filler.py` refuses to run unless
  `application.human_approved is True`.
- `STOP_FIELD_PATTERNS` in the same file skips any field whose label
  matches attestation/signature/SSN/CAPTCHA/terms-and-conditions/banking
  patterns — those are never resolved from stored profile/answer/document
  data, regardless of what `value_source` a field_map entry claims.
- Most of those paused fields *can* be completed through
  `POST /api/applications/{id}/resume-fill`, but only with a value a human
  supplies in that exact request — the browser stays open right where it
  stopped so nothing else has to be redone. The value is used once, is
  never written to the database, and the endpoint rejects any selector that
  wasn't already vetted as paused by the preceding `/fill` call (see
  `app/automation/session_registry.py` for the paused-session handoff, and
  `app/tests/test_resume_fill.py` for the tests proving `value_source` is
  never consulted on this path). This is how a caller like an automation
  agent gets a live credential or attestation into a form without ever
  storing or auto-replaying it.
- `HARD_STOP_PATTERNS` (CAPTCHA-labeled fields) is a stricter, separate list
  with no resume path at all — solving a CAPTCHA is an interactive visual
  challenge that can't be satisfied by passing a typed value through an API
  call, so this tool never offers to. `app/automation/browser_manager.py`
  also raises `CaptchaEncounteredError` the moment a CAPTCHA widget selector
  is detected in the DOM; no code path attempts to solve one either way.
- No code path ever clicks a submit button. `POST
  /api/applications/{id}/confirm-submitted` only records that a human
  clicked submit themselves, and requires a literal confirmation phrase.
- `dry_run` (default `true`) additionally blocks outbound submit-looking
  network requests at the Playwright route-interception layer, as defense
  in depth on top of "we never click submit."
- `applications` has a unique `(opportunity_id, profile_id)` constraint —
  duplicate-application protection at the database level, not just the API.
- Every state change is written to `audit_log` with actor + timestamp.
- The extraction and drafting services never invent a fact: anything not
  literally present in the source text/profile is left null and surfaced
  via `missing_fields` for a human to resolve.
