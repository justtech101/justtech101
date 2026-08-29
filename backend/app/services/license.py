"""
Pro license / entitlement checks.

Free: discovery, scoring, dashboard, tracking.
Pro: drafting + Playwright form fill (the monetized automation path).

Activation paths:
1. Stripe Checkout webhook (hosted or self-serve on this install)
2. Signed license key pasted by the customer (JUSTTECH_LICENSE_SIGNING_SECRET)
3. Dev escape hatch when REQUIRE_PRO is false
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.entitlement import Entitlement

PRO_FEATURES = ("drafting", "automation")


async def get_or_create_entitlement(db: AsyncSession) -> Entitlement:
    result = await db.execute(select(Entitlement).limit(1))
    row = result.scalar_one_or_none()
    if row:
        return row
    row = Entitlement(plan="free", status="inactive")
    db.add(row)
    await db.flush()
    return row


def _is_unexpired(valid_until: datetime | None) -> bool:
    if valid_until is None:
        return True
    if valid_until.tzinfo is None:
        valid_until = valid_until.replace(tzinfo=timezone.utc)
    return valid_until >= datetime.now(timezone.utc)


async def entitlement_snapshot(db: AsyncSession) -> dict[str, Any]:
    settings = get_settings()
    row = await get_or_create_entitlement(db)
    active = row.plan == "pro" and row.status == "active" and _is_unexpired(row.valid_until)
    enforced = settings.JUSTTECH_REQUIRE_PRO
    checkout_pro = bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_PRICE_PRO_MONTHLY)
    checkout_hosted = bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_PRICE_HOSTED_SETUP)
    link_pro = settings.STRIPE_PAYMENT_LINK_PRO or None
    link_hosted = settings.STRIPE_PAYMENT_LINK_HOSTED_SETUP or None
    return {
        "plan": row.plan if active else "free",
        "status": row.status,
        "active": active,
        "valid_until": row.valid_until.isoformat() if row.valid_until else None,
        "pro_required": enforced,
        "pro_features_unlocked": active or not enforced,
        "billing_configured": checkout_pro or checkout_hosted or bool(link_pro or link_hosted),
        "has_stripe_customer": bool(row.stripe_customer_id),
        "features": {
            "discovery": True,
            "scoring": True,
            "drafting": active or not enforced,
            "automation": active or not enforced,
        },
        "products": {
            "pro_monthly": {
                "name": "JustTech Pro",
                "price_display": settings.PRO_PRICE_DISPLAY,
                "description": "Unlock application drafting and browser form-fill automation.",
                "price_id_configured": checkout_pro,
                "payment_link": link_pro,
            },
            "hosted_setup": {
                "name": "Founding Hosted Setup",
                "price_display": settings.HOSTED_SETUP_PRICE_DISPLAY,
                "description": "One-time done-for-you deploy on your machine or a VPS you own.",
                "price_id_configured": checkout_hosted,
                "payment_link": link_hosted,
            },
        },
    }


async def require_pro(feature: str, db: AsyncSession = Depends(get_db)) -> Entitlement:
    """FastAPI dependency — raise 402 when Pro is required and not active."""
    settings = get_settings()
    row = await get_or_create_entitlement(db)
    if not settings.JUSTTECH_REQUIRE_PRO:
        return row
    active = row.plan == "pro" and row.status == "active" and _is_unexpired(row.valid_until)
    if active:
        return row
    raise HTTPException(
        status_code=402,
        detail={
            "error": "pro_required",
            "feature": feature,
            "message": f"JustTech Pro is required for {feature}. Upgrade at /#/pricing.",
            "upgrade_path": "/pricing",
        },
    )


def fingerprint_license_key(license_key: str) -> str:
    return hashlib.sha256(license_key.strip().encode("utf-8")).hexdigest()[:32]


def mint_license_key(*, days_valid: int | None, email: str | None = None) -> str:
    """Create a signed Pro license key (seller-side; needs LICENSE_SIGNING_SECRET)."""
    settings = get_settings()
    secret = settings.JUSTTECH_LICENSE_SIGNING_SECRET
    if not secret:
        raise ValueError("JUSTTECH_LICENSE_SIGNING_SECRET is not configured")

    payload: dict[str, Any] = {"plan": "pro", "v": 1}
    if days_valid is not None:
        exp = datetime.now(timezone.utc).timestamp() + days_valid * 86400
        payload["exp"] = int(exp)
    if email:
        payload["email"] = email

    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"JTPRO.{body}.{sig}"


def verify_license_key(license_key: str) -> dict[str, Any]:
    settings = get_settings()
    secret = settings.JUSTTECH_LICENSE_SIGNING_SECRET
    if not secret:
        raise ValueError("JUSTTECH_LICENSE_SIGNING_SECRET is not configured")

    parts = license_key.strip().split(".")
    if len(parts) != 3 or parts[0] != "JTPRO":
        raise ValueError("Malformed license key")
    _, body, sig = parts
    expected = hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise ValueError("Invalid license signature")

    padded = body + "=" * (-len(body) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")))
    if payload.get("plan") != "pro":
        raise ValueError("License is not a Pro plan")
    exp = payload.get("exp")
    if exp is not None and datetime.now(timezone.utc).timestamp() > float(exp):
        raise ValueError("License key has expired")
    return payload
