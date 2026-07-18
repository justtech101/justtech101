"""
n8n-compatible inbound webhook. Point an n8n "HTTP Request" node (or any
other automation tool) at:

    POST /api/webhooks/n8n/opportunity
    Header: X-Webhook-Secret: <N8N_WEBHOOK_SHARED_SECRET>
    Body: OpportunityIngest JSON (see app/schemas/opportunity.py)

This lets n8n workflows that scrape a site Playwright can't handle, or that
watch a mailbox n8n already has native nodes for, push structured
opportunities into JUSTTECH without any code changes here.
"""
import logging
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.ingestion import IngestionSource, WebhookLog
from app.schemas.opportunity import OpportunityIngest, OpportunityOut
from app.services.ingestion.runner import ingest_opportunity, run_all_enabled, run_source

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


def verify_webhook_secret(x_webhook_secret: str = Header(default="")) -> None:
    settings = get_settings()
    if not settings.N8N_WEBHOOK_SHARED_SECRET:
        raise HTTPException(500, "N8N_WEBHOOK_SHARED_SECRET is not configured on the server -- inbound webhooks are disabled.")
    if x_webhook_secret != settings.N8N_WEBHOOK_SHARED_SECRET:
        raise HTTPException(401, "Invalid or missing X-Webhook-Secret header.")


@router.post("/n8n/opportunity", response_model=OpportunityOut, dependencies=[Depends(verify_webhook_secret)])
async def receive_opportunity(payload: OpportunityIngest, db: AsyncSession = Depends(get_db)):
    log_entry = WebhookLog(source="n8n", payload=payload.model_dump(mode="json"))
    db.add(log_entry)
    await db.flush()

    try:
        opportunity, _created = await ingest_opportunity(db, payload)
        log_entry.processed = True
        await db.commit()
        return opportunity
    except Exception as exc:
        log_entry.error = str(exc)
        await db.commit()
        logger.exception("Failed to ingest n8n webhook payload")
        raise HTTPException(422, f"Failed to ingest opportunity: {exc}") from exc


@router.post("/ingestion/run-all", dependencies=[Depends(verify_webhook_secret)])
async def trigger_all_ingestion(db: AsyncSession = Depends(get_db)):
    """Manual/n8n-scheduled trigger to run every enabled ingestion source
    immediately, outside the normal APScheduler interval."""
    return await run_all_enabled(db)


@router.post("/ingestion/run/{source_id}", dependencies=[Depends(verify_webhook_secret)])
async def trigger_source_ingestion(source_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    source = await db.get(IngestionSource, source_id)
    if not source:
        raise HTTPException(404, "Ingestion source not found")
    return await run_source(db, source)
