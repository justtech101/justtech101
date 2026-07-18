import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile
from app.schemas.opportunity import OpportunityOut, OpportunityStatusUpdate, ScoreRequest
from app.services import scoring
from app.services.audit import record_event

router = APIRouter(prefix="/api/opportunities", tags=["opportunities"])


@router.get("", response_model=list[OpportunityOut])
async def list_opportunities(
    type: str | None = None,
    status: str | None = None,
    min_score: int | None = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    query = select(Opportunity)
    if type:
        query = query.where(Opportunity.type == type)
    if status:
        query = query.where(Opportunity.status == status)
    if min_score is not None:
        query = query.where(Opportunity.score >= min_score)
    query = query.order_by(Opportunity.score.desc().nulls_last(), Opportunity.discovered_at.desc())
    query = query.limit(limit).offset(offset)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/{opportunity_id}", response_model=OpportunityOut)
async def get_opportunity(opportunity_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    opportunity = await db.get(Opportunity, opportunity_id)
    if not opportunity:
        raise HTTPException(404, "Opportunity not found")
    return opportunity


@router.patch("/{opportunity_id}/status", response_model=OpportunityOut)
async def update_status(opportunity_id: uuid.UUID, payload: OpportunityStatusUpdate, db: AsyncSession = Depends(get_db)):
    opportunity = await db.get(Opportunity, opportunity_id)
    if not opportunity:
        raise HTTPException(404, "Opportunity not found")
    old_status = opportunity.status
    opportunity.status = payload.status
    await record_event(
        db, entity_type="opportunity", entity_id=opportunity.id, event_type="status_changed",
        actor_type="human", payload={"from": old_status, "to": payload.status}, commit=False,
    )
    await db.commit()
    await db.refresh(opportunity)
    return opportunity


@router.post("/{opportunity_id}/score", response_model=OpportunityOut)
async def rescore_opportunity(opportunity_id: uuid.UUID, payload: ScoreRequest, db: AsyncSession = Depends(get_db)):
    opportunity = await db.get(Opportunity, opportunity_id)
    if not opportunity:
        raise HTTPException(404, "Opportunity not found")
    profile = await db.get(ApplicantProfile, payload.profile_id)
    if not profile:
        raise HTTPException(404, "Profile not found")

    score, breakdown = scoring.score_opportunity(opportunity, profile)
    opportunity.score = score
    existing_by_profile = (opportunity.score_breakdown or {}).get("by_profile", {})
    existing_by_profile[str(profile.id)] = breakdown
    opportunity.score_breakdown = {"best": breakdown, "by_profile": existing_by_profile}
    if score >= 70 and opportunity.status == "new":
        opportunity.status = "qualified"

    await record_event(
        db, entity_type="opportunity", entity_id=opportunity.id, event_type="rescored",
        actor_type="human", payload={"profile_id": str(profile.id), "score": score}, commit=False,
    )
    await db.commit()
    await db.refresh(opportunity)
    return opportunity


@router.delete("/{opportunity_id}", status_code=204)
async def delete_opportunity(opportunity_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    opportunity = await db.get(Opportunity, opportunity_id)
    if not opportunity:
        raise HTTPException(404, "Opportunity not found")
    await db.delete(opportunity)
    await db.commit()
