"""
Stripe Checkout + webhook + license activation for JustTech Pro.

Money flow:
1. Customer hits POST /api/billing/checkout with product=pro_monthly|hosted_setup
2. Stripe Checkout Session is created; customer pays
3. Stripe POSTs to /api/billing/webhook → entitlement activated (pro)
4. Self-hosted alternative: seller mints a key, customer POSTs /api/billing/activate-license
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.services import license as license_service
from app.services.audit import record_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/billing", tags=["billing"])

ProductSku = Literal["pro_monthly", "hosted_setup"]


class CheckoutRequest(BaseModel):
    product: ProductSku = "pro_monthly"
    success_url: str | None = None
    cancel_url: str | None = None
    customer_email: str | None = None


class CheckoutResponse(BaseModel):
    checkout_url: str
    session_id: str


class ActivateLicenseRequest(BaseModel):
    license_key: str = Field(min_length=20)


class MintLicenseRequest(BaseModel):
    admin_secret: str
    days_valid: int | None = 365
    email: str | None = None


def _configure_stripe() -> None:
    settings = get_settings()
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(503, "Stripe is not configured (STRIPE_SECRET_KEY missing).")
    stripe.api_key = settings.STRIPE_SECRET_KEY


def _price_for_product(product: ProductSku) -> tuple[str, str]:
    settings = get_settings()
    if product == "pro_monthly":
        if not settings.STRIPE_PRICE_PRO_MONTHLY:
            raise HTTPException(503, "STRIPE_PRICE_PRO_MONTHLY is not set.")
        return settings.STRIPE_PRICE_PRO_MONTHLY, "subscription"
    if not settings.STRIPE_PRICE_HOSTED_SETUP:
        raise HTTPException(503, "STRIPE_PRICE_HOSTED_SETUP is not set.")
    return settings.STRIPE_PRICE_HOSTED_SETUP, "payment"


@router.get("/status")
async def billing_status(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return await license_service.entitlement_snapshot(db)


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout(payload: CheckoutRequest, db: AsyncSession = Depends(get_db)) -> CheckoutResponse:
    """Create a Stripe Checkout Session, or redirect to a Payment Link fallback."""
    settings = get_settings()
    link = (
        settings.STRIPE_PAYMENT_LINK_PRO
        if payload.product == "pro_monthly"
        else settings.STRIPE_PAYMENT_LINK_HOSTED_SETUP
    )

    # Prefer API Checkout when Price IDs exist; otherwise open a Dashboard Payment Link.
    try:
        price_id, mode = _price_for_product(payload.product)
    except HTTPException:
        if link:
            entitlement = await license_service.get_or_create_entitlement(db)
            await record_event(
                db,
                entity_type="billing",
                entity_id=entitlement.id,
                event_type="payment_link_opened",
                payload={"product": payload.product},
                commit=True,
            )
            return CheckoutResponse(checkout_url=link, session_id="payment_link")
        raise

    try:
        _configure_stripe()
    except HTTPException:
        if link:
            return CheckoutResponse(checkout_url=link, session_id="payment_link")
        raise

    success = payload.success_url or settings.BILLING_SUCCESS_URL
    cancel = payload.cancel_url or settings.BILLING_CANCEL_URL

    session_params: dict[str, Any] = {
        "mode": mode,
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success,
        "cancel_url": cancel,
        "metadata": {"justtech_product": payload.product},
        "allow_promotion_codes": True,
    }
    if payload.customer_email:
        session_params["customer_email"] = payload.customer_email
    if mode == "subscription":
        session_params["subscription_data"] = {"metadata": {"justtech_product": payload.product}}

    try:
        session = stripe.checkout.Session.create(**session_params)
    except stripe.StripeError as exc:
        logger.exception("Stripe Checkout session creation failed")
        if link:
            return CheckoutResponse(checkout_url=link, session_id="payment_link_fallback")
        raise HTTPException(502, f"Stripe error: {exc.user_message or str(exc)}") from exc

    entitlement = await license_service.get_or_create_entitlement(db)
    await record_event(
        db,
        entity_type="billing",
        entity_id=entitlement.id,
        event_type="checkout_session_created",
        payload={"session_id": session.id, "product": payload.product, "mode": mode},
        commit=True,
    )
    return CheckoutResponse(checkout_url=session.url, session_id=session.id)


@router.post("/portal")
async def create_portal(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Stripe Customer Portal for Pro subscribers to manage/cancel billing."""
    _configure_stripe()
    settings = get_settings()
    row = await license_service.get_or_create_entitlement(db)
    if not row.stripe_customer_id:
        raise HTTPException(400, "No Stripe customer on this install yet. Complete Checkout first.")
    try:
        session = stripe.billing_portal.Session.create(
            customer=row.stripe_customer_id,
            return_url=settings.BILLING_PORTAL_RETURN_URL,
        )
    except stripe.StripeError as exc:
        raise HTTPException(502, f"Stripe portal error: {exc.user_message or str(exc)}") from exc
    return {"portal_url": session.url}


