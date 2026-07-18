import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.profile import ApplicantProfile, ReusableAnswer
from app.schemas.profile import (
    ProfileCreate,
    ProfileOut,
    ProfileUpdate,
    ReusableAnswerCreate,
    ReusableAnswerOut,
)
from app.services.audit import record_event

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


@router.get("", response_model=list[ProfileOut])
async def list_profiles(active_only: bool = False, db: AsyncSession = Depends(get_db)):
    query = select(ApplicantProfile)
    if active_only:
        query = query.where(ApplicantProfile.is_active.is_(True))
    result = await db.execute(query.order_by(ApplicantProfile.created_at.desc()))
    return result.scalars().all()


@router.post("", response_model=ProfileOut, status_code=201)
async def create_profile(payload: ProfileCreate, db: AsyncSession = Depends(get_db)):
    profile = ApplicantProfile(**payload.model_dump())
    db.add(profile)
    await db.flush()
    await record_event(db, entity_type="profile", entity_id=profile.id, event_type="created", actor_type="human", commit=False)
    await db.commit()
    await db.refresh(profile)
    return profile


@router.get("/{profile_id}", response_model=ProfileOut)
async def get_profile(profile_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    profile = await db.get(ApplicantProfile, profile_id)
    if not profile:
        raise HTTPException(404, "Profile not found")
    return profile


@router.patch("/{profile_id}", response_model=ProfileOut)
async def update_profile(profile_id: uuid.UUID, payload: ProfileUpdate, db: AsyncSession = Depends(get_db)):
    profile = await db.get(ApplicantProfile, profile_id)
    if not profile:
        raise HTTPException(404, "Profile not found")
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(profile, key, value)
    await record_event(
        db, entity_type="profile", entity_id=profile.id, event_type="updated",
        actor_type="human", payload={"changed_fields": list(changes.keys())}, commit=False,
    )
    await db.commit()
    await db.refresh(profile)
    return profile


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(profile_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    profile = await db.get(ApplicantProfile, profile_id)
    if not profile:
        raise HTTPException(404, "Profile not found")
    await db.delete(profile)
    await db.commit()


@router.get("/{profile_id}/answers", response_model=list[ReusableAnswerOut])
async def list_reusable_answers(profile_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ReusableAnswer).where(ReusableAnswer.profile_id == profile_id))
    return result.scalars().all()


@router.post("/{profile_id}/answers", response_model=ReusableAnswerOut, status_code=201)
async def upsert_reusable_answer(profile_id: uuid.UUID, payload: ReusableAnswerCreate, db: AsyncSession = Depends(get_db)):
    profile = await db.get(ApplicantProfile, profile_id)
    if not profile:
        raise HTTPException(404, "Profile not found")

    question_hash = hashlib.sha256(payload.question_text.strip().lower().encode()).hexdigest()
    result = await db.execute(
        select(ReusableAnswer).where(
            ReusableAnswer.profile_id == profile_id, ReusableAnswer.question_hash == question_hash
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.answer_text = payload.answer_text
        existing.category = payload.category
        existing.verified = payload.verified
        existing.verified_at = datetime.now(timezone.utc) if payload.verified else None
        answer = existing
    else:
        answer = ReusableAnswer(
            profile_id=profile_id,
            question_hash=question_hash,
            question_text=payload.question_text,
            answer_text=payload.answer_text,
            category=payload.category,
            verified=payload.verified,
            verified_at=datetime.now(timezone.utc) if payload.verified else None,
        )
        db.add(answer)

    await db.commit()
    await db.refresh(answer)
    return answer


@router.delete("/{profile_id}/answers/{answer_id}", status_code=204)
async def delete_reusable_answer(profile_id: uuid.UUID, answer_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    answer = await db.get(ReusableAnswer, answer_id)
    if not answer or answer.profile_id != profile_id:
        raise HTTPException(404, "Answer not found")
    await db.delete(answer)
    await db.commit()
