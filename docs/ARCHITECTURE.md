# JUSTTECH Application Manager — System Architecture

## 1. Goals and constraints

- Local-first, open-source, single-user-or-small-team tool that finds job and
  grant opportunities, scores them, drafts application material, and drives a
  Playwright browser to fill (but never submit) application forms.
- Runs comfortably on a **Windows ARM Surface Pro, 8 GB RAM**. Playwright /
  Chromium is the heaviest component, so it is isolated behind a worker
  process that can optionally run on a separate machine.
- Human-in-the-loop by design: nothing is submitted, no CAPTCHA is solved,
  and no legal attestation / sensitive question is answered automatically.
- Modular boundaries so third-party OSS projects (Career-ops, GrantHunt,
  browser-use, Stagehand, etc.) can be dropped in behind the same interfaces
  later without touching the core.

## 2. High-level component diagram

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              Client machine (Surface Pro)                 │
│                                                                           │
│  ┌───────────────┐        ┌───────────────────────────────┐             │
│  │  React SPA    │  HTTP  │        FastAPI backend         │             │
│  │  (Vite)       │◄──────►│  (uvicorn, single process)     │             │
│  │  Dashboards   │  JSON  │                                 │             │
│  └───────────────┘        │  ┌─────────────┐ ┌────────────┐│             │
│                            │  │ REST routers│ │ Scheduler  ││             │
│                            │  └─────────────┘ │(APScheduler)│             │
│                            │  ┌─────────────┐ └────────────┘│             │
│                            │  │  Services    │               │             │
│                            │  │  - dedup     │               │             │
│                            │  │  - scoring   │               │             │
│                            │  │  - ingestion │               │             │
│                            │  │  - drafting  │               │             │
│                            │  │  - audit     │               │             │
│                            │  └─────────────┘               │             │
│                            └───────────────┬─────────────────┘             │
│                                            │ psycopg / SQLAlchemy           │
└────────────────────────────────────────────┼─────────────────────────────┘
                                             │
                          ┌──────────────────▼───────────────────┐
                          │   Supabase / PostgreSQL (local or     │
                          │   hosted). Tables + RLS policies.     │
                          │   Storage bucket for documents/       │
                          │   screenshots (Supabase Storage or    │
                          │   local disk in dev).                 │
                          └────────────────────────────────────────┘

                     Heavy browser automation (optional remote worker)
┌───────────────────────────────────────────────────────────────────────────┐
│  Worker process (can run on the same laptop OR a remote box)              │
│  ┌─────────────────────────────┐                                         │
│  │ Playwright / Chromium        │  Pulls "pending_review" applications,   │
│  │ form_filler.py                │  fills forms in headed/dry-run mode,   │
│  │ browser_manager.py             │  screenshots every step, STOPS before │
│  └─────────────────────────────┘  submit/attestation/CAPTCHA.            │
│               │ writes screenshots + filled-field audit trail             │
│               ▼                                                          │
│         Supabase / shared Postgres (same DB as backend)                  │
└───────────────────────────────────────────────────────────────────────────┘

               External world (pull + push)
