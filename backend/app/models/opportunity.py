import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Opportunity(Base):
    __tablename__ = "opportunities"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    type: Mapped[str] = mapped_column(String, nullable=False)  # 'job' | 'grant'
    source: Mapped[str] = mapped_column(String, nullable=False)
    source_url: Mapped[str | None] = mapped_column(String)
    external_id: Mapped[str | None] = mapped_column(String)
    content_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    organization: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(String)
    remote: Mapped[bool | None] = mapped_column(Boolean)
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    eligibility: Mapped[dict] = mapped_column(JSONB, default=dict)
    salary_min: Mapped[float | None] = mapped_column(Numeric)
    salary_max: Mapped[float | None] = mapped_column(Numeric)
    salary_currency: Mapped[str] = mapped_column(String, default="USD")
    award_amount: Mapped[float | None] = mapped_column(Numeric)
    required_documents: Mapped[list] = mapped_column(JSONB, default=list)
    application_questions: Mapped[list] = mapped_column(JSONB, default=list)
    raw_data: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String, default="new")
    score: Mapped[int | None] = mapped_column(Integer)
    score_breakdown: Mapped[dict] = mapped_column(JSONB, default=dict)
    missing_fields: Mapped[list] = mapped_column(JSONB, default=list)
    discovered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
