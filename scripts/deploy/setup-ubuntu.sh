#!/usr/bin/env bash
# =============================================================================
# DocuExtract — Ubuntu server bootstrap & deployment
#
# One-time setup that:
#   1. Installs Docker Engine + the Compose plugin (idempotent).
#   2. Ensures the shared external "jdp-network" exists.
#   3. Prepares and sanity-checks .env (refuses placeholder secrets).
#   4. Builds the images and starts the stack with `docker compose up -d`.
#
# Re-running it after a code change is safe: it rebuilds and restarts only what
# changed. Use `--no-install` to skip the Docker install step on later runs.
#
# Usage:
#   sudo bash scripts/deploy/setup-ubuntu.sh
#   sudo bash scripts/deploy/setup-ubuntu.sh --no-install
# =============================================================================
set -euo pipefail

SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-install) SKIP_INSTALL=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Resolve the repository root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; }

NETWORK_NAME="jdp-network"

# --- 1. Docker ---------------------------------------------------------------
if [[ "$SKIP_INSTALL" -eq 1 ]] || command -v docker >/dev/null 2>&1; then
  log "Docker already present: $(docker --version)"
else
  log "Installing Docker Engine + Compose plugin"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

# Allow the invoking (non-root) user to run docker, if not already in the group.
if [[ -n "${SUDO_USER:-}" ]] && ! id -nG "$SUDO_USER" | grep -qw docker; then
  usermod -aG docker "$SUDO_USER"
  log "Added $SUDO_USER to the docker group (re-login required for the sudo-less CLI)."
fi

docker compose version

# --- 2. Shared network -------------------------------------------------------
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  log "Docker network '$NETWORK_NAME' already exists."
else
  log "Creating Docker network '$NETWORK_NAME'"
  docker network create "$NETWORK_NAME"
fi

# --- 3. Environment file -----------------------------------------------------
if [[ ! -f .env ]]; then
  log "No .env found — creating from .env.example. EDIT IT before continuing."
  cp .env.example .env
  err "Edit $REPO_ROOT/.env (secrets, DB URL, CORS origins), then re-run this script."
  exit 1
fi

# Fail fast on leftover placeholders / missing required values.
require_env() {
  local key="$1" value
  value="$(grep -E "^${key}=" .env | tail -n1 | cut -d= -f2- || true)"
  if [[ -z "$value" ]]; then err "$key is empty in .env"; exit 1; fi
  case "$value" in
    replace-with-*|change-this-*) err "$key still has a placeholder value ('$value')"; exit 1 ;;
  esac
}
for key in DJANGO_SECRET_KEY POSTGRES_PASSWORD DATABASE_URL CORS_ALLOWED_ORIGINS; do
  require_env "$key"
done
log ".env passed the placeholder check."

# --- 4. Build & start --------------------------------------------------------
log "Building images"
docker compose build

log "Starting the stack"
docker compose up -d

# Wait for the backend/frontend to report healthy (max ~90s).
log "Waiting for services to become healthy"
for i in $(seq 1 30); do
  if [[ "$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -c healthy || true)" -ge 2 ]]; then
    break
  fi
  sleep 3
done
docker compose ps

# --- 5. Smoke test through the frontend proxy --------------------------------
# Verify the reverse-proxy chain from *inside* the frontend container rather than
# by re-mapping a host port (the design intent is that ports stay unpublished).
log "Smoke test: frontend nginx -> /api/ -> backend (checked inside the frontend container)"
if docker compose exec -T frontend wget -qO- http://127.0.0.1/api/ >/dev/null; then
  log "OK: nginx proxies /api/ to the backend successfully."
else
  err "The /api/ proxy check failed. Inspect: docker compose logs backend frontend"
fi

PUBLIC_HOSTNAME="$(grep -E '^PUBLIC_HOSTNAME=' .env | cut -d= -f2- || true)"
log "Done. Services are reachable only through the existing Cloudflare Tunnel on ${NETWORK_NAME}."
cat <<EOF

Next steps:
  * In Cloudflare Zero Trust -> Networks -> Tunnels, add a Public Hostname that
    maps ${PUBLIC_HOSTNAME:-your-hostname} -> HTTP://frontend:80, choosing the
    tunnel that is already attached to the ${NETWORK_NAME} Docker network.
    (The compose file exports no host port; the tunnel resolves the service name
    'frontend' via Docker's embedded DNS, exactly like 'backend' and 'db'.)
  * Verify from the internet:  curl -I https://${PUBLIC_HOSTNAME:-your-hostname}/api/
    (expect a JSON health response from the backend).
  * Stream logs:  docker compose logs -f backend
  * Apply updates later:  git pull && docker compose up -d --build
EOF
