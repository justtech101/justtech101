import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.application import Application, Screenshot
from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile
from app.schemas.application import (
    ApplicationApprove,
    ApplicationCreate,
    ApplicationOut,
    ApplicationSubmitConfirm,
    ApplicationUpdate,
    ScreenshotOut,
)
from app.services.audit import record_event

router = APIRouter(prefix="/api/applications", tags=["applications"])


@router.get("", response_model=list[ApplicationOut])
async def list_applications(status: str | None = None, profile_id: uuid.UUID | None = None, db: AsyncSession = Depends(get_db)):
    query = select(Application)
    if status:
        query = query.where(Application.status == status)
    if profile_id:
        query = query.where(Application.profile_id == profile_id)
    result = await db.execute(query.order_by(Application.updated_at.desc()))
    return result.scalars().all()


@router.post("", response_model=ApplicationOut, status_code=201)
async def create_application(payload: ApplicationCreate, db: AsyncSession = Depends(get_db)):
    opportunity = await db.get(Opportunity, payload.opportunity_id)
    if not opportunity:
        raise HTTPException(404, "Opportunity not found")
    profile = await db.get(ApplicantProfile, payload.profile_id)
    if not profile:
        raise HTTPException(404, "Profile not found")

    settings = get_settings()
    application = Application(
        opportunity_id=payload.opportunity_id,
        profile_id=payload.profile_id,
        dry_run=payload.dry_run if payload.dry_run is not None else settings.DEFAULT_DRY_RUN,
        missing_fields=opportunity.missing_fields or [],
        status="missing_info" if opportunity.missing_fields else "qualified",
    )
    db.add(application)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            409,
            "Duplicate application: this profile already has an application for this opportunity.",
        ) from exc

    await record_event(
        db, entity_type="application", entity_id=application.id, event_type="created",
        actor_type="human", payload={"opportunity_id": str(opportunity.id), "profile_id": str(profile.id)}, commit=False,
    )
    await db.commit()
    await db.refresh(application)
    return application


@router.get("/{application_id}", response_model=ApplicationOut)
async def get_application(application_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")
    return application


@router.patch("/{application_id}", response_model=ApplicationOut)
async def update_application(application_id: uuid.UUID, payload: ApplicationUpdate, db: AsyncSession = Depends(get_db)):
    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(application, key, value)
    await record_event(
        db, entity_type="application", entity_id=application.id, event_type="updated",
        actor_type="human", payload={"changed_fields": list(changes.keys())}, commit=False,
    )
    await db.commit()
    await db.refresh(application)
    return application


@router.post("/{application_id}/approve", response_model=ApplicationOut)
async def approve_application(application_id: uuid.UUID, payload: ApplicationApprove, db: AsyncSession = Depends(get_db)):
    """Human review gate. Nothing in /automation will run against an
    application until this has been called."""
    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")
    if application.missing_fields:
        raise HTTPException(400, f"Cannot approve: missing fields {application.missing_fields}")

    application.human_approved = True
    application.human_approved_by = payload.approved_by
    application.human_approved_at = datetime.now(timezone.utc)
    application.status = "ready_for_review"
    await record_event(
        db, entity_type="application", entity_id=application.id, event_type="human_approved",
        actor_type="human", actor=payload.approved_by, commit=False,
    )
    await db.commit()
    await db.refresh(application)
    return application


@router.post("/{application_id}/confirm-submitted", response_model=ApplicationOut)
async def confirm_submitted(application_id: uuid.UUID, payload: ApplicationSubmitConfirm, db: AsyncSession = Depends(get_db)):
    """This endpoint NEVER triggers a browser submit. It only records that a
    human has manually reviewed the filled-in form and clicked submit
    themselves. The confirmation_phrase must be typed exactly, so this can't
    be triggered accidentally by an automated caller."""
    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")
    if not application.human_approved:
        raise HTTPException(400, "Application must be human-approved before it can be marked submitted.")

    application.status = "submitted"
    application.submitted_at = datetime.now(timezone.utc)
    await record_event(
        db, entity_type="application", entity_id=application.id, event_type="submitted",
        actor_type="human", actor=payload.confirmed_by, commit=False,
    )
    await db.commit()
    await db.refresh(application)
    return application


@router.get("/{application_id}/screenshots", response_model=list[ScreenshotOut])
async def list_screenshots(application_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Screenshot).where(Screenshot.application_id == application_id).order_by(Screenshot.created_at))
    return result.scalars().all()


@router.delete("/{application_id}", status_code=204)
async def delete_application(application_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")
    await db.delete(application)
    await db.commit()
