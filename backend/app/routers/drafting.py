import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.application import Application
from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile, ProfileDocument
from app.services.audit import record_event
from app.services.drafting import default_drafter

router = APIRouter(prefix="/api/applications", tags=["drafting"])

DocType = Literal["cover_letter", "resume", "grant_narrative"]

_DRAFT_METHOD = {
    "cover_letter": "draft_cover_letter",
    "resume": "draft_resume_summary",
    "grant_narrative": "draft_grant_narrative",
}
_APPLICATION_FIELD = {
    "cover_letter": "cover_letter_doc_id",
    "resume": "resume_doc_id",
    "grant_narrative": "narrative_doc_id",
}


class DraftRequest(BaseModel):
    doc_type: DocType
    persist: bool = True  # if true, saves as a profile_documents row and links it on the application


class DraftResponse(BaseModel):
    document_text: str
    missing_fields: list[str]
    document_id: uuid.UUID | None = None


@router.post("/{application_id}/draft", response_model=DraftResponse)
async def draft_document(application_id: uuid.UUID, payload: DraftRequest, db: AsyncSession = Depends(get_db)):
    """Generates a resume summary / cover letter / grant narrative from
    VERIFIED profile data only (see app/services/drafting.py). Anything the
    profile is missing is returned in `missing_fields` rather than invented
    -- this is also how an application ends up in the Missing Information
    bucket instead of Ready for Review."""
    application = await db.get(Application, application_id)
    if not application:
        raise HTTPException(404, "Application not found")
    opportunity = await db.get(Opportunity, application.opportunity_id)
    profile = await db.get(ApplicantProfile, application.profile_id)
    if not opportunity or not profile:
        raise HTTPException(404, "Related opportunity or profile not found")

    method = getattr(default_drafter, _DRAFT_METHOD[payload.doc_type])
    draft = method(opportunity, profile)

    document_id = None
    if payload.persist:
        settings = get_settings()
        doc_dir = Path(settings.STORAGE_ROOT) / "documents"
        doc_dir.mkdir(parents=True, exist_ok=True)
        file_path = doc_dir / f"{application.id}__{payload.doc_type}.txt"
        file_path.write_text(draft.document_text, encoding="utf-8")

        document = ProfileDocument(
            profile_id=profile.id,
            doc_type=payload.doc_type,
            title=f"{payload.doc_type} for {opportunity.title}",
            file_path=str(file_path),
            generated_by="drafting_service",
            is_verified=False,
        )
        db.add(document)
        await db.flush()
        setattr(application, _APPLICATION_FIELD[payload.doc_type], document.id)
        document_id = document.id

    if draft.missing_fields:
        application.missing_fields = list(set((application.missing_fields or []) + draft.missing_fields))
        if application.status in ("new", "qualified"):
            application.status = "missing_info"
            opportunity.status = "missing_info"

    await record_event(
        db,
        entity_type="application",
        entity_id=application.id,
        event_type="draft_generated",
        actor_type="automation",
        payload={"doc_type": payload.doc_type, "missing_fields": draft.missing_fields},
        commit=False,
    )
    await db.commit()

    return DraftResponse(document_text=draft.document_text, missing_fields=draft.missing_fields, document_id=document_id)
