import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

SourceType = Literal["rss", "email", "api", "website", "n8n_webhook"]
OppType = Literal["job", "grant"]


class IngestionSourceCreate(BaseModel):
    name: str
    source_type: SourceType
    opportunity_type: OppType
    config: dict[str, Any]
    enabled: bool = True


class IngestionSourceUpdate(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None
    enabled: bool | None = None


class IngestionSourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    source_type: SourceType
    opportunity_type: OppType
    config: dict[str, Any]
    enabled: bool
    last_run_at: datetime | None
    last_status: str | None
    last_error: str | None
    created_at: datetime
