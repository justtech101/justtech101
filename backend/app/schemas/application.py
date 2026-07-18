import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

ApplicationStatus = Literal[
    "new", "qualified", "missing_info", "ready_for_review",
    "submitted", "rejected", "follow_up",
]


class ApplicationCreate(BaseModel):
    opportunity_id: uuid.UUID
    profile_id: uuid.UUID
    dry_run: bool = True


class ApplicationUpdate(BaseModel):
    status: ApplicationStatus | None = None
    answers: dict[str, Any] | None = None
    notes: str | None = None
    rejected_reason: str | None = None
    follow_up_date: date | None = None


class ApplicationApprove(BaseModel):
    approved_by: str


class ApplicationSubmitConfirm(BaseModel):
    """Explicit human confirmation required to mark an application submitted.
    This endpoint never triggers a browser submit itself -- it only records
    that a human clicked submit after visually reviewing the filled form."""

    confirmed_by: str
    confirmation_phrase: Literal["I confirm I have manually submitted this application"]


class ApplicationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    opportunity_id: uuid.UUID
    profile_id: uuid.UUID
    status: ApplicationStatus
    resume_doc_id: uuid.UUID | None
    cover_letter_doc_id: uuid.UUID | None
    narrative_doc_id: uuid.UUID | None
    answers: dict[str, Any]
    missing_fields: list[str]
    dry_run: bool
    human_approved: bool
    human_approved_by: str | None
    human_approved_at: datetime | None
    submitted_at: datetime | None
    rejected_reason: str | None
    follow_up_date: date | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class ScreenshotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    application_id: uuid.UUID
    step: str
    file_path: str
    created_at: datetime
