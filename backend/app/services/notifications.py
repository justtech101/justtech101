"""
Outbound n8n webhook notifications. Configure N8N_OUTBOUND_WEBHOOK_URL in
.env to point at an n8n "Webhook" trigger node's URL -- from there you can
fan out to Slack, email, SMS, etc. entirely inside n8n with no code changes
here.
"""
import logging

import httpx

from app.config import get_settings
from app.models.opportunity import Opportunity

logger = logging.getLogger(__name__)


async def notify_new_qualified_opportunity(opportunity: Opportunity) -> None:
    settings = get_settings()
    if not settings.N8N_OUTBOUND_WEBHOOK_URL:
        return

    payload = {
        "event": "opportunity_qualified",
        "opportunity_id": str(opportunity.id),
        "type": opportunity.type,
        "title": opportunity.title,
        "organization": opportunity.organization,
        "score": opportunity.score,
        "deadline": opportunity.deadline.isoformat() if opportunity.deadline else None,
        "source_url": opportunity.source_url,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(settings.N8N_OUTBOUND_WEBHOOK_URL, json=payload)
    except httpx.HTTPError:
        logger.exception("Failed to notify n8n outbound webhook for opportunity %s", opportunity.id)
