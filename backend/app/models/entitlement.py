import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Entitlement(Base):
    """Singleton billing state for this local-first install (free vs pro)."""

    __tablename__ = "entitlements"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plan: Mapped[str] = mapped_column(String, nullable=False, default="free")  # free | pro
    status: Mapped[str] = mapped_column(String, nullable=False, default="inactive")
    stripe_customer_id: Mapped[str | None] = mapped_column(String)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String)
    stripe_checkout_session_id: Mapped[str | None] = mapped_column(String)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    license_key_fingerprint: Mapped[str | None] = mapped_column(String)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
