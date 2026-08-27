"""
Central configuration. Every value here is backed by an environment variable
(see /.env.example at the repo root for the full list and manual setup notes).
"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Checks both locations so `.env` works whether it lives at the repo
    # root (as the setup instructions say: `cp .env.example .env` in the
    # repo root) or in `backend/.env` -- later paths win if both exist.
    # Actual OS environment variables (e.g. from docker-compose's env_file)
    # always take precedence over either file.
    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    # --- Database -----------------------------------------------------------
    # REQUIRED. Postgres connection string, e.g. for local docker-compose:
    #   postgresql+asyncpg://justtech:justtech@localhost:5432/justtech
    # or a Supabase project's "connection string" (use the pooler URI for
    # asyncpg, port 6543, and set DATABASE_URL_SYNC to the direct 5432 URI
    # for tools that need a sync connection, e.g. psql migrations).
    DATABASE_URL: str = "postgresql+asyncpg://justtech:justtech@localhost:5432/justtech"
    # Phase 1 stores documents/screenshots on local disk (STORAGE_ROOT below),
    # served via FastAPI's StaticFiles mount. Swapping in Supabase Storage as
    # an alternative backend is a documented extension point -- see
    # docs/ARCHITECTURE.md section 7 -- not wired into Phase 1 config.

    # --- Security -------------------------------------------------------------
    # REQUIRED. Generate with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # Used to encrypt/decrypt rows in the `credentials` table. Losing this key
    # makes stored credentials unrecoverable by design.
    JUSTTECH_ENCRYPTION_KEY: str = ""

    # --- Billing / JustTech Pro ----------------------------------------------
    # When true, drafting + browser fill require an active Pro entitlement.
    # Keep false for pure OSS self-host; set true on paid/hosted installs you sell.
    JUSTTECH_REQUIRE_PRO: bool = False
    # Stripe (https://dashboard.stripe.com/apikeys). Required to take payments.
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRICE_PRO_MONTHLY: str = ""       # price_... for Pro subscription
    STRIPE_PRICE_HOSTED_SETUP: str = ""      # price_... for one-time founding setup
    BILLING_SUCCESS_URL: str = "http://localhost:5173/#/pricing?checkout=success"
    BILLING_CANCEL_URL: str = "http://localhost:5173/#/pricing?checkout=canceled"
    PRO_PRICE_DISPLAY: str = "$29/mo"
    HOSTED_SETUP_PRICE_DISPLAY: str = "$499 one-time"
    # HMAC secret used to mint/verify offline Pro license keys (seller keeps this).
    JUSTTECH_LICENSE_SIGNING_SECRET: str = ""
    # Protects POST /api/billing/mint-license (seller-only).
    JUSTTECH_BILLING_ADMIN_SECRET: str = ""

    # --- App behavior -----------------------------------------------------
    ENVIRONMENT: str = "development"           # development | production
    CORS_ORIGINS: str = "http://localhost:5173"  # comma-separated list
    STORAGE_ROOT: str = "./storage"            # local disk root for documents/screenshots
    DEFAULT_DRY_RUN: bool = True               # every new application defaults to dry_run=true
    ENABLE_LOCAL_BROWSER_WORKER: bool = True   # set false on the thin client if using a remote worker
    INGESTION_INTERVAL_MINUTES: int = 60       # APScheduler poll interval for RSS/API ingestion

    # --- n8n integration ----------------------------------------------------
    N8N_WEBHOOK_SHARED_SECRET: str = ""        # REQUIRED to accept inbound n8n webhooks; sent as X-Webhook-Secret header
    N8N_OUTBOUND_WEBHOOK_URL: str | None = None  # OPTIONAL: n8n webhook URL this app POSTs notifications to (e.g. new high-score opportunity)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def storage_path(self) -> Path:
        p = Path(self.STORAGE_ROOT)
        p.mkdir(parents=True, exist_ok=True)
        return p


@lru_cache
def get_settings() -> Settings:
    return Settings()
