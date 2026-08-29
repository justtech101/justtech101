#!/usr/bin/env python3
"""
Seller tool: mint a JustTech Pro license key after a Stripe Payment Link sale.

Usage (from repo root, with signing secret set):

  export JUSTTECH_LICENSE_SIGNING_SECRET=$(openssl rand -hex 32)  # once; store safely
  python3 scripts/mint_license.py --days 365 --email buyer@example.com

Or call the API instead:

  curl -X POST "$API/api/billing/mint-license" \\
    -H 'Content-Type: application/json' \\
    -d '{"admin_secret":"…","days_valid":365,"email":"buyer@example.com"}'
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

# Prefer env; allow loading repo .env if present.
env_path = ROOT / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

from app.config import get_settings  # noqa: E402
from app.services.license import mint_license_key  # noqa: E402

get_settings.cache_clear()


def main() -> int:
    parser = argparse.ArgumentParser(description="Mint a JustTech Pro license key")
    parser.add_argument("--days", type=int, default=365, help="Days until expiry (default 365)")
    parser.add_argument("--email", type=str, default=None, help="Buyer email embedded in claims")
    parser.add_argument("--perpetual", action="store_true", help="No expiry (omit exp claim)")
    args = parser.parse_args()

    if not get_settings().JUSTTECH_LICENSE_SIGNING_SECRET:
        print("ERROR: set JUSTTECH_LICENSE_SIGNING_SECRET in the environment or .env", file=sys.stderr)
        return 1

    days = None if args.perpetual else args.days
    key = mint_license_key(days_valid=days, email=args.email)
    print(key)
    print(
        "\nEmail this key to the buyer. They paste it on Pricing → Activate license key.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
