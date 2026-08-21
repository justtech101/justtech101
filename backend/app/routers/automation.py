import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.automation import session_registry
from app.automation.form_filler import FieldMapping, FormFiller, resume_paused_fields
from app.automation.session_registry import PausedSession
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


class PendingFieldOut(BaseModel):
    selector: str
    label: str
    field_type: str


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
    # Populated only when status == "awaiting_human_input" -- exactly the
    # fields a human can supply a live value for via POST /resume-fill.
    # These are NEVER auto-filled from stored data; see form_filler.py.
    pending_fields: list[PendingFieldOut] = []


class HumanInputIn(BaseModel):
    selector: str
    # The live value a human is typing/checking right now, in this request.
    # Never persisted anywhere -- used once to fill this one field, then
    # discarded. For a "check" field_type, "true"/"yes"/"1" checks the box.
    value: str


class ResumeFillRequest(BaseModel):
    human_inputs: list[HumanInputIn]


def _to_field_mapping(f: FieldMappingIn) -> FieldMapping:
    return FieldMapping(**f.model_dump())


def _to_pending_out(f: FieldMapping) -> PendingFieldOut:
    return PendingFieldOut(selector=f.selector, label=f.label, field_type=f.field_type)


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

    # Starting a fresh run supersedes any earlier paused session for this
    # application -- don't leave a stale browser process open.
    await session_registry.close_and_discard(str(application_id))

    field_map = [_to_field_mapping(f) for f in payload.field_map]
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
        opportunity.status = "missing_info"
        application.missing_fields = list(set((application.missing_fields or []) + ["captcha_blocked"]))
    elif result.status == "awaiting_human_review" and result.stopped_fields:
        application.missing_fields = list(set((application.missing_fields or []) + result.stopped_fields))

    pending_out: list[PendingFieldOut] = []
    if result.status == "awaiting_human_input" and result.browser is not None:
        await session_registry.store(
            str(application_id),
            PausedSession(browser=result.browser, pending_fields=result.paused_fields, dry_run=application.dry_run),
        )
        pending_out = [_to_pending_out(f) for f in result.paused_fields]

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
            "pending_fields": [f.label for f in result.paused_fields],
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
        pending_fields=pending_out,
    )


@router.post("/{application_id}/resume-fill", response_model=FillResponse)
async def resume_fill(application_id: uuid.UUID, payload: ResumeFillRequest, db: AsyncSession = Depends(get_db)):
    """Completes exactly the paused fields a human is supplying a live value
    for right now (a password, an attestation checkbox, a typed signature,
    an SSN, etc.). This is the fast path for the human-review checkpoint
    described in form_filler.py: the browser stayed open at the exact point
    it stopped, so nothing else needs to be redone.

    Every value in `human_inputs` is used once, immediately, to fill that
    one field on the already-open page -- it is never written to the
    database and never becomes reusable/auto-fillable data. Only
    `filled_fields` (labels, not values) are recorded in the audit log.
    """
    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")

    session = await session_registry.get(str(application_id))
    if not session:
        raise HTTPException(
            404,
            "No paused automation session for this application (it may have expired after "
            f"{session_registry.SESSION_TTL_SECONDS // 60} minutes of inactivity). Run /fill again.",
        )

    pending_selectors = {f.selector for f in session.pending_fields}
    unknown = [i.selector for i in payload.human_inputs if i.selector not in pending_selectors]
    if unknown:
        raise HTTPException(
            400,
            f"These selectors were not paused by the last /fill run and can't be filled here: {unknown}. "
            "This endpoint only accepts fields that were already vetted as sensitive/paused.",
        )

    human_inputs_map = {i.selector: i.value for i in payload.human_inputs}
    resume_result = await resume_paused_fields(
        application_id=str(application_id),
        browser=session.browser,
        pending_fields=session.pending_fields,
        human_inputs=human_inputs_map,
    )

    for shot_path in resume_result.screenshots:
        db.add(Screenshot(application_id=application.id, step=Path(shot_path).stem, file_path=shot_path))

    filled_labels = resume_result.filled_fields
    remaining_labels = [f.label for f in resume_result.remaining_pending]

    if resume_result.status in ("awaiting_human_review", "error"):
        await session_registry.close_and_discard(str(application_id))
    else:
        session.pending_fields = resume_result.remaining_pending

    await record_event(
        db,
        entity_type="application",
        entity_id=application.id,
        event_type="human_input_applied",
        actor_type="human",
        payload={
            "status": resume_result.status,
            "filled_labels": filled_labels,
            "remaining_pending_labels": remaining_labels,
            "error": resume_result.error,
        },
        commit=False,
    )
    await db.commit()

    return FillResponse(
        status=resume_result.status,
        filled_fields=filled_labels,
        missing_fields=[],
        stopped_fields=remaining_labels,
        screenshots=resume_result.screenshots,
        error=resume_result.error,
        pending_fields=[_to_pending_out(f) for f in resume_result.remaining_pending],
    )
