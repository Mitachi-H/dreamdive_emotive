#!/usr/bin/env bash
set -euo pipefail

# Bootstrap script: installs Node deps, copies server/.env, and creates a Python venv with required packages.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Repo root: $ROOT_DIR"

have_cmd() { command -v "$1" >/dev/null 2>&1; }

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[WARN]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ERR ]\033[0m %s\n" "$*"; }

# ----- Node / server -----
if have_cmd node && have_cmd npm; then
  info "Installing Node dependencies (server/)"
  (cd server && npm install)

  if [[ ! -f server/.env ]] && [[ -f server/.env.example ]]; then
    info "Creating server/.env from .env.example"
    cp server/.env.example server/.env
    warn "Edit server/.env to set CORTEX_CLIENT_ID / CORTEX_CLIENT_SECRET before starting the server."
  fi
else
  warn "node/npm not found. Skipping server dependency install. Install Node.js >= 18 to run the server."
fi

# ----- Python / venv -----
PY="${PYTHON:-}"
if [[ -z "${PY}" ]]; then
  if have_cmd python3; then PY="python3"; elif have_cmd python; then PY="python"; else PY=""; fi
fi

if [[ -n "$PY" ]]; then
  if [[ ! -d .venv ]]; then
    info "Creating Python venv at ./.venv"
    "$PY" -m venv .venv
  else
    info "Using existing Python venv at ./.venv"
  fi

  # Resolve the venv python executable (Unix vs Windows)
  if [[ -x .venv/bin/python ]]; then VENV_PY=".venv/bin/python";
  elif [[ -x .venv/Scripts/python.exe ]]; then VENV_PY=".venv/Scripts/python.exe";
  else VENV_PY=""; fi

  if [[ -z "$VENV_PY" ]]; then
    err "Cannot find python in the venv."
    exit 1
  fi

  info "Upgrading pip"
  "$VENV_PY" -m pip install --upgrade pip

  if [[ -f python/requirements.txt ]]; then
    info "Installing Python dependencies from python/requirements.txt"
    "$VENV_PY" -m pip install -r python/requirements.txt
  else
    warn "python/requirements.txt not found; skipping Python deps install."
  fi
else
  warn "python not found. Skipping Python venv setup. Install Python 3.9+ to run Streamlit sample."
fi

cat <<'EOF'

Done.

Next steps:
- Start the server:
    cd server && npm start
  Then open: http://localhost:3000

- Run the Python dashboard (in another terminal):
    source .venv/bin/activate   # Windows: .venv\Scripts\activate
    streamlit run python/sleep_dashboard/app.py

If you configured API_AUTH_TOKEN in server/.env, input the same token in the Streamlit app sidebar (and browser UI via localStorage if needed).
EOF