@router.post("/webhook")
async def stripe_webhook(request: Request, db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    settings = get_settings()
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "STRIPE_WEBHOOK_SECRET is not configured.")
    _configure_stripe()

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, settings.STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.SignatureVerificationError) as exc:
        raise HTTPException(400, f"Webhook signature verification failed: {exc}") from exc

    event_type = event["type"]
    data = event["data"]["object"]

    if event_type == "checkout.session.completed":
        await _activate_from_checkout(db, data)
    elif event_type in ("customer.subscription.updated", "customer.subscription.deleted"):
        await _sync_subscription(db, data)
    else:
        logger.info("Ignoring Stripe event type %s", event_type)

    return {"status": "ok"}


async def _activate_from_checkout(db: AsyncSession, session: dict[str, Any]) -> None:
    product = (session.get("metadata") or {}).get("justtech_product", "pro_monthly")
    row = await license_service.get_or_create_entitlement(db)
    row.stripe_checkout_session_id = session.get("id")
    row.stripe_customer_id = session.get("customer")
    if session.get("subscription"):
        row.stripe_subscription_id = session["subscription"]
    # Both SKUs unlock Pro on this install; hosted_setup is a services upsell.
    row.plan = "pro"
    row.status = "active"
    if product == "hosted_setup":
        row.valid_until = datetime.now(timezone.utc) + timedelta(days=365)
        meta = dict(row.metadata_ or {})
        meta["hosted_setup_purchased"] = True
        row.metadata_ = meta
    else:
        row.valid_until = None  # subscription-managed
    await db.commit()
    await record_event(
        db,
        entity_type="billing",
        entity_id=row.id,
        event_type="entitlement_activated",
        payload={"product": product, "session_id": session.get("id")},
        commit=True,
    )


async def _sync_subscription(db: AsyncSession, subscription: dict[str, Any]) -> None:
    row = await license_service.get_or_create_entitlement(db)
    status = subscription.get("status")
    row.stripe_subscription_id = subscription.get("id")
    row.stripe_customer_id = subscription.get("customer")
    if status in ("active", "trialing"):
        row.plan = "pro"
        row.status = "active"
        row.valid_until = None
    elif status == "past_due":
        row.status = "past_due"
    else:
        row.plan = "free"
        row.status = "canceled"
    await db.commit()


@router.post("/activate-license")
async def activate_license(payload: ActivateLicenseRequest, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Customer pastes a signed Pro key (seller emailed after payment)."""
    try:
        claims = license_service.verify_license_key(payload.license_key)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    row = await license_service.get_or_create_entitlement(db)
    row.plan = "pro"
    row.status = "active"
    row.license_key_fingerprint = license_service.fingerprint_license_key(payload.license_key)
    exp = claims.get("exp")
    row.valid_until = datetime.fromtimestamp(exp, tz=timezone.utc) if exp else None
    meta = dict(row.metadata_ or {})
    if claims.get("email"):
        meta["license_email"] = claims["email"]
    row.metadata_ = meta
    await db.commit()
    return await license_service.entitlement_snapshot(db)


@router.post("/mint-license")
async def mint_license(payload: MintLicenseRequest) -> dict[str, str]:
    """Seller-only: mint a Pro key after a Payment Link sale (protect with admin secret)."""
    settings = get_settings()
    if not settings.JUSTTECH_BILLING_ADMIN_SECRET:
        raise HTTPException(503, "JUSTTECH_BILLING_ADMIN_SECRET is not configured.")
    if payload.admin_secret != settings.JUSTTECH_BILLING_ADMIN_SECRET:
        raise HTTPException(403, "Invalid admin secret")
    try:
        key = license_service.mint_license_key(days_valid=payload.days_valid, email=payload.email)
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"license_key": key}
