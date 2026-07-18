import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import AsyncSessionLocal
from app.routers import applications, audit, automation, credentials, dashboard, drafting, ingestion_sources, opportunities, profiles, webhooks
from app.services.ingestion.runner import run_all_enabled

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()
scheduler = AsyncIOScheduler()

app = FastAPI(
    title="JUSTTECH Application Manager",
    description="Local-first job & grant discovery, scoring, drafting, and browser-assisted application tracker.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/storage", StaticFiles(directory=str(settings.storage_path)), name="storage")

app.include_router(profiles.router)
app.include_router(opportunities.router)
app.include_router(applications.router)
app.include_router(automation.router)
app.include_router(drafting.router)
app.include_router(dashboard.router)
app.include_router(webhooks.router)
app.include_router(credentials.router)
app.include_router(audit.router)
app.include_router(ingestion_sources.router)


async def _scheduled_ingestion_run() -> None:
    async with AsyncSessionLocal() as db:
        try:
            results = await run_all_enabled(db)
            logger.info("Scheduled ingestion run completed: %s", results)
        except Exception:
            logger.exception("Scheduled ingestion run failed")


@app.on_event("startup")
async def on_startup() -> None:
    # First run fires after one interval has elapsed. For an immediate run
    # (e.g. right after adding a new ingestion source), call
    # POST /api/webhooks/ingestion/run-all instead of waiting.
    scheduler.add_job(
        _scheduled_ingestion_run,
        "interval",
        minutes=settings.INGESTION_INTERVAL_MINUTES,
        id="ingestion_poll",
    )
    scheduler.start()
    logger.info(
        "JUSTTECH Application Manager started (environment=%s, ingestion every %s min)",
        settings.ENVIRONMENT,
        settings.INGESTION_INTERVAL_MINUTES,
    )


@app.on_event("shutdown")
async def on_shutdown() -> None:
    scheduler.shutdown(wait=False)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
