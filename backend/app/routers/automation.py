import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.automation.form_filler import FieldMapping, FormFiller
from app.config import get_settings
from app.database import get_db
from app.models.application import Application, Screenshot
from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile
from app.services.audit import record_event

router = APIRouter(prefix="/api/applications", tags=["automation"])


class FieldMappingIn(BaseModel):
    selector: str
    label: str
    field_type: str  # fill | select | check | upload
    value_source: str


class FillRequest(BaseModel):
    field_map: list[FieldMappingIn]
    headless: bool = True


class FillResponse(BaseModel):
    status: str
    filled_fields: list[str]
    missing_fields: list[str]
    stopped_fields: list[str]
    screenshots: list[str]
    error: str | None = None


@router.post("/{application_id}/fill", response_model=FillResponse)
async def fill_application_form(application_id: uuid.UUID, payload: FillRequest, db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    if not settings.ENABLE_LOCAL_BROWSER_WORKER:
        raise HTTPException(
            400,
            "Local browser automation is disabled on this client "
            "(ENABLE_LOCAL_BROWSER_WORKER=false). Run this from the remote worker instead.",
        )

    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")
    if not application.human_approved:
        raise HTTPException(400, "Application must be approved (Ready for Review) before a form-fill run can start.")

    opportunity = await db.get(Opportunity, application.opportunity_id)
    profile = await db.get(ApplicantProfile, application.profile_id)
    if not opportunity or not profile:
        raise HTTPException(404, "Related opportunity or profile not found")

    field_map = [FieldMapping(**f.model_dump()) for f in payload.field_map]
    filler = FormFiller(
        dry_run=application.dry_run,
        screenshot_dir=Path(settings.STORAGE_ROOT) / "screenshots",
        headless=payload.headless,
    )

    result = await filler.run(application=application, opportunity=opportunity, profile=profile, field_map=field_map)

    for shot_path in result.screenshots:
        db.add(Screenshot(application_id=application.id, step=Path(shot_path).stem, file_path=shot_path))

    if result.status == "stopped_captcha":
        application.status = "missing_info"
        application.missing_fields = list(set((application.missing_fields or []) + ["captcha_blocked"]))
    elif result.status == "awaiting_human_review" and result.stopped_fields:
        application.missing_fields = list(set((application.missing_fields or []) + result.stopped_fields))

    await record_event(
        db,
        entity_type="application",
        entity_id=application.id,
        event_type="form_fill_run",
        actor_type="automation",
        payload={
            "status": result.status,
            "dry_run": application.dry_run,
            "filled_fields": result.filled_fields,
            "stopped_fields": result.stopped_fields,
            "missing_fields": result.missing_fields,
            "error": result.error,
        },
        commit=False,
    )
    await db.commit()

    return FillResponse(
        status=result.status,
        filled_fields=result.filled_fields,
        missing_fields=result.missing_fields,
        stopped_fields=result.stopped_fields,
        screenshots=result.screenshots,
        error=result.error,
    )
