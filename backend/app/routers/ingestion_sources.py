import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.ingestion import IngestionSource
from app.schemas.ingestion_source import IngestionSourceCreate, IngestionSourceOut, IngestionSourceUpdate

router = APIRouter(prefix="/api/ingestion-sources", tags=["ingestion-sources"])


@router.get("", response_model=list[IngestionSourceOut])
async def list_sources(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(IngestionSource).order_by(IngestionSource.name))
    return result.scalars().all()


@router.post("", response_model=IngestionSourceOut, status_code=201)
async def create_source(payload: IngestionSourceCreate, db: AsyncSession = Depends(get_db)):
    source = IngestionSource(**payload.model_dump())
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source


@router.patch("/{source_id}", response_model=IngestionSourceOut)
async def update_source(source_id: uuid.UUID, payload: IngestionSourceUpdate, db: AsyncSession = Depends(get_db)):
    source = await db.get(IngestionSource, source_id)
    if not source:
        raise HTTPException(404, "Ingestion source not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(source, key, value)
    await db.commit()
    await db.refresh(source)
    return source


@router.delete("/{source_id}", status_code=204)
async def delete_source(source_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    source = await db.get(IngestionSource, source_id)
    if not source:
        raise HTTPException(404, "Ingestion source not found")
    await db.delete(source)
    await db.commit()
