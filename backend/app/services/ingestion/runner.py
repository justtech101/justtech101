"""
Orchestrates ingestion: builds the right Ingestor for each enabled
`ingestion_sources` row, fetches, then hands every item to
`ingest_opportunity`, which is the single choke point for dedup + scoring +
insert. n8n webhook payloads flow through the exact same `ingest_opportunity`
function so behavior is identical regardless of where an opportunity came
from.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ingestion import IngestionSource
from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile
from app.schemas.opportunity import OpportunityIngest
from app.services import extraction, scoring
from app.services.audit import record_event
from app.services.dedup import compute_content_hash, find_exact_duplicate, find_fuzzy_duplicate
from app.services.ingestion.api_ingestor import GrantsGovIngestor, RemoteOKIngestor
from app.services.ingestion.base import Ingestor
from app.services.ingestion.email_ingestor import EmailAlertIngestor
from app.services.ingestion.rss_ingestor import RSSIngestor
from app.services.notifications import notify_new_qualified_opportunity

logger = logging.getLogger(__name__)


def build_ingestor(source: IngestionSource) -> Ingestor:
    if source.source_type == "rss":
        return RSSIngestor(name=source.name, config=source.config, opportunity_type=source.opportunity_type)
    if source.source_type == "email":
        return EmailAlertIngestor(name=source.name, config=source.config, opportunity_type=source.opportunity_type)
    if source.source_type == "api":
        provider = source.config.get("provider")
        if provider == "grants_gov":
            return GrantsGovIngestor(name=source.name, config=source.config)
        if provider == "remoteok":
            return RemoteOKIngestor(name=source.name, config=source.config)
        raise ValueError(f"Unknown api provider '{provider}' for source '{source.name}'")
    raise ValueError(f"No ingestor implemented for source_type '{source.source_type}' (source '{source.name}')")


async def ingest_opportunity(db: AsyncSession, item: OpportunityIngest) -> tuple[Opportunity, bool]:
    """Insert a normalized opportunity if it's not a duplicate. Returns
    (opportunity, created). If a duplicate is found, returns the existing
    row and created=False -- no data is overwritten on a re-ingest."""
    content_hash = compute_content_hash(
        type_=item.type, organization=item.organization, title=item.title, source=item.source
    )

    existing = await find_exact_duplicate(db, content_hash)
    if existing:
        return existing, False

    fuzzy_match = await find_fuzzy_duplicate(db, type_=item.type, organization=item.organization, title=item.title)
    if fuzzy_match:
        await record_event(
            db,
            entity_type="opportunity",
            entity_id=fuzzy_match.id,
            event_type="duplicate_detected",
            payload={"incoming_source": item.source, "incoming_title": item.title},
            commit=False,
        )
        return fuzzy_match, False

    # Backfill any structured field the caller didn't already supply by
    # running the same text-extraction pass the RSS/API ingestors use. This
    # keeps extraction behavior uniform across every entry point (n8n
    # webhooks and manually-posted payloads included), not just the
    # built-in ingestors -- it only ever fills a field from text that is
    # actually present in `description`, never invents one.
    deadline = item.deadline or extraction.extract_deadline(item.description or "")
    required_documents = item.required_documents or extraction.extract_required_documents(item.description or "")
    application_questions = item.application_questions or extraction.extract_application_questions(item.description or "")
    salary_min, salary_max = item.salary_min, item.salary_max
    award_amount = item.award_amount
    if item.type == "job" and salary_min is None and salary_max is None:
        salary_min, salary_max = extraction.extract_salary_range(item.description or "")
    if item.type == "grant" and award_amount is None:
        award_amount = extraction.extract_award_amount(item.description or "")

    salary_or_award = salary_min or salary_max or award_amount
    missing_fields = extraction.compute_missing_fields(
        deadline=deadline,
        eligibility=item.eligibility,
        required_documents=required_documents,
        salary_or_award=salary_or_award,
        description=item.description,
    )
    status = "missing_info" if missing_fields else "new"

    opportunity = Opportunity(
        type=item.type,
        source=item.source,
        source_url=item.source_url,
        external_id=item.external_id,
        content_hash=content_hash,
        title=item.title,
        organization=item.organization,
        description=item.description,
        location=item.location,
        remote=item.remote,
        deadline=deadline,
        eligibility=item.eligibility,
        salary_min=salary_min,
        salary_max=salary_max,
        salary_currency=item.salary_currency,
        award_amount=award_amount,
        required_documents=required_documents,
        application_questions=application_questions,
        raw_data=item.raw_data,
        status=status,
        missing_fields=missing_fields,
    )
    db.add(opportunity)
    await db.flush()

    await score_against_active_profiles(db, opportunity)
    await record_event(
        db, entity_type="opportunity", entity_id=opportunity.id, event_type="ingested",
        payload={"source": item.source}, commit=False,
    )
    await db.commit()
    await db.refresh(opportunity)
    if opportunity.status == "qualified":
        await notify_new_qualified_opportunity(opportunity)
    return opportunity, True


async def score_against_active_profiles(db: AsyncSession, opportunity: Opportunity) -> None:
    """Scores the opportunity against every active profile and keeps the
    best score as the headline `score`, with every profile's breakdown kept
    for transparency."""
    result = await db.execute(select(ApplicantProfile).where(ApplicantProfile.is_active.is_(True)))
    profiles = result.scalars().all()
    if not profiles:
        return

    per_profile: dict[str, dict] = {}
    best_score = -1
    best_breakdown: dict = {}
    for profile in profiles:
        score, breakdown = scoring.score_opportunity(opportunity, profile)
        per_profile[str(profile.id)] = breakdown
        if score > best_score:
            best_score = score
            best_breakdown = breakdown

    opportunity.score = best_score
    opportunity.score_breakdown = {"best": best_breakdown, "by_profile": per_profile}
    if best_score >= 70 and opportunity.status == "new":
        opportunity.status = "qualified"


async def run_source(db: AsyncSession, source: IngestionSource) -> dict:
    ingestor = build_ingestor(source)
    try:
        items = await ingestor.fetch()
    except Exception as exc:
        source.last_status = "error"
        source.last_error = str(exc)
        source.last_run_at = datetime.now(timezone.utc)
        await db.commit()
        logger.exception("Ingestion source '%s' failed", source.name)
        return {"source": source.name, "status": "error", "error": str(exc)}

    created = 0
    duplicates = 0
    for item in items:
        _, was_created = await ingest_opportunity(db, item)
        if was_created:
            created += 1
        else:
            duplicates += 1

    source.last_status = "ok"
    source.last_error = None
    source.last_run_at = datetime.now(timezone.utc)
    await db.commit()
    return {"source": source.name, "status": "ok", "fetched": len(items), "created": created, "duplicates": duplicates}


async def run_all_enabled(db: AsyncSession) -> list[dict]:
    result = await db.execute(select(IngestionSource).where(IngestionSource.enabled.is_(True)))
    sources = result.scalars().all()
    return [await run_source(db, source) for source in sources]
