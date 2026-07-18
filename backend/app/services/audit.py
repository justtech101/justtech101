import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.application import AuditLog


async def record_event(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: uuid.UUID,
    event_type: str,
    actor_type: str = "system",
    actor: str | None = None,
    payload: dict[str, Any] | None = None,
    commit: bool = True,
) -> AuditLog:
    entry = AuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        event_type=event_type,
        actor_type=actor_type,
        actor=actor,
        payload=payload or {},
    )
    db.add(entry)
    if commit:
        await db.commit()
        await db.refresh(entry)
    return entry
