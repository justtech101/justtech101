import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CredentialCreate(BaseModel):
    profile_id: uuid.UUID
    site_domain: str
    username: str
    secret: str  # plaintext in transit over localhost/TLS only; encrypted at rest immediately


class CredentialOut(BaseModel):
    """Never returns decrypted secrets."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    profile_id: uuid.UUID
    site_domain: str
    created_at: datetime
    updated_at: datetime


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    event_type: str
    actor_type: str
    actor: str | None
    payload: dict
    created_at: datetime
