import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

OpportunityType = Literal["job", "grant"]
OpportunityStatus = Literal[
    "new", "qualified", "missing_info", "ready_for_review",
    "submitted", "rejected", "follow_up", "duplicate", "archived",
]


class OpportunityIngest(BaseModel):
    """Payload shape accepted from ingestors and n8n webhooks. Only fields
    actually present in the source should be populated -- everything else
    must stay null rather than be guessed."""

    type: OpportunityType
    source: str
    source_url: str | None = None
    external_id: str | None = None
    title: str
    organization: str | None = None
    description: str | None = None
    location: str | None = None
    remote: bool | None = None
    deadline: datetime | None = None
    eligibility: dict[str, Any] = {}
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str = "USD"
    award_amount: float | None = None
    required_documents: list[str] = []
    application_questions: list[dict[str, Any]] = []
    raw_data: dict[str, Any] = {}


class OpportunityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    type: OpportunityType
    source: str
    source_url: str | None
    external_id: str | None
    title: str
    organization: str | None
    description: str | None
    location: str | None
    remote: bool | None
    deadline: datetime | None
    eligibility: dict[str, Any]
    salary_min: float | None
    salary_max: float | None
    salary_currency: str
    award_amount: float | None
    required_documents: list[str]
    application_questions: list[dict[str, Any]]
    status: OpportunityStatus
    score: int | None
    score_breakdown: dict[str, Any]
    missing_fields: list[str]
    discovered_at: datetime
    updated_at: datetime


class OpportunityStatusUpdate(BaseModel):
    status: OpportunityStatus


class ScoreRequest(BaseModel):
    profile_id: uuid.UUID
