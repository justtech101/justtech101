# Remote browser-automation worker

The Surface Pro (8 GB RAM, ARM) client is not a great place to keep Chromium
warm for long automation runs. Phase 1 ships everything in one backend
process for simplicity, but the `automation/` package is already isolated so
you can split it out:

## Option A — same backend image, different flags (simplest)

1. On a second, more capable machine (or a cloud VM), clone this repo and
   run the same `backend/Dockerfile` image, pointed at the **same**
   `DATABASE_URL` (a shared Supabase/Postgres instance).
2. On the Surface Pro client, set `ENABLE_LOCAL_BROWSER_WORKER=false` in its
   `.env`. Calls to `POST /api/applications/{id}/fill` will then return a
   400 telling the human to run that step from the worker instead.
3. On the worker machine, leave `ENABLE_LOCAL_BROWSER_WORKER=true` and call
   the same `/api/applications/{id}/fill` endpoint against the worker's own
   FastAPI instance (or expose only that route from the worker and reverse
   proxy to it from the client).

## Option B — dedicated worker process (future phase)

Replace the in-process APScheduler + direct endpoint call with a proper
queue (Celery/RQ + Redis): the client enqueues a `fill_application` job with
the `application_id`, and one or more workers (on any machine, including a
beefier remote box) pull jobs and run `app/automation/form_filler.py`
against the shared database. This is a drop-in change — `FormFiller.run()`
already takes plain, serializable arguments (IDs, not live ORM sessions)
apart from the SQLAlchemy objects, so the queue task only needs to re-fetch
those rows from the DB before calling it.

## Manual setup either way

- `playwright install chromium` must be run once on whichever machine
  actually launches the browser.
- The worker needs read/write access to the same `storage/screenshots`
  location (or `USE_SUPABASE_STORAGE=true` so screenshots land in Supabase
  Storage instead of local disk — recommended for a split topology so the
  client can display screenshots the worker captured).