┌───────────────────────────────────────────────────────────────────────────┐
│  RSS feeds (job/grant boards) │ Public REST APIs (Grants.gov, USAJobs,    │
│  IMAP email alerts            │ RemoteOK, Greenhouse/Lever job boards)    │
│  n8n webhooks (inbound push   │ n8n workflows (outbound trigger, e.g.     │
│  new opportunities)           │ Slack/email notification on new match)   │
└───────────────────────────────────────────────────────────────────────────┘
```

## 3. Why this stack

| Concern                    | Choice                                    | Reason |
|-----------------------------|--------------------------------------------|--------|
| API server                  | FastAPI + Uvicorn                          | async, typed, fast to run locally on ARM |
| DB                           | Supabase (hosted Postgres) or plain Postgres locally | one schema works both ways; RLS policies included but optional in local dev |
| ORM                          | SQLAlchemy 2.0 (async) + Alembic-style raw SQL migrations | explicit SQL migrations are portable to the Supabase SQL editor |
| Frontend                     | React + Vite + TypeScript                  | lightweight dev server, low RAM footprint vs. Next.js |
| Browser automation            | Playwright (Python)                        | required by spec; isolated into its own process/worker |
| Automation triggers/notifications | n8n-compatible webhooks (inbound + outbound) | lets users wire Slack/email/Zapier-like flows without code |
| Scheduling                   | APScheduler (in-process) for Phase 1        | swappable for Celery/RQ + Redis when moved to a remote worker |
| Secrets                       | `cryptography.fernet` symmetric encryption, key from `JUSTTECH_ENCRYPTION_KEY` env var | credentials never stored in plaintext |

## 4. Data flow

1. **Discovery** — `services/ingestion/*` pull from RSS feeds, public APIs,
   and (Phase 2) IMAP email alerts. n8n can also `POST` directly into
   `/webhooks/n8n/opportunity`.
2. **Extraction** — raw postings are normalized into the `opportunities`
   schema (deadline, eligibility, salary/award, required documents,
   application questions) by `services/extraction.py`. Only fields explicitly
   present in the source are populated — the extractor never invents values;
   anything it cannot find is left `null` and flagged in `missing_fields`.
3. **Deduplication** — `services/dedup.py` computes a stable `content_hash`
   (source + normalized title + organization) and a fuzzy-match pass
   (`rapidfuzz`) against recent opportunities of the same type to catch
   reposts across sources.
4. **Scoring** — `services/scoring.py` produces a 0–100 score from
   eligibility fit, keyword/skill match against the active profile, deadline
   urgency, and completeness, with a transparent `score_breakdown`.
5. **Profile matching / missing info** — the applicant's stored profile and
   verified reusable answers are checked against `application_questions`;
   anything unanswered moves the opportunity to **Missing Information**.
6. **Drafting** — (Phase 2 hook, interfaces defined in Phase 1)
   `services/drafting.py` generates a tailored resume / cover letter / grant
   narrative from verified profile data only, and lists exactly what is
   missing rather than guessing.
7. **Review** — everything drafted lands in **Ready for Review**. A human
   approves in the dashboard.
8. **Browser fill** — only after approval does the worker use Playwright to
   fill the live form. It **stops** before: file upload confirmation dialogs
   that require a human click, legal attestations / signatures, CAPTCHA
   widgets, and the final submit button. It screenshots every step.
9. **Submission** — is always a manual, explicit human action (a button in
   the UI that the human clicks after visually verifying the filled form).
   The system records `submitted_at` only after the human confirms.
10. **Tracking** — dashboard buckets: New, Qualified, Missing Information,
    Ready for Review, Submitted, Rejected, Follow-up.

## 5. Safety boundaries (hard rules enforced in code)

- `automation/form_filler.py` has a `STOP_FIELD_PATTERNS` allow/deny list —
  any field whose label matches attestation/signature/certify/SSN/CAPTCHA
  patterns is skipped and flagged, never auto-filled.
- No code path calls a CAPTCHA-solving service; `browser_manager.py` detects
  common CAPTCHA iframes/selectors and raises `CaptchaEncounteredError`,
  pausing the run.
- `dry_run` is a first-class column on `applications` and an explicit
  parameter through the whole pipeline. Dry-run fills a form and screenshots
  it but with `page.route()` interception that blocks the final network
  submit request as a second safety net.
- All state-changing actions (score override, submit, credential access) are
  written to `application_events` / `audit_log` with actor + timestamp.
- Duplicate-application protection: a unique constraint on
  `(opportunity_id, profile_id)` in `applications` plus a pre-submit check in
  the API layer.

## 6. Deployment topology

- **Local dev (single machine)**: `docker-compose up` runs Postgres,
  backend, and frontend. Playwright runs in the same backend container in
  Phase 1 for simplicity (headless, low concurrency) — acceptable on 8 GB RAM
  because it is invoked on-demand, not kept warm.
- **Split topology (recommended once volume grows)**: point
  `DATABASE_URL` at the same Supabase project from a second, more powerful
  machine running only the `worker` (see `/worker`), and disable browser
  automation on the client (`ENABLE_LOCAL_BROWSER_WORKER=false`). The client
  stays a thin FastAPI + React app.

## 7. Extensibility points (for later integration of existing OSS projects)

- `services/ingestion/base.py` defines an `Ingestor` protocol
  (`fetch() -> list[RawOpportunity]`). Career-ops/GrantHunt scrapers can be
  wrapped as new `Ingestor` implementations without touching routers or DB
  code.
- `automation/browser_manager.py` wraps Playwright behind a small interface
  (`open`, `fill_field`, `upload_file`, `screenshot`, `close`) so Browser Use
  or Stagehand can be swapped in as an alternate driver behind the same
  `form_filler.py` orchestration logic.
- `services/drafting.py` defines a `Drafter` protocol so a different
  LLM/prompt backend can be substituted.
