"""Unit tests for Pro license mint/verify (no DB / Stripe required)."""
import os
from datetime import datetime, timedelta, timezone

import pytest

# Configure signing secret before importing modules that read settings cache.
os.environ["JUSTTECH_LICENSE_SIGNING_SECRET"] = "test-signing-secret-for-unit-tests"

from app.config import get_settings
from app.services import license as license_service

get_settings.cache_clear()


def test_mint_and_verify_license_roundtrip():
    key = license_service.mint_license_key(days_valid=30, email="buyer@example.com")
    assert key.startswith("JTPRO.")
    claims = license_service.verify_license_key(key)
    assert claims["plan"] == "pro"
    assert claims["email"] == "buyer@example.com"
    assert "exp" in claims


def test_verify_rejects_tampered_key():
    key = license_service.mint_license_key(days_valid=30)
    parts = key.split(".")
    tampered = f"{parts[0]}.{parts[1]}.deadbeef"
    with pytest.raises(ValueError, match="signature"):
        license_service.verify_license_key(tampered)


def test_verify_rejects_expired_key(monkeypatch):
    key = license_service.mint_license_key(days_valid=1)
    # Force expiry by rewriting payload with past exp while keeping structure via mint path:
    # call verify after monkeypatching time check by crafting exp in the past.
    import base64
    import hashlib
    import hmac
    import json

    secret = "test-signing-secret-for-unit-tests"
    payload = {"plan": "pro", "v": 1, "exp": int((datetime.now(timezone.utc) - timedelta(days=2)).timestamp())}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    expired = f"JTPRO.{body}.{sig}"
    with pytest.raises(ValueError, match="expired"):
        license_service.verify_license_key(expired)


def test_fingerprint_is_stable():
    key = "JTPRO.abc.def"
    assert license_service.fingerprint_license_key(key) == license_service.fingerprint_license_key(f"  {key}  ")
