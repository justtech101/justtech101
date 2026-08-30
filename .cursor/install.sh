#!/usr/bin/env bash
# Idempotent dependency refresh for the JUSTTECH Application Manager.
# Runs after the repository is checked out. Installs system packages, the
# backend Python environment (+ Playwright Chromium), the frontend npm
# packages, generates local .env files on first run, and applies the
# database schema. Docker is intentionally not used here -- docker-compose
# is the documented laptop path, but Cloud Agents provision Postgres and the
# services natively.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- System packages ---------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq postgresql postgresql-contrib python3-venv openssl

# --- Backend (Python venv + deps + Playwright browser) -----------------------
cd "$REPO_ROOT/backend"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip -q
pip install -q -r requirements-dev.txt
# Chromium OS libraries need root; the browser download itself runs as the
# unprivileged user into ~/.cache/ms-playwright.
sudo "$REPO_ROOT/backend/.venv/bin/python" -m playwright install-deps chromium
python -m playwright install chromium

# --- Frontend (npm) ----------------------------------------------------------
cd "$REPO_ROOT/frontend"
npm install

# --- Local env files (first run only; never overwrite existing secrets) ------
cd "$REPO_ROOT"
if [ ! -f .env ]; then
  ENC_KEY="$("$REPO_ROOT/backend/.venv/bin/python" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
  WH_SECRET="$(openssl rand -hex 32)"
  cat > .env <<EOF
DATABASE_URL=postgresql+asyncpg://justtech:justtech@localhost:5432/justtech
JUSTTECH_ENCRYPTION_KEY=${ENC_KEY}
ENVIRONMENT=development
CORS_ORIGINS=http://localhost:5173
STORAGE_ROOT=./storage
DEFAULT_DRY_RUN=true
ENABLE_LOCAL_BROWSER_WORKER=true
INGESTION_INTERVAL_MINUTES=60
N8N_WEBHOOK_SHARED_SECRET=${WH_SECRET}
VITE_API_BASE_URL=http://localhost:8000
EOF
  echo "Generated repo-root .env with a fresh encryption key and webhook secret."
fi
if [ ! -f frontend/.env ]; then
  echo "VITE_API_BASE_URL=http://localhost:8000" > frontend/.env
fi

# --- Database (start Postgres + ensure role/db/schema) -----------------------
bash "$REPO_ROOT/.cursor/start.sh"

echo "JUSTTECH install complete."
