import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.application import Credential
from app.schemas.credential import CredentialCreate, CredentialOut
from app.security import encrypt_value
from app.services.audit import record_event

router = APIRouter(prefix="/api/credentials", tags=["credentials"])


@router.get("", response_model=list[CredentialOut])
async def list_credentials(profile_id: uuid.UUID | None = None, db: AsyncSession = Depends(get_db)):
    query = select(Credential)
    if profile_id:
        query = query.where(Credential.profile_id == profile_id)
    result = await db.execute(query)
    return result.scalars().all()


@router.post("", response_model=CredentialOut, status_code=201)
async def create_credential(payload: CredentialCreate, db: AsyncSession = Depends(get_db)):
    """Secret and username are encrypted immediately with Fernet
    (JUSTTECH_ENCRYPTION_KEY) before touching the database -- plaintext is
    never persisted."""
    credential = Credential(
        profile_id=payload.profile_id,
        site_domain=payload.site_domain,
        username_encrypted=encrypt_value(payload.username),
        secret_encrypted=encrypt_value(payload.secret),
    )
    db.add(credential)
    await db.flush()
    await record_event(
        db, entity_type="credential", entity_id=credential.id, event_type="created",
        actor_type="human", payload={"site_domain": payload.site_domain}, commit=False,
    )
    await db.commit()
    await db.refresh(credential)
    return credential


@router.delete("/{credential_id}", status_code=204)
async def delete_credential(credential_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    credential = await db.get(Credential, credential_id)
    if not credential:
        raise HTTPException(404, "Credential not found")
    await db.delete(credential)
    await record_event(
        db, entity_type="credential", entity_id=credential_id, event_type="deleted", actor_type="human", commit=False,
    )
    await db.commit()
